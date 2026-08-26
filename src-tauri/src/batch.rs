use anyhow::{anyhow, Result};
use rayon::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Pool, Sqlite};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

struct FileScanMeta {
    file_path_str: String,
    parent_folder: String,
    file_size: i64,
    file_modified_at: i64,
    file_hash: String,
    thumb_path_str: String,
}

/// キャンセルフラグが立つまで待ち続ける。
///
/// VLM の1リクエストは数十秒〜数分かかるため、フラグを「リクエストの合間」でしか
/// 見ないとキャンセルの体感速度がそのまま推論時間に引きずられる。
/// `tokio::select!` の片側にこれを置いて解析 Future を drop することで、
/// HTTP 接続が切断され Ollama 側の生成も即座に打ち切られる。
pub async fn wait_until_cancelled(cancel_flag: &Arc<AtomicBool>) {
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub total: usize,
    pub current: usize,
    pub current_file: String,
    pub status: String,
    pub error_count: usize,
    pub is_paused: bool,
}

#[derive(Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

#[derive(Deserialize)]
pub struct OllamaModel {
    pub name: String,
}

/// `/api/show` の応答。使うのは `capabilities` だけ。
#[derive(Deserialize)]
struct OllamaShowResponse {
    #[serde(default)]
    capabilities: Vec<String>,
}

/// モデル名 → `vision` を宣言しているか。
///
/// `/api/show` はモデル1件につき1リクエストで、モデル一覧の取得は設定画面を開くたびに走る
/// （`fetch_ollama_models` のコメント参照）。同じ名前のモデルで宣言が変わることはまず無いので、
/// プロセスが生きている間は使い回す。取り直しは `refresh` を渡したときだけ。
static VISION_CAPABILITY_CACHE: Mutex<Option<HashMap<String, bool>>> = Mutex::new(None);

/// 動画マルチフレーム解析の Ollama オプション。
///
/// **`num_predict` を付けてはならない。** これは生成トークンの上限だが、thinking 対応モデルでは
/// **thinking の消費分も同じ枠から引かれる**。フレーム3枚の解析では thinking だけで
/// 2,000 トークン超を使うため、上限を切ると答えを書く前に打ち切られて応答が空になる。
/// 実測（qwen3-vl:4b / サムネイル3枚 / 4試行）:
/// | オプション | 空応答 | done_reason |
/// | `num_predict: 2048` | **3/4** | length（eval がちょうど 2048 で停止） |
/// | 無指定 | 0/4 | stop（eval は 2,148〜4,337 とばらつく） |
///
/// 上限を上げるのではなく無指定にする。必要量はモデルと画像枚数で変わるため、
/// 固定値を置くと同じ壊れ方を再現するだけになる。`llm/ollama.rs` の本流も無指定である。
#[derive(Serialize)]
struct OllamaOptions {
    temperature: f32,
    num_ctx: i32,
}

/// Ollama /api/generate のリクエスト（動画マルチフレーム解析用）。
///
/// **`format: "json"` フィールドを追加してはならない。** thinking 対応モデル
/// （既定の `qwen3-vl` 系はすべて該当）に指定すると応答が空文字になり、`thinking` も空になる。
/// `done_reason` は "stop"（正常終了）で返るためエラーにならず、パース失敗として現れる。
/// 詳細は `llm/ollama.rs` の同名構造体のコメントを参照（実測データもそこにある）。
/// JSON の抽出は `extract_and_parse_json` が担うので format 指定は不要。
#[derive(Serialize)]
struct OllamaGenerateRequest {
    model: String,
    prompt: String,
    images: Vec<String>,
    stream: bool,
    options: OllamaOptions,
}

#[derive(Deserialize)]
struct OllamaGenerateResponse {
    response: String,
    thinking: Option<String>,
    /// "stop" = 正常終了, "length" = 生成上限に到達して打ち切り。
    /// 打ち切りを見分けないと、途切れた thinking をパースしようとして
    /// 「JSON が壊れている」という誤った診断になる。
    #[serde(default)]
    done_reason: Option<String>,
}

/// Ollama の応答から解析結果を取り出す。
///
/// 空応答を `thinking` で代替するのは、thinking 対応モデルが答えを thinking 側に
/// 書いてしまう場合があるため。ただし**打ち切り（done_reason = "length"）のときは代替しない。**
/// 途切れた thinking には JSON が無く、パースエラーとして原因が隠れるだけになる。
fn parse_generate_response(gen_res: &OllamaGenerateResponse) -> Result<crate::llm::AnalysisResult> {
    if gen_res.response.trim().is_empty() && gen_res.done_reason.as_deref() == Some("length") {
        return Err(anyhow!(
            "Ollama が生成上限に到達し、応答が空のまま打ち切られました（done_reason=length）。\n\n💡【対処のご案内】\n思考（thinking）が長引いて答えを書く前に打ち切られています。設定画面から thinking を使わないモデルか、より小さいモデルに変更してください。"
        ));
    }

    let raw_text = if !gen_res.response.trim().is_empty() {
        gen_res.response.as_str()
    } else {
        gen_res.thinking.as_deref().unwrap_or("")
    };
    extract_and_parse_json(raw_text)
}

// 英語タグの表記揺れ防止（単数形化＆正規化）
pub fn normalize_tag_en(raw_tag: &str) -> String {
    let mut tag = raw_tag.trim().to_lowercase().replace([' ', '-'], "_");
    tag = tag.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect();
    
    if tag.is_empty() {
        return tag;
    }

    if tag.ends_with("ies") && tag.len() > 4 {
        tag.truncate(tag.len() - 3);
        tag.push('y');
    } else if (tag.ends_with("es") && tag.len() > 4 && !tag.ends_with("shes") && !tag.ends_with("ches"))
        || (tag.ends_with('s') && !tag.ends_with("ss") && tag.len() > 3)
    {
        tag.truncate(tag.len() - 1);
    }

    tag
}

// 対応拡張子
const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "avi", "mov", "webm", "gif"];

/// macOS が残すメタデータ。拡張子は本物の画像と同じなので名前で弾くしかない。
/// - `._` 始まり: AppleDouble（先頭4バイトが 00 05 16 07 で、画像デコーダは開けない）
/// - `__MACOSX/` 配下: mac で作った zip を Windows で展開したときに残るフォルダ
pub fn is_macos_metadata(path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("._"))
    {
        return true;
    }
    path.components()
        .any(|c| c.as_os_str().to_str() == Some("__MACOSX"))
}

pub fn is_supported_file(path: &Path) -> bool {
    if is_macos_metadata(path) {
        return false;
    }
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext_lower = ext.to_lowercase();
        IMAGE_EXTENSIONS.contains(&ext_lower.as_str())
            || VIDEO_EXTENSIONS.contains(&ext_lower.as_str())
    } else {
        false
    }
}

// 軽量ハッシュ（先頭64KBのSHA-256）
pub fn compute_light_hash(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0u8; 64 * 1024];
    let count = file.read(&mut buffer)?;
    let mut hasher = Sha256::new();
    hasher.update(&buffer[..count]);
    Ok(format!("{:x}", hasher.finalize()))
}

// サムネイル生成
pub fn generate_thumbnail(
    file_path: &Path,
    thumb_dir: &Path,
    file_id_str: &str,
) -> Result<PathBuf> {
    if !thumb_dir.exists() {
        fs::create_dir_all(thumb_dir)?;
    }
    let thumb_path = thumb_dir.join(format!("{}.jpg", file_id_str));

    if thumb_path.exists() {
        return Ok(thumb_path);
    }

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        // 拡張子ではなく中身でデコーダを選ぶ。ここで image::open を使うと
        // 中身JPEGの .png がサムネイル無しのまま残る（実測13件がこれだった）
        let img = crate::image_io::decode_image(file_path)?;
        let resized = img.thumbnail(512, 512);
        resized.save(&thumb_path)?;
        Ok(thumb_path)
    } else if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        // GIF等の処理、あるいはFFmpeg呼び出し
        if ext == "gif" {
            if let Ok(img) = crate::image_io::decode_image(file_path) {
                let resized = img.thumbnail(512, 512);
                resized.save(&thumb_path)?;
                return Ok(thumb_path);
            }
        }
        // FFmpegがインストールされている場合のフォールバックコマンド実行
        let mut output = crate::proc::hidden_command("ffmpeg")
            .args([
                "-ss",
                "00:00:01",
                "-i",
                file_path.to_str().unwrap_or(""),
                "-vframes",
                "1",
                "-vf",
                "scale=512:-1",
                thumb_path.to_str().unwrap_or(""),
                "-y",
            ])
            .output();

        if !(output.is_ok() && thumb_path.exists()) {
            // 00:00:01 で失敗した場合は 00:00:00 (先頭フレーム) で再試行
            output = crate::proc::hidden_command("ffmpeg")
                .args([
                    "-ss",
                    "00:00:00",
                    "-i",
                    file_path.to_str().unwrap_or(""),
                    "-vframes",
                    "1",
                    "-vf",
                    "scale=512:-1",
                    thumb_path.to_str().unwrap_or(""),
                    "-y",
                ])
                .output();
        }

        if output.is_ok() && thumb_path.exists() {
            Ok(thumb_path)
        } else {
            // FFmpeg失敗時の代替: エラーを返す
            Err(anyhow!("Failed to generate thumbnail for video"))
        }
    } else {
        Err(anyhow!("Unsupported file format"))
    }
}

