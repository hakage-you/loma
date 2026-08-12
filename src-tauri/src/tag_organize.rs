//! タグ整理の提案生成。**ルール検出とは別の、明示実行の方式群。**
//!
//! 設計と実測の根拠: `_plan/20260805_tag_organize_rebuild_implementation_plan.md`
//!
//! | 方式 | 対象 | 手段 | LLM |
//! |---|---|---|---|
//! | ルール検出 | 全タグ | 表記の規則 | 不要（`commands.rs`） |
//! | 包括関係 | 単語1語 basic | 包括語の抽出 → カテゴリへの割り当て → 集約 | 要 |
//! | **関連タグ** | basic + descriptive | 埋め込みクラスタ | **不要**（本モジュール） |
//!
//! **方式は混ぜない。** リストには選んだ方式の結果だけを出す。
//! ルール検出の誤爆（上位12件中5件）が LLM の結果に混ざると質を下げるため。

use crate::commands::{MergeSuggestion, TagItem};
use crate::llm::ollama_text::{self, TextGenError, TextGenOptions};
use crate::suggestion_store::{self, Method, PairRecord, RunMode};
use serde::Serialize;
use sqlx::{Pool, Sqlite};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

// ---------------------------------------------------------------------------
// 包括関係の検出（2段構成）
// ---------------------------------------------------------------------------

/// 段1で1チャンクから選ばせる包括語の数。
///
/// **「包括語か否か」という絶対判断は閾値が振れる** —— 同じプロンプト・同じ入力で
/// thinking on なら 4%、off なら 52% だった。「最も包括的な N 件」という
/// 相対判断にすると正確に N 件になり、1チャンク7〜8秒で終わる（絶対判断は262秒〜タイムアウト）。
const STAGE1_TOP_N: usize = 5;

/// 段1の1チャンクに渡すタグ数
const STAGE1_CHUNK: usize = 100;

/// 段2の1チャンクに渡す対象タグ数（カテゴリは毎回全件入る）。
///
/// **「1回100件が上限」を段2に当てはめてはいけない。** あれはグルーピングでの実測値。
/// 段2は割り当てなので負荷が軽く、54グループ・最大57件という結果を出した実測は
/// カテゴリ75 + 対象50 = 125件だった。
const STAGE2_CHUNK: usize = 50;

/// 段2のプロンプトの版。**文面を変えたら必ず上げる。**
/// 引き継ぎの条件に入れており、版が違えば保存済みの判定を捨てる
/// （条件の違う結果を混ぜると解釈できなくなる）。
///
/// - v1: 初版
/// - v2: 部分-全体と兄弟の除外を明示 → **人手判定で -74件の悪化。破棄**
/// - v3: v1 の文面に戻した（番号は戻さない。v2 の結果を引き継がせないため）
const STAGE2_PROMPT_VERSION: u32 = 3;

/// 有効な結果が0件だったときの再試行回数。
///
/// **同一プロンプト・同一入力でも結果が振れる。** 実測で21チャンク中3つが
/// 割当0を返し（`done_reason` は `stop`、`eval_count` も3,000前後）、
/// うち1つを単独で再実行すると 0件 → 78件になった。
/// 消えたチャンクには最も使用数の多いタグが含まれていた。
///
/// **出なかった提案はユーザーに見えず取り返せないが、追加の呼び出しは安い。**
const RETRY_EMPTY: usize = 2;

/// タグ整理の実行パラメータ。**`settings` テーブルから読む。**
///
/// UI は今は用意しないが、**後から設定画面を足せる形にしておく**。
/// キーが無ければ既定値を使うので、設定を書かなくても動く。
///
/// 既定値はすべて実測で決めたもの。根拠は
/// `_plan/20260805_tag_organize_rebuild_implementation_plan.md` §2。
#[derive(Debug, Clone)]
pub struct OrganizeConfig {
    /// 1回の生成に許す秒数。**生成長は Ollama 側で止められないので、これが唯一の歯止め。**
    /// 実測で1チャンク 30秒〜16分と振れ、16分の回も最終的に結果を返した。
    pub timeout_secs: u64,
    /// 段1で1チャンクから選ばせる包括語の数
    pub stage1_top_n: usize,
    /// 段1の1チャンクに渡すタグ数
    pub stage1_chunk: usize,
    /// 段2の1チャンクに渡す対象タグ数（カテゴリは毎回全件入る）
    pub stage2_chunk: usize,
    /// 有効な結果が0件だったときの再試行回数
    pub retry_empty: usize,
}

impl Default for OrganizeConfig {
    fn default() -> Self {
        Self {
            timeout_secs: ollama_text::DEFAULT_TIMEOUT_SECS,
            stage1_top_n: STAGE1_TOP_N,
            stage1_chunk: STAGE1_CHUNK,
            stage2_chunk: STAGE2_CHUNK,
            retry_empty: RETRY_EMPTY,
        }
    }
}

impl OrganizeConfig {
    pub async fn load(pool: &Pool<Sqlite>) -> Self {
        let d = Self::default();
        Self {
            timeout_secs: num_setting(pool, "tag_organize_timeout_secs", d.timeout_secs).await,
            stage1_top_n: num_setting(pool, "tag_organize_stage1_top_n", d.stage1_top_n).await,
            stage1_chunk: num_setting(pool, "tag_organize_stage1_chunk", d.stage1_chunk).await,
            stage2_chunk: num_setting(pool, "tag_organize_stage2_chunk", d.stage2_chunk).await,
            retry_empty: num_setting(pool, "tag_organize_retry_empty", d.retry_empty).await,
        }
    }
}

/// 設定値を数値で読む。未設定・空文字・0・解釈できない値は既定値にする
async fn num_setting<T>(pool: &Pool<Sqlite>, key: &str, default: T) -> T
where
    T: std::str::FromStr + PartialOrd + From<u8>,
{
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<T>().ok())
        .filter(|v| *v > T::from(0u8))
        .unwrap_or(default)
}

#[derive(Serialize, Clone)]
pub struct HypernymProgress {
    /// `categories` か `assign`
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub elapsed_ms: u128,
    /// 再試行しても駄目だったチャンク数
    pub failed: usize,
}

/// 段1: 包括語（カテゴリ）を選ばせる。
///
/// 出力は該当するものだけを1行1件。100件全部に真偽を書かせると出力が4倍になり、
/// 発散の危険が上がる（n=200 で32万トークン生成した実測がある）。
fn build_stage1_prompt(descriptors: &[String], top_n: usize) -> String {
    format!(
        "You are organizing image tags. From the list below, find the tags that are \
CATEGORY-LIKE: general terms that other, more specific tags could be grouped under.\n\n\
Tags: {}\n\n\
A tag is category-like if you can name a more specific kind of it that a photo might show.\n\
Example: \"pathway\" is category-like because \"sidewalk\" is a kind of pathway.\n\
\"streetlamp\" is NOT category-like: it is already specific.\n\
A mid-level term still counts (it can be a kind of something broader and still have kinds of its own).\n\n\
Select AT MOST {} tags: the most category-like ones, most general first.\n\
Fewer is fine. If none of them are category-like, output nothing at all.\n\n\
Output ONE tag per line, nothing else. No numbering, no explanation, no reasoning:\n\
pathway\n\
Use exact tag names from the input list. Do not output tags that are not in the list.\n\
Never write anything other than tag names. Do not reconsider or explain your choice.",
        serde_json::to_string(descriptors).unwrap_or_default(),
        top_n
    )
}

/// 段2: 既知のカテゴリへの**割り当て**。グルーピングではない。
///
/// カテゴリをそのまま混ぜてグルーピングさせると、モデルは**毎回カテゴリどうしの
/// 関係まで解き直す**（`container`/`utensil`/`tableware` は互いに関係が濃い）。
/// 実測でカテゴリ75件＋通常25件で600秒タイムアウト、48件＋52件でも900秒タイムアウトした。
/// **P に関わらず不成立**だったので、割り当てだけに制約する。
fn build_stage2_prompt(categories: &[String], items: &[String]) -> String {
    // **除外を明示する改修（v2）は捨てた。** 人手判定で差引 -74件の悪化だった。
    //
    // 経緯（2026-08-12）: qwen3:14b のラベルで「部分-全体（`container ← lid`）と
    // 兄弟（`glass ← mug`）が混ざる」失敗が見つかり、それを禁じる3行を足した。
    // ところが**その失敗8件のうち7件を gemma4 は元から出しておらず**、
    // 存在しない問題を潰そうとしていた。gemma4 で前後を比べると:
    //
    //   消えた28件 ○28 ×0 ／ 増えた28件 ○28 ×0  → 母集団換算で -74件
    //
    // **56件の判定で × が1件も出ていない。** 除外の指示は悪い提案ではなく
    // 良い提案を削っていた（`building ← cathedral`、`texture ← mesh/stripe/grid` 等）。
    //
    // 教訓は `tools/text-check/COMPARE.md` に置いた。**対象モデルで同じ失敗が
    // 起きるかを確かめる前にプロンプトを直さない。**
    format!(
        "You are organizing image tags.\n\n\
Categories: {}\n\n\
Tags: {}\n\n\
For each tag in \"Tags\" that is a KIND OF one of the categories, output the assignment.\n\
Example: if \"pathway\" is a category and \"sidewalk\" is a tag, a sidewalk is a kind of pathway.\n\n\
Rules:\n\
- Only assign a tag when it is genuinely a kind of that category, not merely related.\n\
- A tag may be assigned to more than one category when it genuinely fits several.\n\
- Skip tags that fit no category. Do not force an assignment.\n\
- Do not relate categories to each other. Only assign tags from \"Tags\".\n\
- Never invent a name that is not in the lists.\n\n\
Output ONE assignment per line as JSON, nothing else:\n\
{{\"target\": \"pathway\", \"members\": [\"sidewalk\"]}}\n\
Use exact names from the lists.",
        serde_json::to_string(categories).unwrap_or_default(),
        serde_json::to_string(items).unwrap_or_default()
    )
}

