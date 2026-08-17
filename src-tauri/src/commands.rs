use crate::batch::{fetch_ollama_models, run_scan_and_batch};
use crate::db::DbState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ScanState {
    pub cancel_flag: Arc<AtomicBool>,
    pub pause_flag: Arc<AtomicBool>,
    pub is_running: Arc<AtomicBool>,
}

/// バックグラウンドスキャンを実行し、その終了理由をログに残す。
///
/// 各コマンドは `let _ = run_scan_and_batch(...)` でエラーを握り潰しており、
/// 連続エラーによる中断やDBエラーで終了しても何も記録されていなかった。
async fn run_scan_and_log_outcome(
    label: &str,
    target_folders: Vec<std::path::PathBuf>,
    pool: sqlx::Pool<sqlx::Sqlite>,
    app_handle: AppHandle,
    cancel_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
) {
    crate::logger::log_info(&format!("[Scan Started] {}", label));
    match run_scan_and_batch(target_folders, pool, app_handle, cancel_flag, pause_flag).await {
        Ok(()) => crate::logger::log_info(&format!("[Scan Finished] {} ended normally.", label)),
        Err(e) => crate::logger::log_error(&format!("[Scan Aborted] {} terminated with an error: {}", label, e)),
    }
}

pub struct TaskGuard(pub Arc<AtomicBool>);

impl Drop for TaskGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

pub fn cmd_err<E: std::fmt::Display>(cmd_name: &str, err: E) -> String {
    let msg = format!("[Command Error: {}] {}", cmd_name, err);
    crate::logger::log_error(&msg);
    msg
}

pub fn try_acquire_task_lock(scan_state: &ScanState) -> Result<TaskGuard, String> {
    if scan_state
        .is_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::Relaxed)
        .is_err()
    {
        return Err("別の解析または書き込み処理が実行中です。完了するまでお待ちください。".to_string());
    }
    Ok(TaskGuard(scan_state.is_running.clone()))
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TagPairItem {
    pub name: String,
    pub name_ja: Option<String>,
    #[serde(default = "default_tag_kind")]
    pub kind: String,
}