// Ollama事前疎通 & モデルチェック
pub async fn check_ollama(base_url: &str, model_name: &str) -> Result<()> {
    let client = Client::new();
    let res = client
        .get(format!("{}/api/tags", base_url))
        .send()
        .await
        .map_err(|e| anyhow!("Failed to connect to Ollama: {}", e))?;

    if !res.status().is_success() {
        return Err(anyhow!("Ollama returned non-success status"));
    }

    let tags_res: OllamaTagsResponse = res.json().await?;
    let model_exists = tags_res.models.iter().any(|m| m.name.starts_with(model_name));

    if !model_exists {
        return Err(anyhow!(
            "Model '{}' not found in Ollama. Available: {:?}",
            model_name,
            tags_res
                .models
                .iter()
                .map(|m| &m.name)
                .collect::<Vec<_>>()
        ));
    }

    Ok(())
}

// Ollamaモデル一覧取得
pub async fn fetch_ollama_models(base_url: &str) -> Result<Vec<String>> {
    // タイムアウトは必須。設定画面を開くたびに同期的に呼ばれるため、
    // Ollama が起動していない・URL が誤っている場合に OS の TCP タイムアウトまで
    // 待たされ、画面が固まったように見える。一覧取得は本来ミリ秒で返る。
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap_or_else(|_| Client::new());
    let res = client.get(format!("{}/api/tags", base_url)).send().await?;
    let tags_res: OllamaTagsResponse = res.json().await?;
    Ok(tags_res.models.into_iter().map(|m| m.name).collect())
}

/// `/api/tags` のモデルのうち、`/api/show` の `capabilities` に `"vision"` を含むものを返す。
///
/// **宣言は「選択肢に出してよい」の根拠でしかない。** `gemma4:e4b` は vision を宣言していながら
/// 解析の成否が大きくばらつく（2026-07-30 に tools/prompt-check で実測。同一12枚で LIGHT 6/12）。
/// 呼び出し側でこれを「動く保証」として見せないこと。
///
/// `/api/show` が失敗したモデルは vision 無しとして扱うが、**キャッシュには入れない**
/// （一時的な失敗を焼き付けず、次の取得でやり直せるようにするため）。
pub async fn fetch_vision_capable_models(base_url: &str, refresh: bool) -> Result<Vec<String>> {
    let names = fetch_ollama_models(base_url).await?;

    if refresh {
        if let Ok(mut cache) = VISION_CAPABILITY_CACHE.lock() {
            *cache = None;
        }
    }

    // キャッシュ済みと未取得をここで仕分けし、ロックは await をまたぐ前に手放す
    let mut known: HashMap<String, bool> = HashMap::new();
    let mut unknown: Vec<String> = Vec::new();
    {
        let guard = VISION_CAPABILITY_CACHE.lock().ok();
        let cached = guard.as_ref().and_then(|c| c.as_ref());
        for name in &names {
            match cached.and_then(|c| c.get(name)) {
                Some(&vision) => {
                    known.insert(name.clone(), vision);
                }
                None => unknown.push(name.clone()),
            }
        }
    }

    if !unknown.is_empty() {
        // 逐次で回すとモデル数に比例して設定画面が待たされる。
        // 接続プールは Client が持つので、clone しても TCP 接続は使い回される。
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());
        let endpoint = format!("{}/api/show", base_url.trim_end_matches('/'));

        let mut tasks = tokio::task::JoinSet::new();
        for name in unknown {
            let client = client.clone();
            let endpoint = endpoint.clone();
            tasks.spawn(async move {
                let vision = match client
                    .post(&endpoint)
                    .json(&serde_json::json!({ "model": name }))
                    .send()
                    .await
                {
                    Ok(res) => res
                        .json::<OllamaShowResponse>()
                        .await
                        .ok()
                        .map(|show| show.capabilities.iter().any(|c| c == "vision")),
                    Err(_) => None,
                };
                (name, vision)
            });
        }

        let mut fetched: Vec<(String, bool)> = Vec::new();
        while let Some(joined) = tasks.join_next().await {
            if let Ok((name, Some(vision))) = joined {
                fetched.push((name, vision));
            }
        }

        if let Ok(mut guard) = VISION_CAPABILITY_CACHE.lock() {
            let cache = guard.get_or_insert_with(HashMap::new);
            for (name, vision) in &fetched {
                cache.insert(name.clone(), *vision);
            }
        }
        for (name, vision) in fetched {
            known.insert(name, vision);
        }
    }

    Ok(names
        .into_iter()
        .filter(|name| known.get(name).copied().unwrap_or(false))
        .collect())
}

// Ollamaモデルの明示的アンロード（VRAM即時解放）
/// settings テーブルから解析プロンプト設定（粒度・高精度強制）を読み込む
pub async fn load_prompt_config(pool: &Pool<Sqlite>) -> crate::llm::PromptConfig {
    let granularity_str: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'tag_granularity'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "atomic".to_string());
    let force_detailed_str: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'force_detailed_prompt'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "false".to_string());

    crate::llm::PromptConfig {
        granularity: crate::llm::TagGranularity::from_setting(&granularity_str),
        force_detailed: force_detailed_str == "true",
    }
}

pub async fn unload_ollama_model(base_url: &str, model_name: &str) -> Result<()> {
    // アンロードはキャンセル完了直前にも呼ばれるため、Ollama が応答しない場合でも
    // 待ち続けないようタイムアウトを設ける（未実行でも keep_alive 満了で解放される）
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| Client::new());
    let body = serde_json::json!({
        "model": model_name,
        "keep_alive": 0
    });
    let _ = client
        .post(format!("{}/api/generate", base_url))
        .json(&body)
        .send()
        .await;
    Ok(())
}