/// `name (name_ja)` 形式。日本語名があれば添える
fn descriptor_of(t: &TagItem) -> String {
    match t.name_ja.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ja) => format!("{} ({})", t.name, ja),
        None => t.name.clone(),
    }
}

/// 応答からタグ名を1行1件で拾う。番号や記号が混ざっても拾えるようにする
fn parse_tag_lines(raw: &str, allowed: &HashSet<&str>) -> Vec<String> {
    let mut found = Vec::new();
    for line in raw.lines() {
        let t = line.trim().trim_start_matches(['-', '*', '•', ' ']);
        let t = t.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.' || c == ')');
        let name = t.split('(').next().unwrap_or(t).trim().trim_matches(['"', '\'', ',']);
        if !name.is_empty() && allowed.contains(name) && !found.iter().any(|f| f == name) {
            found.push(name.to_string());
        }
    }
    found
}

/// 段2の応答（1行1件の JSON）から割り当てを拾う
fn parse_assignments(
    raw: &str,
    categories: &HashSet<&str>,
    items: &HashSet<&str>,
) -> Vec<(String, String)> {
    let clean = |s: &str| s.split('(').next().unwrap_or(s).trim().to_string();
    let mut out = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if !t.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
            continue;
        };
        let Some(target) = v.get("target").and_then(|x| x.as_str()).map(clean) else {
            continue;
        };
        if !categories.contains(target.as_str()) {
            continue;
        }
        let Some(members) = v.get("members").and_then(|x| x.as_array()) else {
            continue;
        };
        for m in members {
            if let Some(name) = m.as_str().map(clean) {
                // **items にしか無い名前だけを受け付ける。**
                // カテゴリ同士を結ばせない制約が効いているかの検査も兼ねる
                if items.contains(name.as_str()) {
                    out.push((target.clone(), name));
                }
            }
        }
    }
    out
}

/// 1回の生成を実行し、**0件なら条件を変えて再試行する**。
///
/// - 有効な結果が0件 → 同条件で `RETRY_EMPTY` 回まで
/// - 時間切れ → **thinking を切って**1回だけ。同条件で繰り返しても同じく時間切れになる
/// - 環境障害（`llama-server` 落ち）→ 再試行しない。Ollama の再起動が要る
/// 失敗したときだけ応答の先頭をログに残す。**`llm_debug_logging` が有効なときのみ。**
///
/// **指標だけでは原因が分からない失敗が繰り返し起きている。**
/// この project で診断の決め手はいつも応答本文だった:
///
///   - `format:"json"` で応答が `{}` に縮退（`done_reason` は `stop`）
///   - パーサが `target` 必須で全行を捨てていた（「LLMが全消しした」ように見えた）
///   - 「exactly 5件」の指示でモデルが逡巡してループ（`done_reason=length`）
///
/// いずれも指標は正常に見えていた。ユーザー環境で同じことが起きたとき、
/// 本文が無いと「0件でした」以上のことが分からない。
///
/// 常時出すとログが膨らむので、デバッグ設定が有効なときだけにする。
fn log_response_excerpt(response: &str) {
    if !crate::logger::is_llm_debug_enabled() {
        return;
    }
    let excerpt: String = response.chars().take(300).collect();
    crate::logger::log_debug(&format!(
        "[tag-organize] 応答の先頭300文字: {:?}{}",
        excerpt,
        if response.chars().count() > 300 { " …（以降省略）" } else { "" }
    ));
}