fn default_tag_kind() -> String {
    "basic".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MediaItem {
    pub id: i64,
    pub file_path: String,
    pub parent_folder: String,
    pub thumbnail_path: String,
    pub file_size: i64,
    pub analysis_status: String,
    pub analysis_error: Option<String>,
    pub categories: Vec<String>,
    pub tags: Vec<TagPairItem>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TagItem {
    pub id: i64,
    pub name: String,
    pub name_ja: Option<String>,
    pub is_category: bool,
    pub count: i64,
    #[serde(default = "default_tag_kind")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScanFolderItem {
    pub id: i64,
    pub path: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type")]
pub enum TagFilterNode {
    #[serde(rename = "tag")]
    Tag { value: String },
    #[serde(rename = "and")]
    And { children: Vec<TagFilterNode> },
    #[serde(rename = "or")]
    Or { children: Vec<TagFilterNode> },
    #[serde(rename = "not")]
    Not { child: Box<TagFilterNode> },
}

/// 論理ツリーを再帰的に評価し、メディアのタグが条件に合致するかを判定する
fn evaluate_tag_filter(node: &TagFilterNode, media_tags: &[TagPairItem]) -> bool {
    match node {
        TagFilterNode::Tag { value } => {
            media_tags.iter().any(|t| {
                t.name.eq_ignore_ascii_case(value)
                    || t.name_ja.as_deref().unwrap_or("").eq(value)
            })
        }
        TagFilterNode::And { children } => {
            children.iter().all(|child| evaluate_tag_filter(child, media_tags))
        }
        TagFilterNode::Or { children } => {
            children.iter().any(|child| evaluate_tag_filter(child, media_tags))
        }
        TagFilterNode::Not { child } => {
            !evaluate_tag_filter(child, media_tags)
        }
    }
}


fn is_matching_category(db_cat: &str, target_cat: &str) -> bool {
    let db_norm = crate::batch::normalize_tag_en(db_cat);
    let target_norm = crate::batch::normalize_tag_en(target_cat);

    if db_norm == target_norm || db_cat.eq_ignore_ascii_case(target_cat) {
        return true;
    }

    match target_norm.as_str() {
        "screenshot" => db_norm.contains("screenshot") || db_cat.contains("スクリーンショット"),
        "document" => db_norm.contains("document") || db_norm.contains("text") || db_cat.contains("書類") || db_cat.contains("文書"),
        "landscape" => db_norm.contains("landscape") || db_norm.contains("scenery") || db_cat.contains("風景") || db_cat.contains("自然"),
        "food" => db_norm.contains("food") || db_norm.contains("dish") || db_cat.contains("料理") || db_cat.contains("食べ物"),
        "character" => db_norm.contains("character") || db_cat.contains("キャラクター"),
        "animal" => db_norm.contains("animal") || db_norm.contains("pet") || db_cat.contains("動物") || db_cat.contains("ペット"),
        "person" => db_norm.contains("person") || db_norm.contains("people") || db_norm.contains("human") || db_cat.contains("人物") || db_cat.contains("顔写真"),
        "item_product" | "item" | "product" => db_norm.contains("item") || db_norm.contains("product") || db_norm.contains("goods") || db_cat.contains("商品") || db_cat.contains("雑貨"),
        "art_illustration" | "art" | "illustration" => db_norm.contains("art") || db_norm.contains("illustration") || db_cat.contains("イラスト"),
        "text_heavy" => db_norm.contains("text") || db_norm.contains("doc") || db_cat.contains("文字"),
        "tech" => db_norm.contains("tech") || db_norm.contains("code") || db_cat.contains("技術"),
        "other" => db_norm.contains("other") || db_cat.contains("その他"),
        _ => false,
    }
}

#[tauri::command]
pub async fn get_media(
    state: State<'_, DbState>,
    category_filter: Option<Vec<String>>,
    tag_filter: Option<Vec<String>>,
    tag_filter_tree: Option<String>,
    parent_folder_filter: Option<String>,
    scan_folder_filter: Option<String>,
    status_filter: Option<String>,
    media_type_filter: Option<String>,
    extension_filter: Option<Vec<String>>,
) -> Result<Vec<MediaItem>, String> {
    let pool = &state.pool;

    let mut query = String::from(
        r#"
        SELECT m.id, m.file_path, m.parent_folder, m.thumbnail_path, m.file_size, m.analysis_status, m.analysis_error
        FROM media m
        WHERE 1=1
        "#,
    );

    if let Some(ref pf) = parent_folder_filter {
        if !pf.is_empty() {
            query.push_str(&format!(" AND m.parent_folder = '{}'", pf.replace("'", "''")));
        }
    }

    if let Some(ref sf) = scan_folder_filter {
        if !sf.is_empty() {
            let sf_norm = sf.replace('\\', "/").replace('\'', "''");
            let sf_prefix = if sf_norm.ends_with('/') {
                sf_norm.clone()
            } else {
                format!("{}/", sf_norm)
            };
            query.push_str(&format!(
                " AND (REPLACE(m.file_path, '\\', '/') LIKE '{}%' OR REPLACE(m.file_path, '\\', '/') = '{}')",
                sf_prefix,
                sf_norm.trim_end_matches('/')
            ));
        }
    }

    if let Some(ref status) = status_filter {
        if !status.is_empty() {
            query.push_str(&format!(" AND LOWER(m.analysis_status) = '{}'", status.to_lowercase().replace("'", "''")));
        }
    }

    if let Some(ref mt) = media_type_filter {
        if mt == "image" {
            query.push_str(" AND (LOWER(m.file_path) LIKE '%.jpg' OR LOWER(m.file_path) LIKE '%.jpeg' OR LOWER(m.file_path) LIKE '%.png' OR LOWER(m.file_path) LIKE '%.webp' OR LOWER(m.file_path) LIKE '%.gif' OR LOWER(m.file_path) LIKE '%.bmp')");
        } else if mt == "video" {
            query.push_str(" AND (LOWER(m.file_path) LIKE '%.mp4' OR LOWER(m.file_path) LIKE '%.webm' OR LOWER(m.file_path) LIKE '%.mov' OR LOWER(m.file_path) LIKE '%.avi' OR LOWER(m.file_path) LIKE '%.mkv' OR LOWER(m.file_path) LIKE '%.flv' OR LOWER(m.file_path) LIKE '%.wmv')");
        }
    }

    if let Some(ref exts) = extension_filter {
        if !exts.is_empty() {
            let conds: Vec<String> = exts
                .iter()
                .map(|ext| format!("LOWER(m.file_path) LIKE '%.{}'", ext.trim_start_matches('.').to_lowercase().replace("'", "''")))
                .collect();
            query.push_str(&format!(" AND ({})", conds.join(" OR ")));
        }
    }

    query.push_str(" ORDER BY m.id DESC");

    let rows = sqlx::query_as::<_, (i64, String, String, String, i64, String, Option<String>)>(&query)
        .fetch_all(pool)
        .await
        .map_err(|e| cmd_err("get_media", e))?;

    // メディア全件に対するタグ情報のバッチ取得
    let media_ids: Vec<i64> = rows.iter().map(|r| r.0).collect();
    let mut tags_map: HashMap<i64, (Vec<String>, Vec<TagPairItem>)> = HashMap::new();

    if !media_ids.is_empty() {
        let ids_str = media_ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let tag_query = format!(
            r#"
            SELECT mt.media_id, t.name, t.name_ja, t.is_category, t.tag_kind
            FROM media_tags mt
            JOIN tags t ON mt.tag_id = t.id
            WHERE mt.media_id IN ({})
            "#,
            ids_str
        );

        let tag_rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(&tag_query)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

        for (m_id, tag_name, tag_name_ja, is_cat, tag_kind) in tag_rows {
            let entry = tags_map.entry(m_id).or_insert_with(|| (Vec::new(), Vec::new()));
            if is_cat == 1 {
                entry.0.push(tag_name);
            } else {
                entry.1.push(TagPairItem {
                    name: tag_name,
                    name_ja: tag_name_ja,
                    kind: tag_kind,
                });
            }
        }
    }

    let mut result = Vec::new();
    for (id, file_path, parent_folder, thumbnail_path, file_size, analysis_status, analysis_error) in rows {
        let (categories, tags) = tags_map.remove(&id).unwrap_or((Vec::new(), Vec::new()));

        // フィルタリング適用 (ステータスフィルタのメモリ上ダブルチェック)
        if let Some(ref st) = status_filter {
            if !st.is_empty() && !analysis_status.eq_ignore_ascii_case(st) {
                continue;
            }
        }

        // フィルタリング適用 (メディアタイプフィルタのメモリ上ダブルチェック)
        if let Some(ref mt) = media_type_filter {
            let lower = file_path.to_lowercase();
            let is_img = lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".png") || lower.ends_with(".webp") || lower.ends_with(".gif") || lower.ends_with(".bmp");
            let is_vid = lower.ends_with(".mp4") || lower.ends_with(".webm") || lower.ends_with(".mov") || lower.ends_with(".avi") || lower.ends_with(".mkv") || lower.ends_with(".flv") || lower.ends_with(".wmv");
            if (mt == "image" && !is_img) || (mt == "video" && !is_vid) {
                continue;
            }
        }

        // フィルタリング適用 (カテゴリフィルタ)
        if let Some(ref cats) = category_filter {
            if !cats.is_empty() {
                let matches = cats.iter().any(|target_cat| {
                    categories.iter().any(|c| is_matching_category(c, target_cat))
                });
                if !matches {
                    continue;
                }
            }
        }

        // フィルタリング適用 (論理ツリーフィルタ: tag_filter_tree が優先)
        if let Some(ref tree_json) = tag_filter_tree {
            if !tree_json.is_empty() {
                match serde_json::from_str::<TagFilterNode>(tree_json) {
                    Ok(tree) => {
                        if !evaluate_tag_filter(&tree, &tags) {
                            continue;
                        }
                    }
                    Err(_) => {
                        // JSONパースに失敗した場合はフォールバック（何もフィルタしない）
                    }
                }
            }
        } else if let Some(ref tf) = tag_filter {
            // 従来のANDフィルタ（後方互換性のため残す）
            if !tf.is_empty() {
                let matches = tf.iter().all(|target_tag| {
                    tags.iter().any(|t| {
                        t.name.eq_ignore_ascii_case(target_tag)
                            || t.name_ja.as_deref().unwrap_or("").eq(target_tag)
                    })
                });
                if !matches {
                    continue;
                }
            }
        }

        result.push(MediaItem {
            id,
            file_path,
            parent_folder,
            thumbnail_path,
            file_size,
            analysis_status,
            analysis_error,
            categories,
            tags,
        });
    }

    Ok(result)
}

#[tauri::command]
pub async fn start_scan(
    folder_path: String,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let task_guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);
    let pool = db_state.pool.clone();
    let cancel_flag = scan_state.cancel_flag.clone();
    let pause_flag = scan_state.pause_flag.clone();
    let path = std::path::PathBuf::from(folder_path);

    tokio::spawn(async move {
        let _guard = task_guard;
        run_scan_and_log_outcome("start_scan", vec![path], pool, app_handle, cancel_flag, pause_flag).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_scan(scan_state: State<'_, ScanState>) -> Result<(), String> {
    let was_running = scan_state.is_running.load(Ordering::Relaxed);
    crate::logger::log_info(&format!(
        "[User Action] Scan cancellation requested (scan running: {}). Waiting for the background task to stop...",
        was_running
    ));

    scan_state.cancel_flag.store(true, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);

    // バックグラウンドタスクが完全に停止して TaskGuard (is_running) が解放されるまで確実に待機
    let started = std::time::Instant::now();
    while scan_state.is_running.load(Ordering::Relaxed) {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }

    if was_running {
        // 解析中のリクエストが完了するまで待つため、停止までに時間がかかることがある
        crate::logger::log_info(&format!(
            "[User Action] Scan stopped and resources released ({:.1}s after the cancellation request).",
            started.elapsed().as_secs_f64()
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn pause_scan(scan_state: State<'_, ScanState>) -> Result<(), String> {
    crate::logger::log_info("[User Action] Scan pause requested.");
    scan_state.pause_flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn resume_scan(scan_state: State<'_, ScanState>) -> Result<(), String> {
    crate::logger::log_info("[User Action] Scan resume requested.");
    scan_state.pause_flag.store(false, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
pub async fn get_scan_status(scan_state: State<'_, ScanState>) -> Result<bool, String> {
    Ok(scan_state.is_running.load(Ordering::Relaxed))
}

#[tauri::command]
pub async fn get_settings(db_state: State<'_, DbState>) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query_as::<_, (String, String)>("SELECT key, value FROM settings")
        .fetch_all(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let mut map = HashMap::new();
    for (k, v) in rows {
        map.insert(k, v);
    }
    Ok(map)
}

#[tauri::command]
pub async fn update_setting(
    key: String,
    value: String,
    db_state: State<'_, DbState>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2"
    )
    .bind(key)
    .bind(value)
    .execute(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 現在のプロバイダー・モデル・強制フラグから実際に使用されるプロンプト種別 ("DETAILED" | "LIGHT") を返す。
/// DBを読まない純粋関数のラッパーで、設定画面が未保存の選択状態を反映するために使う。
#[tauri::command]
pub fn get_effective_prompt_type(provider: String, model: String, force_detailed: bool) -> String {
    let config = crate::llm::PromptConfig {
        granularity: crate::llm::TagGranularity::Atomic,
        force_detailed,
    };
    let (kind, _) = crate::llm::get_vlm_prompt_info(&provider, &model, &config);
    match kind {
        crate::llm::VlmPromptType::Detailed => "DETAILED".to_string(),
        crate::llm::VlmPromptType::Light => "LIGHT".to_string(),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GranularityComparisonItem {
    pub granularity: String,
    pub categories: Vec<String>,
    pub tags: Vec<crate::llm::TagPair>,
    pub descriptive_tags: Vec<crate::llm::TagPair>,
    pub error: Option<String>,
}

/// フロントエンドへ都度通知する進捗イベント ("granularity_comparison_progress")
#[derive(Serialize, Clone)]
pub struct GranularityComparisonProgress {
    /// "running" | "done"
    pub status: String,
    pub item: Option<GranularityComparisonItem>,
    pub granularity: String,
}

/// 検証用: 指定画像を Lv1(atomic) / Lv2(balanced) / Lv3(descriptive) の3プロンプトで
/// 連続解析し、結果を並べて返す。DBには一切書き込まない。
/// レベルごとに "granularity_comparison_progress" イベントを発火し、
/// モーダルが全件完了を待たずに進捗を表示できるようにする。
#[tauri::command]
pub async fn compare_granularity_levels(
    image_path: String,
    app_handle: AppHandle,
    db_state: State<'_, DbState>,
) -> Result<Vec<GranularityComparisonItem>, String> {
    let pool = &db_state.pool;
    let path = Path::new(&image_path);
    if !path.exists() {
        return Err("指定された画像ファイルが見つかりません".to_string());
    }

    let levels = [
        crate::llm::TagGranularity::Atomic,
        crate::llm::TagGranularity::Balanced,
        crate::llm::TagGranularity::Descriptive,
    ];

    let mut items = Vec::new();
    for granularity in levels {
        let granularity_str = granularity.as_setting_str().to_string();

        let _ = app_handle.emit(
            "granularity_comparison_progress",
            GranularityComparisonProgress {
                status: "running".to_string(),
                item: None,
                granularity: granularity_str.clone(),
            },
        );

        // 比較の目的上、常に高精度プロンプトを強制して粒度の差を明確にする
        let prompt_override = crate::llm::PromptConfig { granularity, force_detailed: true };

        let item = match crate::llm::factory::create_llm_provider_with_prompt_override(pool, Some(prompt_override)).await {
            Ok((provider, _)) => match provider.analyze_image(path).await {
                Ok(result) => GranularityComparisonItem {
                    granularity: granularity_str.clone(),
                    categories: result.categories,
                    tags: result.tags,
                    descriptive_tags: result.descriptive_tags,
                    error: None,
                },
                Err(e) => GranularityComparisonItem {
                    granularity: granularity_str.clone(),
                    categories: Vec::new(),
                    tags: Vec::new(),
                    descriptive_tags: Vec::new(),
                    error: Some(e.to_string()),
                },
            },
            Err(e) => GranularityComparisonItem {
                granularity: granularity_str.clone(),
                categories: Vec::new(),
                tags: Vec::new(),
                descriptive_tags: Vec::new(),
                error: Some(e.to_string()),
            },
        };

        let _ = app_handle.emit(
            "granularity_comparison_progress",
            GranularityComparisonProgress {
                status: "done".to_string(),
                item: Some(item.clone()),
                granularity: granularity_str,
            },
        );

        items.push(item);
    }

    // Ollama利用時は検証後に必ずVRAMを解放する
    let provider_name: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'llm_provider'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "ollama".to_string());
    if provider_name.to_lowercase() == "ollama" {
        let url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
            .fetch_optional(pool)
            .await
            .unwrap_or(None)
            .unwrap_or_else(|| "http://localhost:11434".to_string());
        let model: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_model'")
            .fetch_optional(pool)
            .await
            .unwrap_or(None)
            .unwrap_or_else(|| "llava".to_string());
        let _ = crate::batch::unload_ollama_model(&url, &model).await;
    }

    Ok(items)
}

#[tauri::command]
pub async fn get_available_models(db_state: State<'_, DbState>) -> Result<Vec<String>, String> {
    let url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    fetch_ollama_models(&url).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pull_ollama_model(app: tauri::AppHandle, db_state: State<'_, DbState>, model_name: String) -> Result<(), String> {
    let url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    crate::batch::pull_ollama_model(app, &url, &model_name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_ollama_pull() {
    crate::batch::cancel_ollama_pull();
}

#[tauri::command]
pub async fn get_all_tags(db_state: State<'_, DbState>) -> Result<Vec<TagItem>, String> {
    let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, i64, String)>(
        r#"
        SELECT t.id, t.name, t.name_ja, t.is_category, COUNT(mt.media_id) AS count, t.tag_kind
        FROM tags t
        LEFT JOIN media_tags mt ON t.id = mt.tag_id
        GROUP BY t.id, t.name, t.name_ja, t.is_category, t.tag_kind
        ORDER BY t.is_category DESC, count DESC, COALESCE(t.name_ja, t.name) ASC
        "#
    )
    .fetch_all(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, name, name_ja, is_cat, count, kind)| TagItem {
            id,
            name,
            name_ja,
            is_category: is_cat == 1,
            count,
            kind,
        })
        .collect())
}

#[tauri::command]
pub async fn rename_tag(
    tag_id: i64,
    new_name: String,
    new_name_ja: Option<String>,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    sqlx::query("UPDATE tags SET name = ?1, name_ja = ?2 WHERE id = ?3")
        .bind(new_name)
        .bind(new_name_ja)
        .bind(tag_id)
        .execute(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_or_create_tag(
    name: String,
    name_ja: Option<String>,
    db_state: State<'_, DbState>,
) -> Result<TagItem, String> {
    let clean_name = crate::batch::normalize_tag_en(&name);
    if clean_name.is_empty() {
        return Err("Invalid tag name".to_string());
    }

    let existing = sqlx::query(
        r#"
        SELECT t.id, t.name, t.name_ja, t.is_category, COUNT(mt.media_id) AS count, t.tag_kind
        FROM tags t
        LEFT JOIN media_tags mt ON t.id = mt.tag_id
        WHERE t.name = ?1
        GROUP BY t.id, t.name, t.name_ja, t.is_category, t.tag_kind
        "#
    )
    .bind(&clean_name)
    .fetch_optional(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    if let Some(r) = existing {
        use sqlx::Row;
        let id: i64 = r.get("id");
        let mut cur_name_ja: Option<String> = r.get("name_ja");
        if (cur_name_ja.is_none() || cur_name_ja.as_deref() == Some("")) && name_ja.is_some() {
            let new_ja = name_ja.clone();
            let _ = sqlx::query("UPDATE tags SET name_ja = ?1 WHERE id = ?2")
                .bind(&new_ja)
                .bind(id)
                .execute(&db_state.pool)
                .await;
            cur_name_ja = new_ja;
        }
        return Ok(TagItem {
            id,
            name: r.get("name"),
            name_ja: cur_name_ja,
            is_category: r.get::<i64, _>("is_category") == 1,
            count: r.get("count"),
            kind: r.get("tag_kind"),
        });
    }

    // 手動作成されるタグは常に basic 種別として扱う
    let res = sqlx::query(
        "INSERT INTO tags (name, name_ja, is_category, tag_kind) VALUES (?1, ?2, 0, 'basic')"
    )
    .bind(&clean_name)
    .bind(&name_ja)
    .execute(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let new_id = res.last_insert_rowid();
    Ok(TagItem {
        id: new_id,
        name: clean_name,
        name_ja,
        is_category: false,
        count: 0,
        kind: "basic".to_string(),
    })
}

#[tauri::command]
pub async fn add_tag_to_media(
    media_id: i64,
    tag_name: String,
    tag_name_ja: Option<String>,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<TagItem, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    let tag = get_or_create_tag(tag_name, tag_name_ja, db_state.clone()).await?;

    sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
        .bind(media_id)
        .bind(tag.id)
        .execute(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(tag)
}

#[tauri::command]
pub async fn remove_tag_from_media(
    media_id: i64,
    tag_id: i64,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    sqlx::query("DELETE FROM media_tags WHERE media_id = ?1 AND tag_id = ?2")
        .bind(media_id)
        .bind(tag_id)
        .execute(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    let _ = sqlx::query(
        "DELETE FROM tags WHERE is_category = 0 AND id = ?1 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)"
    )
    .bind(tag_id)
    .execute(&db_state.pool)
    .await;

    Ok(())
}

#[tauri::command]
pub async fn merge_tags(
    target_tag_id: i64,
    source_tag_ids: Vec<i64>,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    let mut tx = db_state.pool.begin().await.map_err(|e| e.to_string())?;

    for src_id in source_tag_ids {
        if src_id == target_tag_id {
            continue;
        }

        sqlx::query("INSERT OR IGNORE INTO media_tags (media_id, tag_id) SELECT media_id, ?1 FROM media_tags WHERE tag_id = ?2")
            .bind(target_tag_id)
            .bind(src_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

        sqlx::query("DELETE FROM tags WHERE id = ?1")
            .bind(src_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    // 念のため浮いた未使用タグを自動一括クリーンアップ
    sqlx::query("DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_parent_folders(db_state: State<'_, DbState>) -> Result<Vec<String>, String> {
    let rows = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT parent_folder FROM media WHERE parent_folder != '' ORDER BY parent_folder ASC",
    )
    .fetch_all(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows)
}

#[tauri::command]
pub async fn retry_media(
    media_ids: Vec<i64>,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    if media_ids.is_empty() {
        return Ok(());
    }

    let task_guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);
    let pool = db_state.pool.clone();
    let cancel_flag = scan_state.cancel_flag.clone();
    let pause_flag = scan_state.pause_flag.clone();

    let ids_str = media_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let query = format!(
        "UPDATE media SET analysis_status = 'pending', analysis_error = NULL WHERE id IN ({})",
        ids_str
    );

    sqlx::query(&query)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folders = sqlx::query_scalar::<_, String>("SELECT path FROM scan_folders")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folder_paths: Vec<std::path::PathBuf> = folders
        .into_iter()
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    tokio::spawn(async move {
        let _guard = task_guard;
        run_scan_and_log_outcome("retry_media", folder_paths, pool, app_handle, cancel_flag, pause_flag).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn get_scan_folders(db_state: State<'_, DbState>) -> Result<Vec<ScanFolderItem>, String> {
    let rows = sqlx::query_as::<_, (i64, String, i64)>(
        "SELECT id, path, created_at FROM scan_folders ORDER BY id DESC",
    )
    .fetch_all(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows
        .into_iter()
        .map(|(id, path, created_at)| ScanFolderItem {
            id,
            path,
            created_at,
        })
        .collect())
}

#[tauri::command]
pub async fn get_media_by_tag(
    tag_id: i64,
    db_state: State<'_, DbState>,
) -> Result<Vec<MediaItem>, String> {
    let media_ids = sqlx::query_scalar::<_, i64>(
        "SELECT DISTINCT media_id FROM media_tags WHERE tag_id = ?1"
    )
    .bind(tag_id)
    .fetch_all(&db_state.pool)
    .await
    .map_err(|e| e.to_string())?;

    if media_ids.is_empty() {
        return Ok(Vec::new());
    }

    let all_media = get_media(db_state, None, None, None, None, None, None, None, None).await?;
    let filtered = all_media
        .into_iter()
        .filter(|m| media_ids.contains(&m.id))
        .collect();

    Ok(filtered)
}

#[tauri::command]
pub async fn rescan_all_folders(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let task_guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);
    let pool = db_state.pool.clone();
    let cancel_flag = scan_state.cancel_flag.clone();
    let pause_flag = scan_state.pause_flag.clone();

    sqlx::query("UPDATE media SET analysis_status = 'pending', analysis_error = NULL WHERE analysis_status = 'failed'")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folders = sqlx::query_scalar::<_, String>("SELECT path FROM scan_folders")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folder_paths: Vec<std::path::PathBuf> = folders
        .into_iter()
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    tokio::spawn(async move {
        let _guard = task_guard;
        run_scan_and_log_outcome("rescan_all_folders", folder_paths, pool, app_handle, cancel_flag, pause_flag).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn reanalyze_all_media(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let task_guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);
    let pool = db_state.pool.clone();
    let cancel_flag = scan_state.cancel_flag.clone();
    let pause_flag = scan_state.pause_flag.clone();

    sqlx::query("DELETE FROM media_tags")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    sqlx::query("UPDATE media SET analysis_status = 'pending', analysis_error = NULL")
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folders = sqlx::query_scalar::<_, String>("SELECT path FROM scan_folders")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?;

    let folder_paths: Vec<std::path::PathBuf> = folders
        .into_iter()
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .collect();

    tokio::spawn(async move {
        let _guard = task_guard;
        run_scan_and_log_outcome("reanalyze_all_media", folder_paths, pool, app_handle, cancel_flag, pause_flag).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn reanalyze_folder(
    folder_path: String,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let task_guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);
    let pool = db_state.pool.clone();
    let cancel_flag = scan_state.cancel_flag.clone();
    let pause_flag = scan_state.pause_flag.clone();

    let sql_prefix_pattern = format!("{}%", folder_path.replace('\\', "/"));
    let sql_prefix_pattern_win = format!("{}%", folder_path.replace('/', "\\"));

    let _ = sqlx::query(
        "DELETE FROM media_tags WHERE media_id IN (SELECT id FROM media WHERE file_path LIKE ?1 OR file_path LIKE ?2 OR parent_folder = ?3)"
    )
    .bind(&sql_prefix_pattern)
    .bind(&sql_prefix_pattern_win)
    .bind(&folder_path)
    .execute(&pool)
    .await;

    let _ = sqlx::query(
        "UPDATE media SET analysis_status = 'pending', analysis_error = NULL WHERE file_path LIKE ?1 OR file_path LIKE ?2 OR parent_folder = ?3"
    )
    .bind(&sql_prefix_pattern)
    .bind(&sql_prefix_pattern_win)
    .bind(&folder_path)
    .execute(&pool)
    .await;

    tokio::spawn(async move {
        let _guard = task_guard;
        let path = std::path::PathBuf::from(&folder_path);
        if path.exists() {
            run_scan_and_log_outcome("reanalyze_folder", vec![path], pool, app_handle, cancel_flag, pause_flag).await;
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn remove_scan_folder(
    folder_id: i64,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    // 実行中タスクがあればキャンセル
    scan_state.cancel_flag.store(true, Ordering::Relaxed);

    let folder_path_opt: Option<String> = sqlx::query_scalar("SELECT path FROM scan_folders WHERE id = ?1")
        .bind(folder_id)
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(folder_path_str) = folder_path_opt {
        let folder_path = Path::new(&folder_path_str);

        let all_media = sqlx::query_as::<_, (i64, String, String)>(
            "SELECT id, file_path, thumbnail_path FROM media"
        )
        .fetch_all(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

        let mut ids_to_delete = Vec::new();
        let mut thumbs_to_delete = Vec::new();

        for (id, file_path_str, thumb_path_str) in all_media {
            let file_path = Path::new(&file_path_str);
            if file_path.starts_with(folder_path) || file_path == folder_path {
                ids_to_delete.push(id);
                if !thumb_path_str.is_empty() {
                    thumbs_to_delete.push(thumb_path_str);
                }
            }
        }

        for thumb_path in thumbs_to_delete {
            let p = Path::new(&thumb_path);
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }

        if !ids_to_delete.is_empty() {
            let mut tx = db_state.pool.begin().await.map_err(|e| e.to_string())?;
            for chunk in ids_to_delete.chunks(500) {
                let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");

                let query_tags = format!("DELETE FROM media_tags WHERE media_id IN ({})", placeholders);
                let mut q_tags = sqlx::query(&query_tags);
                for id in chunk {
                    q_tags = q_tags.bind(id);
                }
                q_tags.execute(&mut *tx).await.map_err(|e| e.to_string())?;

                let query_media = format!("DELETE FROM media WHERE id IN ({})", placeholders);
                let mut q_media = sqlx::query(&query_media);
                for id in chunk {
                    q_media = q_media.bind(id);
                }
                q_media.execute(&mut *tx).await.map_err(|e| e.to_string())?;
            }
            tx.commit().await.map_err(|e| e.to_string())?;
        }
    }

    sqlx::query("DELETE FROM scan_folders WHERE id = ?1")
        .bind(folder_id)
        .execute(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn cleanup_missing_media(db_state: State<'_, DbState>) -> Result<usize, String> {
    crate::batch::cleanup_missing_media(&db_state.pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unload_model(db_state: State<'_, DbState>) -> Result<(), String> {
    let url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    let model: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_model'")
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "llava".to_string());

    crate::batch::unload_ollama_model(&url, &model)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_app_logs(app_handle: AppHandle) -> Result<String, String> {
    Ok(crate::logger::read_logs(&app_handle))
}

#[tauri::command]
pub async fn clear_app_logs(app_handle: AppHandle) -> Result<(), String> {
    crate::logger::clear_logs(&app_handle);
    Ok(())
}

#[tauri::command]
pub async fn open_file(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }

    #[cfg(target_os = "windows")]
    {
        crate::proc::hidden_command("cmd")
            .args(["/C", "start", "", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&file_path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn open_folder(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File/Folder does not exist: {}", file_path));
    }

    #[cfg(target_os = "windows")]
    {
        let win_path = file_path.replace("/", "\\");
        std::process::Command::new("explorer")
            .args(["/select,", &win_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &file_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub async fn check_and_open_file(file_path: String) -> Result<(), String> {
    open_file(file_path).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeSuggestion {
    pub id: String,
    pub target_tag: TagItem,
    pub source_tags: Vec<TagItem>,
    pub reason: String,
    pub confidence: String,
    pub sample_thumbnails: Vec<String>,
    pub total_images_count: usize,
}

#[allow(clippy::needless_range_loop)]
fn levenshtein_distance(a: &str, b: &str) -> usize {
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let len_a = a_chars.len();
    let len_b = b_chars.len();

    let mut dp = vec![vec![0; len_b + 1]; len_a + 1];
    for i in 0..=len_a {
        dp[i][0] = i;
    }
    for j in 0..=len_b {
        dp[0][j] = j;
    }

    for i in 1..=len_a {
        for j in 1..=len_b {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            dp[i][j] = (dp[i - 1][j] + 1)
                .min(dp[i][j - 1] + 1)
                .min(dp[i - 1][j - 1] + cost);
        }
    }
    dp[len_a][len_b]
}

struct RawPair {
    t1: TagItem,
    t2: TagItem,
    reason: String,
}

pub fn get_cache_path(app_handle: &AppHandle) -> std::path::PathBuf {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("./data"));
    if !app_dir.exists() {
        let _ = std::fs::create_dir_all(&app_dir);
    }
    app_dir.join("tag_suggestions_cache.json")
}

pub fn save_tag_suggestions_cache_internal(
    app_handle: &AppHandle,
    suggestions: &[MergeSuggestion],
) -> Result<(), String> {
    let path = get_cache_path(app_handle);
    let json_str = serde_json::to_string_pretty(suggestions).map_err(|e| e.to_string())?;
    std::fs::write(path, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_tag_suggestions_cache(app_handle: AppHandle) -> Result<Vec<MergeSuggestion>, String> {
    let path = get_cache_path(&app_handle);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let suggestions: Vec<MergeSuggestion> = serde_json::from_str(&content).unwrap_or_default();
    Ok(suggestions)
}

#[tauri::command]
pub async fn save_tag_suggestions_cache(
    app_handle: AppHandle,
    suggestions: Vec<MergeSuggestion>,
) -> Result<(), String> {
    save_tag_suggestions_cache_internal(&app_handle, &suggestions)
}

#[tauri::command]
pub async fn clear_tag_suggestions_cache(app_handle: AppHandle) -> Result<(), String> {
    let path = get_cache_path(&app_handle);
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

pub async fn run_suggest_tag_merges_logic(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<Vec<MergeSuggestion>, String> {
    // 0. 浮いた未使用タグ (orphaned tags) を事前削除クリーンアップ
    let _ = sqlx::query(
        "DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)"
    )
    .execute(pool)
    .await;

    let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, i64, String)>(
        r#"
        SELECT t.id, t.name, t.name_ja, t.is_category, COUNT(mt.media_id) AS count, t.tag_kind
        FROM tags t
        LEFT JOIN media_tags mt ON t.id = mt.tag_id
        GROUP BY t.id, t.name, t.name_ja, t.is_category, t.tag_kind
        ORDER BY t.is_category DESC, count DESC, COALESCE(t.name_ja, t.name) ASC
        "#
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let tags: Vec<TagItem> = rows
        .into_iter()
        .map(|(id, name, name_ja, is_cat, count, kind)| TagItem {
            id,
            name,
            name_ja,
            is_category: is_cat == 1,
            count,
            kind,
        })
        .collect();

    let free_tags: Vec<TagItem> = tags.into_iter().filter(|t| !t.is_category).collect();
    let tag_map: std::collections::HashMap<i64, TagItem> = free_tags.iter().map(|t| (t.id, t.clone())).collect();

    let free_tags_count = free_tags.len();
    crate::logger::log_info(&format!("Starting tag merge scan for {} free tags...", free_tags_count));

    let mut raw_pairs: Vec<RawPair> = Vec::new();
    let mut paired_keys = std::collections::HashSet::<(i64, i64)>::new();

    const STOP_WORDS: &[&str] = &[
        "photo", "image", "media", "picture", "mobile", "device", "screen", "paper", "plant",
        "board", "model", "system", "object", "item", "product", "style", "design", "background",
        "foreground", "color", "light", "dark", "white", "black", "text", "view", "part", "detail",
        "group", "card", "type", "file", "data", "info", "page", "line", "sign", "wood", "glass",
        "metal", "app", "application", "icon", "logo", "vector", "art", "graphic", "illustration",
        "set", "collection", "element", "symbol", "banner", "web", "website", "online", "digital"
    ];

    struct TagMeta<'a> {
        item: &'a TagItem,
        norm_name: String,
        words: Vec<&'a str>,
        ja_clean: Option<String>,
    }

    let precalculated: Vec<TagMeta> = free_tags
        .iter()
        .map(|t| {
            let norm_name = crate::batch::normalize_tag_en(&t.name);
            let words: Vec<&str> = t.name.split(&['_', '-'][..]).filter(|w| w.len() >= 3 && !STOP_WORDS.contains(w)).collect();
            let ja_clean = t.name_ja.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            TagMeta {
                item: t,
                norm_name,
                words,
                ja_clean,
            }
        })
        .collect();

    // 1. 多角的ルール判定: 単複表記揺れ & 同一日本語訳 & 共通単語フレーズ & 編集距離
    for i in 0..precalculated.len() {
        let p1 = &precalculated[i];
        for j in (i + 1)..precalculated.len() {
            let p2 = &precalculated[j];

            let pair_key = (p1.item.id.min(p2.item.id), p1.item.id.max(p2.item.id));
            if paired_keys.contains(&pair_key) {
                continue;
            }

            // 種別(基本語/記述的)をまたぐペアはマージ候補にしない
            if p1.item.kind != p2.item.kind {
                continue;
            }

            let mut matched_reason = None;

            // 1-A. 日本語訳完全一致 (例:どちらも「猫」)
            if let (Some(ref ja1), Some(ref ja2)) = (&p1.ja_clean, &p2.ja_clean) {
                if ja1 == ja2 {
                    matched_reason = Some(format!("同一日本語表記 ({})", ja1));
                }
            }

            // 1-B. 単数形正規化一致 (例: cat と cats)
            if matched_reason.is_none() {
                if p1.norm_name == p2.norm_name {
                    matched_reason = Some(format!("単数形・表記統一 ({})", p1.norm_name));
                }
            }

            // 1-C. 共通単語・フレーズ (ストップワードを除外し、固有度が高いフレーズのみ一致とみなす)
            if matched_reason.is_none() && !p1.words.is_empty() && !p2.words.is_empty() {
                let common_words: Vec<String> = p1.words
                    .iter()
                    .filter(|w| p2.words.contains(w))
                    .map(|s| s.to_string())
                    .collect();

                if common_words.len() >= 2 || (common_words.len() == 1 && common_words[0].len() >= 7) {
                    matched_reason = Some(format!("共通キーフレーズ ({})", common_words.join(", ")));
                }
            }

            // 1-D. 日本語の共通プレフィックス・キーワード (例: ESP32開発ボード ↔ ESP32-WROOMボード)
            if matched_reason.is_none() {
                if let (Some(ref ja1), Some(ref ja2)) = (&p1.ja_clean, &p2.ja_clean) {
                    if ja1.chars().count() >= 4 && ja2.chars().count() >= 4 {
                        let common_prefix: String = ja1
                            .chars()
                            .zip(ja2.chars())
                            .take_while(|(c1, c2)| c1 == c2)
                            .map(|(c, _)| c)
                            .collect();
                        if common_prefix.chars().count() >= 4 {
                            matched_reason = Some(format!("類似日本語表記 ({})", common_prefix));
                        }
                    }
                }
            }

            // 1-E. 編集距離が非常に近い (例: smart_phone と smartphone)
            if matched_reason.is_none() && p1.item.name.len() >= 4 && p2.item.name.len() >= 4 {
                let len_diff = (p1.item.name.len() as isize - p2.item.name.len() as isize).abs();
                if len_diff <= 3 {
                    let dist = levenshtein_distance(&p1.item.name, &p2.item.name);
                    let max_len = p1.item.name.len().max(p2.item.name.len());
                    if dist == 1 || (dist <= 3 && max_len >= 8) {
                        matched_reason = Some(format!("類似スペル (編集距離 {})", dist));
                    }
                }
            }

            if let Some(reason) = matched_reason {
                paired_keys.insert(pair_key);
                raw_pairs.push(RawPair {
                    t1: p1.item.clone(),
                    t2: p2.item.clone(),
                    reason,
                });
            }
        }
    }

    let rule_pairs_count = raw_pairs.len();
    crate::logger::log_info(&format!("Rule-based scan found {} candidate pairs.", rule_pairs_count));

    let ollama_url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    let ollama_text_model: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_text_model'")
        .fetch_optional(pool)
        .await
        .unwrap_or(None)
        .unwrap_or_else(|| "qwen3:14b".to_string());

    // 2. Ollama LLM による同義語検出
    if free_tags.len() >= 2 && free_tags.len() <= 300 {
        let tag_descriptors: Vec<String> = free_tags
            .iter()
            .map(|t| {
                if let Some(ref ja) = t.name_ja {
                    format!("{} ({})", t.name, ja)
                } else {
                    t.name.clone()
                }
            })
            .collect();

        let prompt = format!(
            "Analyze the following list of tags and find synonymous or duplicate-meaning tag pairs.\nTags: {:?}\nOutput ONLY valid JSON format: {{\"synonyms\": [[\"tagA\", \"tagB\"], ...]}} using exact tag names from the input list.",
            tag_descriptors
        );

        let client = reqwest::Client::new();
        // "format": "json" は指定しないこと。
        // thinking 対応モデル（既定の qwen3:14b を含む）に対して指定すると応答が `{}` に縮退し、
        // synonyms が常に空になってLLM同義語判定が丸ごと無効化される（2026-07-29 実測）。
        // done_reason は "stop"（正常終了）で返るためエラーにもならず静かに壊れる。
        // JSON の抽出は下の find('{') / rfind('}') が担うので format 指定は不要。
        // 検証方法: tools/prompt-check/README.md
        let req_body = serde_json::json!({
            "model": ollama_text_model,
            "prompt": prompt,
            "stream": false
        });

        if let Ok(res) = client.post(format!("{}/api/generate", ollama_url)).json(&req_body).send().await {
            if res.status().is_success() {
                if let Ok(json_res) = res.json::<serde_json::Value>().await {
                    if let Some(raw_response) = json_res.get("response").and_then(|v| v.as_str()) {
                        let clean_text = raw_response.trim();
                        let json_str = if let (Some(start), Some(end)) = (clean_text.find('{'), clean_text.rfind('}')) {
                            if start < end { &clean_text[start..=end] } else { clean_text }
                        } else {
                            clean_text
                        };

                        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
                            if let Some(synonym_list) = parsed.get("synonyms").and_then(|v| v.as_array()) {
                                let find_tag = |raw_name: &str| -> Option<&TagItem> {
                                    let clean = raw_name.trim().trim_start_matches('#');
                                    let key_en = clean.split('(').next().unwrap_or(clean).trim();
                                    free_tags.iter().find(|t| {
                                        t.name == key_en ||
                                        t.name == clean ||
                                        t.name_ja.as_deref() == Some(clean)
                                    })
                                };

                                for pair_arr in synonym_list {
                                    if let Some(arr) = pair_arr.as_array() {
                                        if arr.len() == 2 {
                                            if let (Some(name1), Some(name2)) = (arr[0].as_str(), arr[1].as_str()) {
                                                if let (Some(t1), Some(t2)) = (find_tag(name1), find_tag(name2)) {
                                                    if t1.id != t2.id && t1.kind == t2.kind {
                                                        let pkey = (t1.id.min(t2.id), t1.id.max(t2.id));
                                                        if !paired_keys.contains(&pkey) {
                                                            paired_keys.insert(pkey);
                                                            raw_pairs.push(RawPair {
                                                                t1: t1.clone(),
                                                                t2: t2.clone(),
                                                                reason: "LLM同義語判定".to_string(),
                                                            });
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 分析終了後にテキストLLMをVRAMから自動アンロード
        let _ = crate::batch::unload_ollama_model(&ollama_url, &ollama_text_model).await;
    }

    // 3. BFS による連結成分グラフの抽出
    let mut adj: std::collections::HashMap<i64, std::collections::HashSet<i64>> = std::collections::HashMap::new();
    let mut pair_reasons: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();

    for pair in &raw_pairs {
        adj.entry(pair.t1.id).or_default().insert(pair.t2.id);
        adj.entry(pair.t2.id).or_default().insert(pair.t1.id);
        pair_reasons.entry(pair.t1.id).or_default().push(pair.reason.clone());
        pair_reasons.entry(pair.t2.id).or_default().push(pair.reason.clone());
    }

    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut suggestions: Vec<MergeSuggestion> = Vec::new();
    let mut group_idx = 0;

    for &node in adj.keys() {
        if visited.contains(&node) {
            continue;
        }

        let mut member_ids = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(node);
        visited.insert(node);

        while let Some(curr) = queue.pop_front() {
            member_ids.push(curr);
            if let Some(neighbors) = adj.get(&curr) {
                for &neighbor in neighbors {
                    if !visited.contains(&neighbor) {
                        visited.insert(neighbor);
                        queue.push_back(neighbor);
                    }
                }
            }
        }

        if member_ids.len() > 1 && member_ids.len() <= 15 {
            // 代表 (Target) の決定: 短い名前のタグを優先マスターとする
            member_ids.sort_by(|a, b| {
                let t_a = tag_map.get(a).unwrap();
                let t_b = tag_map.get(b).unwrap();
                t_a.name.len().cmp(&t_b.name.len())
            });

            let target_id = member_ids[0];
            let target_tag = tag_map.get(&target_id).unwrap().clone();
            let source_tags: Vec<TagItem> = member_ids[1..]
                .iter()
                .map(|id| tag_map.get(id).unwrap().clone())
                .collect();

            // 代表的な理由メッセージ (最大3件に制限し要約化)
            let mut reasons: Vec<String> = member_ids
                .iter()
                .filter_map(|id| pair_reasons.get(id))
                .flatten()
                .cloned()
                .collect();
            reasons.sort();
            reasons.dedup();
            let main_reason = if reasons.len() > 3 {
                format!("{} など他{}件", reasons[..3].join(" / "), reasons.len() - 3)
            } else if !reasons.is_empty() {
                reasons.join(" / ")
            } else {
                "類似タググループ".to_string()
            };

            // 代表的な画像サムネイルをグループ内から最大5件抽出
            let ids_str = member_ids.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
            let query_str = format!(
                "SELECT DISTINCT m.thumbnail_path FROM media m JOIN media_tags mt ON m.id = mt.media_id WHERE mt.tag_id IN ({}) AND m.thumbnail_path != '' LIMIT 5",
                ids_str
            );
            let sample_thumbnails = sqlx::query_scalar::<_, String>(&query_str)
                .fetch_all(pool)
                .await
                .unwrap_or_default();

            let count_query = format!(
                "SELECT COUNT(DISTINCT m.id) FROM media m JOIN media_tags mt ON m.id = mt.media_id WHERE mt.tag_id IN ({})",
                ids_str
            );
            let total_images_count = sqlx::query_scalar::<_, i64>(&count_query)
                .fetch_one(pool)
                .await
                .unwrap_or(0) as usize;

            suggestions.push(MergeSuggestion {
                id: format!("group-sug-{}", group_idx),
                target_tag,
                source_tags,
                reason: main_reason,
                confidence: "high".to_string(),
                sample_thumbnails,
                total_images_count,
            });
            group_idx += 1;
        }
    }

    suggestions.sort_by(|a, b| (b.source_tags.len() + 1).cmp(&(a.source_tags.len() + 1)));

    Ok(suggestions)
}

#[tauri::command]
pub async fn suggest_tag_merges(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<Vec<MergeSuggestion>, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    let suggestions = run_suggest_tag_merges_logic(&db_state.pool).await?;
    let _ = save_tag_suggestions_cache_internal(&app_handle, &suggestions);
    Ok(suggestions)
}

#[tauri::command]
pub async fn custom_analyze_video(
    media_id: i64,
    timestamp_seconds: f64,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    scan_state.pause_flag.store(false, Ordering::Relaxed);

    let pool = db_state.pool.clone();
    let cancel_flag = scan_state.cancel_flag.clone();

    crate::batch::custom_analyze_video_media(&pool, media_id, timestamp_seconds, cancel_flag)
        .await
        .map_err(|e| cmd_err("custom_analyze_video", e))
}

#[tauri::command]
pub async fn save_provider_api_key(
    provider: String,
    api_key: String,
) -> Result<(), String> {
    crate::credentials::set_api_key(&provider, &api_key)
        .map_err(|e| cmd_err("save_provider_api_key", e))
}

#[tauri::command]
pub async fn get_provider_api_key(
    provider: String,
) -> Result<String, String> {
    crate::credentials::get_api_key(&provider)
        .map_err(|e| cmd_err("get_provider_api_key", e))
}

#[tauri::command]
pub async fn reanalyze_single_media(
    media_id: i64,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    let pool = db_state.pool.clone();
    crate::batch::reanalyze_single_media(&pool, media_id)
        .await
        .map_err(|e| cmd_err("reanalyze_single_media", e))
}

#[tauri::command]
pub async fn check_ffmpeg_installed() -> Result<bool, String> {
    let output = crate::proc::hidden_command("ffmpeg")
        .arg("-version")
        .output();
    match output {
        Ok(out) => Ok(out.status.success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
pub async fn sync_folders(
    app_handle: AppHandle,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<(), String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    let pool = db_state.pool.clone();
    scan_state.cancel_flag.store(false, Ordering::SeqCst);
    scan_state.pause_flag.store(false, Ordering::SeqCst);

    let cancel_flag = scan_state.cancel_flag.clone();
    let pause_flag = scan_state.pause_flag.clone();

    tokio::spawn(async move {
        if let Err(e) = crate::batch::run_sync_folders(&app_handle, &pool, cancel_flag, pause_flag).await {
            crate::logger::log_error(&format!("[Sync Aborted] Folder sync terminated with an error: {}", e));
        }
    });

    Ok(())
}

#[tauri::command]
pub fn get_system_vram_gb() -> Result<f64, String> {
    #[cfg(target_os = "windows")]
    {
        use crate::proc::hidden_command;

        // 1. Try nvidia-smi (Most accurate for NVIDIA GPUs like RTX 5070 Ti / 40xx / 30xx)
        if let Ok(out) = hidden_command("nvidia-smi")
            .args(&["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
            .output()
        {
            if out.status.success() {
                let stdout = String::from_utf8_lossy(&out.stdout);
                for line in stdout.lines() {
                    if let Ok(mb) = line.trim().parse::<f64>() {
                        if mb > 0.0 {
                            let gb = (mb / 1024.0 * 10.0).round() / 10.0;
                            return Ok(gb);
                        }
                    }
                }
            }
        }

        // 2. PowerShell Registry Query (Avoid 32-bit AdapterRAM 4GB cap bug)
        let ps_cmd = r#"
        $vram = 0
        Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.'HardwareInformation.DedicatedVideoMemory') {
                $val = [int64]$_.'HardwareInformation.DedicatedVideoMemory'
                if ($val -gt $vram) { $vram = $val }
            }
            if ($_.'qwMemorySize') {
                $val = [int64]$_.'qwMemorySize'
                if ($val -gt $vram) { $vram = $val }
            }
        }
        if ($vram -gt 0) { [math]::Round($vram / 1GB, 1) } else { 0 }
        "#;

        if let Ok(out) = hidden_command("powershell")
            .args(&["-NoProfile", "-Command", ps_cmd])
            .output()
        {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if let Ok(gb) = line.trim().parse::<f64>() {
                    if gb > 0.0 {
                        return Ok(gb);
                    }
                }
            }
        }
    }

    // Return 0.0 if VRAM could not be reliably detected
    Ok(0.0)
}