pub static PULL_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Serialize, Deserialize)]
pub struct OllamaPullProgressPayload {
    pub model: String,
    pub status: String,
    pub completed: u64,
    pub total: u64,
    pub percent: f64,
    pub done: bool,
    pub error: Option<String>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
struct OllamaPullStreamChunk {
    status: Option<String>,
    digest: Option<String>,
    total: Option<u64>,
    completed: Option<u64>,
    error: Option<String>,
}

// Ollamaモデルのダウンロード（pull）とリアルタイム進捗通知
pub async fn pull_ollama_model(app_handle: AppHandle, base_url: &str, model_name: &str) -> Result<()> {
    PULL_CANCELLED.store(false, Ordering::SeqCst);

    let client = Client::new();
    let body = serde_json::json!({
        "name": model_name,
        "stream": true
    });

    let mut res = client
        .post(format!("{}/api/pull", base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to send pull request to Ollama: {}", e))?;

    if !res.status().is_success() {
        let err_msg = format!("Ollama pull failed with HTTP status {}", res.status());
        let _ = app_handle.emit("ollama-pull-progress", OllamaPullProgressPayload {
            model: model_name.to_string(),
            status: "error".to_string(),
            completed: 0,
            total: 0,
            percent: 0.0,
            done: true,
            error: Some(err_msg.clone()),
        });
        return Err(anyhow!(err_msg));
    }

    let mut buffer = Vec::new();
    let mut last_completed: u64 = 0;
    let mut last_total: u64 = 0;
    let mut current_status = "Starting download...".to_string();

    while let Ok(Some(chunk)) = res.chunk().await {
        if PULL_CANCELLED.load(Ordering::SeqCst) {
            PULL_CANCELLED.store(false, Ordering::SeqCst);
            crate::logger::log_info(&format!(
                "[Download Cancelled] Model pull '{}' cancelled by user at {} / {} MB.",
                model_name,
                last_completed / (1024 * 1024),
                last_total / (1024 * 1024)
            ));
            let _ = app_handle.emit("ollama-pull-progress", OllamaPullProgressPayload {
                model: model_name.to_string(),
                status: "Cancelled by user".to_string(),
                completed: last_completed,
                total: last_total,
                percent: if last_total > 0 { (last_completed as f64 / last_total as f64) * 100.0 } else { 0.0 },
                done: true,
                error: Some("Download cancelled".to_string()),
            });
            return Err(anyhow!("Download cancelled"));
        }

        buffer.extend_from_slice(&chunk);

        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = buffer.drain(..=pos).collect::<Vec<u8>>();
            let line_str = String::from_utf8_lossy(&line_bytes);
            let line_trimmed = line_str.trim();

            if line_trimmed.is_empty() {
                continue;
            }

            if let Ok(parsed) = serde_json::from_str::<OllamaPullStreamChunk>(line_trimmed) {
                if let Some(err) = parsed.error {
                    let _ = app_handle.emit("ollama-pull-progress", OllamaPullProgressPayload {
                        model: model_name.to_string(),
                        status: "error".to_string(),
                        completed: last_completed,
                        total: last_total,
                        percent: 0.0,
                        done: true,
                        error: Some(err.clone()),
                    });
                    return Err(anyhow!("Ollama pull error: {}", err));
                }

                if let Some(s) = parsed.status {
                    current_status = s;
                }
                if let Some(c) = parsed.completed {
                    last_completed = c;
                }
                if let Some(t) = parsed.total {
                    last_total = t;
                }

                let percent = if last_total > 0 {
                    ((last_completed as f64 / last_total as f64) * 100.0).min(100.0)
                } else {
                    0.0
                };

                let _ = app_handle.emit("ollama-pull-progress", OllamaPullProgressPayload {
                    model: model_name.to_string(),
                    status: current_status.clone(),
                    completed: last_completed,
                    total: last_total,
                    percent,
                    done: false,
                    error: None,
                });
            }
        }
    }

    // Done
    let _ = app_handle.emit("ollama-pull-progress", OllamaPullProgressPayload {
        model: model_name.to_string(),
        status: "success".to_string(),
        completed: last_total,
        total: last_total,
        percent: 100.0,
        done: true,
        error: None,
    });

    Ok(())
}

pub fn cancel_ollama_pull() {
    PULL_CANCELLED.store(true, Ordering::SeqCst);
}

// 生出力から JSON 部分を取り出して柔軟にパースする堅牢抽出関数
fn extract_and_parse_json(raw_text: &str) -> Result<crate::llm::AnalysisResult> {
    let clean_text = raw_text.trim();
    if let Ok(res) = serde_json::from_str::<crate::llm::AnalysisResult>(clean_text) {
        return Ok(res);
    }

    if let (Some(start), Some(end)) = (clean_text.find('{'), clean_text.rfind('}')) {
        if start < end {
            let json_sub = &clean_text[start..=end];
            if let Ok(res) = serde_json::from_str::<crate::llm::AnalysisResult>(json_sub) {
                return Ok(res);
            }
        }
    }

    Err(anyhow!(
        "Failed to parse VLM JSON output. Raw response content: {}",
        clean_text
    ))
}

// スキャン＆バッチ解析メイン処理
pub async fn run_scan_and_batch(
    target_folders: Vec<PathBuf>,
    pool: Pool<Sqlite>,
    app_handle: AppHandle,
    cancel_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
) -> Result<()> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));
    let thumb_dir = app_dir.join("thumbnails");

    // 設定読み込み
    let ollama_url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(&pool)
        .await?
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    let ollama_model: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_model'")
        .fetch_optional(&pool)
        .await?
        .unwrap_or_else(|| "llava".to_string());

    // 疎通確認
    check_ollama(&ollama_url, &ollama_model).await?;

    // ファイルシステム上に存在しない孤立メディアの自動クリーンアップ
    let _ = cleanup_missing_media(&pool).await;

    // 旧バージョンが登録した macOS メタデータ（__MACOSX/._*）の除去
    let _ = cleanup_macos_metadata_media(&pool).await;

    // ユーザーが解析対象から外したパス。ファイル1件ずつ問い合わせると
    // 走査のたびに数千クエリになるので、先にまとめて読み込む
    let excluded_paths = load_excluded_paths(&pool).await;

    // フォルダ登録 DB & 対象ファイルの集約
    let mut files_to_process = Vec::new();
    for folder in &target_folders {
        let folder_str = folder.to_string_lossy().to_string();
        sqlx::query("INSERT OR IGNORE INTO scan_folders (path) VALUES (?1)")
            .bind(&folder_str)
            .execute(&pool)
            .await?;

        for entry in WalkDir::new(folder).into_iter().filter_map(|e| e.ok()) {
            if cancel_flag.load(Ordering::Relaxed) {
                return Ok(());
            }
            let path = entry.path();
            if path.is_file()
                && is_supported_file(path)
                && !excluded_paths.contains(&path.to_string_lossy().to_string())
            {
                files_to_process.push(path.to_path_buf());
            }
        }
    }

    let total_files = files_to_process.len();

    // 1. マルチスレッド並列処理 (サムネイル作成・メタデータ取得・軽量ハッシュ計算)
    let processed_count = Arc::new(AtomicUsize::new(0));

    let scanned_items: Vec<FileScanMeta> = files_to_process
        .par_iter()
        .filter_map(|file_path| {
            if cancel_flag.load(Ordering::Relaxed) {
                return None;
            }

            let file_path_str = file_path.to_string_lossy().to_string();
            let parent_folder = file_path
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let metadata = fs::metadata(file_path).ok()?;
            let file_size = metadata.len() as i64;
            let file_modified_at = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let file_hash = compute_light_hash(file_path).unwrap_or_default();

            // パスハッシュから決定論的なサムネイルファイル名を生成
            let mut hasher = Sha256::new();
            hasher.update(file_path_str.as_bytes());
            let name_hash = format!("{:x}", hasher.finalize());

            let thumb_path_str = generate_thumbnail(file_path, &thumb_dir, &name_hash)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();

            let curr = processed_count.fetch_add(1, Ordering::Relaxed) + 1;
            if curr.is_multiple_of(5) || curr == total_files {
                let _ = app_handle.emit(
                    "batch_progress",
                    ProgressPayload {
                        total: total_files,
                        current: curr,
                        current_file: file_path_str.clone(),
                        status: "Registering media & Thumbnails (Multi-threaded)".to_string(),
                        error_count: 0,
                        is_paused: false,
                    },
                );
            }

            Some(FileScanMeta {
                file_path_str,
                parent_folder,
                file_size,
                file_modified_at,
                file_hash,
                thumb_path_str,
            })
        })
        .collect();

    // DBへの高速トランザクション一括同期
    let mut tx = pool.begin().await?;
    for item in scanned_items {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        let existing = sqlx::query_as::<_, (i64, i64, String, String)>(
            "SELECT id, file_modified_at, thumbnail_path, analysis_status FROM media WHERE file_path = ?1",
        )
        .bind(&item.file_path_str)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some((id, mtime, thumb_path, status)) = existing {
            // すでに completed の場合、ファイル更新日時が変わっていなければ completed を維持
            if status == "completed" {
                if mtime == item.file_modified_at {
                    // DB上のサムネイルが存在しない/空で、今回作成できた場合はサムネイルパスのみ補完更新
                    if (thumb_path.is_empty() || !Path::new(&thumb_path).exists()) && !item.thumb_path_str.is_empty() {
                        let _ = sqlx::query("UPDATE media SET thumbnail_path = ?1 WHERE id = ?2")
                            .bind(&item.thumb_path_str)
                            .bind(id)
                            .execute(&mut *tx)
                            .await;
                    }
                    continue;
                }
            } else if status == "pending" {
                // pending の場合で、更新日時が同じかつサムネイルも存在すればスキップ
                if mtime == item.file_modified_at && !thumb_path.is_empty() && Path::new(&thumb_path).exists() {
                    continue;
                }
            }

            // ファイルが実際に変更されている場合（またはFailedからの復帰等）のみ pending に更新
            sqlx::query(
                "UPDATE media SET file_size = ?1, file_hash = ?2, file_modified_at = ?3, thumbnail_path = ?4, analysis_status = 'pending' WHERE id = ?5"
            )
            .bind(item.file_size)
            .bind(item.file_hash)
            .bind(item.file_modified_at)
            .bind(item.thumb_path_str)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        } else {
            sqlx::query(
                "INSERT INTO media (file_path, parent_folder, thumbnail_path, file_size, file_hash, file_modified_at, analysis_status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')"
            )
            .bind(&item.file_path_str)
            .bind(&item.parent_folder)
            .bind(&item.thumb_path_str)
            .bind(item.file_size)
            .bind(&item.file_hash)
            .bind(item.file_modified_at)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;

    // スキャン段階でキャンセルされた場合は、VLM プロバイダーの初期化まで進めず即座に終了する
    if cancel_flag.load(Ordering::Relaxed) {
        crate::logger::log_info("[Scan Cancelled] Cancelled during the file registration phase. Exiting before VLM initialization.");
        return Ok(());
    }

    // 2. LLM プロバイダーの初期化
    let (llm_provider, factory_config) = crate::llm::factory::create_llm_provider(&pool).await?;

    // Pending件数の取得および VLM 解析ループ
    let pending_items = if target_folders.is_empty() {
        sqlx::query_as::<_, (i64, String, String, i64, Option<String>)>(
            "SELECT id, file_path, thumbnail_path, file_size, file_hash FROM media WHERE analysis_status = 'pending'",
        )
        .fetch_all(&pool)
        .await?
    } else {
        // target_folders が指定されている場合、各フォルダ配下のファイルまたはparent_folderが一致するメディアのみを抽出
        let mut conditions = Vec::new();
        let mut params = Vec::new();

        for folder in &target_folders {
            let folder_str = folder.to_string_lossy().to_string();
            let sql_prefix_slash = format!("{}%", folder_str.replace('\\', "/"));
            let sql_prefix_backslash = format!("{}%", folder_str.replace('/', "\\"));

            conditions.push("(file_path LIKE ? OR file_path LIKE ? OR parent_folder = ?)");
            params.push(sql_prefix_slash);
            params.push(sql_prefix_backslash);
            params.push(folder_str);
        }

        let query_str = format!(
            "SELECT id, file_path, thumbnail_path, file_size, file_hash FROM media WHERE analysis_status = 'pending' AND ({})",
            conditions.join(" OR ")
        );

        let mut query = sqlx::query_as::<_, (i64, String, String, i64, Option<String>)>(&query_str);
        for param in params {
            query = query.bind(param);
        }
        query.fetch_all(&pool).await?
    };

    // 除外されたパスは解析キューから外す。走査で弾いても、除外前に登録済みの
    // レコードが pending のまま残っているため、ここでも落とす必要がある
    let pending_items: Vec<_> = pending_items
        .into_iter()
        .filter(|(_, file_path, _, _, _)| !excluded_paths.contains(file_path))
        .collect();

    let total_pending = pending_items.len();
    let mut consecutive_errors = 0;
    let mut processed_count = 0;
    let mut was_paused_and_unloaded = false;
    let mut is_first_vlm_call = true;

    for (pending_idx, (media_id, file_path_str, thumb_path_str, file_size, file_hash)) in
        pending_items.into_iter().enumerate()
    {
        // 外部LLM使用時の上限枚数制限チェック
        if factory_config.provider.to_lowercase() != "ollama" && processed_count >= factory_config.max_batch_items {
            let limit_msg = format!(
                "External LLM batch limit reached ({}/{} items processed). Pausing batch analysis.",
                processed_count, factory_config.max_batch_items
            );
            crate::logger::log_info(&limit_msg);
            
            let _ = app_handle.emit(
                "batch_progress",
                ProgressPayload {
                    total: total_pending,
                    current: pending_idx,
                    current_file: file_path_str.clone(),
                    status: format!("Batch Limit Reached ({}/{} items) - Stopped", processed_count, factory_config.max_batch_items),
                    error_count: consecutive_errors,
                    is_paused: false,
                },
            );
            break;
        }

        // 1. Pause 待機およびモデル即時アンロード (VRAM 解放)
        let mut pause_logged = false;
        while pause_flag.load(Ordering::Relaxed) {
            if !pause_logged {
                let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
                crate::logger::log_info(&format!(
                    "Scan Paused: Unloaded model '{}' from VRAM.",
                    ollama_model
                ));
                pause_logged = true;
                was_paused_and_unloaded = true;
            }

            if cancel_flag.load(Ordering::Relaxed) {
                let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
                crate::logger::log_info(&format!(
                    "[Scan Cancelled] Cancelled while paused at {}/{} ({} analyzed this run). Model '{}' unloaded from VRAM.",
                    pending_idx, total_pending, processed_count, ollama_model
                ));
                return Ok(());
            }

            let _ = app_handle.emit(
                "batch_progress",
                ProgressPayload {
                    total: total_pending,
                    current: pending_idx,
                    current_file: file_path_str.clone(),
                    status: "Analysis Paused (VRAM Unloaded)".to_string(),
                    error_count: consecutive_errors,
                    is_paused: true,
                },
            );
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }

        if cancel_flag.load(Ordering::Relaxed) {
            let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
            crate::logger::log_info(&format!(
                "[Scan Cancelled] Stopped before analyzing {}/{} '{}' ({} analyzed this run). Model '{}' unloaded from VRAM.",
                pending_idx + 1,
                total_pending,
                Path::new(&file_path_str).file_name().and_then(|n| n.to_str()).unwrap_or(&file_path_str),
                processed_count,
                ollama_model
            ));
            return Ok(());
        }

        // 対象ファイルが存在しない場合はDBから除去してスキップ
        if !Path::new(&file_path_str).exists() {
            let _ = sqlx::query("DELETE FROM media_tags WHERE media_id = ?1").bind(media_id).execute(&pool).await;
            let _ = sqlx::query("DELETE FROM media WHERE id = ?1").bind(media_id).execute(&pool).await;
            if !thumb_path_str.is_empty() {
                let _ = fs::remove_file(&thumb_path_str);
            }
            continue;
        }

        // 2. プロバイダーに委譲して実態に沿った進捗ステータスメッセージを取得
        let is_first = is_first_vlm_call || was_paused_and_unloaded;
        let current_status = llm_provider.status_message(is_first);

        llm_provider.update_progress_context(
            &app_handle,
            &cancel_flag,
            total_pending,
            pending_idx + 1,
            &file_path_str,
            consecutive_errors,
        );

        let _ = app_handle.emit(
            "batch_progress",
            ProgressPayload {
                total: total_pending,
                current: pending_idx + 1,
                current_file: file_path_str.clone(),
                status: current_status.clone(),
                error_count: consecutive_errors,
                is_paused: false,
            },
        );

        let file_name_short = Path::new(&file_path_str).file_name().and_then(|n| n.to_str()).unwrap_or(&file_path_str);
        crate::logger::log_info(&format!(
            "[{}] Analyzing ({}/{}): {}",
            llm_provider.name(), pending_idx + 1, total_pending, file_name_short
        ));

        if is_first {
            was_paused_and_unloaded = false;
            is_first_vlm_call = false;
        }



        let path = Path::new(&file_path_str);
        let thumb_path = Path::new(&thumb_path_str);

        // 重複判定 (同じサイズ & 軽量ハッシュを持つ既存 completed メディアを検索)
        if let Some(ref hash) = file_hash {
            if !hash.is_empty() {
                let duplicate_media_id = sqlx::query_scalar::<_, i64>(
                    "SELECT id FROM media WHERE file_size = ?1 AND file_hash = ?2 AND analysis_status = 'completed' AND id != ?3 LIMIT 1"
                )
                .bind(file_size)
                .bind(hash)
                .bind(media_id)
                .fetch_optional(&pool)
                .await?;

                if let Some(dup_id) = duplicate_media_id {
                    // タグを複製
                    sqlx::query(
                        "INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT ?1, tag_id FROM media_tags WHERE media_id = ?2"
                    )
                    .bind(media_id)
                    .bind(dup_id)
                    .execute(&pool)
                    .await?;

                    sqlx::query("UPDATE media SET analysis_status = 'completed' WHERE id = ?1")
                        .bind(media_id)
                        .execute(&pool)
                        .await?;

                    continue;
                }
            }
        }

        // 解析実行（画像ファイルは元の高解像度画像、動画は抽出フレーム画像を入力とする）
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let target_img_path = if IMAGE_EXTENSIONS.contains(&ext.as_str()) && path.exists() {
            path
        } else if thumb_path.exists() {
            thumb_path
        } else {
            // 動画等でサムネイル生成失敗時は動画バイナリを送らずスキップ
            crate::logger::log_error(&format!("No thumbnail available for video {:?}, skipping Ollama analysis", path));
            let _ = sqlx::query(
                "UPDATE media SET analysis_status = 'failed', analysis_error = ?1,
                 consecutive_failures = CASE WHEN analysis_error_kind = ?2 THEN consecutive_failures + 1 ELSE 1 END,
                 analysis_error_kind = ?2
                 WHERE id = ?3",
            )
                .bind(crate::llm::NO_VIDEO_FRAME_ERROR)
                .bind(crate::llm::error_kind::NO_VIDEO_FRAME)
                .bind(media_id)
                .execute(&pool)
                .await;
            continue;
        };

        // 解析中のキャンセルは Future の drop で HTTP 接続ごと打ち切る（推論完了を待たない）
        let analysis = tokio::select! {
            biased;
            _ = wait_until_cancelled(&cancel_flag) => None,
            res = llm_provider.analyze_image(target_img_path) => Some(res),
        };

        let Some(analysis) = analysis else {
            crate::logger::log_info(&format!(
                "[Scan Cancelled] Aborted the in-flight analysis request for '{}' ({}/{}).",
                file_name_short, pending_idx + 1, total_pending
            ));
            break;
        };

        match analysis {
            Ok(result) => {
                consecutive_errors = 0;
                processed_count += 1;

                // 1. カテゴリを登録
                for cat_en in &result.categories {
                    let clean_cat = cat_en.trim().to_lowercase();
                    if clean_cat.is_empty() {
                        continue;
                    }

                    let tag_id = sqlx::query_scalar::<_, i64>(
                        "INSERT INTO tags (name, is_category) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET is_category=1 RETURNING id"
                    )
                    .bind(&clean_cat)
                    .fetch_one(&pool)
                    .await?;

                    sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
                        .bind(media_id)
                        .bind(tag_id)
                        .execute(&pool)
                        .await?;
                }

                // 2. 自由記述タグ（TagPair: 英語 + 日本語）を登録
                for tag_pair in &result.tags {
                    let norm_en = normalize_tag_en(&tag_pair.en);
                    let norm_ja = tag_pair.ja.trim();

                    if norm_en.is_empty() {
                        continue;
                    }

                    // 英語名で登録/重複解決し、日本語名も保存
                    let tag_id = sqlx::query_scalar::<_, i64>(
                        "INSERT INTO tags (name, name_ja, is_category) VALUES (?1, ?2, 0)
                         ON CONFLICT(name) DO UPDATE SET name_ja = COALESCE(tags.name_ja, EXCLUDED.name_ja) RETURNING id"
                    )
                    .bind(&norm_en)
                    .bind(if norm_ja.is_empty() { None } else { Some(norm_ja) })
                    .fetch_one(&pool)
                    .await?;

                    sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
                        .bind(media_id)
                        .bind(tag_id)
                        .execute(&pool)
                        .await?;
                }

                // 3. 記述的タグ（tag_granularity が atomic 以外の場合のみ、descriptive_tags に入っている）を登録
                for tag_pair in &result.descriptive_tags {
                    let norm_en = normalize_tag_en(&tag_pair.en);
                    let norm_ja = tag_pair.ja.trim();

                    if norm_en.is_empty() {
                        continue;
                    }

                    // 既に basic として登録済みのタグは降格させない（basic を優先）
                    let tag_id = sqlx::query_scalar::<_, i64>(
                        "INSERT INTO tags (name, name_ja, is_category, tag_kind) VALUES (?1, ?2, 0, 'descriptive')
                         ON CONFLICT(name) DO UPDATE SET name_ja = COALESCE(tags.name_ja, EXCLUDED.name_ja) RETURNING id"
                    )
                    .bind(&norm_en)
                    .bind(if norm_ja.is_empty() { None } else { Some(norm_ja) })
                    .fetch_one(&pool)
                    .await?;

                    sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
                        .bind(media_id)
                        .bind(tag_id)
                        .execute(&pool)
                        .await?;
                }

                let cat_list = result.categories.join(", ");
                let tag_list = result.tags
                    .iter()
                    .map(|t| if t.ja.trim().is_empty() { t.en.clone() } else { format!("{}({})", t.ja.trim(), t.en) })
                    .collect::<Vec<_>>()
                    .join(", ");

                crate::logger::log_info(&format!(
                    "[{}] Analyzed '{}' -> Categories: [{}] | Tags: [{}]",
                    llm_provider.name(), file_name_short, cat_list, tag_list
                ));


                sqlx::query("UPDATE media SET analysis_status = 'completed', analysis_error = NULL, analysis_error_kind = NULL, consecutive_failures = 0 WHERE id = ?1")
                    .bind(media_id)
                    .execute(&pool)
                    .await?;

                // 外部LLM利用時は無料枠・レート制限対策としてリクエスト間に短いペーシング待機 (3秒) を挿入
                if factory_config.provider.to_lowercase() != "ollama" {
                    crate::logger::log_info("[Pacing] Waiting 3s before next API request...");
                    for _ in 0..30 {
                        if cancel_flag.load(Ordering::Relaxed) {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
            }

            Err(e) => {
                let err_msg = e.to_string();
                // そのファイル固有の入力エラーは、次のファイルなら成功する。
                // サーバー障害用の連続エラー打ち切りに数えてしまうと、壊れた
                // ファイルが3件並んでいるだけでスキャン全体が進まなくなる。
                let error_kind = crate::llm::classify_error(&err_msg);
                let input_error = crate::llm::is_media_input_error(&err_msg);
                if !input_error {
                    consecutive_errors += 1;
                }
                crate::logger::log_error(&format!(
                    "[{}] Failed to analyze {}: {}{}",
                    llm_provider.name(),
                    file_name_short,
                    err_msg,
                    if input_error { " (this file only; scan continues)" } else { "" }
                ));

                // 同じ種別で連続して失敗した回数を数える。種別が変われば1に戻す。
                // SQLite は SET の右辺を更新前の値で評価するので、同じ文の中で
                // analysis_error_kind を比較しつつ上書きできる
                sqlx::query(
                    "UPDATE media SET analysis_status = 'failed', analysis_error = ?1,
                     consecutive_failures = CASE WHEN analysis_error_kind = ?2 THEN consecutive_failures + 1 ELSE 1 END,
                     analysis_error_kind = ?2
                     WHERE id = ?3",
                )
                    .bind(&err_msg)
                    .bind(error_kind)
                    .bind(media_id)
                    .execute(&pool)
                    .await?;


                if consecutive_errors >= 3 {
                    let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
                    let _ = app_handle.emit(
                        "batch_progress",
                        ProgressPayload {
                            total: total_pending,
                            current: pending_idx + 1,
                            current_file: file_path_str,
                            status: "Stopped due to 3 consecutive errors with Ollama".to_string(),
                            error_count: consecutive_errors,
                            is_paused: false,
                        },
                    );
                    return Err(anyhow!("Aborted scan due to 3 consecutive Ollama errors"));
                }
            }
        }
    }

    if cancel_flag.load(Ordering::Relaxed) {
        let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
        crate::logger::log_info(&format!(
            "[Scan Cancelled] Batch process cancelled after the analysis loop ({}/{} analyzed). Exiting clean.",
            processed_count, total_pending
        ));
        return Ok(());
    }

    // 未使用（どのメディアにも紐付いていない）自由記述タグを自動クリーンアップ
    let deleted_tags = sqlx::query(
        "DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)"
    )
    .execute(&pool)
    .await?
    .rows_affected();

    if deleted_tags > 0 {
        crate::logger::log_info(&format!("Cleaned up {} unused orphaned tags from database.", deleted_tags));
    }

    // 自動 VRAM 解放 (モデルをメモリから即座にアンロード)
    let _ = unload_ollama_model(&ollama_url, &ollama_model).await;

    let _ = app_handle.emit(
        "batch_progress",
        ProgressPayload {
            total: total_files,
            current: total_files,
            current_file: "".to_string(),
            status: "Completed".to_string(),
            error_count: consecutive_errors,
            is_paused: false,
        },
    );

    // **スキャン後の自動タグ整理は廃止した（2026-08-05）。**
    //
    // 以前はここで `run_suggest_tag_merges_logic` を実行しキャッシュを更新していたが、
    // 3つの問題があった:
    //
    //   1. **上書き** — 作り直し後の LLM 経路は実測37分かかる。その結果を表示中でも
    //      メディアを1件取り込めば消えてしまう
    //   2. **意図しない LLM 実行** — タグ301件未満のライブラリでは LLM 判定まで自動で走っていた
    //   3. **不可視** — モーダルを開いていなくてもキャッシュが書き換わる
    //
    // 提案の生成は常にユーザーが起動する。代わりに UI 側で
    // 「前回の検出以降にタグが N 件変わっています」と示して再実行を促す。
    // 設計: `_plan/20260805_tag_organize_rebuild_implementation_plan.md` §7

    Ok(())
}

// 動画の指定時間（タイムスタンプ）フレーム抽出 ＆ 高精度VLM解析 ＆ サムネイル上書き（完全保護・VRAMアンロード対応）
pub async fn custom_analyze_video_media(
    pool: &Pool<Sqlite>,
    media_id: i64,
    timestamp_seconds: f64,
    cancel_flag: Arc<AtomicBool>,
) -> Result<()> {
    // 1. DBから対象メディア情報を取得
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT file_path, thumbnail_path FROM media WHERE id = ?1"
    )
    .bind(media_id)
    .fetch_optional(pool)
    .await?;

    let (file_path_str, thumb_path_str) = match row {
        Some(r) => r,
        None => return Err(anyhow!("Media not found with id {}", media_id)),
    };

    let file_path = PathBuf::from(&file_path_str);
    let thumb_path = PathBuf::from(&thumb_path_str);

    if !file_path.exists() {
        return Err(anyhow!("Source video file does not exist: {}", file_path_str));
    }

    // Settings から Ollama 設定を取得
    let ollama_url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(pool)
        .await?
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    let ollama_model: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_model'")
        .fetch_optional(pool)
        .await?
        .unwrap_or_else(|| "llava".to_string());

    let prompt_config = load_prompt_config(pool).await;

    // 疎通確認
    check_ollama(&ollama_url, &ollama_model).await?;

    // 一時ディレクトリの作成
    let temp_dir = thumb_path.parent().unwrap_or(Path::new("./data")).join("temp_frames");
    if !temp_dir.exists() {
        let _ = fs::create_dir_all(&temp_dir);
    }

    // 2. FFmpegで動画の再生時間 (Duration) を取得して範囲クランプ
    let duration = get_video_duration(&file_path).unwrap_or(300.0);
    let safe_timestamp = timestamp_seconds.max(0.0).min(duration);

    let main_frame_path = temp_dir.join(format!("custom_{}_main.jpg", media_id));
    let pre_frame_path = temp_dir.join(format!("custom_{}_pre.jpg", media_id));
    let post_frame_path = temp_dir.join(format!("custom_{}_post.jpg", media_id));

    // 自動クリーンアップクロージャ
    let cleanup_temp = || {
        let _ = fs::remove_file(&main_frame_path);
        let _ = fs::remove_file(&pre_frame_path);
        let _ = fs::remove_file(&post_frame_path);
    };

    // FFmpeg でメインフレームおよび前後サブフレームの抽出
    let extract_frame = |time_sec: f64, out_path: &Path| -> bool {
        let time_str = format!("{:.2}", time_sec);
        let output = crate::proc::hidden_command("ffmpeg")
            .args([
                "-ss",
                &time_str,
                "-i",
                file_path.to_str().unwrap_or(""),
                "-vframes",
                "1",
                "-vf",
                "scale=512:-1",
                out_path.to_str().unwrap_or(""),
                "-y",
            ])
            .output();
        output.is_ok() && out_path.exists()
    };

    let main_ok = extract_frame(safe_timestamp, &main_frame_path);
    if cancel_flag.load(Ordering::Relaxed) {
        cleanup_temp();
        let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
        return Err(anyhow!("Task canceled by user"));
    }

    if !main_ok {
        cleanup_temp();
        let _ = unload_ollama_model(&ollama_url, &ollama_model).await;
        return Err(anyhow!("Failed to extract video frame at {}s", safe_timestamp));
    }

    let pre_ok = extract_frame((safe_timestamp - 2.0).max(0.0), &pre_frame_path);
    let post_ok = extract_frame((safe_timestamp + 2.0).min(duration), &post_frame_path);

    // 3. Ollama へマルチ画像 VLM 解析リクエスト送信
    let client = Client::new();
    // バッチ解析と同様、キャンセル時は生成完了を待たずリクエストを打ち切る
    let res = tokio::select! {
        biased;
        _ = wait_until_cancelled(&cancel_flag) => Err(anyhow!("Task canceled by user during the analysis request")),
        r = analyze_multi_frame_with_ollama(
            &client,
            &ollama_url,
            &ollama_model,
            &main_frame_path,
            if pre_ok { Some(&pre_frame_path) } else { None },
            if post_ok { Some(&post_frame_path) } else { None },
            cancel_flag.clone(),
            &prompt_config,
        ) => r,
    };

    // 必ず VRAM を即時解放
    let _ = unload_ollama_model(&ollama_url, &ollama_model).await;

    match res {
        Ok(analysis_result) => {
            // 4. 成功した場合のみ: サムネイルの上書きと DB のアトミック更新
            if let Err(e) = fs::copy(&main_frame_path, &thumb_path) {
                crate::logger::log_error(&format!("Failed to update thumbnail file: {}", e));
            }

            let mut tx = pool.begin().await?;

            // 既存タグをクリア
            sqlx::query("DELETE FROM media_tags WHERE media_id = ?1")
                .bind(media_id)
                .execute(&mut *tx)
                .await?;

            for cat_en in analysis_result.categories {
                let clean_cat = cat_en.trim().to_lowercase();
                if clean_cat.is_empty() { continue; }
                let tag_id = sqlx::query_scalar::<_, i64>(
                    "INSERT INTO tags (name, is_category) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET is_category=1 RETURNING id"
                )
                .bind(&clean_cat)
                .fetch_one(&mut *tx)
                .await?;

                sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
                    .bind(media_id)
                    .bind(tag_id)
                    .execute(&mut *tx)
                    .await?;
            }

            for tag_pair in analysis_result.tags {
                let clean_en = normalize_tag_en(&tag_pair.en);
                let clean_ja = tag_pair.ja.trim().to_string();
                if clean_en.is_empty() { continue; }

                let tag_id = sqlx::query_scalar::<_, i64>(
                    "INSERT INTO tags (name, name_ja, is_category) VALUES (?1, ?2, 0) ON CONFLICT(name) DO UPDATE SET name_ja = COALESCE(EXCLUDED.name_ja, tags.name_ja) RETURNING id"
                )
                .bind(&clean_en)
                .bind(&clean_ja)
                .fetch_one(&mut *tx)
                .await?;

                sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
                    .bind(media_id)
                    .bind(tag_id)
                    .execute(&mut *tx)
                    .await?;
            }

            for tag_pair in analysis_result.descriptive_tags {
                let clean_en = normalize_tag_en(&tag_pair.en);
                let clean_ja = tag_pair.ja.trim().to_string();
                if clean_en.is_empty() { continue; }

                let tag_id = sqlx::query_scalar::<_, i64>(
                    "INSERT INTO tags (name, name_ja, is_category, tag_kind) VALUES (?1, ?2, 0, 'descriptive')
                     ON CONFLICT(name) DO UPDATE SET name_ja = COALESCE(tags.name_ja, EXCLUDED.name_ja) RETURNING id"
                )
                .bind(&clean_en)
                .bind(&clean_ja)
                .fetch_one(&mut *tx)
                .await?;

                sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
                    .bind(media_id)
                    .bind(tag_id)
                    .execute(&mut *tx)
                    .await?;
            }

            sqlx::query("UPDATE media SET analysis_status = 'completed', analysis_error = NULL, analysis_error_kind = NULL, consecutive_failures = 0, thumbnail_path = ?1 WHERE id = ?2")
                .bind(thumb_path.to_string_lossy().to_string())
                .bind(media_id)
                .execute(&mut *tx)
                .await?;

            tx.commit().await?;
            cleanup_temp();
            crate::logger::log_info(&format!("Custom frame analysis & thumbnail update completed for media {}", media_id));
            Ok(())
        }
        Err(e) => {
            // 失敗・キャンセル時: DBや既存サムネイルを一切変更せず完全保護（ロールバック）
            cleanup_temp();
            crate::logger::log_error(&format!("Custom frame analysis failed or canceled for media {}: {}. Original tags & thumbnail preserved.", media_id, e));
            Err(e)
        }
    }
}

// 補助: FFmpeg を使って動画の再生時間 (秒) を取得
fn get_video_duration(file_path: &Path) -> Result<f64> {
    let output = crate::proc::hidden_command("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            file_path.to_str().unwrap_or(""),
        ])
        .output()?;

    let dur_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    dur_str.parse::<f64>().map_err(|e| anyhow!("Failed to parse duration: {}", e))
}

// 補助: マルチフレーム VLM 解析リクエスト
async fn analyze_multi_frame_with_ollama(
    client: &Client,
    base_url: &str,
    model_name: &str,
    main_frame: &Path,
    pre_frame: Option<&Path>,
    post_frame: Option<&Path>,
    cancel_flag: Arc<AtomicBool>,
    prompt_config: &crate::llm::PromptConfig,
) -> Result<crate::llm::AnalysisResult> {
    let mut images_b64 = Vec::new();

    let encode_jpg = |path: &Path| -> Result<String> {
        let img = crate::image_io::decode_image(path)?;
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Jpeg)?;
        Ok(base64::Engine::encode(&base64::engine::general_purpose::STANDARD, buffer.into_inner()))
    };

    if let Ok(b64) = encode_jpg(main_frame) {
        images_b64.push(b64);
    }
    if let Some(pf) = pre_frame {
        if let Ok(b64) = encode_jpg(pf) {
            images_b64.push(b64);
        }
    }
    if let Some(pf) = post_frame {
        if let Ok(b64) = encode_jpg(pf) {
            images_b64.push(b64);
        }
    }

    if images_b64.is_empty() {
        return Err(anyhow!("No valid frame images to analyze"));
    }

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(anyhow!("Canceled before API call"));
    }

    let base_prompt = crate::llm::get_vlm_prompt("Ollama", model_name, prompt_config);
    let prompt = format!("{}\n\nNote: Multiple sequential video frames (3 frames: pre, main, post) are provided above. Synthesize them to generate accurate tags and categories capturing the core unified theme across frames.", base_prompt);

    let req_body = OllamaGenerateRequest {
        model: model_name.to_string(),
        prompt: prompt.to_string(),
        images: images_b64.clone(),
        stream: false,
        options: OllamaOptions {
            temperature: 0.1,
            num_ctx: 16384,
        },
    };

    let res = client
        .post(format!("{}/api/generate", base_url))
        .json(&req_body)
        .send()
        .await?;

    if cancel_flag.load(Ordering::Relaxed) {
        return Err(anyhow!("Task canceled during API call"));
    }

    if res.status().is_success() {
        let gen_res: OllamaGenerateResponse = res.json().await?;
        return parse_generate_response(&gen_res);
    }

    let err_status = res.status();
    let err_text = res.text().await.unwrap_or_default();

    // マルチフレーム(2枚以上)でエラーが発生した場合は、メインフレーム1枚でフォールバック再試行
    if images_b64.len() > 1 {
        crate::logger::log_error(&format!(
            "Ollama multi-frame analysis failed (Status {}: {}). Retrying with single main frame...",
            err_status, err_text
        ));

        let fallback_req = OllamaGenerateRequest {
            model: model_name.to_string(),
            prompt: prompt.to_string(),
            images: vec![images_b64[0].clone()],
            stream: false,
            options: OllamaOptions {
                temperature: 0.1,
                num_ctx: 8192,
            },
        };

        let fb_res = client
            .post(format!("{}/api/generate", base_url))
            .json(&fallback_req)
            .send()
            .await?;

        if cancel_flag.load(Ordering::Relaxed) {
            return Err(anyhow!("Task canceled during fallback API call"));
        }

        if !fb_res.status().is_success() {
            let fb_status = fb_res.status();
            let fb_text = fb_res.text().await.unwrap_or_default();
            return Err(anyhow!(
                "Ollama API Error (Fallback) Status {}: {}\n\n💡【対処のご案内】\nGPUのVRAM不足またはOllamaプロセスの異常終了の可能性があります。設定画面からより軽量なモデル（例: llava:7b や moondream など）に変更するか、Ollamaの再起動をお試しください。",
                fb_status,
                fb_text
            ));
        }

        let gen_res: OllamaGenerateResponse = fb_res.json().await?;
        return parse_generate_response(&gen_res);
    }

    Err(anyhow!(
        "Ollama API Error Status {}: {}\n\n💡【対処のご案内】\nGPUのVRAM不足またはOllamaプロセスの異常終了の可能性があります。設定画面からより軽量なモデル（例: llava:7b や moondream など）に変更するか、Ollamaの再起動をお試しください。",
        err_status,
        err_text
    ))
}

