//! 概念スペクトラム検索: タグ埋め込みとメディア重心の算出。
//!
//! 設計の要点（詳細は _plan/20260729_semantic_spectrum_search_implementation_plan.md）:
//!
//! - タグのベクトルだけを永続化し、**メディアの重心はキャッシュしない**。
//!   メディアはタグより桁違いに多く、タグ編集・マージのたびに大量再計算が必要になるため。
//! - 重心に入れるのは `basic` タグとカテゴリのみ。`descriptive` は既定で除外する。
//!   `media` テーブルは解析に使ったモデル・粒度を記録していないため、descriptive を入れると
//!   「意味が似ている」ではなく「同じ設定で解析された」でクラスタリングされる恐れがある。
//! - 埋め込みに投入するのは英語名ではなく `name_ja`。`normalize_tag_en` が
//!   機械的な単数形化で語を壊すため（`lens` → `len` 等。docs/vlm-notes.md 参照）。

use anyhow::{anyhow, Result};
use rayon::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{Pool, Sqlite};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Emitter, State};

use crate::commands::{cmd_err, try_acquire_task_lock, ScanState};
use crate::db::DbState;

/// 候補集合に入るために必要な `basic` タグの数。
///
/// 1〜2個の重心は実質「そのタグ1個での検索」でしかなく、通しても価値が出ない。
/// LIGHT プロンプトはこの下限を満たすために `Output 3 to 5 tags.` を指示している。
pub const MIN_BASIC_TAGS: usize = 3;

/// これ未満の候補数では機能自体を無効化する。
pub const MIN_CANDIDATES: usize = 5;

/// これ未満では3ゾーン分割を行わず、類似上位のみの縮退モードにする。
pub const FULL_SPECTRUM_MIN: usize = 20;

/// `/api/embed` に一度に投げるタグ数。
const EMBED_BATCH_SIZE: usize = 32;

/// 診断で総当り類似度を取るときの標本上限。全件は O(N^2) で現実的でない。
const DIAGNOSTICS_SAMPLE_CAP: usize = 400;

/// 各ゾーンに表示する件数。
pub const ZONE_SIZE: usize = 4;

/// 帯の幅（候補数に対する比率）。下限は `ZONE_SIZE`、上限は `ZONE_BAND_MAX`。
///
/// 帯から `ZONE_SIZE` 件を無作為抽出するので、ライブラリが育つほど帯が広がり
/// 引き直しの多様性が自然に増える。N=20 では帯 = 4 件で決定的になる。
const ZONE_BAND_RATIO: f32 = 0.10;

/// 帯の件数上限。
///
/// **比率だけで帯を切ると裾で精度が壊れる。** 順位で切っているのに、帯が覆う
/// 類似度の幅は分布上の位置によって桁で変わるため。実測（bge-m3 / 候補 1,007 件 /
/// 基準 40 件平均 / `tools/embedding-check/band-width.mjs`）:
///
/// | 帯幅 | 上位帯が覆う幅 | 下端σ | 最下位帯が覆う幅 | 最類似が出る確率 |
/// |---|---|---|---|---|
/// | 4 | 0.141 | +3.62σ | 0.032 | 100% |
/// | 8 | 0.201 | +3.13σ | 0.045 | 50% |
/// | 101（比率 10%） | 0.431 | +1.34σ | 0.126 | 4% |
///
/// 上限が無いと上位帯の下端が平均 +1.34σ まで降りてきて、「タグの類似度が高い」枠が
/// 実質「平均より少し上」の候補を出す。中央付近は密集しているので比率のままでも
/// 精度は落ちないが、ゾーンごとに規則を変える理由が無いので一律に上限を掛ける。
///
/// `ZONE_SIZE * 2` にすると引き直しの組み合わせが C(8,4) = 70 通り残るので、
/// 引き直しは死なない。1 にすれば決定的な「上位 N 件」になるが、それは
/// この機能の目的（スペクトラムの提示）ではない。
const ZONE_BAND_MAX: usize = ZONE_SIZE * 2;

// ---------------------------------------------------------------------------
// 乱択（帯域サンプリング用）
// ---------------------------------------------------------------------------

/// SplitMix64。`rand` クレートを足さないための最小実装。
///
/// シードを呼び出し側から受け取る決定的な設計にしてある。こうすると
/// 「🎲 引き直し」= 新しいシードで呼び直す、と定義でき、同じシードなら同じ結果になるので
/// テストも再現調査もできる。内部で時刻を拾うと、どちらもできなくなる。
struct SplitMix64(u64);

impl SplitMix64 {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }
}

/// `len` 個から `k` 個の添字を重複なく選ぶ（部分 Fisher-Yates）。
fn sample_indices(len: usize, k: usize, rng: &mut SplitMix64) -> Vec<usize> {
    let k = k.min(len);
    let mut pool: Vec<usize> = (0..len).collect();
    for i in 0..k {
        let j = i + rng.below(len - i);
        pool.swap(i, j);
    }
    pool.truncate(k);
    pool
}

/// 類似度降順に並んだ `n` 件を3つの帯に切る。返すのは `[start, end)` の範囲。
///
/// 絶対的なコサイン閾値ではなく**順位**で切るのは、実測で分布が
/// centering 無しでは 0.61〜0.99 に圧縮され、有りでも 0 中心に集まるため
/// （閾値では Zone2・Zone3 が空になる）。順位ベースは分布とモデルに依存しない。
///
/// ただし順位だけでは裾の精度が保てないので、件数に上限を掛ける（`ZONE_BAND_MAX`）。
fn zone_bands(n: usize) -> [(usize, usize); 3] {
    let band = ((n as f32 * ZONE_BAND_RATIO).ceil() as usize)
        .max(ZONE_SIZE)
        .min(ZONE_BAND_MAX)
        .min(n);
    let mid_start = (n / 2).saturating_sub(band / 2).min(n - band);
    [
        (0, band),
        (mid_start, mid_start + band),
        (n - band, n),
    ]
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SpectrumConfig {
    pub ollama_url: String,
    pub model: String,
    pub include_descriptive: bool,
    pub centering: bool,
}

async fn setting(pool: &Pool<Sqlite>, key: &str, default: &str) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| default.to_string())
}

pub async fn load_spectrum_config(pool: &Pool<Sqlite>) -> SpectrumConfig {
    SpectrumConfig {
        ollama_url: setting(pool, "ollama_url", "http://localhost:11434").await,
        model: setting(pool, "spectrum_embedding_model", "bge-m3").await,
        include_descriptive: setting(pool, "spectrum_include_descriptive", "false").await == "true",
        centering: setting(pool, "spectrum_centering", "true").await == "true",
    }
}

// ---------------------------------------------------------------------------
// Ollama /api/embed
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

#[derive(Deserialize)]
struct EmbedResponse {
    embeddings: Vec<Vec<f32>>,
}

/// タグ文字列をまとめてベクトル化する。
///
/// `/api/embed`（複数入力）は比較的新しい API で、旧 `/api/embeddings`（単一入力・
/// `prompt` / `embedding`）とは形が異なる。旧版しか持たない Ollama では 404 が返るため、
/// 「Ollama を更新せよ」と読み取れるエラーに変換する。
pub async fn fetch_embeddings(
    client: &Client,
    base_url: &str,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>> {
    let res = client
        .post(format!("{}/api/embed", base_url))
        .json(&EmbedRequest { model, input: texts })
        .send()
        .await?;

    let status = res.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(anyhow!(
            "この Ollama には /api/embed がありません。Ollama を更新してください（埋め込み機能には比較的新しいバージョンが必要です）。"
        ));
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(anyhow!("Ollama API Error ({}): {}", status, body.trim()));
    }

    let parsed: EmbedResponse = res.json().await?;
    if parsed.embeddings.len() != texts.len() {
        return Err(anyhow!(
            "埋め込みの件数が要求と一致しません (要求 {} / 応答 {})",
            texts.len(),
            parsed.embeddings.len()
        ));
    }
    Ok(parsed.embeddings)
}

// ---------------------------------------------------------------------------
// ベクトルのシリアライズと基本演算
// ---------------------------------------------------------------------------