async fn generate_with_retry<F>(
    url: &str,
    model: &str,
    prompt: &str,
    mut opts: TextGenOptions,
    retry_empty: usize,
    mut extract: F,
) -> Result<usize, TextGenError>
where
    F: FnMut(&str) -> usize,
{
    let mut last_err = None;
    for attempt in 0..=retry_empty {
        match ollama_text::generate(url, model, prompt, &opts).await {
            Ok((res, elapsed)) => {
                let n = extract(&res.response);
                // **発散した応答を同条件で再試行しても無駄。**
                // 文脈を使い切るまで生成しているので、もう一度やれば同じだけ時間を食う
                // （実測: 410秒 × 3回）。条件を変えるか、諦める
                if n == 0 && res.diverged(opts.num_ctx) {
                    crate::logger::log_info(&format!(
                        "[tag-organize] 生成が発散: {}",
                        res.diagnostics(opts.num_ctx, elapsed)
                    ));
                    log_response_excerpt(&res.response);
                    if opts.think != Some(false) {
                        opts.think = Some(false);
                        continue;
                    }
                    return Ok(0);
                }
                if n > 0 || attempt == retry_empty {
                    if n == 0 {
                        crate::logger::log_info(&format!(
                            "[tag-organize] 有効な結果が0件: {}",
                            res.diagnostics(opts.num_ctx, elapsed)
                        ));
                        log_response_excerpt(&res.response);
                    }
                    return Ok(n);
                }
            }
            Err(TextGenError::Timeout { secs }) => {
                // 同条件では再び時間切れになる。**条件を変える**
                if opts.think != Some(false) {
                    opts.think = Some(false);
                    crate::logger::log_info(&format!(
                        "[tag-organize] {}秒で時間切れ。thinking を切って再試行",
                        secs
                    ));
                    continue;
                }
                return Err(TextGenError::Timeout { secs });
            }
            Err(TextGenError::Environment(m)) => return Err(TextGenError::Environment(m)),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or(TextGenError::Parse("再試行しても結果が得られない".into())))
}

/// ③ が種別ごとに使う埋め込みモデル。
///
/// **用途で最良のモデルが違う**（計画書 §4 の実測）:
///
/// | 種別 | 既定 | 正例 | 誤混入 |
/// |---|---|---|---|
/// | basic | `embeddinggemma`（0.7GB） | 3/3 | 0/2 |
/// | descriptive | `bge-m3`（1.1GB） | 2/2 | 0/3 |
///
/// embeddinggemma は basic で最良だが descriptive が弱く、bge-m3 は逆。
/// 「重い方が良い」は成立しない（`qwen3-embedding:8b` は descriptive で最下位）。
///
/// **これは③専用。** 概念スペクトラム検索は種別をまたいでベクトルを平均するので
/// （`embedding.rs` の `build_library`）、あちらは1モデルで揃っている必要がある。
/// ③は種別ごとに閉じて処理するため、別モデルにしてよい。
const DEFAULT_BASIC_MODEL: &str = "embeddinggemma";
const DEFAULT_DESCRIPTIVE_MODEL: &str = "bge-m3";

fn related_model_for(kind: &str, cfg: &RelatedConfig) -> String {
    match kind {
        "descriptive" => cfg.descriptive_model.clone(),
        _ => cfg.basic_model.clone(),
    }
}

#[derive(Debug, Clone)]
pub struct RelatedConfig {
    pub ollama_url: String,
    pub basic_model: String,
    pub descriptive_model: String,
}

impl RelatedConfig {
    pub async fn load(pool: &Pool<Sqlite>) -> Self {
        Self {
            ollama_url: str_setting(pool, "ollama_url", "http://localhost:11434").await,
            basic_model: str_setting(pool, "related_basic_model", DEFAULT_BASIC_MODEL).await,
            descriptive_model: str_setting(
                pool,
                "related_descriptive_model",
                DEFAULT_DESCRIPTIVE_MODEL,
            )
            .await,
        }
    }
}

async fn str_setting(pool: &Pool<Sqlite>, key: &str, default: &str) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// 1つの提案に入れてよいタグ数の上限。**閾値の代わりに決める値。**
///
/// 閾値そのものはモデルごとに 0.72〜0.95 と大きく違うので固定できない。
/// 一方この上限は「1つの提案に何件まで入ってよいか」というUIの話で、
/// **モデルに依らず設計側が答えを持っている。**
///
/// 実測での根拠:
///   - 10 だと `bright_light` の12件グループが分断される
///   - 30以上だと embeddinggemma の basic が崩壊する（誤混入が出る）
///   - 両立するのが 15〜25 で、その中央
const MAX_CLUSTER_SIZE: usize = 20;

/// ブロックの大きさ。**全ペア比較を避けるための分割単位。**
///
/// 粗分割は包括関係を17〜25%しか残さないが、**高類似度のペアは96%残る**
/// （`partition-check.mjs` の対照実験 / cos ≥ 0.90 の124ペア）。
/// 関連タグが探すのはまさに高類似度の組なので、この方式で落ちない。
///
/// コストは n × B で n に線形。1万枚（descriptive 30,100件）なら
/// 4.5億ペア → 1,500万ペアになる。
const BLOCK_SIZE: usize = 500;

/// 辺として保持する下限。これ未満は連結成分を作り得ないので捨てる
const EDGE_FLOOR: f32 = 0.5;

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// 正規化された平均ベクトル（球面k-means の重心）
fn centroid(members: &[usize], vecs: &[&Vec<f32>], dim: usize) -> Vec<f32> {
    let mut c = vec![0.0f32; dim];
    for &m in members {
        for (i, v) in vecs[m].iter().enumerate() {
            c[i] += v;
        }
    }
    let n = c.iter().map(|x| x * x).sum::<f32>().sqrt();
    if n > 0.0 {
        for x in c.iter_mut() {
            *x /= n;
        }
    }
    c
}

/// 球面k-means (k=2) で1回分割する。**初期値は決定的**にする。
///
/// 乱数を使うと同じ入力で結果が変わり、後から検証できなくなる。
/// 重心から最も遠い点を第1中心、そこから最も遠い点を第2中心にする。
fn bisect(members: &[usize], vecs: &[&Vec<f32>], dim: usize) -> (Vec<usize>, Vec<usize>) {
    let c = centroid(members, vecs, dim);
    let far_from = |base: &[f32]| -> usize {
        *members
            .iter()
            .min_by(|a, b| {
                dot(vecs[**a], base)
                    .partial_cmp(&dot(vecs[**b], base))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(&members[0])
    };
    let a0 = far_from(&c);
    let b0 = far_from(vecs[a0]);

    let mut ca = vecs[a0].clone();
    let mut cb = vecs[b0].clone();
    let (mut left, mut right) = (Vec::new(), Vec::new());

    for _ in 0..15 {
        let (mut l, mut r) = (Vec::new(), Vec::new());
        for &m in members {
            if dot(vecs[m], &ca) >= dot(vecs[m], &cb) {
                l.push(m);
            } else {
                r.push(m);
            }
        }
        // 片側が空なら重心が退化している。距離順の中央で強制的に割る
        if l.is_empty() || r.is_empty() {
            let mut sorted = members.to_vec();
            sorted.sort_by(|x, y| {
                dot(vecs[*y], &ca)
                    .partial_cmp(&dot(vecs[*x], &ca))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let mid = sorted.len() / 2;
            return (sorted[..mid].to_vec(), sorted[mid..].to_vec());
        }
        let stable = l.len() == left.len() && l == left;
        left = l;
        right = r;
        if stable {
            break;
        }
        ca = centroid(&left, vecs, dim);
        cb = centroid(&right, vecs, dim);
    }
    (left, right)
}

/// どのブロックも `BLOCK_SIZE` 以下になるまで再帰的に二分する
fn partition(members: Vec<usize>, vecs: &[&Vec<f32>], dim: usize, out: &mut Vec<Vec<usize>>) {
    if members.len() <= BLOCK_SIZE {
        out.push(members);
        return;
    }
    let (l, r) = bisect(&members, vecs, dim);
    // 分割が進まない（同一ベクトルの塊など）ときは添字で割って停止を保証する
    if l.is_empty() || r.is_empty() || l.len() == members.len() || r.len() == members.len() {
        let mid = members.len() / 2;
        out.push(members[..mid].to_vec());
        out.push(members[mid..].to_vec());
        return;
    }
    partition(l, vecs, dim, out);
    partition(r, vecs, dim, out);
}

/// ユニオンファインド。閾値の探索と連結成分の構築に使う
struct DisjointSet {
    parent: Vec<usize>,
    size: Vec<usize>,
}

impl DisjointSet {
    fn new(n: usize) -> Self {
        Self { parent: (0..n).collect(), size: vec![1; n] }
    }
    fn find(&mut self, mut x: usize) -> usize {
        while self.parent[x] != x {
            self.parent[x] = self.parent[self.parent[x]];
            x = self.parent[x];
        }
        x
    }
    /// 併合後のサイズが `cap` を超えるなら併合せず `None` を返す
    fn union_capped(&mut self, a: usize, b: usize, cap: usize) -> Option<usize> {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra == rb {
            return Some(self.size[ra]);
        }
        let merged = self.size[ra] + self.size[rb];
        if merged > cap {
            return None;
        }
        let (big, small) = if self.size[ra] >= self.size[rb] { (ra, rb) } else { (rb, ra) };
        self.parent[small] = big;
        self.size[big] = merged;
        Some(merged)
    }
}

/// 関連タグの検出。
///
/// **「同義である」とは主張しない。** 「意味が近い。まとめるなら名前を決めて」という提案で、
/// `slope` / `diagonal` に「傾き」のような**既存タグに無い包括語をユーザーが与える**
/// 使い方が成立する（UI は手入力の代表タグに対応済み）。
///
/// 主張が弱いぶん誤りを許容できる。**それを成立させるのは表示**
/// —「類似度 0.85 以上の組です」と示せば期待値どおりで、認知負荷が上がらない。
///
/// ベクトルが未生成なら**黙って生成する**。拒否する理由が無く、確認を挟むと
/// 重要な決定を問うているように見えるため。
pub async fn suggest_related_tags(
    pool: &Pool<Sqlite>,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<Vec<MergeSuggestion>, String> {
    let cfg = RelatedConfig::load(pool).await;

    let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(
        r#"
        SELECT t.id, t.name, t.name_ja, COUNT(mt.media_id) AS count, t.tag_kind
        FROM tags t
        LEFT JOIN media_tags mt ON t.id = mt.tag_id
        WHERE t.is_category = 0
        GROUP BY t.id, t.name, t.name_ja, t.tag_kind
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut tag_map: HashMap<i64, TagItem> = HashMap::with_capacity(rows.len());
    // **種別ごとに閉じる。** 本番は種別またぎの統合を禁止している
    let mut by_kind: HashMap<String, Vec<i64>> = HashMap::new();
    for (id, name, name_ja, count, kind) in rows {
        by_kind.entry(kind.clone()).or_default().push(id);
        tag_map.insert(
            id,
            TagItem { id, name, name_ja, is_category: false, count, kind },
        );
    }

    // **種別ごとに違うモデルでベクトルを用意する。**
    // 足りないぶんだけ生成するので、揃っていれば即座に返る。
    // 種別をまたいで比較しないので、空間が違っても問題にならない。
    let mut vectors_by_kind: HashMap<String, HashMap<i64, Vec<f32>>> = HashMap::new();
    for kind in by_kind.keys() {
        let model = related_model_for(kind, &cfg);
        crate::embedding::generate_missing_for(
            pool,
            app_handle,
            &cfg.ollama_url,
            &model,
            Some(kind),
        )
        .await?;
        let v = crate::embedding::load_tag_vectors(pool, &model).await?;
        crate::logger::log_info(&format!(
            "[related] {} は {} を使用（ベクトル{}件）",
            kind,
            model,
            v.len()
        ));
        vectors_by_kind.insert(kind.clone(), v);
    }
    // ベクトルが無いタグは対象外
    for (kind, ids) in by_kind.iter_mut() {
        let v = &vectors_by_kind[kind];
        ids.retain(|id| v.contains_key(id));
    }
    tag_map.retain(|id, t| vectors_by_kind.get(&t.kind).is_some_and(|v| v.contains_key(id)));

    let mut adj: HashMap<i64, HashSet<i64>> = HashMap::new();
    // 種別ごとに算出された閾値。表示に使う
    let mut used_threshold: HashMap<String, f32> = HashMap::new();
    // ペアごとの実際の類似度。保存して読み出し時の表示に使う
    let mut edge_score: HashMap<(i64, i64), f32> = HashMap::new();

    for (kind, ids) in &by_kind {
        if ids.len() < 2 {
            continue;
        }
        let vectors = &vectors_by_kind[kind];
        let vecs: Vec<&Vec<f32>> = ids.iter().map(|id| &vectors[id]).collect();
        let dim = vecs[0].len();

        // 1. 粗分割。**全ペア比較を避ける唯一の手段。**
        //    包括関係は17〜25%しか残らないが、高類似度のペアは96%残る（実測）
        let mut blocks = Vec::new();
        partition((0..ids.len()).collect(), &vecs, dim, &mut blocks);

        // 2. ブロック内だけ厳密に比較して辺を作る
        let mut edges: Vec<(usize, usize, f32)> = Vec::new();
        for block in &blocks {
            for i in 0..block.len() {
                for j in (i + 1)..block.len() {
                    let s = dot(vecs[block[i]], vecs[block[j]]);
                    if s >= EDGE_FLOOR {
                        edges.push((block[i], block[j], s));
                    }
                }
            }
        }

        // 3. 類似度の降順に辺を足し、最大成分が上限を超える直前で止める。
        //    **閾値を固定せず構造から決める** — 閾値はモデルごとに 0.72〜0.95 と
        //    大きく違うが、「1つの提案に何件まで入ってよいか」はモデルに依らない
        edges.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        let mut ds = DisjointSet::new(ids.len());
        let mut threshold = EDGE_FLOOR;
        for &(a, b, s) in &edges {
            if ds.union_capped(a, b, MAX_CLUSTER_SIZE).is_none() {
                threshold = s;
                break;
            }
        }
        used_threshold.insert(kind.clone(), threshold);

        for &(a, b, s) in &edges {
            if s >= threshold {
                adj.entry(ids[a]).or_default().insert(ids[b]);
                adj.entry(ids[b]).or_default().insert(ids[a]);
                // **実際の類似度を残す。** これが無いと、保存済みの判定から
                // 提案を組み直したときに「どれくらい近いのか」を出せなくなる
                // （提案が妥当かをユーザーが判断する唯一の材料）
                edge_score.insert((ids[a].min(ids[b]), ids[a].max(ids[b])), s);
            }
        }

        crate::logger::log_info(&format!(
            "Related-tag [{}]: {} tags, {} blocks, {} edges, threshold {:.3}",
            kind,
            ids.len(),
            blocks.len(),
            edges.len(),
            threshold
        ));
    }

    // 判定を保存する。③は即時なので再開は不要だが、**却下は残す**。
    // 閾値は構造から決まるので、母集団が変われば同じ組が出るとは限らない。
    // それでも却下したペアが戻らないことは保証できる（ペア単位で記録するため）。
    suggestion_store::begin_run(pool, Method::Related, "related-v1", RunMode::Full).await?;
    let scores = &edge_score;
    let records: Vec<PairRecord> = adj
        .iter()
        .flat_map(|(a, ns)| {
            ns.iter()
                .filter(move |b| *b > a) // 無向辺なので片側だけ
                // 規則の識別子を必ず入れる。**無効化の予告で「何の提案が消えるか」を出すのに使う**
                .map(move |b| PairRecord {
                    target_id: *a,
                    member_id: *b,
                    rules: vec!["embedding".to_string()],
                    score: scores.get(&((*a).min(*b), (*a).max(*b))).copied(),
                })
        })
        .collect();
    let judged: Vec<i64> = tag_map.keys().copied().collect();
    suggestion_store::commit_chunk(pool, Method::Related, &records, &judged).await?;
    suggestion_store::finish_run(pool, Method::Related).await?;

    // **読み出し経路と同じ関数を通す。** 却下されたペアの除外も連結成分の構築も
    // あちらが行う（別経路にすると、同じ判定なのに件数も中身もずれる）
    let suggestions =
        crate::commands::build_suggestions_from_store(pool, Method::Related, &tag_map).await?;

    crate::logger::log_info(&format!(
        "[related] 完了: 提案{}件 / 対象{}件（{}）／ 閾値 {}",
        suggestions.len(),
        tag_map.len(),
        by_kind
            .iter()
            .map(|(k, ids)| format!("{} {}件", k, ids.len()))
            .collect::<Vec<_>>()
            .join(" / "),
        used_threshold
            .iter()
            .map(|(k, v)| format!("{} {:.3}", k, v))
            .collect::<Vec<_>>()
            .join(" / ")
    ));

    Ok(suggestions)
}

/// ② 包括関係の検出。段1で包括語を集め、段2で残りを割り当てて集約する。
///
/// **なぜ2段に分けるのか。** グルーピングは総当たりなので分割できないが、
/// 「このタグは包括語か」の判定は**タグ単位で独立**なので任意に分割してよい。
/// この非対称性が唯一の逃げ道だった（埋め込みの粗分割は包括関係を17〜25%しか残さない）。
///
/// **なぜ集約するのか。** 大きいグループを「同居」ではなく「蓄積」で作るため。
/// 素の分割では親と子が同じチャンクに落ちる確率が17〜25%しかないが、
/// チャンクを跨いで target ごとに足し合わせれば確率に依存しない。
///
/// 中断されたら**そこまでの結果を返す**（段2は集約なので途中結果がそのまま使える）。
pub async fn suggest_hypernyms(
    pool: &Pool<Sqlite>,
    app_handle: Option<&tauri::AppHandle>,
    cancel: Option<&AtomicBool>,
    mode: RunMode,
) -> Result<Vec<MergeSuggestion>, String> {
    use tauri::Emitter;

    let cfg = OrganizeConfig::load(pool).await;
    let url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let model: String =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_text_model'")
            .fetch_optional(pool)
            .await
            .unwrap_or(None)
            .unwrap_or_else(|| "gemma4:12b".to_string());

    let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(
        r#"
        SELECT t.id, t.name, t.name_ja, COUNT(mt.media_id) AS count, t.tag_kind
        FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
        WHERE t.is_category = 0 AND t.tag_kind = 'basic'
        GROUP BY t.id, t.name, t.name_ja, t.tag_kind
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // **単語1語 basic だけを対象にする。**
    // 階層シード18組のうち14組が「単語1語 ⊃ 単語1語」で、単語1語 basic は
    // 全体の35%（記述子の文字数比）しかない。包括関係のために全件を渡す必要はない。
    let pool_tags: Vec<TagItem> = rows
        .into_iter()
        .map(|(id, name, name_ja, count, kind)| TagItem {
            id,
            name,
            name_ja,
            is_category: false,
            count,
            kind,
        })
        .filter(|t| !t.name.contains('_'))
        .collect();
    if pool_tags.len() < cfg.stage1_chunk / 2 {
        return Ok(Vec::new());
    }

    // **中断されても、タグが増えても、未判定のぶんだけ走る。**
    // 引き継ぎの可否はモデルと段1のパラメータで決める —— 条件の違う結果を
    // 混ぜると解釈できなくなる（段2の結果は段1のカテゴリ集合に対する相対値）。
    // **プロンプトの版を入れる。** 文面を変えたら過去の判定は引き継げない
    // （条件の違う結果を混ぜると解釈できなくなる）
    let signature = format!("{}|top_n={}|p={}", model, cfg.stage1_top_n, STAGE2_PROMPT_VERSION);
    let resume = suggestion_store::begin_run(pool, Method::Hypernym, &signature, mode).await?;

    let started = std::time::Instant::now();
    let cancelled = || cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false);
    // **進捗はイベントとログの両方に出す。**
    // イベントは `app_handle` が無い経路（検証テスト）では消え、ログに残るのは失敗だけになる。
    // それだと遅いときに「どこまで進んだか」も「あと何分か」も分からず、
    // 発散なのか単に重いだけなのかを切り分けられない（実測で2時間判断を待たされた）。
    // 明示実行の機能なので、チャンクごとに1行出しても量は知れている。
    let emit = |phase: &str, done: usize, total: usize, failed: usize, note: &str| {
        let elapsed = started.elapsed().as_secs_f64();
        let eta = if done > 0 && done < total {
            format!(
                " 残り約{:.0}分",
                elapsed / done as f64 * (total - done) as f64 / 60.0
            )
        } else {
            String::new()
        };
        crate::logger::log_info(&format!(
            "[tag-organize] {} {}/{} {} 失敗{} 経過{:.1}分{}",
            phase, done, total, note, failed, elapsed / 60.0, eta
        ));
        if let Some(h) = app_handle {
            let _ = h.emit(
                "tag_hypernym_progress",
                HypernymProgress {
                    phase: phase.to_string(),
                    done,
                    total,
                    elapsed_ms: started.elapsed().as_millis(),
                    failed,
                },
            );
        }
    };

    // ---- 段1: 包括語を集める ----
    //
    // **切り方を変えて2回実行し和集合を取る。** 枠の取り合いがあり、
    // 切り方によって勝つ親が入れ替わる（ID順では `furniture` を、
    // ハッシュ順では `footwear` を落とした。和集合で 5/5 になる）。
    //
    // 再開時はここを飛ばす。段1は約45秒なので時間の節約が目的ではなく、
    // **同じカテゴリ集合を使い続けるため**（集合が変われば段2の途中結果が無意味になる）。
    let mut categories: HashSet<String> = HashSet::new();
    let mut failed = 0usize;
    let resumed_judged: HashSet<i64> = resume
        .as_ref()
        .map(|r| r.judged.iter().copied().collect())
        .unwrap_or_default();

    if let Some(r) = &resume {
        let by_id: HashMap<i64, &TagItem> = pool_tags.iter().map(|t| (t.id, t)).collect();
        categories.extend(r.categories.iter().filter_map(|id| by_id.get(id).map(|t| t.name.clone())));
        crate::logger::log_info(&format!(
            "[tag-organize] 段1は再開のため省略: カテゴリ{}件 判定済み{}件",
            categories.len(),
            resumed_judged.len()
        ));
    }

    let mut orderings: Vec<Vec<&TagItem>> = Vec::new();
    orderings.push(pool_tags.iter().collect());
    let mut shuffled: Vec<&TagItem> = pool_tags.iter().collect();
    shuffled.sort_by_key(|t| {
        // 乱数は使わない（同じ入力で結果が変わると後から検証できない）
        let mut h: u32 = 2166136261;
        for b in t.name.as_bytes() {
            h ^= *b as u32;
            h = h.wrapping_mul(16777619);
        }
        h
    });
    orderings.push(shuffled);

    let stage1_total: usize = orderings
        .iter()
        .map(|o| o.len().div_ceil(cfg.stage1_chunk))
        .sum();
    let mut stage1_done = 0usize;

    for ordering in orderings.iter().filter(|_| resume.is_none()) {
        for chunk in ordering.chunks(cfg.stage1_chunk) {
            if cancelled() {
                return Err("中断されました".to_string());
            }
            let allowed: HashSet<&str> = chunk.iter().map(|t| t.name.as_str()).collect();
            let prompt = build_stage1_prompt(
                &chunk.iter().map(|t| descriptor_of(t)).collect::<Vec<_>>(),
                cfg.stage1_top_n,
            );
            // 段1は出力がタグ名の列挙だけなので thinking を切る（6〜15倍速い）
            let opts = TextGenOptions {
                think: Some(false),
                timeout_secs: cfg.timeout_secs,
                ..Default::default()
            };
            let mut picked: Vec<String> = Vec::new();
            let r = generate_with_retry(&url, &model, &prompt, opts, cfg.retry_empty, |resp| {
                picked = parse_tag_lines(resp, &allowed);
                picked.len()
            })
            .await;
            let note;
            match r {
                Ok(_) => {
                    // 上限に対して何件返したかを残す。**カテゴリが集まらない事象の一次診断はここ。**
                    // 段2のプロンプト長はカテゴリ数で決まるので、少なすぎれば段2の弱さの説明になる
                    note = format!("カテゴリ{}/{}件", picked.len(), cfg.stage1_top_n);
                    categories.extend(picked.drain(..));
                }
                Err(TextGenError::Environment(m)) => {
                    return Err(format!("Ollama 側の障害です。再起動してから再実行してください: {}", m))
                }
                Err(e) => {
                    failed += 1;
                    note = format!("失敗: {}", e);
                }
            }
            stage1_done += 1;
            emit("段1", stage1_done, stage1_total, failed, &note);
        }
    }

    if resume.is_none() {
        crate::logger::log_info(&format!(
            "[tag-organize] 段1完了: 対象{}件 → カテゴリ{}件 ({:.1}分)",
            pool_tags.len(),
            categories.len(),
            started.elapsed().as_secs_f64() / 60.0
        ));
    }

    if categories.is_empty() {
        return Ok(Vec::new());
    }

    let by_name: HashMap<&str, &TagItem> = pool_tags.iter().map(|t| (t.name.as_str(), t)).collect();
    let cat_tags: Vec<&TagItem> = pool_tags.iter().filter(|t| categories.contains(&t.name)).collect();
    if resume.is_none() {
        let ids: Vec<i64> = cat_tags.iter().map(|t| t.id).collect();
        suggestion_store::save_categories(pool, Method::Hypernym, &ids).await?;
    }

    // ---- 段2: 残りをカテゴリに割り当てる ----
    //
    // **判定済みは飛ばす。** 中断で残ったぶんと、前回の実行後に増えたタグが
    // 同じ形（母集団 − 判定済み）で対象になる。
    let items: Vec<&TagItem> = pool_tags
        .iter()
        .filter(|t| !categories.contains(&t.name) && !resumed_judged.contains(&t.id))
        .collect();
    let cat_names: HashSet<&str> = cat_tags.iter().map(|t| t.name.as_str()).collect();
    let cat_descriptors: Vec<String> = cat_tags.iter().map(|t| descriptor_of(t)).collect();

    let stage2_total = items.len().div_ceil(cfg.stage2_chunk);
    let mut interrupted = false;

    for (ci, chunk) in items.chunks(cfg.stage2_chunk).enumerate() {
        if cancelled() {
            // 保存済みのぶんはそのまま残る。次回はここから続く
            crate::logger::log_info("[tag-organize] 段2を中断。次回は続きから走ります");
            interrupted = true;
            break;
        }
        let item_names: HashSet<&str> = chunk.iter().map(|t| t.name.as_str()).collect();
        let prompt = build_stage2_prompt(
            &cat_descriptors,
            &chunk.iter().map(|t| descriptor_of(t)).collect::<Vec<_>>(),
        );
        // **段2も thinking を切る。** 以前は「切ると全軸で悪化する」と記録していたが、
        // 同一チャンク・同一カテゴリ集合で測り直したところ逆だった（2026-08-07）:
        //
        //   回収率  有効 54%  →  無効 90/97/90%（既知の親子39組が分母）
        //   所要    有効 9.6分 →  無効 0.3分
        //   eval    有効 26,818 → 無効 804
        //
        // 有効のときは1チャンクが276秒・12,732トークン生成して**割当0件**を返し、
        // `furniture ⊃ table` のような明白な組を18/39落とした。
        // 無効の eval は 200〜400 で、これは JSONL の出力そのものの量。
        let opts = TextGenOptions {
            think: Some(false),
            timeout_secs: cfg.timeout_secs,
            ..Default::default()
        };
        let mut pairs: Vec<(String, String)> = Vec::new();
        let r = generate_with_retry(&url, &model, &prompt, opts, cfg.retry_empty, |resp| {
            pairs = parse_assignments(resp, &cat_names, &item_names);
            pairs.len()
        })
        .await;
        let note;
        match r {
            Ok(_) => {
                note = format!("割当{}件", pairs.len());
                // **結果と「判定済み」を同じトランザクションで確定する。**
                // 別々に書くと、間で落ちたときに再開が壊れる
                let records: Vec<PairRecord> = pairs
                    .drain(..)
                    .filter_map(|(target, member)| {
                        Some(PairRecord {
                            target_id: by_name.get(target.as_str())?.id,
                            member_id: by_name.get(member.as_str())?.id,
                            // 規則の識別子を必ず入れる。
                            // **無効化の予告で「何の提案が消えるか」を出すのに使う**
                            rules: vec!["hypernym".to_string()],
                            score: None,
                        })
                    })
                    .collect();
                let judged: Vec<i64> = chunk.iter().map(|t| t.id).collect();
                suggestion_store::commit_chunk(pool, Method::Hypernym, &records, &judged).await?;
            }
            Err(TextGenError::Environment(m)) => {
                return Err(format!("Ollama 側の障害です。再起動してから再実行してください: {}", m))
            }
            Err(e) => {
                failed += 1;
                // **判定済みにしない。** 段2は該当しないタグを出力しないので、
                // 記録しないと「判定したが該当なし」と区別がつかなくなる。
                // 次回の実行でこのチャンクだけが対象になる
                note = format!("失敗: {}", e);
            }
        }
        emit("段2", ci + 1, stage2_total, failed, &note);
    }

    if !interrupted {
        suggestion_store::finish_run(pool, Method::Hypernym).await?;
    }

    // ---- 提案に組み立てる ----
    // **保存済みの全ペアから作る。** 今回のぶんだけでは再開時に前回の結果が落ちる。
    // 読み出し経路と同じ関数を通す（別経路にすると件数も中身もずれる）
    let tag_map: HashMap<i64, TagItem> = pool_tags.iter().map(|t| (t.id, t.clone())).collect();

    // **カテゴリは母集団から外す。** 段2の対象ではない（割り当てる先であって
    // 割り当てられる側ではない）ので、未判定に数えると常にカテゴリ数ぶん残って見える
    let population: Vec<i64> = pool_tags
        .iter()
        .filter(|t| !categories.contains(&t.name))
        .map(|t| t.id)
        .collect();
    let unjudged = suggestion_store::unjudged(pool, Method::Hypernym, &population).await?;

    let suggestions =
        crate::commands::build_suggestions_from_store(pool, Method::Hypernym, &tag_map).await?;

    crate::logger::log_info(&format!(
        "[tag-organize] 完了{}: カテゴリ{}件 提案{}件 失敗チャンク{} 未判定{}件 {:.1}分",
        if interrupted { "（中断・次回は続きから）" } else { "" },
        categories.len(),
        suggestions.len(),
        failed,
        unjudged.len(),
        started.elapsed().as_secs_f64() / 60.0
    ));
    Ok(suggestions)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 段1のプロンプトをそのまま出す。計測ツールの文面と突き合わせるため。
    ///
    /// ```bash
    ///   LOMA_DESCRIPTORS_JSON=/path/to/desc.json \
    ///     cargo test --release dump_stage1_prompt -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn dump_stage1_prompt() {
        let Ok(path) = std::env::var("LOMA_DESCRIPTORS_JSON") else {
            eprintln!("LOMA_DESCRIPTORS_JSON が未設定のためスキップ");
            return;
        };
        let raw = std::fs::read_to_string(&path).expect("記述子を読めない");
        let descriptors: Vec<String> = serde_json::from_str(&raw).expect("JSON 配列である必要があります");
        let prompt = super::build_stage1_prompt(&descriptors, super::STAGE1_TOP_N);
        if let Ok(out) = std::env::var("LOMA_PROMPT_OUT") {
            std::fs::write(&out, &prompt).expect("書き出せない");
            eprintln!("書き出しました: {} ({} bytes)", out, prompt.len());
        } else {
            println!("{}", prompt);
        }
    }

    /// 段1を1チャンクだけ実行する。計測ツールとの挙動差を切り分けるため。
    ///
    /// ```bash
    ///   LOMA_DESCRIPTORS_JSON=/path/to/desc.json LOMA_DUMP_REQUEST=1 \
    ///     cargo test --release stage1_single_chunk -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn stage1_single_chunk() {
        let Ok(path) = std::env::var("LOMA_DESCRIPTORS_JSON") else {
            eprintln!("LOMA_DESCRIPTORS_JSON が未設定のためスキップ");
            return;
        };
        let raw = std::fs::read_to_string(&path).expect("記述子を読めない");
        let descriptors: Vec<String> = serde_json::from_str(&raw).expect("JSON 配列");
        let model = std::env::var("LOMA_MODEL").unwrap_or_else(|_| "gemma4:12b".to_string());
        let prompt = super::build_stage1_prompt(&descriptors, super::STAGE1_TOP_N);
        let timeout: u64 = std::env::var("LOMA_TIMEOUT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(600);
        let repeat: usize = std::env::var("LOMA_REPEAT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        // **窓を広げたら終わるのか、広げても足りないのかを見る。**
        // 前者なら単に窓が足りないだけ、後者は生成がループしている
        let num_ctx: usize = std::env::var("LOMA_NUM_CTX")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(ollama_text::DEFAULT_NUM_CTX);
        let think = match std::env::var("LOMA_THINK").as_deref() {
            Ok("on") => Some(true),
            Ok("auto") => None,
            _ => Some(false),
        };
        let opts = TextGenOptions { think, num_ctx, timeout_secs: timeout, ..Default::default() };

        // **同じ入力を連続で投げる。** 単独では正常なのに通しで走らせると発散するため、
        // 「連続実行そのもの」が原因かを切り分ける
        for i in 0..repeat {
            let t0 = std::time::Instant::now();
            match ollama_text::generate("http://localhost:11434", &model, &prompt, &opts).await {
                Ok((res, elapsed)) => {
                    println!("[{}] {}", i + 1, res.diagnostics(opts.num_ctx, elapsed));
                    // **全文を出す。** 何件返したかと、余計なものを書いていないかを見るための試験
                    println!("--- 応答ここから ---\n{}\n--- ここまで ---", res.response);
                }
                Err(e) => println!("[{}] 失敗: {} ({:.1}秒)", i + 1, e, t0.elapsed().as_secs_f64()),
            }
        }
    }

    /// 実データのDBを、**アプリと同じスキーマに揃えてから**開く。
    ///
    /// テストは `init_db` を通らないので、テーブルを足したときに
    /// 「アプリでは動くのに検証で落ちる」が起きる。移行の安全確認も兼ねる。
    async fn open_real_db(db_path: &str) -> Pool<Sqlite> {
        let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}", db_path))
            .await
            .expect("DB を開けない");
        sqlx::query("PRAGMA foreign_keys = ON;")
            .execute(&pool)
            .await
            .expect("外部キーを有効にできない");
        crate::db::create_tables(&pool)
            .await
            .expect("スキーマを揃えられない");
        pool
    }

    /// 既存の実データDBに新しいテーブルを足せることを確認する。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/.../loma.db' \
    ///     cargo test --release migration_on_real_db -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn migration_on_real_db() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let pool = open_real_db(&db_path).await;
        for t in [
            "tag_suggestion_runs",
            "tag_suggestion_categories",
            "tag_suggestion_pairs",
            "tag_suggestion_judged",
        ] {
            let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", t))
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("{} を読めない: {}", t, e));
            println!("{}: {}件", t, n);
        }
        // 既存データが壊れていないこと
        let tags: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM tags")
            .fetch_one(&pool)
            .await
            .unwrap();
        let media: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM media")
            .fetch_one(&pool)
            .await
            .unwrap();
        println!("tags: {}件 / media: {}件", tags, media);
        assert!(tags > 0 && media > 0, "既存データが読める");
    }

    /// 手で確認した親子関係。**回収率の分母。**
    ///
    /// ランダム抽出＋目視では評価にならないので正解セットを固定する
    /// （2026-08-04 に一度その方法で失敗している）。
    /// 単語1語 basic の中で閉じているものだけを並べてある。
    const HIERARCHY_SEEDS: &[(&str, &[&str])] = &[
        ("container", &["bowl", "jar", "bottle", "basket", "box", "can", "cup", "vase"]),
        ("footwear", &["shoe", "boot", "sneaker", "sandal"]),
        ("vehicle", &["car", "bicycle", "bus", "truck", "motorcycle", "train", "boat"]),
        ("structure", &["bridge", "tower", "fence", "wall", "gate", "roof"]),
        ("furniture", &["chair", "table", "sofa", "desk", "shelf", "bed", "cabinet"]),
        ("appliance", &["refrigerator", "oven", "microwave", "stove", "toaster"]),
        ("building", &["house", "church", "temple", "castle", "shrine"]),
        ("tool", &["hammer", "knife", "brush", "scissors", "wrench"]),
        ("instrument", &["guitar", "piano", "drum", "violin"]),
        ("clothing", &["shirt", "jacket", "dress", "skirt", "coat", "sweater"]),
        ("plant", &["tree", "flower", "grass", "bush", "leaf"]),
        ("animal", &["dog", "cat", "bird", "horse", "fish"]),
        ("food", &["bread", "rice", "meat", "soup", "cake", "noodle"]),
        ("drink", &["coffee", "tea", "beer", "wine", "juice"]),
        ("room", &["kitchen", "bathroom", "bedroom", "office"]),
    ];

    /// 段2の thinking の有無を、**同じチャンク・同じカテゴリ集合**で比べる。
    ///
    /// 実測で「対象10件・カテゴリ34件が thinking 有効では300秒でも終わらず、
    /// 切ると2秒で8件返す」という、記録済みの前提と逆の挙動が出たため。
    ///
    /// **速さだけでは決められない。** 前回の測定では回収率も落ちたと記録されている。
    /// 見るのは回収率（既知の親子を何組拾えたか）。割り当て件数は多ければ良いとは限らない。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/.../think.db' \
    ///     cargo test --release stage2_thinking_comparison -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn stage2_thinking_comparison() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let pool = open_real_db(&db_path).await;
        let cfg = OrganizeConfig::load(&pool).await;
        let model: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_text_model'")
                .fetch_optional(&pool)
                .await
                .unwrap_or(None)
                .unwrap_or_else(|| "gemma4:12b".to_string());
        let url = "http://localhost:11434";

        let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(
            r#"SELECT t.id, t.name, t.name_ja, COUNT(mt.media_id), t.tag_kind
               FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
               WHERE t.is_category = 0 AND t.tag_kind = 'basic'
               GROUP BY t.id, t.name, t.name_ja, t.tag_kind"#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let pool_tags: Vec<TagItem> = rows
            .into_iter()
            .map(|(id, name, name_ja, count, kind)| TagItem {
                id, name, name_ja, is_category: false, count, kind,
            })
            .filter(|t| !t.name.contains('_'))
            .collect();
        let by_name: HashMap<&str, &TagItem> =
            pool_tags.iter().map(|t| (t.name.as_str(), t)).collect();

        // ---- カテゴリ集合を作る ----
        // **段1の実出力に、正解セットの親を足す。**
        // 段1が親を拾えるかと、段2が割り当てられるかは別の問題。
        // 足しておかないと「段1で落ちたから回収0」と混ざって切り分けられない。
        println!("段1を実行中...");
        let mut categories: HashSet<String> = HashSet::new();
        let t0 = std::time::Instant::now();
        for chunk in pool_tags.chunks(cfg.stage1_chunk) {
            let allowed: HashSet<&str> = chunk.iter().map(|t| t.name.as_str()).collect();
            let prompt = build_stage1_prompt(
                &chunk.iter().map(descriptor_of).collect::<Vec<_>>(),
                cfg.stage1_top_n,
            );
            let opts = TextGenOptions {
                think: Some(false), timeout_secs: cfg.timeout_secs, ..Default::default()
            };
            if let Ok((res, _)) = ollama_text::generate(url, &model, &prompt, &opts).await {
                categories.extend(parse_tag_lines(&res.response, &allowed));
            }
        }
        let found_by_stage1 = categories.len();
        let seed_parents: Vec<&str> = HIERARCHY_SEEDS
            .iter()
            .map(|(p, _)| *p)
            .filter(|p| by_name.contains_key(p))
            .collect();
        let stage1_hit: Vec<&&str> =
            seed_parents.iter().filter(|p| categories.contains(**p)).collect();
        for p in &seed_parents {
            categories.insert(p.to_string());
        }
        println!(
            "段1: {}件（{:.0}秒）→ 正解セットの親を足して {}件",
            found_by_stage1,
            t0.elapsed().as_secs_f64(),
            categories.len()
        );
        println!(
            "  正解セットの親 {}件のうち段1が自力で拾ったのは {}件: {:?}",
            seed_parents.len(),
            stage1_hit.len(),
            stage1_hit
        );

        // ---- 対象チャンクを作る ----
        // 正解セットの子を全部入れ、残りを埋めて本番と同じ大きさにする
        let cat_names: HashSet<&str> =
            categories.iter().map(|s| s.as_str()).collect::<HashSet<_>>();
        let seed_children: Vec<&TagItem> = HIERARCHY_SEEDS
            .iter()
            .flat_map(|(_, kids)| kids.iter())
            .filter_map(|k| by_name.get(k).copied())
            .filter(|t| !cat_names.contains(t.name.as_str()))
            .collect();
        let filler: Vec<&TagItem> = pool_tags
            .iter()
            .filter(|t| {
                !cat_names.contains(t.name.as_str())
                    && !seed_children.iter().any(|s| s.id == t.id)
            })
            .collect();

        const CHUNKS: usize = 3;
        let per_chunk_seeds = seed_children.len().div_ceil(CHUNKS);
        let mut chunks: Vec<Vec<&TagItem>> = Vec::new();
        for i in 0..CHUNKS {
            let mut c: Vec<&TagItem> = seed_children
                .iter()
                .skip(i * per_chunk_seeds)
                .take(per_chunk_seeds)
                .copied()
                .collect();
            let need = cfg.stage2_chunk.saturating_sub(c.len());
            c.extend(filler.iter().skip(i * need).take(need).copied());
            chunks.push(c);
        }
        println!(
            "対象チャンク {}個（各{}件）／正解の子 {}件",
            chunks.len(),
            chunks[0].len(),
            seed_children.len()
        );

        // 正解ペアのうち、この条件で拾えるはずのもの
        let expected: HashSet<(String, String)> = HIERARCHY_SEEDS
            .iter()
            .flat_map(|(p, kids)| kids.iter().map(move |k| (p.to_string(), k.to_string())))
            .filter(|(p, k)| {
                categories.contains(p) && chunks.iter().any(|c| c.iter().any(|t| &t.name == k))
            })
            .collect();
        println!("回収の分母（親も子も条件を満たすペア）: {}組\n", expected.len());

        let cat_descriptors: Vec<String> =
            categories.iter().filter_map(|n| by_name.get(n.as_str())).map(|t| descriptor_of(t)).collect();

        // ---- 比較 ----
        // thinking 有効は1チャンク数分かかるので繰り返さない。
        // 無効は安いので繰り返し、**振れ幅も見る**（0件を返す事象が実測である）
        for (label, think, repeat) in [("thinking 有効", true, 1usize), ("thinking 無効", false, 3)] {
            println!("=== {} ===", label);
            for rep in 0..repeat {
                let mut got: HashSet<(String, String)> = HashSet::new();
                let mut total_pairs = 0usize;
                let mut total_eval = 0u32;
                let t = std::time::Instant::now();
                for (ci, chunk) in chunks.iter().enumerate() {
                    let item_names: HashSet<&str> =
                        chunk.iter().map(|t| t.name.as_str()).collect();
                    let prompt = build_stage2_prompt(
                        &cat_descriptors,
                        &chunk.iter().map(|t| descriptor_of(t)).collect::<Vec<_>>(),
                    );
                    let opts = TextGenOptions {
                        think: Some(think),
                        timeout_secs: cfg.timeout_secs,
                        ..Default::default()
                    };
                    let c0 = std::time::Instant::now();
                    match ollama_text::generate(url, &model, &prompt, &opts).await {
                        Ok((res, _)) => {
                            let pairs = parse_assignments(&res.response, &cat_names, &item_names);
                            let n = pairs.len();
                            total_pairs += n;
                            total_eval += res.eval_count.unwrap_or(0);
                            got.extend(pairs);
                            println!(
                                "  チャンク{}: 割当{}件 eval={} {:.0}秒",
                                ci + 1,
                                n,
                                res.eval_count.unwrap_or(0),
                                c0.elapsed().as_secs_f64()
                            );
                        }
                        Err(e) => println!("  チャンク{}: 失敗 {} ({:.0}秒)", ci + 1, e, c0.elapsed().as_secs_f64()),
                    }
                }
                let hit: Vec<&(String, String)> = expected.iter().filter(|p| got.contains(p)).collect();
                println!(
                    "  [{}回目] 回収 {}/{} ({:.0}%) ／ 割当計{}件 ／ eval計{} ／ {:.1}分",
                    rep + 1,
                    hit.len(),
                    expected.len(),
                    hit.len() as f64 / expected.len().max(1) as f64 * 100.0,
                    total_pairs,
                    total_eval,
                    t.elapsed().as_secs_f64() / 60.0
                );
                let missed: Vec<String> = expected
                    .iter()
                    .filter(|p| !got.contains(p))
                    .map(|(p, k)| format!("{}⊃{}", p, k))
                    .collect();
                if !missed.is_empty() {
                    println!("  取りこぼし: {}", missed.join(" "));
                }
            }
            println!();
        }
    }

    /// 実データで③を通す。**種別ごとに違うモデルで埋め込みを生成する。**
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/.../related.db' \
    ///     cargo test --release related_on_real_data -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn related_on_real_data() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let pool = open_real_db(&db_path).await;
        let cfg = RelatedConfig::load(&pool).await;
        println!("basic={} / descriptive={}", cfg.basic_model, cfg.descriptive_model);

        let t0 = std::time::Instant::now();
        let s = super::suggest_related_tags(&pool, None).await.expect("失敗");
        println!("\n提案 {}件 / {:.1}分", s.len(), t0.elapsed().as_secs_f64() / 60.0);

        // モデルごとの保有状況。**種別ごとに別モデルで入っていること**
        let rows = sqlx::query_as::<_, (String, i64, i64)>(
            "SELECT model, COUNT(*), COALESCE(MAX(dim),0) FROM tag_embeddings GROUP BY model",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        println!("\nベクトル:");
        for (m, n, d) in rows {
            println!("  {}  {}件 dim={}", m, n, d);
        }

        for kind in ["basic", "descriptive"] {
            let mut list: Vec<&MergeSuggestion> =
                s.iter().filter(|x| x.target_tag.kind == kind).collect();
            list.sort_by_key(|x| std::cmp::Reverse(x.source_tags.len()));
            println!("\n=== {} 上位10件（{}件中）===", kind, list.len());
            for x in list.iter().take(10) {
                let m: Vec<&str> = x.source_tags.iter().take(6).map(|t| t.name.as_str()).collect();
                println!(
                    "[{}] {} <- {}{}   ({})",
                    x.source_tags.len() + 1,
                    x.target_tag.name,
                    m.join(", "),
                    if x.source_tags.len() > 6 { " …" } else { "" },
                    x.reason
                );
            }
        }
    }

    /// ラベル付け用に、保存済みの提案を JSON で書き出す。**Ollama は使わない。**
    ///
    /// **本番の組み立て経路をそのまま通す。** JS 側にミラーを持たない方針なので、
    /// 評価する対象は必ずここから出す（画面に出るものと同じでなければ評価の意味がない）。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/.../loma.db' LOMA_LABEL_OUT='tools/text-check/results/proposals.json' \
    ///     cargo test --release dump_suggestions_for_labeling -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn dump_suggestions_for_labeling() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let out = std::env::var("LOMA_LABEL_OUT")
            .unwrap_or_else(|_| "proposals.json".to_string());
        let pool = open_real_db(&db_path).await;

        let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(
            r#"SELECT t.id, t.name, t.name_ja, COUNT(mt.media_id), t.tag_kind
               FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
               WHERE t.is_category = 0 GROUP BY t.id"#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let tag_map: HashMap<i64, TagItem> = rows
            .into_iter()
            .map(|(id, n, ja, c, k)| {
                (id, TagItem { id, name: n, name_ja: ja, is_category: false, count: c, kind: k })
            })
            .collect();

        let mut all = serde_json::Map::new();
        for (name, method) in [
            ("rules", Method::Rules),
            ("hypernym", Method::Hypernym),
            ("related", Method::Related),
        ] {
            let s = crate::commands::build_suggestions_from_store(&pool, method, &tag_map)
                .await
                .unwrap();
            if s.is_empty() {
                println!("{}: 保存された判定が無いのでスキップ", name);
                continue;
            }

            // **判定の単位はペア。** グループ単位で ○/× を付けると
            // 「20件中10件は正しい」を表現できず情報が落ちる。
            // ペアで持てば、集約し直すだけでグループの質も出せる。
            let pairs = suggestion_store::load_pairs(&pool, method).await.unwrap();
            // どのグループに属するか（表示の文脈として要る）
            let mut group_of: HashMap<i64, (String, usize)> = HashMap::new();
            for g in &s {
                for t in std::iter::once(&g.target_tag).chain(g.source_tags.iter()) {
                    group_of.insert(t.id, (g.id.clone(), g.source_tags.len() + 1));
                }
            }
            let pair_rows: Vec<serde_json::Value> = pairs
                .iter()
                .filter_map(|p| {
                    let t = tag_map.get(&p.target_id)?;
                    let mem = tag_map.get(&p.member_id)?;
                    let (gid, gsize) = group_of.get(&p.target_id).cloned().unwrap_or_default();
                    Some(serde_json::json!({
                        "id": format!("{}-{}-{}", name, p.target_id, p.member_id),
                        "target": t, "member": mem,
                        "rules": p.rules, "score": p.score,
                        "group_id": gid, "group_size": gsize,
                    }))
                })
                .collect();

            println!("{}: 提案{}件 / ペア{}件", name, s.len(), pair_rows.len());
            all.insert(name.to_string(), serde_json::to_value(&s).unwrap());
            all.insert(format!("{}_pairs", name), serde_json::Value::Array(pair_rows));
        }

        std::fs::write(&out, serde_json::to_string(&all).unwrap()).expect("書き出せない");
        println!("\n書き出しました: {}", out);
    }

    /// 保存済みの判定から提案を組み立て直す。**Ollama は使わない。**
    ///
    /// 生のペアで持つ設計の要点そのもの —— 一度走らせれば、組み立て側の
    /// 修正は再実行なしで確認できる。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/.../full.db' \
    ///     cargo test --release rebuild_suggestions_from_store -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn rebuild_suggestions_from_store() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let pool = open_real_db(&db_path).await;
        let pairs = suggestion_store::load_pairs(&pool, Method::Hypernym).await.unwrap();
        println!("保存済みペア {}件", pairs.len());

        let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(
            r#"SELECT t.id, t.name, t.name_ja, COUNT(mt.media_id), t.tag_kind
               FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
               WHERE t.is_category = 0 GROUP BY t.id"#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        let tag_map: HashMap<i64, TagItem> = rows
            .into_iter()
            .map(|(id, name, name_ja, count, kind)| {
                (id, TagItem { id, name, name_ja, is_category: false, count, kind })
            })
            .collect();

        let s = crate::commands::build_suggestions_from_store(&pool, Method::Hypernym, &tag_map)
            .await
            .unwrap();

        let total: usize = s.iter().map(|x| x.source_tags.len() + 1).sum();
        println!("提案 {}件 / 延べメンバー {}\n", s.len(), total);
        println!("=== 上位20件 ===");
        for x in s.iter().take(20) {
            let m: Vec<&str> = x.source_tags.iter().take(8).map(|t| t.name.as_str()).collect();
            println!(
                "[{}] {} (使用数{}) <- {}{}",
                x.source_tags.len() + 1,
                x.target_tag.name,
                x.target_tag.count,
                m.join(", "),
                if x.source_tags.len() > 8 { " …" } else { "" }
            );
        }
        // グループの大きさの分布。レビュー負荷の判断材料
        let mut sizes: Vec<usize> = s.iter().map(|x| x.source_tags.len() + 1).collect();
        sizes.sort_unstable();
        println!(
            "\nグループサイズ 中央{} 最大{} / 5件以下 {}件 / 20件超 {}件",
            sizes[sizes.len() / 2],
            sizes.last().copied().unwrap_or(0),
            sizes.iter().filter(|&&n| n <= 5).count(),
            sizes.iter().filter(|&&n| n > 20).count()
        );
    }

    /// 実データで**中断 → 再開**を確かめる。Ollama を使う（10分程度）。
    ///
    /// 見るのは仕組みだけなので、品質のための既定値は使わない
    /// （`stage1_top_n` と `stage2_chunk` を落として1チャンクを短くする）。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/.../resume.db' LOMA_PHASE_SECS=300 \
    ///     cargo test --release hypernym_resume_on_real_data -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn hypernym_resume_on_real_data() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let phase_secs: u64 = std::env::var("LOMA_PHASE_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(300);
        let pool = open_real_db(&db_path).await;

        async fn counts(pool: &Pool<Sqlite>) -> (i64, i64, i64, Option<i64>) {
            let judged = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM tag_suggestion_judged WHERE method='hypernym'")
                .fetch_one(pool).await.unwrap();
            let pairs = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM tag_suggestion_pairs WHERE method='hypernym'")
                .fetch_one(pool).await.unwrap();
            let cats = sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM tag_suggestion_categories WHERE method='hypernym'")
                .fetch_one(pool).await.unwrap();
            let fin = sqlx::query_scalar::<_, Option<i64>>(
                "SELECT finished_at FROM tag_suggestion_runs WHERE method='hypernym'")
                .fetch_optional(pool).await.unwrap().flatten();
            (judged, pairs, cats, fin)
        }

        // 一定時間で中断させる
        async fn run_phase(
            pool: &Pool<Sqlite>,
            secs: u64,
        ) -> Result<Vec<MergeSuggestion>, String> {
            let cancel = std::sync::Arc::new(AtomicBool::new(false));
            let c = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
                c.store(true, Ordering::Relaxed);
            });
            super::suggest_hypernyms(pool, None, Some(&cancel), RunMode::Incremental).await
        }

        println!("=== 1回目（{}秒で中断）===", phase_secs);
        let r1 = run_phase(&pool, phase_secs).await.expect("1回目が失敗");
        let (j1, p1, c1, f1) = counts(&pool).await;
        println!("提案{}件 / 判定済み{} ペア{} カテゴリ{} finished_at={:?}", r1.len(), j1, p1, c1, f1);
        assert!(c1 > 0, "段1の結果が保存されている");
        assert!(j1 > 0, "1チャンク以上は判定できている（短すぎるなら LOMA_PHASE_SECS を上げる）");
        assert!(f1.is_none(), "中断したので未完了のまま");

        println!("\n=== 2回目（続きから / {}秒で中断）===", phase_secs);
        let r2 = run_phase(&pool, phase_secs).await.expect("2回目が失敗");
        let (j2, p2, c2, _) = counts(&pool).await;
        println!("提案{}件 / 判定済み{} ペア{} カテゴリ{}", r2.len(), j2, p2, c2);

        assert_eq!(c2, c1, "カテゴリは作り直されない（段1を飛ばしている）");
        assert!(j2 > j1, "判定済みが増えている: {} → {}", j1, j2);
        assert!(p2 >= p1, "前回のペアが消えていない: {} → {}", p1, p2);
        assert!(
            r2.len() >= r1.len(),
            "提案が減っていない: {} → {}",
            r1.len(),
            r2.len()
        );
        println!(
            "\n中断再開は成立。判定済み {} → {} 件（+{}）、ペア {} → {} 件",
            j1, j2, j2 - j1, p1, p2
        );
    }

    /// 実データで包括関係の検出を通しで走らせる。**Ollama を長時間使う。**
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/Users/.../loma.db' \
    ///     cargo test --release hypernym_on_real_data -- --ignored --nocapture
    /// ```
    ///
    /// アプリを起動せずに本番ロジックをそのまま呼ぶ（JS 側にミラーを持たない方針）。
    #[tokio::test]
    #[ignore]
    async fn hypernym_on_real_data() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let pool = open_real_db(&db_path).await;
        let started = std::time::Instant::now();
        let suggestions = super::suggest_hypernyms(&pool, None, None, RunMode::Full)
            .await
            .expect("suggest_hypernyms が失敗しました");

        println!("\n=== 包括関係の検出 ===");
        println!("提案 {} 件 / {:.1} 分", suggestions.len(), started.elapsed().as_secs_f64() / 60.0);
        let total: usize = suggestions.iter().map(|s| s.source_tags.len() + 1).sum();
        println!("延べメンバー {}", total);
        println!("\n=== 上位20件（件数降順）===");
        for s in suggestions.iter().take(20) {
            let members: Vec<&str> = s.source_tags.iter().map(|t| t.name.as_str()).collect();
            println!(
                "[{}] {} <- {}",
                members.len() + 1,
                s.target_tag.name,
                members.join(", ")
            );
        }
    }

    #[test]
    fn stage2_parser_rejects_names_outside_the_lists() {
        let cats: HashSet<&str> = ["container", "vehicle"].into_iter().collect();
        let items: HashSet<&str> = ["bowl", "car", "cup"].into_iter().collect();
        let raw = r#"
{"target": "container", "members": ["bowl", "cup"]}
{"target": "vehicle", "members": ["car"]}
{"target": "container", "members": ["spaceship"]}
{"target": "furniture", "members": ["bowl"]}
{"target": "container", "members": ["vehicle"]}
これは JSON ではない行
"#;
        let got = parse_assignments(raw, &cats, &items);
        assert!(got.contains(&("container".into(), "bowl".into())));
        assert!(got.contains(&("container".into(), "cup".into())));
        assert!(got.contains(&("vehicle".into(), "car".into())));
        // 入力に無い名前は落とす
        assert!(!got.iter().any(|(_, m)| m == "spaceship"));
        // カテゴリに無い target は落とす
        assert!(!got.iter().any(|(t, _)| t == "furniture"));
        // **カテゴリ同士を結ばせない。** items にしか無い名前だけを受け付ける
        assert!(!got.iter().any(|(_, m)| m == "vehicle"));
        assert_eq!(got.len(), 3);
    }

    #[test]
    fn stage1_parser_tolerates_decorated_lines() {
        let allowed: HashSet<&str> = ["container", "vehicle", "pathway"].into_iter().collect();
        let raw = "1. container\n- vehicle (車両)\n  * pathway\nstreetlamp\n";
        let got = parse_tag_lines(raw, &allowed);
        assert_eq!(got, vec!["container", "vehicle", "pathway"]);
        // 入力に無いものは拾わない
        assert!(!got.iter().any(|x| x == "streetlamp"));
    }

    #[test]
    fn dot_of_normalized_vectors_is_cosine() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        let c = vec![0.0, 1.0, 0.0];
        assert!((dot(&a, &b) - 1.0).abs() < 1e-6);
        assert!(dot(&a, &c).abs() < 1e-6);
    }

    #[test]
    fn union_stops_at_the_cap() {
        let mut ds = DisjointSet::new(6);
        // 3件までなら繋がる
        assert_eq!(ds.union_capped(0, 1, 3), Some(2));
        assert_eq!(ds.union_capped(1, 2, 3), Some(3));
        // 4件目は拒否される（上限を超えるので併合しない）
        assert_eq!(ds.union_capped(2, 3, 3), None);
        // 拒否されても状態は壊れない
        assert_eq!(ds.find(0), ds.find(2));
        assert_ne!(ds.find(0), ds.find(3));
        // 別の成分は独立に作れる
        assert_eq!(ds.union_capped(3, 4, 3), Some(2));
    }

    #[test]
    fn partition_splits_until_blocks_fit() {
        // 同一ベクトルばかりでも停止する（添字で強制的に割る経路）
        let v = vec![1.0f32, 0.0, 0.0];
        let owned: Vec<Vec<f32>> = (0..BLOCK_SIZE * 3).map(|_| v.clone()).collect();
        let vecs: Vec<&Vec<f32>> = owned.iter().collect();
        let mut blocks = Vec::new();
        partition((0..vecs.len()).collect(), &vecs, 3, &mut blocks);
        assert!(!blocks.is_empty());
        assert!(blocks.iter().all(|b| b.len() <= BLOCK_SIZE), "全ブロックが上限以下");
        assert_eq!(blocks.iter().map(|b| b.len()).sum::<usize>(), vecs.len(), "取りこぼしなし");
    }

    #[test]
    fn partition_keeps_similar_vectors_together() {
        // 2つの離れた塊を作ると、分割はその境界で切れるはず
        let mut owned: Vec<Vec<f32>> = Vec::new();
        for i in 0..BLOCK_SIZE + 10 {
            let t = (i as f32) * 1e-4;
            owned.push(vec![1.0 - t, t, 0.0]);
        }
        for i in 0..BLOCK_SIZE + 10 {
            let t = (i as f32) * 1e-4;
            owned.push(vec![0.0, t, 1.0 - t]);
        }
        for v in owned.iter_mut() {
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            for x in v.iter_mut() {
                *x /= n;
            }
        }
        let vecs: Vec<&Vec<f32>> = owned.iter().collect();
        let mut blocks = Vec::new();
        partition((0..vecs.len()).collect(), &vecs, 3, &mut blocks);
        // どのブロックも2つの塊をまたがない
        for b in &blocks {
            let first_half = b.iter().filter(|&&i| i < BLOCK_SIZE + 10).count();
            assert!(
                first_half == 0 || first_half == b.len(),
                "ブロックが塊をまたいでいる: {} / {}",
                first_half,
                b.len()
            );
        }
    }
}