/// 単一メディア（画像/動画サムネイル）の再解析を実行する
pub async fn reanalyze_single_media(
    pool: &Pool<Sqlite>,
    media_id: i64,
) -> Result<()> {
    let (file_path_str, thumb_path_str) = sqlx::query_as::<_, (String, String)>(
        "SELECT file_path, thumbnail_path FROM media WHERE id = ?1"
    )
    .fetch_one(pool)
    .await?;

    let (llm_provider, _) = crate::llm::factory::create_llm_provider(pool).await?;

    let path = Path::new(&file_path_str);
    let thumb_path = Path::new(&thumb_path_str);

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let target_img_path = if IMAGE_EXTENSIONS.contains(&ext.as_str()) && path.exists() {
        path
    } else if thumb_path.exists() {
        thumb_path
    } else {
        return Err(anyhow!("No valid image file or thumbnail frame found for analysis"));
    };

    let result = llm_provider.analyze_image(target_img_path).await?;

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM media_tags WHERE media_id = ?1").bind(media_id).execute(&mut *tx).await?;

    for cat_en in &result.categories {
        let clean_cat = cat_en.trim().to_lowercase();
        if clean_cat.is_empty() { continue; }
        let tag_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO tags (name, is_category) VALUES (?1, 1) ON CONFLICT(name) DO UPDATE SET is_category=1 RETURNING id"
        )
        .bind(&clean_cat)
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
            .bind(media_id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await?;
    }

    for tag_pair in &result.tags {
        let norm_en = normalize_tag_en(&tag_pair.en);

        if norm_en.is_empty() { continue; }
        let norm_ja = tag_pair.ja.trim().to_string();

        let tag_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO tags (name, name_ja, is_category) VALUES (?1, ?2, 0)
             ON CONFLICT(name) DO UPDATE SET name_ja = COALESCE(EXCLUDED.name_ja, tags.name_ja) RETURNING id"
        )
        .bind(&norm_en)
        .bind(if norm_ja.is_empty() { None } else { Some(&norm_ja) })
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
            .bind(media_id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await?;
    }

    for tag_pair in &result.descriptive_tags {
        let norm_en = normalize_tag_en(&tag_pair.en);

        if norm_en.is_empty() { continue; }
        let norm_ja = tag_pair.ja.trim().to_string();

        let tag_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO tags (name, name_ja, is_category, tag_kind) VALUES (?1, ?2, 0, 'descriptive')
             ON CONFLICT(name) DO UPDATE SET name_ja = COALESCE(tags.name_ja, EXCLUDED.name_ja) RETURNING id"
        )
        .bind(&norm_en)
        .bind(if norm_ja.is_empty() { None } else { Some(&norm_ja) })
        .fetch_one(&mut *tx)
        .await?;

        sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
            .bind(media_id)
            .bind(tag_id)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query("UPDATE media SET analysis_status = 'completed', analysis_error = NULL, analysis_error_kind = NULL, consecutive_failures = 0 WHERE id = ?1")
        .bind(media_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    let cat_list = result.categories.join(", ");
    let tag_list = result.tags
        .iter()
        .map(|t| if t.ja.trim().is_empty() { t.en.clone() } else { format!("{}({})", t.ja.trim(), t.en) })
        .collect::<Vec<_>>()
        .join(", ");

    let file_name_short = path.file_name().and_then(|n| n.to_str()).unwrap_or(&file_path_str);
    crate::logger::log_info(&format!(
        "[{}] Re-analyzed '{}' -> Categories: [{}] | Tags: [{}]",
        llm_provider.name(), file_name_short, cat_list, tag_list
    ));

    Ok(())
}

// 存在しない（削除された）メディアレコードおよびサムネイルをDBから自動クリーンアップ
pub async fn cleanup_missing_media(pool: &Pool<Sqlite>) -> Result<usize> {
    let all_media = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT id, file_path, thumbnail_path FROM media"
    )
    .fetch_all(pool)
    .await?;

    let mut ids_to_delete = Vec::new();
    let mut thumbs_to_delete = Vec::new();
    let mut stale_thumb_ids = Vec::new();

    for (id, file_path_str, thumb_path_str) in all_media {
        let file_path = Path::new(&file_path_str);
        if !file_path.exists() {
            ids_to_delete.push(id);
            if !thumb_path_str.is_empty() {
                thumbs_to_delete.push(thumb_path_str);
            }
        } else if !thumb_path_str.is_empty() && !Path::new(&thumb_path_str).exists() {
            stale_thumb_ids.push(id);
        }
    }

    let deleted_count = ids_to_delete.len();

    // 消失したサムネイルパスのクリア
    if !stale_thumb_ids.is_empty() {
        for chunk in stale_thumb_ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let query = format!("UPDATE media SET thumbnail_path = '' WHERE id IN ({})", placeholders);
            let mut q = sqlx::query(&query);
            for id in chunk {
                q = q.bind(id);
            }
            let _ = q.execute(pool).await;
        }
        crate::logger::log_info(&format!("Cleared {} stale thumbnail paths from database", stale_thumb_ids.len()));
    }

    for thumb_path in thumbs_to_delete {
        let p = Path::new(&thumb_path);
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }

    if !ids_to_delete.is_empty() {
        let mut tx = pool.begin().await?;
        for chunk in ids_to_delete.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");

            let query_tags = format!("DELETE FROM media_tags WHERE media_id IN ({})", placeholders);
            let mut q_tags = sqlx::query(&query_tags);
            for id in chunk {
                q_tags = q_tags.bind(id);
            }
            q_tags.execute(&mut *tx).await?;

            let query_media = format!("DELETE FROM media WHERE id IN ({})", placeholders);
            let mut q_media = sqlx::query(&query_media);
            for id in chunk {
                q_media = q_media.bind(id);
            }
            q_media.execute(&mut *tx).await?;
        }
        tx.commit().await?;

        // 浮いたタグの自動削除
        let _ = sqlx::query("DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)")
            .execute(pool)
            .await;
    }

    if deleted_count > 0 {
        crate::logger::log_info(&format!("Cleaned up {} missing media records", deleted_count));
    }

    Ok(deleted_count)
}