fn to_blob(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

fn from_blob(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// L2 正規化する。ノルムが 0 なら false を返し、値は変更しない。
///
/// 保存時に正規化しておくことで、モデルが出力ノルムを揃えていない場合でも
/// たまたまノルムの大きいタグが重心を支配する事故を防げる。
fn l2_normalize(v: &mut [f32]) -> bool {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return false;
    }
    for x in v.iter_mut() {
        *x /= norm;
    }
    true
}

/// 正規化済みベクトル同士のコサイン類似度（= 内積）。
fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// 埋め込みに投入するテキストを決める。
///
/// `name_ja` を優先するのは、英語名 `name` が `normalize_tag_en` の機械的な単数形化で
/// 壊れていることがあるため（`lens` → `len` / `canvas` → `canva`）。
/// `name_ja` は `trim()` のみで無加工保存される。
fn embedding_text(name: &str, name_ja: Option<&str>) -> String {
    match name_ja {
        Some(ja) if !ja.trim().is_empty() => ja.trim().to_string(),
        _ => name.replace('_', " "),
    }
}

// ---------------------------------------------------------------------------
// ライブラリ（全メディアの重心）の構築
// ---------------------------------------------------------------------------

pub struct Library {
    pub media_ids: Vec<i64>,
    /// 正規化済み重心（centering 有効時は中心を引いた後に再正規化したもの）
    pub centroids: Vec<Vec<f32>>,
    /// 重心に寄与したタグ数（本数バイアスの診断に使う）
    pub contributing_counts: Vec<usize>,
    pub has_descriptive: Vec<bool>,
    /// `basic` タグの id（昇順）。基準とタグを共有する候補を外すのに使う。
    /// カテゴリを含めないのは、全メディアが必ず持つため共有判定が常に真になるから。
    pub basic_tag_ids: Vec<Vec<i64>>,
    pub dim: usize,
    /// `basic` タグ不足で候補集合から外れたメディア数
    pub excluded_by_tag_count: usize,
    /// タグはあるが、そのタグのベクトルが未生成で重心を作れなかったメディア数
    pub excluded_by_missing_vectors: usize,
    pub load_ms: u64,
    pub centroid_ms: u64,
}

impl Library {
    pub fn index_of(&self, media_id: i64) -> Option<usize> {
        self.media_ids.iter().position(|&id| id == media_id)
    }

    /// 2件が `basic` タグを1つでも共有しているか。両方昇順なのでマージで判定する。
    pub fn shares_basic_tag(&self, a: usize, b: usize) -> bool {
        let (xs, ys) = (&self.basic_tag_ids[a], &self.basic_tag_ids[b]);
        let (mut i, mut j) = (0, 0);
        while i < xs.len() && j < ys.len() {
            match xs[i].cmp(&ys[j]) {
                std::cmp::Ordering::Equal => return true,
                std::cmp::Ordering::Less => i += 1,
                std::cmp::Ordering::Greater => j += 1,
            }
        }
        false
    }
}

/// 指定モデルの全タグベクトルを読み込む（正規化済みで返す）。
pub async fn load_tag_vectors(pool: &Pool<Sqlite>, model: &str) -> Result<HashMap<i64, Vec<f32>>, String> {
    let rows = sqlx::query_as::<_, (i64, Vec<u8>)>(
        "SELECT tag_id, vector FROM tag_embeddings WHERE model = ?1",
    )
    .bind(model)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut map = HashMap::with_capacity(rows.len());
    for (tag_id, blob) in rows {
        let mut v = from_blob(&blob);
        if l2_normalize(&mut v) {
            map.insert(tag_id, v);
        }
    }
    Ok(map)
}

/// 解析済みメディアのタグ構成を読み出し、重心を算出する。
pub async fn build_library(pool: &Pool<Sqlite>, cfg: &SpectrumConfig) -> Result<Library, String> {
    let t0 = std::time::Instant::now();

    let vectors = load_tag_vectors(pool, &cfg.model).await?;

    let rows = sqlx::query_as::<_, (i64, i64, i64, String)>(
        r#"
        SELECT mt.media_id, mt.tag_id, t.is_category, t.tag_kind
        FROM media_tags mt
        JOIN tags t ON t.id = mt.tag_id
        JOIN media m ON m.id = mt.media_id
        WHERE m.analysis_status = 'completed'
        ORDER BY mt.media_id
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let load_ms = t0.elapsed().as_millis() as u64;
    let t1 = std::time::Instant::now();

    // メディアごとに (寄与タグ id 集合, basic 本数, descriptive 有無) を組み立てる
    struct Pending {
        tag_ids: Vec<i64>,
        /// カテゴリを除いた basic タグの id。タグ検索で到達できる候補を外すのに使う
        basic_ids: Vec<i64>,
        basic_count: usize,
        has_descriptive: bool,
    }
    let mut per_media: HashMap<i64, Pending> = HashMap::new();

    for (media_id, tag_id, is_category, kind) in rows {
        let is_category = is_category != 0;
        let entry = per_media.entry(media_id).or_insert_with(|| Pending {
            tag_ids: Vec::new(),
            basic_ids: Vec::new(),
            basic_count: 0,
            has_descriptive: false,
        });

        if kind == "descriptive" {
            entry.has_descriptive = true;
        }
        // 参加条件はカテゴリを数えない。カテゴリは全メディアが必ず持つため、
        // 数えると全員が下限を満たしてしまい閾値が意味を失う。
        if !is_category && kind == "basic" {
            entry.basic_count += 1;
            entry.basic_ids.push(tag_id);
        }

        let contributes = is_category || kind == "basic" || (cfg.include_descriptive && kind == "descriptive");
        if contributes {
            entry.tag_ids.push(tag_id);
        }
    }

    // 候補集合の確定と df の集計を同じ母数で行う
    let mut eligible: Vec<(i64, Pending)> = per_media
        .into_iter()
        .filter(|(_, p)| p.basic_count >= MIN_BASIC_TAGS)
        .collect();
    eligible.sort_by_key(|(id, _)| *id);

    let n = eligible.len();
    let mut df: HashMap<i64, usize> = HashMap::new();
    for (_, p) in &eligible {
        // 同一メディア内の重複は df を二重に数えないよう一意化する
        let uniq: HashSet<i64> = p.tag_ids.iter().copied().collect();
        for id in uniq {
            *df.entry(id).or_insert(0) += 1;
        }
    }

    let dim = vectors.values().next().map(|v| v.len()).unwrap_or(0);

    // 重み付き重心を並列に算出する
    let raw: Vec<Option<(i64, Vec<f32>, usize, bool, Vec<i64>)>> = eligible
        .par_iter()
        .map(|(media_id, p)| {
            if dim == 0 {
                return None;
            }
            let mut acc = vec![0f32; dim];
            let mut fallback = vec![0f32; dim];
            let mut used = 0usize;
            let mut weight_sum = 0f32;

            for tag_id in &p.tag_ids {
                let Some(v) = vectors.get(tag_id) else { continue };
                if v.len() != dim {
                    continue;
                }
                used += 1;
                // IDF: w = ln(N / df)。クリップ等の追加防御は入れない。
                // df=1 が df=2 より重い倍率は N=1,000 で 1.11 倍にすぎず、実用規模では誤差。
                let d = *df.get(tag_id).unwrap_or(&1) as f32;
                let w = (n as f32 / d.max(1.0)).ln().max(0.0);
                weight_sum += w;
                for (a, x) in acc.iter_mut().zip(v) {
                    *a += w * x;
                }
                for (f, x) in fallback.iter_mut().zip(v) {
                    *f += x;
                }
            }

            if used == 0 {
                return None;
            }
            // 全タグが df = N の場合 w が全て 0 になり方向が未定義になる。
            // その場合は重み無しの単純平均へ落とす。
            let mut centroid = if weight_sum > f32::EPSILON && l2_normalize(&mut acc) {
                acc
            } else if l2_normalize(&mut fallback) {
                fallback
            } else {
                return None;
            };
            let _ = l2_normalize(&mut centroid);
            // 共有判定をマージで回せるよう昇順・重複なしにしておく
            let mut basic_ids = p.basic_ids.clone();
            basic_ids.sort_unstable();
            basic_ids.dedup();
            Some((*media_id, centroid, used, p.has_descriptive, basic_ids))
        })
        .collect();

    let mut media_ids = Vec::with_capacity(n);
    let mut centroids = Vec::with_capacity(n);
    let mut contributing_counts = Vec::with_capacity(n);
    let mut has_descriptive = Vec::with_capacity(n);
    let mut basic_tag_ids = Vec::with_capacity(n);
    let mut excluded_by_missing_vectors = 0usize;

    for item in raw {
        match item {
            Some((id, c, used, desc, basic)) => {
                media_ids.push(id);
                centroids.push(c);
                contributing_counts.push(used);
                has_descriptive.push(desc);
                basic_tag_ids.push(basic);
            }
            None => excluded_by_missing_vectors += 1,
        }
    }

    // centering: 全重心の平均（= ライブラリの中心）を引いてから再正規化する。
    // これが無いとタグ本数の多いメディアほど中心に寄り、誰とでも似ている「ハブ」になる。
    if cfg.centering && !centroids.is_empty() && dim > 0 {
        let mut mean = vec![0f32; dim];
        for c in &centroids {
            for (m, x) in mean.iter_mut().zip(c) {
                *m += x;
            }
        }
        let inv = 1.0 / centroids.len() as f32;
        for m in mean.iter_mut() {
            *m *= inv;
        }

        // 中心と一致した重心は引くと零ベクトルになる。方向が定義できないので落とす。
        let kept: Vec<bool> = centroids
            .par_iter_mut()
            .map(|c| {
                for (x, m) in c.iter_mut().zip(&mean) {
                    *x -= m;
                }
                l2_normalize(c)
            })
            .collect();

        if kept.iter().any(|k| !k) {
            excluded_by_missing_vectors += kept.iter().filter(|k| !**k).count();
            let mut it = kept.iter();
            media_ids.retain(|_| *it.next().unwrap_or(&true));
            let mut it = kept.iter();
            centroids.retain(|_| *it.next().unwrap_or(&true));
            let mut it = kept.iter();
            contributing_counts.retain(|_| *it.next().unwrap_or(&true));
            let mut it = kept.iter();
            has_descriptive.retain(|_| *it.next().unwrap_or(&true));
            let mut it = kept.iter();
            basic_tag_ids.retain(|_| *it.next().unwrap_or(&true));
        }
    }

    // 解析済みメディアのうち、basic タグ不足で候補集合に入れなかった数
    let completed: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM media WHERE analysis_status = 'completed'")
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    let excluded_by_tag_count = (completed as usize).saturating_sub(n);

    Ok(Library {
        media_ids,
        centroids,
        contributing_counts,
        has_descriptive,
        basic_tag_ids,
        dim,
        excluded_by_tag_count,
        excluded_by_missing_vectors,
        load_ms,
        centroid_ms: t1.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// コマンド: 状態取得
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct EmbeddingStatus {
    pub model: String,
    pub model_available: bool,
    pub available_models: Vec<String>,
    pub total_tags: i64,
    pub embedded_tags: i64,
    pub missing_tags: i64,
    pub eligible_media: i64,
    pub excluded_media: i64,
    pub completed_media: i64,
    pub min_basic_tags: usize,
    pub min_candidates: usize,
    pub full_spectrum_min: usize,
    pub include_descriptive: bool,
    pub centering: bool,
}

#[tauri::command]
pub async fn get_embedding_status(db_state: State<'_, DbState>) -> Result<EmbeddingStatus, String> {
    let pool = &db_state.pool;
    let cfg = load_spectrum_config(pool).await;

    let total_tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
        .fetch_one(pool)
        .await
        .map_err(|e| cmd_err("get_embedding_status", e))?;

    let embedded_tags: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM tag_embeddings WHERE model = ?1")
            .bind(&cfg.model)
            .fetch_one(pool)
            .await
            .unwrap_or(0);

    let completed_media: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM media WHERE analysis_status = 'completed'")
            .fetch_one(pool)
            .await
            .unwrap_or(0);

    // basic タグが下限を満たすメディア数。カテゴリは数えない（全メディアが持つため）。
    let eligible_media: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*) FROM (
            SELECT mt.media_id
            FROM media_tags mt
            JOIN tags t ON t.id = mt.tag_id
            JOIN media m ON m.id = mt.media_id
            WHERE m.analysis_status = 'completed'
              AND t.is_category = 0
              AND t.tag_kind = 'basic'
            GROUP BY mt.media_id
            HAVING COUNT(DISTINCT mt.tag_id) >= ?1
        )
        "#,
    )
    .bind(MIN_BASIC_TAGS as i64)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let available_models = crate::batch::fetch_ollama_models(&cfg.ollama_url)
        .await
        .unwrap_or_default();
    // Ollama はタグ名を `name:tag` で持つため、`:latest` 省略表記も一致させる
    let model_available = available_models
        .iter()
        .any(|m| m == &cfg.model || m.trim_end_matches(":latest") == cfg.model);

    Ok(EmbeddingStatus {
        model: cfg.model,
        model_available,
        available_models,
        total_tags,
        embedded_tags,
        missing_tags: (total_tags - embedded_tags).max(0),
        eligible_media,
        excluded_media: (completed_media - eligible_media).max(0),
        completed_media,
        min_basic_tags: MIN_BASIC_TAGS,
        min_candidates: MIN_CANDIDATES,
        full_spectrum_min: FULL_SPECTRUM_MIN,
        include_descriptive: cfg.include_descriptive,
        centering: cfg.centering,
    })
}

// ---------------------------------------------------------------------------
// コマンド: ベクトル生成
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct EmbeddingProgress {
    pub total: usize,
    pub current: usize,
    pub status: String,
}

#[derive(Serialize)]
pub struct GenerateResult {
    pub model: String,
    pub generated: usize,
    pub dim: usize,
    pub elapsed_ms: u64,
}

/// 未ベクトル化タグを一括生成する。
///
/// スキャン・タグマージ提案と同じグローバルロックを取るため、同時実行は自動的に排他される。
#[tauri::command]
pub async fn generate_tag_embeddings(
    app_handle: AppHandle,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<GenerateResult, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    generate_missing_tag_embeddings(&db_state.pool, Some(&app_handle)).await
}

/// 未生成のタグベクトルだけを埋める。**タスクロックは取らない。**
///
/// コマンド版（`generate_tag_embeddings`）と、関連タグ検出のような
/// **既にロックを持っている呼び出し元**の両方から使う。
/// ロックをここで取ると、呼び出し元が持っている場合に自分で自分を弾いてしまう。
///
/// `app_handle` を渡すと進捗イベントを emit する。内部呼び出しでは `None` でよい。
pub async fn generate_missing_tag_embeddings(
    pool: &Pool<Sqlite>,
    app_handle: Option<&AppHandle>,
) -> Result<GenerateResult, String> {
    let cfg = load_spectrum_config(pool).await;
    generate_missing_for(pool, app_handle, &cfg.ollama_url, &cfg.model, None).await
}

/// 指定したモデル・指定した種別のぶんだけ埋め込みを埋める。
///
/// **③ 関連タグは種別ごとに違うモデルを使う**（basic と descriptive で
/// 最良のモデルが違う。実測は計画書 §4）。種別をまたぐ比較をしないので成立する。
/// 逆に概念スペクトラム検索は**種別をまたいでベクトルを平均する**ため
/// （[`build_library`] の重心計算）、1つのモデルで揃っている必要がある。
///
/// `kind` が `None` なら全タグ。`Some("basic")` などで絞る。
pub async fn generate_missing_for(
    pool: &Pool<Sqlite>,
    app_handle: Option<&AppHandle>,
    ollama_url: &str,
    model: &str,
    kind: Option<&str>,
) -> Result<GenerateResult, String> {
    let started = std::time::Instant::now();

    let sql = format!(
        r#"
        SELECT t.id, t.name, t.name_ja
        FROM tags t
        LEFT JOIN tag_embeddings e ON e.tag_id = t.id AND e.model = ?1
        WHERE e.tag_id IS NULL {}
        ORDER BY t.id
        "#,
        if kind.is_some() { "AND t.tag_kind = ?2" } else { "" }
    );
    let mut q = sqlx::query_as::<_, (i64, String, Option<String>)>(&sql).bind(model);
    if let Some(k) = kind {
        q = q.bind(k);
    }
    let pending = q
        .fetch_all(pool)
        .await
        .map_err(|e| cmd_err("generate_tag_embeddings", e))?;

    let total = pending.len();
    if total == 0 {
        return Ok(GenerateResult {
            model: model.to_string(),
            generated: 0,
            dim: 0,
            elapsed_ms: 0,
        });
    }

    // 埋め込みは1件あたりは速いが、初回はモデルのロードで数十秒かかることがある
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| cmd_err("generate_tag_embeddings", e))?;

    let mut generated = 0usize;
    let mut dim = 0usize;

    for chunk in pending.chunks(EMBED_BATCH_SIZE) {
        if let Some(h) = app_handle {
            let _ = h.emit(
                "embedding_progress",
                EmbeddingProgress { total, current: generated, status: "running".to_string() },
            );
        }

        let texts: Vec<String> = chunk
            .iter()
            .map(|(_, name, name_ja)| embedding_text(name, name_ja.as_deref()))
            .collect();

        let vectors = match fetch_embeddings(&client, ollama_url, model, &texts).await {
            Ok(v) => v,
            Err(e) => {
                if let Some(h) = app_handle {
                    let _ = h.emit(
                        "embedding_progress",
                        EmbeddingProgress { total, current: generated, status: "error".to_string() },
                    );
                }
                let _ = crate::batch::unload_ollama_model(ollama_url, model).await;
                return Err(cmd_err("generate_tag_embeddings", e));
            }
        };

        for ((tag_id, _, _), mut v) in chunk.iter().zip(vectors) {
            // 保存前に正規化しておく。ノルムが 0 のベクトルは保存しても使えないので捨てる。
            if !l2_normalize(&mut v) {
                continue;
            }
            dim = v.len();
            let res = sqlx::query(
                "INSERT INTO tag_embeddings (tag_id, model, dim, vector) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(tag_id, model) DO UPDATE SET dim = ?3, vector = ?4",
            )
            .bind(tag_id)
            .bind(model)
            .bind(v.len() as i64)
            .bind(to_blob(&v))
            .execute(pool)
            .await;
            if res.is_ok() {
                generated += 1;
            }
        }
    }

    // 生成後は VRAM を解放する（タグマージ提案と同じ後始末）
    let _ = crate::batch::unload_ollama_model(ollama_url, model).await;

    if let Some(h) = app_handle {
        let _ = h.emit(
            "embedding_progress",
            EmbeddingProgress { total, current: generated, status: "done".to_string() },
        );
    }

    Ok(GenerateResult {
        model: model.to_string(),
        generated,
        dim,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// コマンド: 類似メディア検索
// ---------------------------------------------------------------------------

/// 類似メディア1件。
///
/// `MediaItem` を丸ごと返すのは3つの理由から。
/// 1. 類似メディアが現在のフィルタ結果に含まれているとは限らず、画面側が id から解決できない
/// 2. **「タグの類似度」と表示するならタグを見せなければ検証できない**
/// 3. カードのクリックでメディア詳細を開くのに、詳細画面が要求する形がそのまま必要
#[derive(Serialize)]
pub struct SimilarItem {
    pub media_id: i64,
    pub similarity: f32,
    pub media: crate::commands::MediaItem,
}

/// 指定した id のメディアを `MediaItem` として読み出す（タグ・カテゴリ込み）。
/// `get_media` のタグ一括取得と同じ組み立て方をしている。
async fn load_media_items(
    pool: &Pool<Sqlite>,
    ids: &[i64],
) -> Result<HashMap<i64, crate::commands::MediaItem>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_str = ids.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");

    let rows = sqlx::query_as::<_, (i64, String, String, String, i64, String, Option<String>)>(&format!(
        "SELECT id, file_path, parent_folder, thumbnail_path, file_size, analysis_status, analysis_error
         FROM media WHERE id IN ({})",
        ids_str
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let tag_rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(&format!(
        "SELECT mt.media_id, t.name, t.name_ja, t.is_category, t.tag_kind
         FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.media_id IN ({})",
        ids_str
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut tags_map: HashMap<i64, (Vec<String>, Vec<crate::commands::TagPairItem>)> = HashMap::new();
    for (m_id, name, name_ja, is_cat, kind) in tag_rows {
        let entry = tags_map.entry(m_id).or_insert_with(|| (Vec::new(), Vec::new()));
        if is_cat == 1 {
            entry.0.push(name);
        } else {
            entry.1.push(crate::commands::TagPairItem { name, name_ja, kind });
        }
    }

    Ok(rows
        .into_iter()
        .map(|(id, file_path, parent_folder, thumbnail_path, file_size, analysis_status, analysis_error)| {
            let (categories, tags) = tags_map.remove(&id).unwrap_or((Vec::new(), Vec::new()));
            (
                id,
                crate::commands::MediaItem {
                    id,
                    file_path,
                    parent_folder,
                    thumbnail_path,
                    file_size,
                    analysis_status,
                    analysis_error,
                    categories,
                    tags,
                },
            )
        })
        .collect())
}

/// スペクトラムの1ゾーン。
///
/// `band_size` を返すのは、引き直し（🎲）に意味があるかを画面側が判断できるようにするため。
/// 帯が `items` と同じ大きさなら、引き直しても同じ顔ぶれしか出ない。
#[derive(Serialize)]
pub struct Zone {
    /// `similar` / `middle` / `distant`
    pub key: String,
    pub band_size: usize,
    pub items: Vec<SimilarItem>,
}

#[derive(Serialize)]
pub struct SpectrumResult {
    /// `ok` / `degraded` / `not_enough_candidates` / `base_not_eligible` / `no_embeddings`
    pub status: String,
    pub base_media_id: i64,
    /// 基準メディア。何と比べているのかを画面上でプレビューできるようにするため返す
    pub base_media: Option<crate::commands::MediaItem>,
    pub model: String,
    pub zones: Vec<Zone>,
    /// このレスポンスを生成したシード。引き直し前の状態を再現したいときに使う。
    pub seed: u64,
    /// 基準メディアから見た全候補の実測レンジ。0〜1固定軸の凡例に線分として描く。
    pub range_min: f32,
    pub range_mean: f32,
    pub range_max: f32,
    pub candidate_count: usize,
    pub excluded_media: usize,
    /// 基準と `basic` タグを共有するため候補から外した件数。
    /// 除外はこの機能の要（タグ検索で到達できるものを出さない）なので、件数を隠さず開示する。
    pub shared_tag_excluded: usize,
    pub centering: bool,
    pub include_descriptive: bool,
    pub elapsed_ms: u64,
}

fn empty_result(status: &str, base_media_id: i64, cfg: &SpectrumConfig, lib: Option<&Library>) -> SpectrumResult {
    SpectrumResult {
        status: status.to_string(),
        base_media_id,
        base_media: None,
        model: cfg.model.clone(),
        zones: Vec::new(),
        seed: 0,
        range_min: 0.0,
        range_mean: 0.0,
        range_max: 0.0,
        candidate_count: lib.map(|l| l.media_ids.len()).unwrap_or(0),
        excluded_media: lib
            .map(|l| l.excluded_by_tag_count + l.excluded_by_missing_vectors)
            .unwrap_or(0),
        shared_tag_excluded: 0,
        centering: cfg.centering,
        include_descriptive: cfg.include_descriptive,
        elapsed_ms: 0,
    }
}

/// 基準メディアに対する類似度を全候補について算出し、3ゾーンに切って返す。
///
/// `seed` を渡すと抽出が決定的になる。「🎲 引き直し」は新しいシードで呼び直すこと。
#[tauri::command]
pub async fn find_similar_media(
    base_media_id: i64,
    seed: Option<u64>,
    db_state: State<'_, DbState>,
) -> Result<SpectrumResult, String> {
    let pool = &db_state.pool;
    let cfg = load_spectrum_config(pool).await;
    let started = std::time::Instant::now();

    let lib = build_library(pool, &cfg).await?;

    if lib.dim == 0 || lib.centroids.is_empty() {
        return Ok(empty_result("no_embeddings", base_media_id, &cfg, Some(&lib)));
    }

    let Some(base_idx) = lib.index_of(base_media_id) else {
        return Ok(empty_result("base_not_eligible", base_media_id, &cfg, Some(&lib)));
    };

    // 基準と `basic` タグを1つでも共有する候補は、タグ検索で到達できるので候補から外す。
    //
    // これが無いと上位ゾーンが近似重複で埋まり、この機能はタグ検索の劣化版になる。
    // 実測（bge-m3 / 1,007 件 / 基準 30 件 / tools/embedding-check/lexical-overlap.mjs）:
    // 上位 8 件のうちタグを共有しない割合は 23% しかなく、1 位は平均 2.5 本を共有していた。
    // この除外で 100% になり、除外されるのは候補の 9%（最悪 18%）だけ。
    //
    // 「共有タグを外してから重心を作り直す」案も測ったが不利だった。共有が 0 の候補では
    // 現行指標と数学的に一致し（省くものが無い）、部分的に重なった候補にしか効かない。
    // しかも残差が語形の違い（`スノーボーダー` 対 `スノーボード`）だと近似重複が 1 位に残る。
    let shared_tag_excluded = (0..lib.centroids.len())
        .filter(|&i| i != base_idx && lib.shares_basic_tag(base_idx, i))
        .count();

    // 候補は基準メディア自身と、タグを共有する分を除いた数で数える
    let candidate_count = lib.media_ids.len() - 1 - shared_tag_excluded;
    if candidate_count < MIN_CANDIDATES {
        let mut r = empty_result("not_enough_candidates", base_media_id, &cfg, Some(&lib));
        r.candidate_count = candidate_count;
        r.shared_tag_excluded = shared_tag_excluded;
        return Ok(r);
    }

    let base = &lib.centroids[base_idx];
    let mut scored: Vec<(i64, f32)> = lib
        .centroids
        .par_iter()
        .enumerate()
        .filter(|(i, _)| *i != base_idx && !lib.shares_basic_tag(base_idx, *i))
        .map(|(i, c)| (lib.media_ids[i], dot(base, c)))
        .collect();

    // レンジ凡例は上位だけでなく**全候補**から取る。これが分布の広がりそのものになる。
    let sum: f32 = scored.iter().map(|s| s.1).sum();
    let range_mean = sum / scored.len() as f32;
    let range_min = scored.iter().map(|s| s.1).fold(f32::INFINITY, f32::min);
    let range_max = scored.iter().map(|s| s.1).fold(f32::NEG_INFINITY, f32::max);

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // 候補が少ないうちは3ゾーンに切らず、類似上位のみの縮退モードにする。
    // 帯を無理に3つ取ると中位・下位がほぼ同じ顔ぶれになり、分かれている風に見えて実質嘘になる。
    let degraded = candidate_count < FULL_SPECTRUM_MIN;
    let bands: Vec<(&str, (usize, usize))> = if degraded {
        vec![("similar", (0, ZONE_SIZE.min(candidate_count)))]
    } else {
        let b = zone_bands(candidate_count);
        vec![("similar", b[0]), ("middle", b[1]), ("distant", b[2])]
    };

    let seed = seed.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0)
    });
    let mut rng = SplitMix64(seed);

    // 帯から ZONE_SIZE 件を無作為抽出し、帯内は類似度降順で並べる
    let picked: Vec<(&str, usize, Vec<(i64, f32)>)> = bands
        .iter()
        .map(|(key, (start, end))| {
            let slice = &scored[*start..*end];
            let mut idx = sample_indices(slice.len(), ZONE_SIZE, &mut rng);
            idx.sort_unstable();
            let items: Vec<(i64, f32)> = idx.into_iter().map(|i| slice[i]).collect();
            (*key, slice.len(), items)
        })
        .collect();

    // 選ばれた分と基準メディアを、タグ込みでまとめて引く
    let mut ids: Vec<i64> = picked
        .iter()
        .flat_map(|(_, _, items)| items.iter().map(|(id, _)| *id))
        .collect();
    ids.push(base_media_id);
    let mut loaded = load_media_items(pool, &ids)
        .await
        .map_err(|e| cmd_err("find_similar_media", e))?;
    let base_media = loaded.get(&base_media_id).cloned();

    let zones: Vec<Zone> = picked
        .into_iter()
        .map(|(key, band_size, items)| Zone {
            key: key.to_string(),
            band_size,
            items: items
                .into_iter()
                .filter_map(|(media_id, similarity)| {
                    // 直前に削除された等でメディアが引けない場合は落とす。
                    // 空のカードを出すより、出さないほうが誠実
                    let media = loaded.remove(&media_id)?;
                    Some(SimilarItem { media_id, similarity, media })
                })
                .collect(),
        })
        .collect();

    Ok(SpectrumResult {
        status: if degraded { "degraded" } else { "ok" }.to_string(),
        base_media_id,
        base_media,
        model: cfg.model.clone(),
        zones,
        seed,
        range_min,
        range_mean,
        range_max,
        candidate_count,
        excluded_media: lib.excluded_by_tag_count + lib.excluded_by_missing_vectors,
        shared_tag_excluded,
        centering: cfg.centering,
        include_descriptive: cfg.include_descriptive,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// コマンド: 保存領域の管理
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct EmbeddingModelStorage {
    pub model: String,
    pub tag_count: i64,
    pub dim: i64,
    pub bytes: i64,
    /// 現在の設定で使われているモデルか。これだけは GC の対象外。
    pub in_use: bool,
}

#[derive(Serialize)]
pub struct EmbeddingStorageInfo {
    pub current_model: String,
    pub total_tags: i64,
    pub models: Vec<EmbeddingModelStorage>,
    /// 使用中でないモデルを削除したときに解放される容量
    pub reclaimable_bytes: i64,
}

/// 現在どのモデルのベクトルが使われているか。**1つとは限らない。**
///
/// 概念スペクトラム検索は1モデル（種別をまたいで重心を取るため揃っている必要がある）、
/// ③ 関連タグは種別ごとに別モデル。ここを1つだと思って扱うと、
/// **使用中のベクトルを「未使用」として削除できてしまう**（再生成が要る）。
pub async fn models_in_use(pool: &Pool<Sqlite>) -> Vec<String> {
    let related = crate::tag_organize::RelatedConfig::load(pool).await;
    let mut v = vec![
        load_spectrum_config(pool).await.model,
        related.basic_model,
        related.descriptive_model,
    ];
    v.sort();
    v.dedup();
    v
}

/// モデル別のベクトル保有状況を返す。
#[tauri::command]
pub async fn get_embedding_storage_info(
    db_state: State<'_, DbState>,
) -> Result<EmbeddingStorageInfo, String> {
    let pool = &db_state.pool;
    let cfg = load_spectrum_config(pool).await;
    let in_use = models_in_use(pool).await;

    let total_tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
        .fetch_one(pool)
        .await
        .unwrap_or(0);

    let rows = sqlx::query_as::<_, (String, i64, i64, i64)>(
        "SELECT model, COUNT(*), COALESCE(MAX(dim), 0), COALESCE(SUM(LENGTH(vector)), 0)
         FROM tag_embeddings GROUP BY model ORDER BY model",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| cmd_err("get_embedding_storage_info", e))?;

    let models: Vec<EmbeddingModelStorage> = rows
        .into_iter()
        .map(|(model, tag_count, dim, bytes)| EmbeddingModelStorage {
            in_use: in_use.contains(&model),
            model,
            tag_count,
            dim,
            bytes,
        })
        .collect();

    let reclaimable_bytes = models.iter().filter(|m| !m.in_use).map(|m| m.bytes).sum();

    Ok(EmbeddingStorageInfo {
        current_model: cfg.model,
        total_tags,
        models,
        reclaimable_bytes,
    })
}

#[derive(Serialize)]
pub struct CleanupResult {
    pub deleted_rows: u64,
    pub freed_bytes: i64,
    pub vacuumed: bool,
}

/// 使用中でないモデルのベクトルを削除する。
///
/// **自動 GC は実装しない。** 「モデルを戻せば以前の類似度が復元される」と学習した直後に
/// 黙って消えるとユーザーの期待を裏切るため、削除は常に明示操作とする。
#[tauri::command]
pub async fn cleanup_unused_embeddings(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<CleanupResult, String> {
    // 削除中に重心算出やベクトル生成が走らないよう、他の処理と同じロックを取る
    let _guard = try_acquire_task_lock(&scan_state)?;
    let pool = &db_state.pool;
    // **使用中は1つとは限らない。** ③ が種別ごとに別モデルを使うので、
    // スペクトラム検索のモデルだけを残すと ③ のベクトルが消えて再生成になる
    let keep = models_in_use(pool).await;
    let placeholders = keep.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let size_sql = format!(
        "SELECT COALESCE(SUM(LENGTH(vector)), 0) FROM tag_embeddings WHERE model NOT IN ({})",
        placeholders
    );
    let delete_sql = format!(
        "DELETE FROM tag_embeddings WHERE model NOT IN ({})",
        placeholders
    );

    let mut q = sqlx::query_scalar::<_, i64>(&size_sql);
    for m in &keep {
        q = q.bind(m);
    }
    let freed_bytes: i64 = q.fetch_one(pool).await.unwrap_or(0);

    let mut d = sqlx::query(&delete_sql);
    for m in &keep {
        d = d.bind(m);
    }
    let deleted = d
        .execute(pool)
        .await
        .map_err(|e| cmd_err("cleanup_unused_embeddings", e))?
        .rows_affected();

    // DELETE だけではファイルは縮まない。数十MB単位の BLOB を消す操作なので、
    // 「解放された」と表示する以上は実際にディスクを返す。
    // 明示操作のときしか走らないため、VACUUM の重さは許容できる。
    let vacuumed = deleted > 0
        && sqlx::query("VACUUM;").execute(pool).await.is_ok();

    Ok(CleanupResult { deleted_rows: deleted, freed_bytes, vacuumed })
}

/// 指定モデル（省略時は使用中のモデル）のベクトルを破棄する。
///
/// `cleanup_unused_embeddings` は**使用中以外**を消すので、使用中のものを作り直す手段が無かった。
/// 埋め込みモデルを差し替えて同じ名前で配布し直された場合や、生成が途中で失敗して
/// 中途半端に入っている場合に、明示的にやり直せる経路が必要になる。
///
/// 破棄後は「未生成のタグをベクトル化」で作り直す。
#[tauri::command]
pub async fn discard_embeddings(
    model: Option<String>,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<CleanupResult, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    let pool = &db_state.pool;
    let target = match model {
        Some(m) => m,
        None => load_spectrum_config(pool).await.model,
    };

    let freed_bytes: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(LENGTH(vector)), 0) FROM tag_embeddings WHERE model = ?1",
    )
    .bind(&target)
    .fetch_one(pool)
    .await
    .unwrap_or(0);

    let deleted = sqlx::query("DELETE FROM tag_embeddings WHERE model = ?1")
        .bind(&target)
        .execute(pool)
        .await
        .map_err(|e| cmd_err("discard_embeddings", e))?
        .rows_affected();

    let vacuumed = deleted > 0 && sqlx::query("VACUUM;").execute(pool).await.is_ok();

    Ok(CleanupResult { deleted_rows: deleted, freed_bytes, vacuumed })
}

// ---------------------------------------------------------------------------
// コマンド: 診断（設計値を確定するための実測）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct HistogramBin {
    pub lower: f32,
    pub upper: f32,
    pub count: usize,
}

#[derive(Serialize)]
pub struct EmbeddingDiagnostics {
    pub model: String,
    pub dim: usize,
    pub centering: bool,
    pub include_descriptive: bool,
    pub eligible_media: usize,
    pub excluded_by_tag_count: usize,
    pub excluded_by_missing_vectors: usize,
    pub sample_size: usize,
    pub pair_count: usize,
    pub sim_min: f32,
    pub sim_mean: f32,
    pub sim_max: f32,
    pub sim_stddev: f32,
    /// 固定軸 [-1, 1] を 0.1 刻みで 20 分割。モデル間で直接比較できるよう軸は動かさない。
    pub histogram: Vec<HistogramBin>,
    /// タグ本数と平均類似度のピアソン相関。ハブ化が起きているかの直接指標。
    pub tagcount_similarity_corr: f32,
    /// descriptive 保有群 / 非保有群の群内・群間平均類似度。群分離の直接指標。
    pub desc_group_size: usize,
    pub nondesc_group_size: usize,
    pub desc_intra_mean: Option<f32>,
    pub nondesc_intra_mean: Option<f32>,
    pub inter_group_mean: Option<f32>,
    pub load_ms: u64,
    pub centroid_ms: u64,
    pub pairwise_ms: u64,
}

fn pearson(xs: &[f32], ys: &[f32]) -> f32 {
    let n = xs.len();
    if n < 2 {
        return 0.0;
    }
    let mx = xs.iter().sum::<f32>() / n as f32;
    let my = ys.iter().sum::<f32>() / n as f32;
    let mut num = 0f32;
    let mut dx = 0f32;
    let mut dy = 0f32;
    for (x, y) in xs.iter().zip(ys) {
        let a = x - mx;
        let b = y - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    let den = (dx * dy).sqrt();
    if den <= f32::EPSILON {
        0.0
    } else {
        num / den
    }
}

/// 類似度分布・ハブ化・群分離を実測する。各対策の要否を決めるための計測。
///
/// `centering` / `include_descriptive` を渡すと、**保存済みの設定を上書きして**測る。
/// 画面上のトグルをその場で反映するために必要。これが無いと、トグルを切り替えても
/// 保存するまで古い設定で測ってしまい、「切り替えが効かない」ように見える。
///
/// この2つは**タグのベクトルに影響しない**（重心を組み立てるときのオプション）。
/// したがって切り替えても再ベクトル化は要らず、その場で測り直せる。
#[tauri::command]
pub async fn get_embedding_diagnostics(
    centering: Option<bool>,
    include_descriptive: Option<bool>,
    db_state: State<'_, DbState>,
) -> Result<EmbeddingDiagnostics, String> {
    let pool = &db_state.pool;
    let mut cfg = load_spectrum_config(pool).await;
    if let Some(v) = centering {
        cfg.centering = v;
    }
    if let Some(v) = include_descriptive {
        cfg.include_descriptive = v;
    }
    let lib = build_library(pool, &cfg).await?;
    compute_diagnostics(&lib, &cfg)
}

/// 診断の実体。コマンドから切り離してあるのは、計測（`#[ignore]` テスト）が
/// **本番と同じコード**を通れるようにするため。
pub fn compute_diagnostics(lib: &Library, cfg: &SpectrumConfig) -> Result<EmbeddingDiagnostics, String> {
    let n = lib.centroids.len();
    if n < 2 || lib.dim == 0 {
        return Err(
            "診断に必要な件数のメディアがありません。タグのベクトル化を先に実行してください。".to_string(),
        );
    }

    // 総当りは O(N^2) なので等間隔サンプリングで上限を掛ける。
    // 等間隔にするのは、実行のたびに標本が変わって結果がぶれるのを避けるため。
    let step = ((n + DIAGNOSTICS_SAMPLE_CAP - 1) / DIAGNOSTICS_SAMPLE_CAP).max(1);
    let idx: Vec<usize> = (0..n).step_by(step).collect();
    let m = idx.len();

    let t = std::time::Instant::now();
    // 各標本について、他の全標本との類似度を出す
    let rows: Vec<Vec<f32>> = idx
        .par_iter()
        .map(|&i| {
            idx.iter()
                .filter(|&&j| j != i)
                .map(|&j| dot(&lib.centroids[i], &lib.centroids[j]))
                .collect()
        })
        .collect();
    let pairwise_ms = t.elapsed().as_millis() as u64;

    let mut all: Vec<f32> = Vec::with_capacity(m * m);
    for r in &rows {
        all.extend_from_slice(r);
    }
    let pair_count = all.len() / 2; // 各ペアが2回現れる

    let sim_mean = all.iter().sum::<f32>() / all.len() as f32;
    let sim_min = all.iter().copied().fold(f32::INFINITY, f32::min);
    let sim_max = all.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let var = all.iter().map(|x| (x - sim_mean).powi(2)).sum::<f32>() / all.len() as f32;

    let mut histogram: Vec<HistogramBin> = (0..20)
        .map(|b| HistogramBin {
            lower: -1.0 + b as f32 * 0.1,
            upper: -1.0 + (b + 1) as f32 * 0.1,
            count: 0,
        })
        .collect();
    for x in &all {
        let b = (((x + 1.0) / 0.1).floor() as isize).clamp(0, 19) as usize;
        histogram[b].count += 1;
    }

    // ハブ化: タグ本数 vs その標本の平均類似度
    let tag_counts: Vec<f32> = idx.iter().map(|&i| lib.contributing_counts[i] as f32).collect();
    let mean_sims: Vec<f32> = rows.iter().map(|r| r.iter().sum::<f32>() / r.len() as f32).collect();
    let tagcount_similarity_corr = pearson(&tag_counts, &mean_sims);

    // 群分離: descriptive 保有 / 非保有
    let mut desc_intra = (0f32, 0usize);
    let mut nondesc_intra = (0f32, 0usize);
    let mut inter = (0f32, 0usize);
    for (a, &i) in idx.iter().enumerate() {
        for &j in idx.iter().skip(a + 1) {
            let s = dot(&lib.centroids[i], &lib.centroids[j]);
            match (lib.has_descriptive[i], lib.has_descriptive[j]) {
                (true, true) => {
                    desc_intra.0 += s;
                    desc_intra.1 += 1;
                }
                (false, false) => {
                    nondesc_intra.0 += s;
                    nondesc_intra.1 += 1;
                }
                _ => {
                    inter.0 += s;
                    inter.1 += 1;
                }
            }
        }
    }
    let avg = |(sum, cnt): (f32, usize)| if cnt == 0 { None } else { Some(sum / cnt as f32) };

    Ok(EmbeddingDiagnostics {
        model: cfg.model.clone(),
        dim: lib.dim,
        centering: cfg.centering,
        include_descriptive: cfg.include_descriptive,
        eligible_media: n,
        excluded_by_tag_count: lib.excluded_by_tag_count,
        excluded_by_missing_vectors: lib.excluded_by_missing_vectors,
        sample_size: m,
        pair_count,
        sim_min,
        sim_mean,
        sim_max,
        sim_stddev: var.sqrt(),
        histogram,
        tagcount_similarity_corr,
        desc_group_size: idx.iter().filter(|&&i| lib.has_descriptive[i]).count(),
        nondesc_group_size: idx.iter().filter(|&&i| !lib.has_descriptive[i]).count(),
        desc_intra_mean: avg(desc_intra),
        nondesc_intra_mean: avg(nondesc_intra),
        inter_group_mean: avg(inter),
        load_ms: lib.load_ms,
        centroid_ms: lib.centroid_ms,
        pairwise_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip_preserves_values() {
        let v = vec![0.0f32, 1.0, -0.5, 3.4028235e38, f32::MIN_POSITIVE];
        assert_eq!(from_blob(&to_blob(&v)), v);
    }

    #[test]
    fn l2_normalize_makes_unit_vector() {
        let mut v = vec![3.0f32, 4.0];
        assert!(l2_normalize(&mut v));
        assert!((v.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
    }

    #[test]
    fn l2_normalize_rejects_zero_vector() {
        // 零ベクトルは方向が未定義。正規化して NaN を撒くのではなく拒否する。
        let mut v = vec![0.0f32; 8];
        assert!(!l2_normalize(&mut v));
        assert_eq!(v, vec![0.0f32; 8]);
    }

    #[test]
    fn dot_of_identical_unit_vectors_is_one() {
        let mut a = vec![1.0f32, 2.0, 3.0];
        l2_normalize(&mut a);
        assert!((dot(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn embedding_text_prefers_japanese_name() {
        // 英語名は normalize_tag_en が壊していることがある（lens -> len）ので
        // name_ja があるときは必ずそちらを使う
        assert_eq!(embedding_text("len", Some("レンズ")), "レンズ");
        assert_eq!(embedding_text("len", Some("  レンズ  ")), "レンズ");
    }

    #[test]
    fn embedding_text_falls_back_to_english_with_underscores_expanded() {
        assert_eq!(embedding_text("rain_soaked_tree", None), "rain soaked tree");
        assert_eq!(embedding_text("cat", Some("")), "cat");
        assert_eq!(embedding_text("cat", Some("   ")), "cat");
    }

    #[test]
    fn pearson_detects_perfect_correlation() {
        let xs = vec![1.0f32, 2.0, 3.0, 4.0];
        assert!((pearson(&xs, &[2.0, 4.0, 6.0, 8.0]) - 1.0).abs() < 1e-5);
        assert!((pearson(&xs, &[8.0, 6.0, 4.0, 2.0]) + 1.0).abs() < 1e-5);
    }

    #[test]
    fn zone_bands_never_overlap_at_the_activation_threshold() {
        // N=20 は3ゾーン表示に切り替わる最小値。ここで帯が重なると
        // 同じメディアが「似ている」と「似ていない」の両方に出る。
        let [a, b, c] = zone_bands(FULL_SPECTRUM_MIN);
        assert!(a.1 <= b.0, "Zone1 {:?} と Zone2 {:?} が重なっている", a, b);
        assert!(b.1 <= c.0, "Zone2 {:?} と Zone3 {:?} が重なっている", b, c);
    }

    #[test]
    fn zone_bands_stay_in_range_and_keep_full_width() {
        for n in FULL_SPECTRUM_MIN..600 {
            let bands = zone_bands(n);
            for (start, end) in bands {
                assert!(start < end, "n={} で空の帯 {:?}", n, (start, end));
                assert!(end <= n, "n={} で範囲外の帯 {:?}", n, (start, end));
                // 帯が ZONE_SIZE を下回ると、抽出しても常に同じ顔ぶれになり
                // 引き直しが機能しなくなる
                assert!(end - start >= ZONE_SIZE, "n={} で帯が狭すぎる {:?}", n, (start, end));
            }
            assert_eq!(bands[2].1, n, "n={} で最下位が帯に入っていない", n);
        }
    }

    #[test]
    fn zone_bands_widen_then_stop_widening() {
        // ライブラリが育つほど帯が広がり、引き直しの多様性が増える。
        // ただし上限で止まること。止めないと上位帯の下端が平均 +1.34σ まで降りてきて、
        // 「タグの類似度が高い」枠が実質「平均より少し上」を出す（ZONE_BAND_MAX の実測表）
        let width = |n: usize| { let b = zone_bands(n); b[0].1 - b[0].0 };
        assert_eq!(width(20), ZONE_SIZE);
        assert_eq!(width(60), 6);
        assert_eq!(width(100), ZONE_BAND_MAX);
        assert_eq!(width(1000), ZONE_BAND_MAX, "候補が増えても帯は広げない");
    }

    /// `shares_basic_tag` の検証だけに使う最小のライブラリ
    fn lib_with_basic_tags(sets: &[&[i64]]) -> Library {
        Library {
            media_ids: (0..sets.len() as i64).collect(),
            centroids: vec![vec![1.0]; sets.len()],
            contributing_counts: vec![0; sets.len()],
            has_descriptive: vec![false; sets.len()],
            basic_tag_ids: sets.iter().map(|s| s.to_vec()).collect(),
            dim: 1,
            excluded_by_tag_count: 0,
            excluded_by_missing_vectors: 0,
            load_ms: 0,
            centroid_ms: 0,
        }
    }

    #[test]
    fn shares_basic_tag_detects_any_single_overlap() {
        // タグを1つでも共有する候補はタグ検索で到達できるので、候補から外す判定
        let lib = lib_with_basic_tags(&[
            &[10, 20, 30], // 基準
            &[40, 50],     // 共有なし
            &[30, 40],     // 末尾で共有
            &[5, 10],      // 先頭で共有
            &[],           // 空（タグ不足で候補に入らないが、判定は落ちないこと）
        ]);
        assert!(!lib.shares_basic_tag(0, 1));
        assert!(lib.shares_basic_tag(0, 2));
        assert!(lib.shares_basic_tag(0, 3));
        assert!(!lib.shares_basic_tag(0, 4));
        // 対称であること。片方向だけ真だと候補数と除外数が食い違う
        assert!(lib.shares_basic_tag(2, 0));
    }

    #[test]
    fn sampling_is_deterministic_for_a_given_seed() {
        // シードを引数で受ける設計の要。同じシードで同じ結果にならないと
        // 「引き直し前に戻す」も再現調査もできない。
        let pick = |seed: u64| sample_indices(50, ZONE_SIZE, &mut SplitMix64(seed));
        assert_eq!(pick(42), pick(42));
        assert_ne!(pick(42), pick(43));
    }

    #[test]
    fn sampling_returns_distinct_indices_within_range() {
        for seed in 0..64u64 {
            let picked = sample_indices(10, ZONE_SIZE, &mut SplitMix64(seed));
            assert_eq!(picked.len(), ZONE_SIZE);
            assert!(picked.iter().all(|&i| i < 10));
            let uniq: HashSet<usize> = picked.iter().copied().collect();
            assert_eq!(uniq.len(), picked.len(), "重複した添字: {:?}", picked);
        }
    }

    #[test]
    fn sampling_caps_at_the_pool_size() {
        // 帯が ZONE_SIZE より小さいときに落ちたり水増ししたりしないこと
        assert_eq!(sample_indices(2, ZONE_SIZE, &mut SplitMix64(1)).len(), 2);
        assert_eq!(sample_indices(0, ZONE_SIZE, &mut SplitMix64(1)).len(), 0);
    }

    #[test]
    fn pearson_returns_zero_for_constant_input() {
        // 分散 0 で 0 除算になる経路。NaN を返してはならない。
        let r = pearson(&[1.0, 1.0, 1.0], &[1.0, 2.0, 3.0]);
        assert!(r.is_finite());
        assert_eq!(r, 0.0);
    }

    /// インメモリDBを1つ用意する（Tauri の State を経由せず純粋なSQLとして検証する）
    async fn storage_test_pool() -> Pool<Sqlite> {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE tag_embeddings (tag_id INTEGER NOT NULL, model TEXT NOT NULL,
             dim INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (tag_id, model))",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (tag_id, model, bytes) in [(1i64, "in-use", 8usize), (2, "in-use", 8), (3, "old", 16)] {
            sqlx::query("INSERT INTO tag_embeddings (tag_id, model, dim, vector) VALUES (?1,?2,?3,?4)")
                .bind(tag_id)
                .bind(model)
                .bind(bytes as i64 / 4)
                .bind(vec![0u8; bytes])
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn cleanup_removes_only_models_not_in_use() {
        // 「モデルを戻せば復元される」と案内している以上、使用中のモデルを
        // 巻き込んで消してはならない
        let pool = storage_test_pool().await;
        let deleted = sqlx::query("DELETE FROM tag_embeddings WHERE model != ?1")
            .bind("in-use")
            .execute(&pool)
            .await
            .unwrap()
            .rows_affected();
        assert_eq!(deleted, 1);

        let remaining: Vec<String> =
            sqlx::query_scalar("SELECT DISTINCT model FROM tag_embeddings")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, vec!["in-use".to_string()]);
    }

    /// **使用中のモデルは1つとは限らない。**
    /// ③ 関連タグが種別ごとに別モデルを使うので、スペクトラム検索のモデルだけを
    /// 残す実装だと ③ のベクトルが毎回消えて作り直しになる。
    #[tokio::test]
    async fn cleanup_keeps_every_model_in_use() {
        let pool = storage_test_pool().await;
        for (tag_id, model) in [(4i64, "related-basic"), (5, "related-descriptive")] {
            sqlx::query("INSERT INTO tag_embeddings (tag_id, model, dim, vector) VALUES (?1,?2,2,?3)")
                .bind(tag_id)
                .bind(model)
                .bind(vec![0u8; 8])
                .execute(&pool)
                .await
                .unwrap();
        }

        // 本番と同じ組み立て（プレースホルダ数は使用中モデルの数で決まる）
        let keep = ["in-use", "related-basic", "related-descriptive"];
        let placeholders = keep.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "DELETE FROM tag_embeddings WHERE model NOT IN ({})",
            placeholders
        );
        let mut d = sqlx::query(&sql);
        for m in keep {
            d = d.bind(m);
        }
        assert_eq!(d.execute(&pool).await.unwrap().rows_affected(), 1, "old だけ消える");

        let mut remaining: Vec<String> =
            sqlx::query_scalar("SELECT DISTINCT model FROM tag_embeddings")
                .fetch_all(&pool)
                .await
                .unwrap();
        remaining.sort();
        assert_eq!(
            remaining,
            vec!["in-use", "related-basic", "related-descriptive"],
            "③のモデルが巻き込まれない"
        );
    }

    #[tokio::test]
    async fn reclaimable_bytes_counts_only_unused_models() {
        // GC ボタンに実数で出す値なので、使用中の分を含めてはならない
        let pool = storage_test_pool().await;
        let reclaimable: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(LENGTH(vector)), 0) FROM tag_embeddings WHERE model != ?1",
        )
        .bind("in-use")
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reclaimable, 16);
    }

    #[tokio::test]
    async fn storage_rollup_groups_by_model() {
        let pool = storage_test_pool().await;
        let rows = sqlx::query_as::<_, (String, i64, i64, i64)>(
            "SELECT model, COUNT(*), COALESCE(MAX(dim), 0), COALESCE(SUM(LENGTH(vector)), 0)
             FROM tag_embeddings GROUP BY model ORDER BY model",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("in-use".to_string(), 2, 2, 16));
        assert_eq!(rows[1], ("old".to_string(), 1, 4, 16));
    }

    /// 計測用テストの共通前処理。
    ///
    /// スナップショットは計測のたびに作り直されるため、ベクトルは毎回未生成の状態から始まる。
    /// `measure_real_library` と `similar_examples` のどちらを単独で走らせても成立するよう、
    /// 生成処理はここに置いて両方から呼ぶ。本番の `generate_tag_embeddings` と同じ手順。
    async fn ensure_embeddings(pool: &Pool<Sqlite>, model: &str, url: &str) -> usize {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS tag_embeddings (
                tag_id INTEGER NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL,
                vector BLOB NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')),
                PRIMARY KEY (tag_id, model))",
        )
        .execute(pool)
        .await
        .unwrap();

        let pending = sqlx::query_as::<_, (i64, String, Option<String>)>(
            "SELECT t.id, t.name, t.name_ja FROM tags t
             LEFT JOIN tag_embeddings e ON e.tag_id = t.id AND e.model = ?1
             WHERE e.tag_id IS NULL ORDER BY t.id",
        )
        .bind(model)
        .fetch_all(pool)
        .await
        .unwrap();

        if pending.is_empty() {
            return 0;
        }

        println!("未生成タグ {} 件をベクトル化します ({})", pending.len(), model);
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .unwrap();
        let started = std::time::Instant::now();
        for chunk in pending.chunks(EMBED_BATCH_SIZE) {
            let texts: Vec<String> = chunk
                .iter()
                .map(|(_, n, ja)| embedding_text(n, ja.as_deref()))
                .collect();
            let vecs = fetch_embeddings(&client, url, model, &texts).await.unwrap();
            for ((id, _, _), mut v) in chunk.iter().zip(vecs) {
                if !l2_normalize(&mut v) {
                    continue;
                }
                sqlx::query(
                    "INSERT INTO tag_embeddings (tag_id, model, dim, vector) VALUES (?1,?2,?3,?4)
                     ON CONFLICT(tag_id, model) DO UPDATE SET dim=?3, vector=?4",
                )
                .bind(id)
                .bind(model)
                .bind(v.len() as i64)
                .bind(to_blob(&v))
                .execute(pool)
                .await
                .unwrap();
            }
        }
        let secs = started.elapsed().as_secs_f32();
        println!(
            "ベクトル化 {} 件 / {:.1} 秒 ({:.1} 件/秒)",
            pending.len(),
            secs,
            pending.len() as f32 / secs.max(0.001)
        );
        pending.len()
    }

    /// 実DBに対する定性確認。分布の数値が良くても結果が無意味ということはあり得るため、
    /// 上位・中位・下位に実際にどのメディアが並ぶかをタグ名付きで目視する。
    ///
    /// ```text
    /// LOMA_MEASURE_DB=... LOMA_MEASURE_MODEL=... \
    ///   cargo test --release similar_examples -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn similar_examples() {
        let Ok(db_path) = std::env::var("LOMA_MEASURE_DB") else {
            eprintln!("LOMA_MEASURE_DB が未設定のためスキップ");
            return;
        };
        let model = std::env::var("LOMA_MEASURE_MODEL").unwrap_or_else(|_| "bge-m3".to_string());
        let url = std::env::var("LOMA_MEASURE_URL")
            .unwrap_or_else(|_| "http://localhost:11434".to_string());
        let centering = std::env::var("LOMA_MEASURE_CENTERING").unwrap_or_else(|_| "true".into()) == "true";

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(4)
                .connect(&format!("sqlite:{}", db_path))
                .await
                .expect("DB を開けません");

            ensure_embeddings(&pool, &model, &url).await;

            let cfg = SpectrumConfig {
                ollama_url: url.clone(),
                model: model.clone(),
                include_descriptive: false,
                centering,
            };
            let lib = build_library(&pool, &cfg).await.unwrap();
            println!("\n=== {} / centering={} / 対象 {} 件 ===", model, centering, lib.media_ids.len());

            // basic タグ名を引く（重心に入っているのと同じ集合）
            async fn tags_of(pool: &Pool<Sqlite>, id: i64) -> String {
                sqlx::query_as::<_, (String,)>(
                    "SELECT COALESCE(t.name_ja, t.name) FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
                     WHERE mt.media_id = ?1 AND t.is_category = 0 AND t.tag_kind = 'basic'",
                )
                .bind(id)
                .fetch_all(pool)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|(s,)| s)
                .collect::<Vec<_>>()
                .join(", ")
            }
            async fn name_of(pool: &Pool<Sqlite>, id: i64) -> String {
                sqlx::query_as::<_, (String,)>("SELECT file_path FROM media WHERE id = ?1")
                    .bind(id)
                    .fetch_one(pool)
                    .await
                    .map(|(p,)| p.rsplit(['/', '\\']).next().unwrap_or("").to_string())
                    .unwrap_or_default()
            }

            // 等間隔に3件を基準として選ぶ
            let n = lib.media_ids.len();
            for base_idx in [0, n / 3, (n * 2) / 3] {
                let base_id = lib.media_ids[base_idx];
                println!("\n■ 基準: {} [{}]", name_of(&pool, base_id).await, tags_of(&pool, base_id).await);

                let mut scored: Vec<(i64, f32)> = (0..n)
                    .filter(|&i| i != base_idx)
                    .map(|i| (lib.media_ids[i], dot(&lib.centroids[base_idx], &lib.centroids[i])))
                    .collect();
                scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());

                for (label, slice) in [
                    ("最も似ている", &scored[0..3]),
                    ("まんなか", &scored[scored.len() / 2..scored.len() / 2 + 3]),
                    ("最も似ていない", &scored[scored.len() - 3..]),
                ] {
                    println!("  [{}]", label);
                    for (id, s) in slice {
                        println!("    {:+.3}  {}  [{}]", s, name_of(&pool, *id).await, tags_of(&pool, *id).await);
                    }
                }
            }
        });
    }

    /// 実DBに対する計測。Phase 1 の目的（§8.3 の未検証前提を潰す）そのもの。
    ///
    /// 通常の `cargo test` では走らない。実行例:
    /// ```text
    /// LOMA_MEASURE_DB=/path/to/copy-of/loma.db \
    /// LOMA_MEASURE_MODEL=qwen3-embedding:8b \
    ///   cargo test --release measure_real_library -- --ignored --nocapture
    /// ```
    ///
    /// **必ず DB のコピーを指すこと。** このテストは `tag_embeddings` に行を書き込む。
    #[test]
    #[ignore]
    fn measure_real_library() {
        let Ok(db_path) = std::env::var("LOMA_MEASURE_DB") else {
            eprintln!("LOMA_MEASURE_DB が未設定のためスキップ");
            return;
        };
        let model = std::env::var("LOMA_MEASURE_MODEL").unwrap_or_else(|_| "bge-m3".to_string());
        let url = std::env::var("LOMA_MEASURE_URL")
            .unwrap_or_else(|_| "http://localhost:11434".to_string());

        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(4)
                .connect(&format!("sqlite:{}", db_path))
                .await
                .expect("DB を開けません");

            println!("\n=== model: {} ===", model);
            ensure_embeddings(&pool, &model, &url).await;

            // centering × descriptive の4条件を実測する
            for centering in [true, false] {
                for include_descriptive in [false, true] {
                    let cfg = SpectrumConfig {
                        ollama_url: url.clone(),
                        model: model.clone(),
                        include_descriptive,
                        centering,
                    };
                    let lib = build_library(&pool, &cfg).await.unwrap();
                    let d = match compute_diagnostics(&lib, &cfg) {
                        Ok(d) => d,
                        Err(e) => {
                            println!("centering={} desc={} -> {}", centering, include_descriptive, e);
                            continue;
                        }
                    };
                    println!(
                        "\n--- centering={} / descriptive={} ---",
                        centering, include_descriptive
                    );
                    println!(
                        "対象 {} 件 (タグ不足で除外 {} / ベクトル無しで除外 {}) / {}次元",
                        d.eligible_media, d.excluded_by_tag_count, d.excluded_by_missing_vectors, d.dim
                    );
                    println!(
                        "類似度  min {:.4} / mean {:.4} / max {:.4} / sd {:.4}  (標本 {} / ペア {})",
                        d.sim_min, d.sim_mean, d.sim_max, d.sim_stddev, d.sample_size, d.pair_count
                    );
                    println!("ハブ化  タグ本数×平均類似度の相関 r = {:+.4}", d.tagcount_similarity_corr);
                    println!(
                        "群分離  desc群内 {:?} / 非desc群内 {:?} / 群間 {:?}  (群サイズ {} / {})",
                        d.desc_intra_mean.map(|v| (v * 1000.0).round() / 1000.0),
                        d.nondesc_intra_mean.map(|v| (v * 1000.0).round() / 1000.0),
                        d.inter_group_mean.map(|v| (v * 1000.0).round() / 1000.0),
                        d.desc_group_size,
                        d.nondesc_group_size
                    );
                    println!(
                        "所要    読込 {}ms + 重心 {}ms + 総当り {}ms",
                        d.load_ms, d.centroid_ms, d.pairwise_ms
                    );
                    let total: usize = d.histogram.iter().map(|b| b.count).sum();
                    let bars: Vec<String> = d
                        .histogram
                        .iter()
                        .filter(|b| b.count > 0)
                        .map(|b| {
                            format!(
                                "{:+.1}..{:+.1} {:>5.1}% {}",
                                b.lower,
                                b.upper,
                                b.count as f32 * 100.0 / total as f32,
                                "#".repeat(((b.count * 40) / total.max(1)).max(1))
                            )
                        })
                        .collect();
                    println!("分布:\n  {}", bars.join("\n  "));
                }
            }
        });
    }
}