/// ユーザーが解析対象から外したパスの集合を読み込む。
///
/// 読み取りに失敗した場合は空集合を返す。除外が効かずに解析されるのは
/// やり直せるが、ここで失敗を伝播させるとスキャン自体が始まらなくなる。
pub async fn load_excluded_paths(pool: &Pool<Sqlite>) -> HashSet<String> {
    sqlx::query_scalar::<_, String>("SELECT path FROM excluded_paths")
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .collect()
}

// 拡張子だけで対応判定していた頃に登録された macOS メタデータのレコードを除去する。
// `__MACOSX/._*.png` は中身が AppleDouble なので解析すると必ず失敗し、
// 解析キューの先頭に居座ってスキャン全体を止める原因になっていた。
pub async fn cleanup_macos_metadata_media(pool: &Pool<Sqlite>) -> Result<usize> {
    let all_media = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT id, file_path, thumbnail_path FROM media"
    )
    .fetch_all(pool)
    .await?;

    let mut ids_to_delete = Vec::new();
    let mut thumbs_to_delete = Vec::new();

    for (id, file_path_str, thumb_path_str) in all_media {
        if is_macos_metadata(Path::new(&file_path_str)) {
            ids_to_delete.push(id);
            if !thumb_path_str.is_empty() {
                thumbs_to_delete.push(thumb_path_str);
            }
        }
    }

    if ids_to_delete.is_empty() {
        return Ok(0);
    }

    for thumb_path in thumbs_to_delete {
        let p = Path::new(&thumb_path);
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }

    let deleted_count = ids_to_delete.len();
    let mut tx = pool.begin().await?;
    for chunk in ids_to_delete.chunks(500) {
        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");

        let query_tags = format!("DELETE FROM media_tags WHERE media_id IN ({})", placeholders);
        let mut q_tags = sqlx::query(&query_tags);
        for id in chunk {
            q_tags = q_tags.bind(id);
        }
        q_tags.execute(&mut *tx).await?;

        let query_media = format!("DELETE FROM media WHERE id IN ({})", placeholders);
        let mut q_media = sqlx::query(&query_media);
        for id in chunk {
            q_media = q_media.bind(id);
        }
        q_media.execute(&mut *tx).await?;
    }
    tx.commit().await?;

    // 浮いたタグの自動削除
    let _ = sqlx::query("DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)")
        .execute(pool)
        .await;

    crate::logger::log_info(&format!(
        "Removed {} macOS metadata records (__MACOSX/ or '._' prefixed) from database",
        deleted_count
    ));

    Ok(deleted_count)
}

// 登録済みフォルダの同期（新規追加、削除、移動・リネーム検知、更新検知）
pub async fn run_sync_folders(
    app_handle: &AppHandle,
    pool: &Pool<Sqlite>,
    cancel_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
) -> Result<()> {
    crate::logger::log_info("Starting folder sync (Sync pipeline)...");

    let scan_folders: Vec<String> = sqlx::query_scalar("SELECT path FROM scan_folders;")
        .fetch_all(pool)
        .await?;

    if scan_folders.is_empty() {
        crate::logger::log_info("No scan folders registered for sync.");
        return Ok(());
    }

    let _ = cleanup_and_detect_moves(pool, &scan_folders).await;
    let target_paths: Vec<PathBuf> = scan_folders.iter().map(PathBuf::from).collect();
    run_scan_and_batch(target_paths, pool.clone(), app_handle.clone(), cancel_flag, pause_flag).await?;

    crate::logger::log_info("Folder sync completed successfully.");
    Ok(())
}

async fn cleanup_and_detect_moves(
    pool: &Pool<Sqlite>,
    scan_folders: &[String],
) -> Result<()> {
    let db_rows: Vec<(i64, String, i64, Option<String>, String)> =
        sqlx::query_as("SELECT id, file_path, file_size, file_hash, thumbnail_path FROM media;")
            .fetch_all(pool)
            .await?;

    let mut missing_records = Vec::new();
    for row in db_rows {
        let (id, file_path, size, hash, thumb) = row;
        if !Path::new(&file_path).exists() {
            missing_records.push((id, file_path, size, hash, thumb));
        }
    }

    if missing_records.is_empty() {
        return Ok(());
    }

    let mut disk_files = Vec::new();
    for folder in scan_folders {
        let folder_path = Path::new(folder);
        if !folder_path.exists() {
            continue;
        }
        for entry in WalkDir::new(folder_path).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() && is_supported_file(path) {
                let path_str = path.to_string_lossy().to_string();
                disk_files.push(path_str);
            }
        }
    }

    let existing_paths: std::collections::HashSet<String> =
        sqlx::query_scalar("SELECT file_path FROM media;")
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();

    let new_disk_files: Vec<String> = disk_files
        .into_iter()
        .filter(|p| !existing_paths.contains(p))
        .collect();

    let new_file_metas: Vec<(String, i64, Option<String>)> = new_disk_files
        .par_iter()
        .filter_map(|p_str| {
            let p = Path::new(p_str);
            let meta = fs::metadata(p).ok()?;
            let size = meta.len() as i64;
            let hash = compute_light_hash(p).ok();
            Some((p_str.clone(), size, hash))
        })
        .collect();

    let mut matched_missing_ids = std::collections::HashSet::new();

    for (new_path, new_size, new_hash) in new_file_metas {
        if let Some(new_h) = &new_hash {
            if let Some(found) = missing_records.iter().find(|(id, _, m_size, m_hash, _)| {
                !matched_missing_ids.contains(id) && m_size == &new_size && m_hash.as_ref() == Some(new_h)
            }) {
                let (id, old_path, _, _, _) = found;
                matched_missing_ids.insert(*id);
                crate::logger::log_info(&format!(
                    "Detected file move/rename: '{}' -> '{}' (Media ID: {})",
                    old_path, new_path, id
                ));

                let parent_folder = Path::new(&new_path)
                    .parent()
                    .and_then(|p| p.file_name())
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();

                let mtime = fs::metadata(&new_path)
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::now())
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64;

                let _ = sqlx::query(
                    "UPDATE media SET file_path = ?1, parent_folder = ?2, file_modified_at = ?3, updated_at = strftime('%s', 'now') WHERE id = ?4;"
                )
                .bind(&new_path)
                .bind(&parent_folder)
                .bind(mtime)
                .bind(id)
                .execute(pool)
                .await;
            }
        }
    }

    let still_missing: Vec<_> = missing_records
        .into_iter()
        .filter(|(id, _, _, _, _)| !matched_missing_ids.contains(id))
        .collect();

    if !still_missing.is_empty() {
        let missing_ids: Vec<i64> = still_missing.iter().map(|(id, _, _, _, _)| *id).collect();
        let missing_thumbs: Vec<String> = still_missing.into_iter().map(|(_, _, _, _, t)| t).collect();

        for thumb in missing_thumbs {
            if Path::new(&thumb).exists() {
                let _ = fs::remove_file(&thumb);
            }
        }

        let mut tx = pool.begin().await?;
        for chunk in missing_ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let q_tags = format!("DELETE FROM media_tags WHERE media_id IN ({})", placeholders);
            let mut qt = sqlx::query(&q_tags);
            for id in chunk {
                qt = qt.bind(id);
            }
            qt.execute(&mut *tx).await?;

            let q_media = format!("DELETE FROM media WHERE id IN ({})", placeholders);
            let mut qm = sqlx::query(&q_media);
            for id in chunk {
                qm = qm.bind(id);
            }
            qm.execute(&mut *tx).await?;
        }
        tx.commit().await?;

        let _ = sqlx::query("DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)")
            .execute(pool)
            .await;
    }

    Ok(())
}




#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    /// macOS のメタデータは拡張子が本物の画像と同じなので、拡張子だけで
    /// 判定すると解析キューに入り込む。実際に `__MACOSX/._全統合版.png`
    /// （中身は AppleDouble）が登録され、スキャンを止めた。
    #[test]
    fn macos_metadata_files_are_not_supported_media() {
        for junk in [
            r"D:\pic\__MACOSX\葉陰ユウさん_20240104\._全統合版.png",
            r"D:\pic\._単体_エフェクト有.png",
            r"D:\pic\__MACOSX\clip.mp4",
        ] {
            assert!(
                !is_supported_file(Path::new(junk)),
                "解析対象から外れていない: {junk}"
            );
        }

        // 名前が似ているだけの通常ファイルは巻き添えにしない
        for ok in [
            r"D:\pic\葉陰ユウさん_20240104\全統合版.png",
            r"D:\pic\_単体.png",
            r"D:\pic\a._b.png",
            r"D:\__MACOSX_backup\photo.png",
        ] {
            assert!(is_supported_file(Path::new(ok)), "誤って除外された: {ok}");
        }
    }

    /// 打ち切られた応答を「JSONが壊れている」と誤診しないことの回帰テスト。
    /// 途切れた thinking を代替に使うと、原因が生成上限であることが隠れる。
    #[test]
    fn truncated_response_reports_the_generation_limit_not_a_parse_error() {
        let truncated = OllamaGenerateResponse {
            response: String::new(),
            thinking: Some("Looking at the frames, I see a can of".to_string()),
            done_reason: Some("length".to_string()),
        };
        let err = parse_generate_response(&truncated).unwrap_err().to_string();
        assert!(err.contains("done_reason=length"), "打ち切りが原因だと分かる文言が必要: {err}");

        // 正常終了なら、答えが thinking 側にあっても拾う
        let in_thinking = OllamaGenerateResponse {
            response: String::new(),
            thinking: Some(r#"考えた結果: {"categories":["Food"],"tags":[{"en":"can","ja":"缶"}]}"#.to_string()),
            done_reason: Some("stop".to_string()),
        };
        let parsed = parse_generate_response(&in_thinking).expect("thinking 側の JSON を拾えていない");
        assert_eq!(parsed.categories, vec!["Food"]);
    }

    /// 解析中のキャンセルが「推論の完了待ち」に引きずられないことの回帰テスト。
    /// 長時間かかる解析 Future を select! の負け側として drop できることを確認する。
    #[tokio::test]
    async fn cancellation_aborts_a_long_running_analysis() {
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let flag = cancel_flag.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            flag.store(true, Ordering::Relaxed);
        });

        let started = Instant::now();
        let result: Option<()> = tokio::select! {
            biased;
            _ = wait_until_cancelled(&cancel_flag) => None,
            _ = tokio::time::sleep(Duration::from_secs(30)) => Some(()),
        };

        assert!(result.is_none(), "cancellation must win over the pending analysis");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cancellation took {:?}; it must not wait for the analysis to finish",
            started.elapsed()
        );
    }

    /// キャンセルされていない間は待ち続け、解析側の完了を横取りしないこと。
    #[tokio::test]
    async fn a_completed_analysis_wins_when_not_cancelled() {
        let cancel_flag = Arc::new(AtomicBool::new(false));

        let result: Option<&str> = tokio::select! {
            biased;
            _ = wait_until_cancelled(&cancel_flag) => None,
            _ = tokio::time::sleep(Duration::from_millis(50)) => Some("analyzed"),
        };

        assert_eq!(result, Some("analyzed"));
    }
}
