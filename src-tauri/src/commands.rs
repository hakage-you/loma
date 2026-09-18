use crate::batch::{fetch_ollama_models, fetch_vision_capable_models, run_scan_and_batch};
use crate::db::DbState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

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
    /// 失敗の種別コード（`llm::error_kind`）。失敗一覧のグループ化に使う
    pub analysis_error_kind: Option<String>,
    /// 同じ種別で連続して失敗した回数
    pub consecutive_failures: i64,
    /// 再試行しても直らない見込みで、ユーザーの判断を要するか。
    /// 判定基準は `llm::needs_attention` にだけ置き、フロントには複製しない
    pub needs_attention: bool,
    /// 解析対象から外されているか（`excluded_paths` に載っている）
    pub excluded: bool,
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
        SELECT m.id, m.file_path, m.parent_folder, m.thumbnail_path, m.file_size, m.analysis_status, m.analysis_error,
               m.analysis_error_kind, m.consecutive_failures,
               EXISTS(SELECT 1 FROM excluded_paths e WHERE e.path = m.file_path)
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

    let rows = sqlx::query_as::<
        _,
        (i64, String, String, String, i64, String, Option<String>, Option<String>, i64, i64),
    >(&query)
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
    for (
        id,
        file_path,
        parent_folder,
        thumbnail_path,
        file_size,
        analysis_status,
        analysis_error,
        analysis_error_kind,
        consecutive_failures,
        excluded_flag,
    ) in rows
    {
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

        let needs_attention = analysis_status == "failed"
            && crate::llm::needs_attention(
                analysis_error_kind
                    .as_deref()
                    .unwrap_or(crate::llm::error_kind::UNKNOWN),
                consecutive_failures,
            );

        result.push(MediaItem {
            id,
            file_path,
            parent_folder,
            thumbnail_path,
            file_size,
            analysis_status,
            analysis_error,
            analysis_error_kind,
            consecutive_failures,
            needs_attention,
            excluded: excluded_flag != 0,
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

#[derive(Deserialize, Debug, Clone)]
pub struct SettingEntry {
    pub key: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ApiKeyEntry {
    pub provider: String,
    pub api_key: String,
}

/// API キーだけが保存できなかったときの内訳。設定本体とは保存先が違うので分けて返す。
#[derive(Serialize, Debug, Clone)]
pub struct ApiKeyFailure {
    pub provider: String,
    pub message: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct SaveSettingsResult {
    pub settings_saved: usize,
    pub api_keys_saved: usize,
    pub api_key_failures: Vec<ApiKeyFailure>,
}

/// 設定を1トランザクションで書く。**途中まで入った状態は作らない。**
/// コマンドから切り出してあるのはテストのため（`State` はテストで組み立てられない）。
async fn write_settings_atomically(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    entries: &[SettingEntry],
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    for entry in entries {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        )
        .bind(&entry.key)
        .bind(&entry.value)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// 設定を1往復でまとめて保存する。
///
/// `update_setting` を項目数だけ呼ぶと、その回数だけ IPC を往復し、
/// フロントは毎回 `setSettings` で再描画する。設定画面の保存が長くかかり、
/// **その間に別の値を触られると、保存されるのは押した時点の値だけ**になっていた。
/// ここに寄せて、DB への書き込みは1トランザクションで全部入るか全部入らないかにする。
///
/// API キーだけは保存先が OS の資格情報ストアなので同じトランザクションに入らない。
/// 設定本体を確定させてから書き、失敗したプロバイダーは握り潰さず内訳で返す
/// （呼び出し側が「設定は保存された / このキーだけ入っていない」と出せるように）。
#[tauri::command]
pub async fn save_settings(
    entries: Vec<SettingEntry>,
    api_keys: Vec<ApiKeyEntry>,
    db_state: State<'_, DbState>,
) -> Result<SaveSettingsResult, String> {
    write_settings_atomically(&db_state.pool, &entries)
        .await
        .map_err(|e| cmd_err("save_settings", e))?;

    let mut api_keys_saved = 0usize;
    let mut api_key_failures = Vec::new();
    for entry in &api_keys {
        match crate::credentials::set_api_key(&entry.provider, &entry.api_key) {
            Ok(()) => api_keys_saved += 1,
            Err(e) => api_key_failures.push(ApiKeyFailure {
                provider: entry.provider.clone(),
                message: e.to_string(),
            }),
        }
    }

    Ok(SaveSettingsResult {
        settings_saved: entries.len(),
        api_keys_saved,
        api_key_failures,
    })
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

/// `get_available_models` のうち、Ollama が `vision` を宣言しているモデルの名前だけを返す。
///
/// VLM のプルダウンはこれで絞り込む。**宣言があっても解析が安定する保証は無い**ため、
/// 呼び出し側で「動作確認済み」と読めるラベルを付けないこと。
/// `refresh` を true にすると `/api/show` の結果を取り直す（「モデル一覧を取得」ボタン用）。
#[tauri::command]
pub async fn get_vision_capable_models(
    db_state: State<'_, DbState>,
    refresh: bool,
) -> Result<Vec<String>, String> {
    let url: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ollama_url'")
        .fetch_optional(&db_state.pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "http://localhost:11434".to_string());

    fetch_vision_capable_models(&url, refresh)
        .await
        .map_err(|e| e.to_string())
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

/// 適用の結果。UI が「N件の提案が無効になりました」を出すのに使う
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ApplyMergesResult {
    /// 実際に消えたタグの数
    pub merged_tags: usize,
    /// 統合先の数（`merge_tags` を呼んだ回数）
    pub targets: usize,
    /// 競合。**空でなければ何も適用していない**
    pub conflicts: Vec<MergeConflict>,
}

/// 承認された提案をまとめて適用する。
///
/// **提案ごとではなく、解決済みの写像ごとに `merge_tags` を呼ぶ。**
/// これで「どの順に適用したか」という概念自体が消える。
///
/// 競合（同じタグに鎖でつながらない2つの行き先）があれば**何も適用せず**返す。
/// ユーザーに選ばせてから呼び直す。
#[tauri::command]
pub async fn apply_tag_merges(
    items: Vec<MergePlanItem>,
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<ApplyMergesResult, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;

    let plan = match resolve_merge_plan(&items) {
        Ok(p) => p,
        Err(conflicts) => {
            return Ok(ApplyMergesResult { merged_tags: 0, targets: 0, conflicts })
        }
    };

    // 最終的な行き先ごとにまとめる
    let mut by_target: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    for (&src, &dst) in &plan.redirects {
        by_target.entry(dst).or_default().push(src);
    }

    let mut tx = db_state.pool.begin().await.map_err(|e| e.to_string())?;
    let mut merged = 0usize;
    for (target_id, source_ids) in &by_target {
        for src_id in source_ids {
            sqlx::query(
                "INSERT OR IGNORE INTO media_tags (media_id, tag_id) \
                 SELECT media_id, ?1 FROM media_tags WHERE tag_id = ?2",
            )
            .bind(target_id)
            .bind(src_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;

            let r = sqlx::query("DELETE FROM tags WHERE id = ?1")
                .bind(src_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
            merged += r.rows_affected() as usize;
        }
    }

    // 浮いた未使用タグの掃除。**統合と無関係なタグも消える**ので、
    // 提案の再構成では必ずタグ一覧を読み直すこと
    sqlx::query(
        "DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)",
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    crate::logger::log_info(&format!(
        "Applied tag merges: {} tags into {} targets",
        merged,
        by_target.len()
    ));
    Ok(ApplyMergesResult { merged_tags: merged, targets: by_target.len(), conflicts: Vec::new() })
}

/// 適用したときに**無効になる提案**を、適用前に数える。
///
/// **取り消せない操作の前に見せる**ためのもの。適用後に知らせても手遅れになる。
/// 前もって分かれば「先にこちらを採用する」といった判断ができる。
///
/// 数えるのは**保持している全方式**。37分かけた包括関係の結果が
/// 知らないうちに削られるのを防ぐ。
#[tauri::command]
pub fn count_invalidated_suggestions(
    items: Vec<MergePlanItem>,
    suggestions: Vec<MergeSuggestion>,
) -> Vec<(String, usize)> {
    let Ok(plan) = resolve_merge_plan(&items) else {
        return Vec::new();
    };
    let doomed: std::collections::HashSet<i64> = plan.redirects.keys().copied().collect();
    let mut by_rule: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for s in &suggestions {
        let involved = std::iter::once(s.target_tag.id)
            .chain(s.source_tags.iter().map(|t| t.id))
            .filter(|id| doomed.contains(id))
            .count();
        // 残るタグが1件以下になる提案は表示できなくなる
        let remaining = s.source_tags.len() + 1 - involved;
        if involved > 0 && remaining < 2 {
            let key = s.rules.first().cloned().unwrap_or_else(|| "other".to_string());
            *by_rule.entry(key).or_insert(0) += 1;
        }
    }
    let mut out: Vec<(String, usize)> = by_rule.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExcludedPathItem {
    pub path: String,
    pub reason: Option<String>,
    pub created_at: i64,
}

/// 指定したメディアを解析対象から外す。ファイルもDBレコードも消さない。
///
/// 除外は `media` の列ではなく `excluded_paths` に置く。`delete_media` で
/// media 行を消しても除外が残るようにするため。
#[tauri::command]
pub async fn exclude_media(
    media_ids: Vec<i64>,
    reason: Option<String>,
    db_state: State<'_, DbState>,
) -> Result<usize, String> {
    if media_ids.is_empty() {
        return Ok(0);
    }
    let pool = &db_state.pool;

    let ids_str = media_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let paths = sqlx::query_scalar::<_, String>(&format!(
        "SELECT file_path FROM media WHERE id IN ({})",
        ids_str
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| cmd_err("exclude_media", e))?;

    let mut excluded = 0usize;
    for path in &paths {
        let res = sqlx::query(
            "INSERT OR IGNORE INTO excluded_paths (path, reason) VALUES (?1, ?2)",
        )
        .bind(path)
        .bind(reason.as_deref())
        .execute(pool)
        .await
        .map_err(|e| cmd_err("exclude_media", e))?;
        excluded += res.rows_affected() as usize;
    }

    crate::logger::log_info(&format!(
        "[Exclude] Marked {} file(s) as not-to-analyze (reason: {})",
        excluded,
        reason.as_deref().unwrap_or("-")
    ));

    Ok(excluded)
}

/// 指定したメディアをライブラリから削除する。ファイル本体は消さない。
///
/// レコードを消すだけでは次のスキャンで再登録されるため、除外も併せて登録する。
#[tauri::command]
pub async fn delete_media(
    media_ids: Vec<i64>,
    reason: Option<String>,
    db_state: State<'_, DbState>,
) -> Result<usize, String> {
    if media_ids.is_empty() {
        return Ok(0);
    }
    let pool = &db_state.pool;

    let ids_str = media_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let rows = sqlx::query_as::<_, (String, String)>(&format!(
        "SELECT file_path, thumbnail_path FROM media WHERE id IN ({})",
        ids_str
    ))
    .fetch_all(pool)
    .await
    .map_err(|e| cmd_err("delete_media", e))?;

    for (path, _) in &rows {
        sqlx::query("INSERT OR IGNORE INTO excluded_paths (path, reason) VALUES (?1, ?2)")
            .bind(path)
            .bind(reason.as_deref())
            .execute(pool)
            .await
            .map_err(|e| cmd_err("delete_media", e))?;
    }

    let mut tx = pool.begin().await.map_err(|e| cmd_err("delete_media", e))?;
    for chunk in media_ids.chunks(500) {
        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");

        let q_tags = format!("DELETE FROM media_tags WHERE media_id IN ({})", placeholders);
        let mut query_tags = sqlx::query(&q_tags);
        for id in chunk {
            query_tags = query_tags.bind(id);
        }
        query_tags
            .execute(&mut *tx)
            .await
            .map_err(|e| cmd_err("delete_media", e))?;

        let q_media = format!("DELETE FROM media WHERE id IN ({})", placeholders);
        let mut query_media = sqlx::query(&q_media);
        for id in chunk {
            query_media = query_media.bind(id);
        }
        query_media
            .execute(&mut *tx)
            .await
            .map_err(|e| cmd_err("delete_media", e))?;
    }
    tx.commit().await.map_err(|e| cmd_err("delete_media", e))?;

    // 浮いたタグの自動削除
    let _ = sqlx::query(
        "DELETE FROM tags WHERE is_category = 0 AND id NOT IN (SELECT DISTINCT tag_id FROM media_tags)",
    )
    .execute(pool)
    .await;

    for (_, thumb) in &rows {
        if !thumb.is_empty() {
            let p = std::path::Path::new(thumb);
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    crate::logger::log_info(&format!(
        "[Delete] Removed {} media record(s) from the library and excluded them from future scans",
        rows.len()
    ));

    Ok(rows.len())
}

/// 除外を解除する。次のスキャンで再登録され、解析対象に戻る。
#[tauri::command]
pub async fn unexclude_paths(
    paths: Vec<String>,
    db_state: State<'_, DbState>,
) -> Result<usize, String> {
    if paths.is_empty() {
        return Ok(0);
    }
    let pool = &db_state.pool;

    let mut removed = 0usize;
    for path in &paths {
        let res = sqlx::query("DELETE FROM excluded_paths WHERE path = ?1")
            .bind(path)
            .execute(pool)
            .await
            .map_err(|e| cmd_err("unexclude_paths", e))?;
        removed += res.rows_affected() as usize;
    }

    crate::logger::log_info(&format!("[Exclude] Cleared {} exclusion(s)", removed));

    Ok(removed)
}

/// 除外中のパス一覧。
#[tauri::command]
pub async fn get_excluded_paths(
    db_state: State<'_, DbState>,
) -> Result<Vec<ExcludedPathItem>, String> {
    let rows = sqlx::query_as::<_, (String, Option<String>, i64)>(
        "SELECT path, reason, COALESCE(created_at, 0) FROM excluded_paths ORDER BY created_at DESC, path",
    )
    .fetch_all(&db_state.pool)
    .await
    .map_err(|e| cmd_err("get_excluded_paths", e))?;

    Ok(rows
        .into_iter()
        .map(|(path, reason, created_at)| ExcludedPathItem {
            path,
            reason,
            created_at,
        })
        .collect())
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

/// 1タグあたりに出すサンプルサムネイルの枚数。AI提案のカードと揃えてある。
const TAG_SAMPLE_THUMBNAIL_LIMIT: usize = 5;

/// タグごとのサンプルサムネイル。**表示中のタグのぶんだけまとめて引く。**
///
/// 1タグずつ引くと一覧の描画で件数ぶんの往復が出る（段階描画で200件なら200回）。
/// タグごとの上限は窓関数で切るので、返る行数は tag_ids.len() * 5 を超えない。
#[tauri::command]
pub async fn get_tag_sample_thumbnails(
    tag_ids: Vec<i64>,
    db_state: State<'_, DbState>,
) -> Result<std::collections::HashMap<i64, Vec<String>>, String> {
    let mut out: std::collections::HashMap<i64, Vec<String>> = std::collections::HashMap::new();
    if tag_ids.is_empty() {
        return Ok(out);
    }

    // IN 句の要素数には上限があるので分割する
    for chunk in tag_ids.chunks(400) {
        let ids_str = chunk
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let rows = sqlx::query_as::<_, (i64, String)>(&format!(
            "SELECT tag_id, thumbnail_path FROM ( \
               SELECT mt.tag_id AS tag_id, m.thumbnail_path AS thumbnail_path, \
                      ROW_NUMBER() OVER (PARTITION BY mt.tag_id ORDER BY m.id DESC) AS rn \
               FROM media_tags mt JOIN media m ON m.id = mt.media_id \
               WHERE mt.tag_id IN ({}) AND m.thumbnail_path != '' \
             ) WHERE rn <= {}",
            ids_str, TAG_SAMPLE_THUMBNAIL_LIMIT
        ))
        .fetch_all(&db_state.pool)
        .await
        .map_err(|e| cmd_err("get_tag_sample_thumbnails", e))?;

        for (tag_id, path) in rows {
            out.entry(tag_id).or_default().push(path);
        }
    }

    Ok(out)
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
/// 消えたファイルの行と、消えたサムネイルのパスを掃除する。
///
/// **定常的にはここを呼ばない。** 全メディアの `Path::exists()` を回るので、
/// 冷えた状態では実測で約3秒かかる（メディア 4,941件）。
/// 通常は「同期」が `cleanup_and_detect_moves` で同じ掃除をする
/// （そちらは移動の検出も兼ねるので、消えた扱いにする前に追随できる）。
/// これは移動検出を挟まずに片付けたいときの入口として残してある。
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
/// ログの末尾を返す。`max_bytes` を省略すると `DEFAULT_LOG_READ_BYTES`。
///
/// **定期的に呼ぶ側は必ず小さい `max_bytes` を渡すこと。** 返した文字列は
/// そのまま WebView の JS ヒープに載る（詳細は `logger::read_logs`）。
pub async fn get_app_logs(
    app_handle: AppHandle,
    max_bytes: Option<u64>,
) -> Result<String, String> {
    let cap = max_bytes.unwrap_or(crate::logger::DEFAULT_LOG_READ_BYTES);
    Ok(crate::logger::read_logs(&app_handle, cap))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeSuggestion {
    pub id: String,
    pub target_tag: TagItem,
    pub source_tags: Vec<TagItem>,
    pub reason: String,
    pub confidence: String,
    pub sample_thumbnails: Vec<String>,
    pub total_images_count: usize,
    /// 当たった規則の識別子（`ja_exact` / `singular` / `keyphrase` / `ja_prefix` / `spelling`）。
    ///
    /// **UI はこれで分類・絞り込みをする。** 表示文字列に依存した判定をしないため、
    /// ラベル（`reason`）とは別に持つ。
    /// **複数入っていれば確度が高い** —— 並び順の第一キーに使う。
    #[serde(default)]
    pub rules: Vec<String>,
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
    /// 当たった規則すべて。**1つとは限らない**（複数一致は確度が高い）
    hits: Vec<RuleHit>,
}

/// 提案の組み立てに使うタグの一覧。カテゴリは統合の対象外なので除く。
async fn load_tag_map(
    pool: &sqlx::Pool<sqlx::Sqlite>,
) -> Result<std::collections::HashMap<i64, TagItem>, String> {
    let rows = sqlx::query_as::<_, (i64, String, Option<String>, i64, i64, String)>(
        r#"
        SELECT t.id, t.name, t.name_ja, t.is_category, COUNT(mt.media_id) AS count, t.tag_kind
        FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
        WHERE t.is_category = 0
        GROUP BY t.id, t.name, t.name_ja, t.is_category, t.tag_kind
        "#,
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|(id, name, name_ja, is_cat, count, kind)| {
            (
                id,
                TagItem { id, name, name_ja, is_category: is_cat == 1, count, kind },
            )
        })
        .collect())
}

fn parse_method(method: Option<&str>) -> crate::suggestion_store::Method {
    use crate::suggestion_store::Method;
    match method {
        Some("hypernym") => Method::Hypernym,
        Some("related") => Method::Related,
        _ => Method::Rules,
    }
}

/// 保存済みの判定から提案を組み立てる。**新規スキャンもこれを通す。**
///
/// 経路を分けると、同じ判定を見ているのに件数も中身も変わる
/// （実測: 新規スキャン 8,984件 / 読み出し 2,460件）。
///
/// 統合で消えたタグは外部キーで既に落ちており、残りのペアはそのまま使える
/// （②は段1からの作り直しになるため、1回の統合で払う代償ではない）。
pub async fn build_suggestions_from_store(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    m: crate::suggestion_store::Method,
    tag_map: &std::collections::HashMap<i64, TagItem>,
) -> Result<Vec<MergeSuggestion>, String> {
    use crate::suggestion_store::Method;
    let pairs = crate::suggestion_store::load_pairs(pool, m).await?;
    if pairs.is_empty() {
        return Ok(Vec::new());
    }

    // **集約の仕方は方式で違う。**
    //   ①② target ごとに1ホップだけ集約する（推移閉包を作らないので暴走しない）
    //   ③   連結成分（クラスタを作るのが目的。閾値の算出で最大サイズを抑えてある）
    let grouped = crate::suggestion_store::group_by_target(&pairs);
    let groups: Vec<Vec<i64>> = if m == Method::Related {
        let mut adj: std::collections::HashMap<i64, std::collections::HashSet<i64>> =
            std::collections::HashMap::new();
        for p in &pairs {
            adj.entry(p.target_id).or_default().insert(p.member_id);
            adj.entry(p.member_id).or_default().insert(p.target_id);
        }
        connected_components(&adj)
    } else {
        grouped
            .iter()
            .map(|(t, members, _)| {
                let mut ids = vec![*t];
                ids.extend(members.iter().copied());
                ids
            })
            .collect()
    };

    // 規則と類似度は **target 側からも member 側からも引けるようにする**
    // （③は連結成分なので、グループの先頭が保存時の target とは限らない）
    let mut rules_of: std::collections::HashMap<i64, Vec<String>> =
        std::collections::HashMap::new();
    let mut min_score: std::collections::HashMap<i64, f32> = std::collections::HashMap::new();
    for p in &pairs {
        for id in [p.target_id, p.member_id] {
            if !p.rules.is_empty() {
                rules_of.entry(id).or_default().extend(p.rules.iter().cloned());
            }
            if let Some(s) = p.score {
                let e = min_score.entry(id).or_insert(s);
                if s < *e {
                    *e = s;
                }
            }
        }
    }
    // target 側の規則を優先する（①はそこに全規則がまとまっている）
    for (t, _, r) in &grouped {
        if !r.is_empty() {
            rules_of.insert(*t, r.clone());
        }
    }

    // **集約の鍵になったタグをそのまま代表にする。**
    //
    // ①② はどちらも保存時に代表が決まっている（①は使用数が多い方、②は段1の包括語）。
    // ここで選び直すと、別の鍵で集めた2つのグループが同じ見出しになる
    // （実測: `green_eyed_character <- …` が2件並んだ）。
    // グループのメンバーは鍵との関係で選ばれているので、見出しを変えると対応が壊れる。
    //
    // ③ だけは連結成分なので保存時の代表に意味がなく、使用数で選ぶ。
    let policy = match m {
        Method::Related => TargetPolicy::MostUsed,
        _ => TargetPolicy::Pinned,
    };

    Ok(build_suggestions(pool, &groups, tag_map, policy, |members| {
        let head = members.first().copied().unwrap_or(0);
        let mut rules = rules_of.get(&head).cloned().unwrap_or_default();
        rules.sort();
        rules.dedup();
        // **規則の識別子は必ず入れる。** 無効化の予告で「何の提案が消えるか」を
        // 出すのに使っており、空だと `other` と表示されて情報にならない。
        // ②③を規則の識別子なしで保存していた時期のデータもここで補える
        if rules.is_empty() {
            rules = match m {
                Method::Hypernym => vec!["hypernym".to_string()],
                Method::Related => vec!["embedding".to_string()],
                Method::Rules => Vec::new(),
            };
        }
        let reason = match m {
            Method::Hypernym => "AI: 包括関係".to_string(),
            // **抽出方法をそのまま見せる。** これが誤りを許容できる条件
            Method::Related => min_score
                .get(&head)
                .map(|s| format!("類似度 {:.2} 以上", s))
                .unwrap_or_else(|| "類似タグ".to_string()),
            Method::Rules => {
                if rules.len() > 1 {
                    format!("{}件のルールに該当", rules.len())
                } else {
                    "類似タグ".to_string()
                }
            }
        };
        (reason, rules)
    })
    .await)
}

#[tauri::command]
pub async fn load_tag_suggestions_cache(
    db_state: State<'_, DbState>,
    method: Option<String>,
) -> Result<Vec<MergeSuggestion>, String> {
    let pool = &db_state.pool;
    // 方式が指定されなければ直前に走らせたものを出す（UI にまだ切り替えが無いため）
    let m = match method.as_deref() {
        Some(s) => parse_method(Some(s)),
        None => match crate::suggestion_store::latest_method(pool).await {
            Some(m) => m,
            None => return Ok(Vec::new()),
        },
    };
    let tag_map = load_tag_map(pool).await?;
    build_suggestions_from_store(pool, m, &tag_map).await
}

/// 提案を却下する。**行は消さない。**
///
/// 消すと再実行で同じ提案が戻る。`dismissed` を立てるだけにすると、
/// 後から新しいメンバーが加わったときにそのメンバーだけが提案に出る。
#[tauri::command]
pub async fn dismiss_tag_suggestion(
    db_state: State<'_, DbState>,
    method: Option<String>,
    target_id: i64,
    member_ids: Vec<i64>,
) -> Result<(), String> {
    let m = match method.as_deref() {
        Some(s) => parse_method(Some(s)),
        None => match crate::suggestion_store::latest_method(&db_state.pool).await {
            Some(m) => m,
            None => return Ok(()),
        },
    };
    // target と member はグループの並べ替えで入れ替わりうるので両方向を消す
    crate::suggestion_store::dismiss(&db_state.pool, m, target_id, &member_ids).await?;
    for id in &member_ids {
        crate::suggestion_store::dismiss(&db_state.pool, m, *id, &[target_id]).await?;
    }
    Ok(())
}

/// 方式の実行状態。UI が「途中で止まっている」を出せるようにする。
#[tauri::command]
pub async fn get_suggestion_run_status(
    db_state: State<'_, DbState>,
    method: Option<String>,
) -> Result<Option<crate::suggestion_store::RunStatus>, String> {
    crate::suggestion_store::run_status(&db_state.pool, parse_method(method.as_deref())).await
}

/// ルール判定で無視する一般語。固有度の低い語で誤ってペアを作らないためのもの。
const SYNONYM_STOP_WORDS: &[&str] = &[
    "photo", "image", "media", "picture", "mobile", "device", "screen", "paper", "plant",
    "board", "model", "system", "object", "item", "product", "style", "design", "background",
    "foreground", "color", "light", "dark", "white", "black", "text", "view", "part", "detail",
    "group", "card", "type", "file", "data", "info", "page", "line", "sign", "wood", "glass",
    "metal", "app", "application", "icon", "logo", "vector", "art", "graphic", "illustration",
    "set", "collection", "element", "symbol", "banner", "web", "website", "online", "digital",
];

/// ルール判定用にタグ1件を前処理した形。総当りで使い回すため事前に作る。
pub struct TagMeta<'a> {
    pub item: &'a TagItem,
    pub norm_name: String,
    pub words: Vec<&'a str>,
    pub ja_clean: Option<String>,
}

pub fn build_tag_meta(t: &TagItem) -> TagMeta<'_> {
    let norm_name = crate::batch::normalize_tag_en(&t.name);
    let words: Vec<&str> = t
        .name
        .split(&['_', '-'][..])
        .filter(|w| w.len() >= 3 && !SYNONYM_STOP_WORDS.contains(w))
        .collect();
    let ja_clean = t.name_ja.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    TagMeta { item: t, norm_name, words, ja_clean }
}

/// ルールベースの同義語判定。一致したら理由を返す。
///
/// **LLM に期待できるのは、ここが `None` を返すペアだけ。** 本番は LLM の前にこの判定を通し、
/// 両者の結果を同じ `raw_pairs` にマージする。ルールが既に拾うペアを LLM が出しても価値は 0 なので、
/// モデルを評価するときは必ずここを通して「ルールで到達できないペア」に絞ること
/// （`tools/text-check` はこれを `#[ignore]` テスト `classify_rule_pairs` 経由で呼ぶ）。
///
/// 呼び出し側で種別（`kind`）が同じことを確認してから渡すこと。
/// 1つの規則が当たったことを表す
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RuleHit {
    /// UI が分類・絞り込みに使う識別子（表示文字列に依存させない）
    pub rule: String,
    /// 表示用のラベル。一致した中身を含む
    pub label: String,
}

/// どの規則に当たったかを**全部**集める。
///
/// 以前は先頭から順に評価して最初に当たった時点で `return` していたため、
/// **複数の規則が同時に当たったことが分からなかった。**
/// 複数一致は統合の確度が高い signal なので、優先度に使う。
///
/// 併せて**どの規則で出た提案かを UI で見せる**ことで誤爆が問題になりにくくなる。
/// 「編集距離グループは誤爆が多いが、複数形は当たりやすい」と分かれば、
/// ユーザーは規則ごとに構えを変えられる（§8.7 の「抽出方法を示す」の延長）。
pub fn rule_matches(p1: &TagMeta, p2: &TagMeta) -> Vec<RuleHit> {
    let mut hits = Vec::new();
    let mut hit = |rule: &str, label: String| hits.push(RuleHit { rule: rule.to_string(), label });

    // 1-A. 日本語訳完全一致 (例:どちらも「猫」)
    if let (Some(ref ja1), Some(ref ja2)) = (&p1.ja_clean, &p2.ja_clean) {
        if ja1 == ja2 {
            hit("ja_exact", format!("同一日本語表記 ({})", ja1));
        }
    }

    // 1-B. 単数形正規化一致 (例: cat と cats)
    if p1.norm_name == p2.norm_name {
        hit("singular", format!("単数形・表記統一 ({})", p1.norm_name));
    }

    // 1-C. 共通単語・フレーズ (ストップワードを除外し、固有度が高いフレーズのみ一致とみなす)
    if !p1.words.is_empty() && !p2.words.is_empty() {
        let common_words: Vec<String> = p1
            .words
            .iter()
            .filter(|w| p2.words.contains(w))
            .map(|s| s.to_string())
            .collect();

        // **「1語でも7文字以上なら一致」は撤廃した（2026-08-06）。**
        //
        // `japanese`(8文字) のような頻出語1つで統合を提案してしまい、
        // `japanese_text` に `japanese_tea` / `japanese_craft_gin` /
        // `complete_japanese_version` … が延々と並んだ。
        // 実測でこの条件だけが提案 33,508件中 29,734件（89%）を生んでいた。
        //
        // 連結成分にしていた頃はこれらが1つの群に畳まれて見えず、
        // さらにグループサイズ上限15が群ごと捨てていたので表面化しなかった。
        // **ペア単位にして初めて質が可視化された。**
        //
        // ストップワードで落とし切れない一般語が「長い」だけで一致になるのは
        // 規則として無理がある。共通語2語以上のみを一致とする。
        if common_words.len() >= 2 {
            hit("keyphrase", format!("共通キーフレーズ ({})", common_words.join(", ")));
        }
    }

    // 1-D. 日本語の共通プレフィックス・キーワード (例: ESP32開発ボード ↔ ESP32-WROOMボード)
    if let (Some(ref ja1), Some(ref ja2)) = (&p1.ja_clean, &p2.ja_clean) {
        if ja1.chars().count() >= 4 && ja2.chars().count() >= 4 {
            let common_prefix: String = ja1
                .chars()
                .zip(ja2.chars())
                .take_while(|(c1, c2)| c1 == c2)
                .map(|(c, _)| c)
                .collect();
            if common_prefix.chars().count() >= 4 {
                hit("ja_prefix", format!("類似日本語表記 ({})", common_prefix));
            }
        }
    }

    // 1-E. 編集距離が非常に近い (例: smart_phone と smartphone)
    if p1.item.name.len() >= 4 && p2.item.name.len() >= 4 {
        let len_diff = (p1.item.name.len() as isize - p2.item.name.len() as isize).abs();
        if len_diff <= 3 {
            let dist = levenshtein_distance(&p1.item.name, &p2.item.name);
            let max_len = p1.item.name.len().max(p2.item.name.len());
            if dist == 1 || (dist <= 3 && max_len >= 8) {
                hit("spelling", format!("類似スペル (編集距離 {})", dist));
            }
        }
    }

    hits
}

/// 後方互換。最初に当たった規則のラベルだけを返す。
///
/// 計測ツール（`classify_rule_pairs`）が「ルールで拾えるか否か」の判定に使う。
/// **提案の生成には使わない** —— そちらは複数一致を優先度に使うため `rule_matches` を直接呼ぶ。
pub fn rule_based_match_reason(p1: &TagMeta, p2: &TagMeta) -> Option<String> {
    rule_matches(p1, p2).into_iter().next().map(|h| h.label)
}

/// ルール判定に掛ける「候補の組」を索引で集める。**全ペア走査の代わり。**
///
/// タグ数はメディア数にほぼ比例して増え続けるので（実測 Heaps β=0.90。
/// 1万枚で43,300件・9.4億ペア）、全ペア走査は規模的に成立しない。
///
/// **判定そのものは変えない。** ここは「判定する必要がある組」を集めるだけで、
/// 各規則が拾う組は必ずこの網に含まれる:
///
/// | 規則 | 拾う条件 | 索引 |
/// |---|---|---|
/// | 1-A 同一日本語表記 | `ja_clean` が一致 | `ja_clean` をキーにグループ化 |
/// | 1-B 単数形正規化 | `norm_name` が一致 | `norm_name` をキーにグループ化 |
/// | 1-C 共通キーフレーズ | 共通語が2語以上、または1語で7文字以上 | 単語の転置索引（**共通語が1つでもあれば同じ posting に入る**） |
/// | 1-D 日本語プレフィックス | 先頭4文字が一致 | 先頭4文字をキーにグループ化 |
/// | 1-E 編集距離 | 距離1、または距離3以下で8文字以上 | 長さ差3以内が必要なので**長さバケット**、さらに文字集合で絞る |
///
/// **各索引は「その規則が拾う条件」を包含する。** 緩い代用ではない:
///
/// - 1-C は「共通語2語以上」なので**語のペア**を鍵にする。1語ずつを鍵にすると
///   `black` のような一般語で巨大な posting ができて組み合わせ爆発する
/// - 1-E の距離1は**1文字削除の変種**を鍵にする。距離1の2語は必ず同じ変種を持つ
///   （置換なら差異位置を、挿入・削除なら余分な文字を削れば一致する）
/// - 1-E の距離3以下（8文字以上）は**2-gram**。長さ8以上で2-gram は7個以上あり、
///   1回の編集が壊す 2-gram は高々2個なので、3回編集しても最低1個は共有される
fn rule_candidate_pairs(metas: &[TagMeta]) -> Vec<(usize, usize)> {
    use std::collections::{HashMap, HashSet};

    let mut buckets: HashMap<String, Vec<usize>> = HashMap::new();
    let push = |key: String, i: usize, b: &mut HashMap<String, Vec<usize>>| {
        b.entry(key).or_default().push(i);
    };

    // **規則1-C の癖への対応。**
    //
    // `common_words` は重複を許すので、`side_by_side` のように1つのタグ内で
    // 同じ語が2回出ると、その語を1つ持つだけの相手とも「2語以上一致」になる。
    // 語のペアを鍵にする索引ではこれを再現できないため、
    // **どこかで重複している語だけ**は単独でも鍵にする。
    // 対象は数語しかないので posting が膨らむ心配は無い。
    let mut dup_words: HashSet<&str> = HashSet::new();
    for m in metas {
        let mut seen_w: HashSet<&str> = HashSet::new();
        for w in &m.words {
            if !seen_w.insert(w) {
                dup_words.insert(w);
            }
        }
    }

    for (i, m) in metas.iter().enumerate() {
        // 1-A: 日本語表記の完全一致
        if let Some(ja) = &m.ja_clean {
            push(format!("ja:{}", ja), i, &mut buckets);
            // 1-D: 先頭4文字
            let chars: Vec<char> = ja.chars().collect();
            if chars.len() >= 4 {
                push(format!("jap:{}", chars[..4].iter().collect::<String>()), i, &mut buckets);
            }
        }

        // 1-B: 単数形正規化
        push(format!("nm:{}", m.norm_name), i, &mut buckets);

        // 1-C(a): 共通語が2語以上 → 語のペアを鍵にする（2語共有なら必ず同じペアを持つ）
        let mut ws: Vec<&str> = m.words.clone();
        ws.sort_unstable();
        ws.dedup();
        for a in 0..ws.len() {
            for b in (a + 1)..ws.len() {
                push(format!("ww:{}|{}", ws[a], ws[b]), i, &mut buckets);
            }
        }
        // 1-C(b): どこかで重複している語は単独でも鍵にする（上記の癖への対応）。
        //         「1語7文字以上」の条件は規則から撤廃したので、長語の索引は不要
        for w in &ws {
            if dup_words.contains(w) {
                push(format!("w:{}", w), i, &mut buckets);
            }
        }

        // 1-E: 編集距離。**規則と同じくバイト長で判定する**
        // （規則は `name.len()` を見ており、文字数ではない）
        let name = &m.item.name;
        if name.len() >= 4 {
            let cs: Vec<char> = name.chars().collect();
            // (a) 距離1 → 1文字削除の変種。
            //     **元の文字列も鍵にする。** 挿入・削除の組（`cat` / `cats`）は
            //     「短い方の原文」と「長い方の削除変種」で出会うため、
            //     変種だけを入れると取りこぼす
            push(format!("d:{}", name), i, &mut buckets);
            for d in 0..cs.len() {
                let v: String = cs
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| *k != d)
                    .map(|(_, c)| *c)
                    .collect();
                push(format!("d:{}", v), i, &mut buckets);
            }
            // (b) 距離3以下かつ**ペアの長い方**が8以上 → 2文字削除の変種。
            //
            //     長さ差は3以内なので、長い方が8以上なら短い方は5以上。
            //     **自分の長さで8以上に絞ってはいけない**（7文字と9文字の組を落とす）。
            //
            //     距離3の2語は、**それぞれから差異のある3箇所を削れば一致する**。
            //     深さ2では足りない（3箇所とも置換なら1箇所残る。実測で460件取りこぼした）。
            //
            //     **2-gram は使わない。** `er` や `in` が数百タグに現れて選択性が無く、
            //     実測でこの索引だけが候補の99.7%（1,482万ペア）を占めていた。
            if name.len() >= 5 {
                let del = |skip: &[usize]| -> String {
                    cs.iter()
                        .enumerate()
                        .filter(|(k, _)| !skip.contains(k))
                        .map(|(_, c)| *c)
                        .collect()
                };
                for a in 0..cs.len() {
                    for b in (a + 1)..cs.len() {
                        push(format!("d:{}", del(&[a, b])), i, &mut buckets);
                        for c in (b + 1)..cs.len() {
                            push(format!("d:{}", del(&[a, b, c])), i, &mut buckets);
                        }
                    }
                }
            }
        }
    }

    // どの索引が候補数を支配しているかを見る（`LOMA_INDEX_PROFILE=1`）
    if std::env::var("LOMA_INDEX_PROFILE").is_ok() {
        let mut by_kind: HashMap<&str, (usize, usize, usize)> = HashMap::new();
        for (k, ids) in buckets.iter() {
            if ids.len() < 2 {
                continue;
            }
            let label = match k.split(':').next().unwrap_or("?") {
                "ja" => "1-A 日本語一致",
                "nm" => "1-B 正規化",
                "ww" => "1-C 語ペア",
                "w" => "1-C 長語/重複語",
                "jap" => "1-D 日本語接頭",
                "d" => "1-E 編集距離",
                
                _ => "?",
            };
            let e = by_kind.entry(label).or_insert((0, 0, 0));
            e.0 += 1;
            e.1 += ids.len() * (ids.len() - 1) / 2;
            e.2 = e.2.max(ids.len());
        }
        let mut v: Vec<_> = by_kind.into_iter().collect();
        v.sort_by_key(|x| std::cmp::Reverse(x.1 .1));
        for (name, (nb, np, mx)) in v {
            println!("INDEX_PROFILE {:<18} バケット{:<7} ペア{:<12} 最大{}", name, nb, np, mx);
        }
    }

    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    let mut out = Vec::new();
    for ids in buckets.values_mut() {
        // 同じタグが同一バケットに複数回入ることがある
        // （削除変種が重複する等）。放置すると自己ペアが出る
        ids.sort_unstable();
        ids.dedup();
        if ids.len() < 2 {
            continue;
        }
        for a in 0..ids.len() {
            for b in (a + 1)..ids.len() {
                let (x, y) = (ids[a], ids[b]);
                if seen.insert((x, y)) {
                    out.push((x, y));
                }
            }
        }
    }
    out
}

/// 承認された提案1件分。UI から渡される。
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MergePlanItem {
    /// 統合先。**既存タグのID**
    pub target_id: i64,
    /// 統合されて消えるタグ
    pub source_ids: Vec<i64>,
}

/// 同じタグに鎖でつながらない2つの行き先がある状態
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct MergeConflict {
    pub tag_id: i64,
    /// 競合する行き先（2つ以上）
    pub target_ids: Vec<i64>,
}

/// 解決済みの写像。`source -> 最終的な行き先`
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlan {
    /// タグID → 最終的な統合先
    pub redirects: std::collections::BTreeMap<i64, i64>,
}

/// 承認集合を**写像として一括で解決する**。
///
/// **提案ごとに `merge_tags` を呼んではいけない。**
/// `merge_tags` は既に削除されたIDを渡されてもエラーを返さない（INSERT 0行・DELETE 0行）ので、
/// 順番次第で結果が変わり、しかも**ユーザーには成功と表示されたまま中身だけが変わる**。
///
/// 鎖は推移的に畳む: `soup_bowl -> bowl` と `bowl -> container` を両方承認したなら
/// `soup_bowl -> container`。ユーザーが承認した統合しか経由しないので、
/// LLM の誤りが勝手に伝播することはない。
///
/// 鎖でつながらない2つの行き先があるときだけ**競合**として返す。
pub fn resolve_merge_plan(items: &[MergePlanItem]) -> Result<ResolvedPlan, Vec<MergeConflict>> {
    use std::collections::{BTreeMap, BTreeSet};

    // source -> 直接の行き先（複数ありうる）
    let mut direct: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
    for item in items {
        for &s in &item.source_ids {
            if s != item.target_id {
                direct.entry(s).or_default().insert(item.target_id);
            }
        }
    }

    // 鎖を辿って最終的な行き先を求める。循環は自分自身で打ち切る
    let final_of = |start: i64| -> i64 {
        let mut cur = start;
        let mut seen = BTreeSet::new();
        while seen.insert(cur) {
            // 行き先が1つに定まらない間は畳めないので、ここでは最初の1つで辿る
            match direct.get(&cur).and_then(|s| s.iter().next().copied()) {
                Some(next) if next != cur => cur = next,
                _ => break,
            }
        }
        cur
    };

    let mut conflicts = Vec::new();
    let mut redirects = BTreeMap::new();
    for (&src, targets) in &direct {
        // **すべての行き先が同じ終点に落ちるなら鎖であって競合ではない。**
        // `A -> B` と `A -> C` でも `B -> C` なら A は C に行くだけ
        let ends: BTreeSet<i64> = targets.iter().map(|&t| final_of(t)).collect();
        if ends.len() > 1 {
            conflicts.push(MergeConflict {
                tag_id: src,
                target_ids: targets.iter().copied().collect(),
            });
            continue;
        }
        let end = ends.into_iter().next().unwrap_or(src);
        if end != src {
            redirects.insert(src, end);
        }
    }

    if conflicts.is_empty() {
        Ok(ResolvedPlan { redirects })
    } else {
        Err(conflicts)
    }
}

/// 隣接リストから連結成分を取り出す。**ルール検出と関連タグの両方が使う。**
///
/// 2件未満の成分は提案にならないので落とす。
/// **サイズの上限は設けない** — 以前は15件で切っていたが、集約でグループを作る方式では
/// 最大57件が実際に出る（実測）。上限があると最も価値のある提案から消える。
pub fn connected_components(
    adj: &std::collections::HashMap<i64, std::collections::HashSet<i64>>,
) -> Vec<Vec<i64>> {
    let mut visited: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut groups = Vec::new();

    // **HashMap / HashSet の走査順に依存しない。**
    // Rust の既定ハッシャはプロセスごとに種が変わるので、そのまま走査すると
    // BFS の開始点と訪問順が実行ごとに変わり、同じ DB・同じバイナリでも
    // グループの並びとメンバーの並びが入れ替わる。
    // 並びが変わると、使用数が同点のタグで代表が入れ替わる（実測 742件中14件）。
    let mut nodes: Vec<i64> = adj.keys().copied().collect();
    nodes.sort_unstable();

    for node in nodes {
        if !visited.insert(node) {
            continue;
        }
        let mut members = Vec::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(node);

        while let Some(curr) = queue.pop_front() {
            members.push(curr);
            if let Some(neighbors) = adj.get(&curr) {
                let mut sorted: Vec<i64> = neighbors.iter().copied().collect();
                sorted.sort_unstable();
                for n in sorted {
                    if visited.insert(n) {
                        queue.push_back(n);
                    }
                }
            }
        }
        if members.len() > 1 {
            groups.push(members);
        }
    }
    // 大きいグループから。同数なら最小のIDが先
    groups.sort_by(|a, b| {
        b.len()
            .cmp(&a.len())
            .then_with(|| a.iter().min().cmp(&b.iter().min()))
    });
    groups
}


/// 連結成分の決定性。
///
/// **`HashMap` の走査順に依存していると、ここで落ちる。**
/// Rust の `RandomState` は `HashMap` を作るたびに鍵が変わるので、
/// 同じ中身でも作り直した `HashMap` は走査順が違う。
/// 実データ（提案 742件）では、この順の違いが「代表とメンバーの並びが
/// 実行ごとに入れ替わる」として表に出ていた。
#[cfg(test)]
mod connected_components_tests {
    use super::connected_components;
    use std::collections::{HashMap, HashSet};

    /// 同じ辺集合を、挿入順だけ変えて隣接リストにする
    fn adj_from(edges: &[(i64, i64)]) -> HashMap<i64, HashSet<i64>> {
        let mut adj: HashMap<i64, HashSet<i64>> = HashMap::new();
        for (a, b) in edges {
            adj.entry(*a).or_default().insert(*b);
            adj.entry(*b).or_default().insert(*a);
        }
        adj
    }

    #[test]
    fn the_same_edges_give_the_same_groups_whatever_the_insertion_order() {
        let edges: Vec<(i64, i64)> = vec![
            (10, 20),
            (20, 30),
            (30, 40),
            (100, 200),
            (200, 300),
            (7, 8),
            (50, 60),
            (60, 70),
            (70, 80),
            (80, 90),
        ];
        let forward = connected_components(&adj_from(&edges));

        let mut reversed = edges.clone();
        reversed.reverse();
        let backward = connected_components(&adj_from(&reversed));

        assert_eq!(forward, backward, "挿入順で結果が変わる");
    }

    /// 同じ入力で何度作り直しても同じ並びになること。
    /// `HashMap` を作り直すたびにハッシュの鍵が変わるので、
    /// **1回の比較では通ってしまうことがある**
    #[test]
    fn rebuilding_the_map_does_not_change_the_order() {
        let edges: Vec<(i64, i64)> = (1..40).map(|i| (i, i + 1)).chain([(500, 600)]).collect();
        let first = connected_components(&adj_from(&edges));
        for _ in 0..20 {
            assert_eq!(first, connected_components(&adj_from(&edges)));
        }
    }

    #[test]
    fn groups_come_out_largest_first() {
        // 2件の組と4件の組。大きい方が先
        let groups = connected_components(&adj_from(&[(1, 2), (10, 11), (11, 12), (12, 13)]));
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].len(), 4);
        assert_eq!(groups[1].len(), 2);
    }

    #[test]
    fn a_node_without_a_partner_is_not_a_group() {
        // 2件未満の成分は提案にならないので落とす
        let mut adj: HashMap<i64, HashSet<i64>> = HashMap::new();
        adj.insert(1, HashSet::new());
        assert!(connected_components(&adj).is_empty());
    }
}

/// 代表タグ（target）の決め方。**方式によって正解が違う。**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetPolicy {
    /// 使用数が最も多いタグを代表にする。同義語（①③）向け。
    ///
    /// 以前は「名前が最も短いタグ」だったが、使用実態と食い違う代表が選ばれていた。
    MostUsed,
    /// **グループの先頭を代表として固定する。** ②（包括関係）専用。
    ///
    /// 包括語は子より使用数が少ない（実測: 既知の階層16組中13組で
    /// 親の使用数 < 子の使用数。`furniture`:1 対 `table`:60）。
    /// `MostUsed` を使うと**必ず親が member に落ちて兄弟が代表に繰り上がり**、
    /// `nature ⊃ 42件` が `tree <- mountain, ocean, desert` として出る。
    /// 段1が選んだ包括語という情報を捨ててはいけない。
    Pinned,
}

/// タグIDのグループ列から `MergeSuggestion` を組み立てる。
///
/// `reason_of` はグループのメンバーIDを受け取り、表示用の理由文字列を返す。
/// **方式ごとに主張の強さが違う**ので、文言は呼び出し側が決める
/// （「類似度 0.85 以上」と「AI: 包括関係」では、外れたときの裏切りの大きさが違う）。
/// 提案カードに出すサムネイルの枚数。
const SUGGESTION_SAMPLE_THUMBNAIL_LIMIT: usize = 5;

/// `build_suggestions` がグループごとに必要とするものを、まとめて引く。
///
/// 返すのは (タグ→メディアID, 実在するメディアID, メディアID→サムネイルのパス)。
/// クエリはタグの分割数 + 1 回で、**グループ数には依存しない**。
async fn fetch_group_media(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    groups: &[Vec<i64>],
) -> (
    std::collections::HashMap<i64, Vec<i64>>,
    std::collections::HashSet<i64>,
    std::collections::HashMap<i64, String>,
) {
    let mut tag_media: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    let mut tag_ids: Vec<i64> = groups.iter().flatten().copied().collect();
    tag_ids.sort_unstable();
    tag_ids.dedup();

    // IN 句の要素数には上限があるので分割する（get_tag_sample_thumbnails と同じ）
    for chunk in tag_ids.chunks(400) {
        let ids_str = chunk.iter().map(|id| id.to_string()).collect::<Vec<_>>().join(",");
        let rows = sqlx::query_as::<_, (i64, i64)>(&format!(
            "SELECT tag_id, media_id FROM media_tags WHERE tag_id IN ({})",
            ids_str
        ))
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        for (tag_id, media_id) in rows {
            tag_media.entry(tag_id).or_default().push(media_id);
        }
    }

    // media 側は1回。存在確認とサムネイルの両方をこれで賄う
    let media_rows = sqlx::query_as::<_, (i64, String)>("SELECT id, thumbnail_path FROM media")
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    let existing_media: std::collections::HashSet<i64> =
        media_rows.iter().map(|(id, _)| *id).collect();
    let thumb_of: std::collections::HashMap<i64, String> = media_rows
        .into_iter()
        .filter(|(_, path)| !path.is_empty())
        .collect();

    (tag_media, existing_media, thumb_of)
}

pub async fn build_suggestions<F>(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    groups: &[Vec<i64>],
    tag_map: &std::collections::HashMap<i64, TagItem>,
    policy: TargetPolicy,
    reason_of: F,
) -> Vec<MergeSuggestion>
where
    F: Fn(&[i64]) -> (String, Vec<String>),
{
    let mut suggestions = Vec::new();

    // **グループごとに DB を叩かない。**
    // 以前はグループ1つにつき「サムネイル5枚」と「総枚数」で2クエリを逐次に投げていた。
    // 実データでは ① だけで 4,215 グループ = 8,430 クエリになり、モーダルを開くたび・
    // 方式を切り替えるたび・適用のたびに走っていた。
    // 先にまとめて引いてメモリ上で組み立てる（実測 427ms → 34ms・結果は一致）。
    let (tag_media, existing_media, thumb_of) = fetch_group_media(pool, groups).await;

    for (group_idx, members) in groups.iter().enumerate() {
        // **代表が消えていたら Pinned は成立しない。**
        // 統合で親タグ自体が消えることがあり、そのとき先頭は別のタグになっている。
        // 残りを使用数で並べ直すしかない（提案としては成立する）
        let pin_first = policy == TargetPolicy::Pinned
            && members.first().is_some_and(|id| tag_map.contains_key(id));
        let mut member_ids: Vec<i64> = members
            .iter()
            .copied()
            .filter(|id| tag_map.contains_key(id))
            .collect();
        if member_ids.len() < 2 {
            continue;
        }

        // 使用数降順。Pinned のときは先頭を外してから並べ替え、あとで戻す
        let pinned = pin_first.then(|| member_ids.remove(0));
        member_ids.sort_by(|a, b| {
            let t_a = &tag_map[a];
            let t_b = &tag_map[b];
            t_b.count
                .cmp(&t_a.count)
                .then_with(|| t_a.name.len().cmp(&t_b.name.len()))
                // **同点のときに入力順へ落とさない。** sort_by は安定なので、
                // ここで決めないと「先に並んでいた方」が代表になる。
                // タグ名は UNIQUE なので、これで並びが一意に決まる
                .then_with(|| t_a.name.cmp(&t_b.name))
        });
        if let Some(p) = pinned {
            member_ids.insert(0, p);
        }
        if member_ids.len() < 2 {
            continue;
        }

        let target_tag = tag_map[&member_ids[0]].clone();
        let source_tags: Vec<TagItem> = member_ids[1..].iter().map(|id| tag_map[id].clone()).collect();

        // グループに属するメディア。**media に無い media_tags の行は数えない**
        // （以前の JOIN と同じ）。孤児が残っていると総枚数が実物より多く出る
        let mut media_ids: Vec<i64> = Vec::new();
        for id in &member_ids {
            if let Some(ids) = tag_media.get(id) {
                media_ids.extend(ids.iter().copied().filter(|m| existing_media.contains(m)));
            }
        }
        media_ids.sort_unstable_by(|a, b| b.cmp(a));
        media_ids.dedup();
        let total_images_count = media_ids.len();

        // 代表的な画像サムネイルをグループ内から最大5件抽出。
        // 以前は LIMIT 5 に順序指定が無く、同じグループでも並びが変わりえた。
        // 新しいメディアから採る（get_tag_sample_thumbnails と同じ向き）
        let mut sample_thumbnails: Vec<String> = Vec::new();
        let mut seen_paths: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for media_id in &media_ids {
            if sample_thumbnails.len() >= SUGGESTION_SAMPLE_THUMBNAIL_LIMIT {
                break;
            }
            if let Some(path) = thumb_of.get(media_id) {
                if seen_paths.insert(path.as_str()) {
                    sample_thumbnails.push(path.clone());
                }
            }
        }

        let (reason, rules) = reason_of(&member_ids);
        suggestions.push(MergeSuggestion {
            id: format!("group-sug-{}", group_idx),
            target_tag,
            source_tags,
            reason,
            confidence: "high".to_string(),
            sample_thumbnails,
            total_images_count,
            rules,
        });
    }

    // 並び順は「複数一致 → 件数 → 使用数」。
    //
    // **第一キーが規則の一致数。** 複数の規則が同時に当たった組は確度が高く、
    // 統合して問題になりにくい。編集距離だけで当たった `grass`/`glass` のような
    // 弱い提案は自然に下がる（規則を消さずに順序で解決する）。
    //
    // 件数は従来どおり降順。ルール検出はペア単位なので全部2件になるが、
    // 関連タグや包括関係では大きいグループが上に来る。
    //
    // 使用数はその次。よく使われているタグの統合ほど効果が大きい。
    suggestions.sort_by(|a, b| {
        let usage = |s: &MergeSuggestion| -> i64 {
            s.target_tag.count + s.source_tags.iter().map(|t| t.count).sum::<i64>()
        };
        b.rules
            .len()
            .cmp(&a.rules.len())
            .then_with(|| b.source_tags.len().cmp(&a.source_tags.len()))
            .then_with(|| usage(b).cmp(&usage(a)))
    });
    suggestions
}

/// 【退役】旧・同義語検出プロンプト。**本番からは呼ばれていない**（2026-08-05 に分離）。
///
/// 「タグ一覧 → 同義語ペア」を1回で問い合わせる方式は作り直しで廃止された。
/// 後継は2つで、いずれも別のプロンプトを持つ:
///   - 包括関係: 包括語の抽出 → カテゴリへの割り当て
///   - 関連タグ: 埋め込みクラスタ（LLM は任意の精査のみ）
///
/// **残してあるのは `tools/text-check/run.mjs`（旧経路の計測ハーネス）が
/// `get_synonym_prompt` テスト経由でこれを呼ぶため。**
/// そのハーネスを畳むときに一緒に削除すること。
#[allow(dead_code)]
pub fn build_synonym_prompt(tag_descriptors: &[String]) -> String {
    format!(
        "Analyze the following list of tags and find synonymous or duplicate-meaning tag pairs.\nTags: {:?}\nOutput ONLY valid JSON format: {{\"synonyms\": [[\"tagA\", \"tagB\"], ...]}} using exact tag names from the input list.",
        tag_descriptors
    )
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

    let precalculated: Vec<TagMeta> = free_tags.iter().map(build_tag_meta).collect();

    // 1. 多角的ルール判定。
    //
    // **全ペア走査はしない。** タグ数はメディア数にほぼ比例して増え続けるので
    // （実測 Heaps β=0.90。1万枚で43,300件）、O(n²) では1万枚で9.4億ペアになる。
    //
    // 索引で候補を絞ってから `rule_based_match_reason` に渡す。
    // **判定そのものは変えていない** —— 索引は「判定する必要がある組」を集めるだけで、
    // 各規則が拾う組は索引の網に必ず含まれる（下記の対応表）。
    for (i, j) in rule_candidate_pairs(&precalculated) {
        let p1 = &precalculated[i];
        let p2 = &precalculated[j];

        let pair_key = (p1.item.id.min(p2.item.id), p1.item.id.max(p2.item.id));
        if paired_keys.contains(&pair_key) {
            continue;
        }

        // 種別(基本語/記述的)をまたぐペアはマージ候補にしない
        if p1.item.kind != p2.item.kind {
            continue;
        }

        // **全規則を評価する。**最初の一致で打ち切らない
        let hits = rule_matches(p1, p2);
        // **綴りの近さ「だけ」のペアは出さない（2026-08-12 の人手判定）。**
        //
        // 層化して測ったところ、`spelling` 単独の層だけが壊れていた:
        //
        //   spelling 単独        適合率 23%（n=13 / 95%区間 8〜50%）  母集団 774ペア
        //   keyphrase + spelling      100%（n=11）                        70ペア
        //   ja_prefix + spelling      100%（n= 9）                        62ペア
        //   他の層                92〜100%
        //
        // 単独の区間は他のどの層とも重ならない。中身は `chicken ← chickpea`、
        // `beak ← bear`、`rock ← dock` のように**綴りが近いだけで意味が無関係**。
        //
        // **綴りの近さは「裏付け」としては有効で、「根拠」としては無効。**
        // 他の規則が当たっているペアでは 100% なので、併用のぶんは残す。
        // これで 8,984 → 8,210ペア、重み付け適合率 89.3% → 95.6%。
        if hits.len() == 1 && hits[0].rule == "spelling" {
            continue;
        }
        if !hits.is_empty() {
            paired_keys.insert(pair_key);
            raw_pairs.push(RawPair {
                t1: p1.item.clone(),
                t2: p2.item.clone(),
                hits,
            });
        }
    }

    let rule_pairs_count = raw_pairs.len();
    crate::logger::log_info(&format!("Rule-based scan found {} candidate pairs.", rule_pairs_count));

    // **LLM 判定はこの関数から分離した（2026-08-05）。**
    //
    // 以前はここで「タグ一覧 → 同義語ペア」を1回のプロンプトで問い合わせていたが、
    // `free_tags.len() <= 300` の条件付きだったため、実ライブラリ（5,827件）では
    // **一度も実行されていなかった**。つまり画面に出ていた提案は 100% ルール由来だった。
    //
    // 作り直し後、LLM 経路は独立した方式になりユーザーが明示的に起動する:
    //   - 包括関係の検出（包括語の抽出 → カテゴリへの割り当て → 集約）
    //   - 関連タグ（埋め込みクラスタ。LLM は任意の追加工程）
    //
    // **この関数はルール検出専用になった。**
    // 設計: `_plan/20260805_tag_organize_rebuild_implementation_plan.md`

    // 3. **連結成分にはしない。推移閉包が暴走する。**
    //
    // ルール判定は「AとBが似ている」というペアしか作らないのに、連結すると
    // A-B、B-C、C-D … が全部1つの群になる。実測: 上限15を外したところ
    // **最大2,792件**（全タグの48%）の群ができ、`wooden_table` に
    // `cloudy_sky` や `snow_covered_mountain` まで入った。
    //
    // 代わりに **target ごとに1ホップだけ集約する**（`group_by_target`）。
    // 推移閉包は作らないので暴走しない。
    //
    // **target は保存時に決める。** 使用数が多い方を target にすることで、
    // 保存の順序に依存しなくなる（以前は `t1` をそのまま使っており、
    // 判定した順で「2グループになるか3件1グループになるか」が変わっていた）。
    crate::suggestion_store::begin_run(pool, crate::suggestion_store::Method::Rules, "rules-v1", crate::suggestion_store::RunMode::Full)
        .await?;
    let records: Vec<crate::suggestion_store::PairRecord> = raw_pairs
        .iter()
        .map(|p| {
            let (target, member) = order_pair(&p.t1, &p.t2);
            crate::suggestion_store::PairRecord {
                target_id: target,
                member_id: member,
                rules: p.hits.iter().map(|h| h.rule.clone()).collect(),
                score: None,
            }
        })
        .collect();
    let judged: Vec<i64> = tag_map.keys().copied().collect();
    crate::suggestion_store::commit_chunk(
        pool,
        crate::suggestion_store::Method::Rules,
        &records,
        &judged,
    )
    .await?;
    crate::suggestion_store::finish_run(pool, crate::suggestion_store::Method::Rules).await?;

    // **保存済みの判定から組み立てる。** 新規スキャンと読み出しで別の経路を通すと、
    // 同じ判定なのに件数も中身も変わる（実測 8,984件 と 2,460件）。経路を1本にする。
    build_suggestions_from_store(pool, crate::suggestion_store::Method::Rules, &tag_map).await
}

/// ペアの代表を決める。**使用数が多い方。** 同数なら名前が短い方、それも同じならID順。
///
/// 保存時にここを通すことで、判定した順序に依存しない安定した集約になる。
fn order_pair(a: &TagItem, b: &TagItem) -> (i64, i64) {
    let a_first = (b.count, b.name.len(), b.id) < (a.count, a.name.len(), a.id);
    if a_first {
        (a.id, b.id)
    } else {
        (b.id, a.id)
    }
}

/// ① ルール検出。表記の規則だけで候補を出す。即時。
#[tauri::command]
pub async fn suggest_tag_merges(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
) -> Result<Vec<MergeSuggestion>, String> {
    // 保存は `run_suggest_tag_merges_logic` の中で行う（判定と同じ場所で確定させる）
    let _guard = try_acquire_task_lock(&scan_state)?;
    run_suggest_tag_merges_logic(&db_state.pool).await
}

/// ② 包括関係。段1で包括語を集め、段2で割り当てて集約する。**LLM を使うので長い。**
///
/// 既定では**未判定のタグだけ**を処理するので、中断からの再開も、
/// タグが増えたあとの追加分も、この呼び出し1つで済む。
/// `full_rescan` を立てたときだけ段1からやり直す（却下の記録は残る）。
#[tauri::command]
pub async fn suggest_hypernyms(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
    full_rescan: Option<bool>,
) -> Result<Vec<MergeSuggestion>, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    scan_state.cancel_flag.store(false, Ordering::Relaxed);
    let mode = if full_rescan.unwrap_or(false) {
        crate::suggestion_store::RunMode::Full
    } else {
        crate::suggestion_store::RunMode::Incremental
    };
    crate::tag_organize::suggest_hypernyms(
        &db_state.pool,
        Some(&app_handle),
        Some(&scan_state.cancel_flag),
        mode,
    )
    .await
}

/// ③ 関連タグ。埋め込みクラスタで意味が近い組を出す。LLM 不要・即時。
///
/// ベクトルが未生成なら自動で生成する。
#[tauri::command]
pub async fn suggest_related_tags(
    db_state: State<'_, DbState>,
    scan_state: State<'_, ScanState>,
    app_handle: AppHandle,
) -> Result<Vec<MergeSuggestion>, String> {
    let _guard = try_acquire_task_lock(&scan_state)?;
    crate::tag_organize::suggest_related_tags(&db_state.pool, Some(&app_handle)).await
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

#[cfg(test)]
mod save_settings_tests {
    use super::*;

    async fn pool_with_settings(check: Option<&str>) -> sqlx::Pool<sqlx::Sqlite> {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let constraint = check.map(|c| format!(" CHECK({})", c)).unwrap_or_default();
        sqlx::query(&format!(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL{})",
            constraint
        ))
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn entry(key: &str, value: &str) -> SettingEntry {
        SettingEntry {
            key: key.to_string(),
            value: value.to_string(),
        }
    }

    async fn value_of(pool: &sqlx::Pool<sqlx::Sqlite>, key: &str) -> Option<String> {
        sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn every_entry_lands_including_updates_of_existing_keys() {
        let pool = pool_with_settings(None).await;
        write_settings_atomically(&pool, &[entry("ollama_model", "old")])
            .await
            .unwrap();

        write_settings_atomically(
            &pool,
            &[
                entry("ollama_model", "new"),
                entry("ui_language", "en"),
                entry("tag_granularity", "descriptive"),
            ],
        )
        .await
        .unwrap();

        assert_eq!(value_of(&pool, "ollama_model").await.as_deref(), Some("new"));
        assert_eq!(value_of(&pool, "ui_language").await.as_deref(), Some("en"));
        assert_eq!(
            value_of(&pool, "tag_granularity").await.as_deref(),
            Some("descriptive")
        );
    }

    /// **途中まで保存された状態を作らない**ことがこのコマンドの存在理由。
    /// 1件でも書けなければ、その前に書いたものも残らないこと。
    #[tokio::test]
    async fn nothing_is_written_when_one_entry_fails() {
        let pool = pool_with_settings(Some("value <> 'rejected'")).await;
        write_settings_atomically(&pool, &[entry("ui_language", "ja")])
            .await
            .unwrap();

        let result = write_settings_atomically(
            &pool,
            &[
                entry("ollama_model", "written-first"),
                entry("tag_granularity", "rejected"),
                entry("ui_language", "en"),
            ],
        )
        .await;

        assert!(result.is_err());
        // 1件目も入っていない
        assert_eq!(value_of(&pool, "ollama_model").await, None);
        // 既にあった値も書き換わっていない
        assert_eq!(value_of(&pool, "ui_language").await.as_deref(), Some("ja"));
    }

    #[tokio::test]
    async fn an_empty_batch_is_not_an_error() {
        let pool = pool_with_settings(None).await;
        write_settings_atomically(&pool, &[]).await.unwrap();
    }
}

#[cfg(test)]
mod target_policy_tests {
    use super::*;

    async fn pool_with_tags(tags: &[(i64, &str, i64)]) -> sqlx::Pool<sqlx::Sqlite> {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE media (id INTEGER PRIMARY KEY, thumbnail_path TEXT);
             CREATE TABLE media_tags (media_id INTEGER, tag_id INTEGER);",
        )
        .execute(&pool)
        .await
        .unwrap();
        let _ = tags;
        pool
    }

    fn map(tags: &[(i64, &str, i64)]) -> std::collections::HashMap<i64, TagItem> {
        tags.iter()
            .map(|(id, name, count)| {
                (
                    *id,
                    TagItem {
                        id: *id,
                        name: name.to_string(),
                        name_ja: None,
                        is_category: false,
                        count: *count,
                        kind: "basic".to_string(),
                    },
                )
            })
            .collect()
    }

    /// **包括語は子より使用数が少ない。** 使用数で代表を選び直すと親が member に落ち、
    /// `nature ⊃ 42件` が `tree <- mountain, ocean` として出る（2026-08-07 実データで発生）。
    #[tokio::test]
    async fn pinned_keeps_the_hypernym_as_target_even_when_barely_used() {
        // furniture は使用数1、table は60
        let tags = [(1i64, "furniture", 1i64), (2, "table", 60), (3, "chair", 14)];
        let pool = pool_with_tags(&tags).await;
        let tag_map = map(&tags);
        let groups = vec![vec![1, 2, 3]];

        let pinned = build_suggestions(&pool, &groups, &tag_map, TargetPolicy::Pinned, |_| {
            (String::new(), vec![])
        })
        .await;
        assert_eq!(pinned[0].target_tag.name, "furniture", "段1が選んだ包括語が代表");
        assert_eq!(pinned[0].source_tags[0].name, "table", "member は使用数降順");

        let most_used = build_suggestions(&pool, &groups, &tag_map, TargetPolicy::MostUsed, |_| {
            (String::new(), vec![])
        })
        .await;
        assert_eq!(most_used[0].target_tag.name, "table", "同義語ではこちらが正しい");
    }

    /// メディアを1件足し、指定したタグに紐づける
    async fn add_media(pool: &sqlx::Pool<sqlx::Sqlite>, media_id: i64, thumb: &str, tag_ids: &[i64]) {
        sqlx::query("INSERT INTO media (id, thumbnail_path) VALUES (?1, ?2)")
            .bind(media_id)
            .bind(thumb)
            .execute(pool)
            .await
            .unwrap();
        for tag_id in tag_ids {
            link_media(pool, media_id, *tag_id).await;
        }
    }

    /// `media` に対応する行を作らずに紐づけだけ足す（孤児の再現に使う）
    async fn link_media(pool: &sqlx::Pool<sqlx::Sqlite>, media_id: i64, tag_id: i64) {
        sqlx::query("INSERT INTO media_tags (media_id, tag_id) VALUES (?1, ?2)")
            .bind(media_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn one_suggestion(
        pool: &sqlx::Pool<sqlx::Sqlite>,
        tags: &[(i64, &str, i64)],
        members: Vec<i64>,
    ) -> MergeSuggestion {
        let tag_map = map(tags);
        let groups = vec![members];
        build_suggestions(pool, &groups, &tag_map, TargetPolicy::MostUsed, |_| {
            (String::new(), vec![])
        })
        .await
        .remove(0)
    }

    /// 総枚数はグループ全体で重複を除いた実数。
    /// 2つのタグが同じメディアに付いていても1枚。
    #[tokio::test]
    async fn total_count_is_distinct_media_across_the_whole_group() {
        let tags = [(1i64, "cat", 5i64), (2, "kitten", 3)];
        let pool = pool_with_tags(&tags).await;
        add_media(&pool, 10, "a.jpg", &[1, 2]).await; // 両方に付く
        add_media(&pool, 11, "b.jpg", &[1]).await;
        add_media(&pool, 12, "c.jpg", &[2]).await;

        let s = one_suggestion(&pool, &tags, vec![1, 2]).await;
        assert_eq!(s.total_images_count, 3);
    }

    /// **`media` に無い `media_tags` の行は数えない。**
    /// 以前の実装は `JOIN media` していたので孤児は落ちていた。
    /// まとめて引く形にしたときに、ここを落とすと総枚数が実物より多く出る。
    #[tokio::test]
    async fn orphan_media_tags_rows_are_not_counted() {
        let tags = [(1i64, "cat", 5i64)];
        let pool = pool_with_tags(&tags).await;
        add_media(&pool, 10, "a.jpg", &[1]).await;
        link_media(&pool, 999, 1).await; // media に対応する行が無い

        let s = one_suggestion(&pool, &tags, vec![1, 1]).await;
        assert_eq!(s.total_images_count, 1, "孤児を数えていない");
    }

    /// サムネイルは最大5枚。空欄は飛ばし、同じパスは1回しか出さない。
    #[tokio::test]
    async fn thumbnails_skip_blanks_and_duplicates_and_stop_at_five() {
        let tags = [(1i64, "cat", 5i64), (2, "kitten", 3)];
        let pool = pool_with_tags(&tags).await;
        add_media(&pool, 20, "", &[1]).await; // サムネイル未生成
        add_media(&pool, 21, "same.jpg", &[1]).await;
        add_media(&pool, 22, "same.jpg", &[2]).await; // 同じパス
        for id in 23..30 {
            add_media(&pool, id, &format!("t{}.jpg", id), &[2]).await;
        }

        let s = one_suggestion(&pool, &tags, vec![1, 2]).await;
        assert_eq!(s.sample_thumbnails.len(), 5);
        assert!(!s.sample_thumbnails.iter().any(|p| p.is_empty()));
        let mut sorted = s.sample_thumbnails.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 5, "同じパスを2回出していない");
        // 新しいメディアから採るので、末尾の id が先に来る
        assert_eq!(s.sample_thumbnails[0], "t29.jpg");
    }

    /// グループ数が増えてもクエリ本数が増えないこと自体は測れないが、
    /// **複数グループを一度に渡しても各グループの値が混ざらない**ことは確かめられる。
    #[tokio::test]
    async fn groups_do_not_leak_into_each_other() {
        let tags = [(1i64, "cat", 5i64), (2, "kitten", 3), (3, "dog", 4), (4, "puppy", 2)];
        let pool = pool_with_tags(&tags).await;
        add_media(&pool, 10, "cat1.jpg", &[1, 2]).await;
        add_media(&pool, 11, "dog1.jpg", &[3]).await;
        add_media(&pool, 12, "dog2.jpg", &[4]).await;

        let tag_map = map(&tags);
        let groups = vec![vec![1, 2], vec![3, 4]];
        let out = build_suggestions(&pool, &groups, &tag_map, TargetPolicy::MostUsed, |_| {
            (String::new(), vec![])
        })
        .await;

        let cat = out.iter().find(|s| s.target_tag.name == "cat").unwrap();
        let dog = out.iter().find(|s| s.target_tag.name == "dog").unwrap();
        assert_eq!(cat.total_images_count, 1);
        assert_eq!(dog.total_images_count, 2);
        assert_eq!(cat.sample_thumbnails, vec!["cat1.jpg"]);
    }

    fn sug(id: &str, target: i64, sources: &[i64], rule: &str) -> MergeSuggestion {
        let mk = |i: i64| TagItem {
            id: i,
            name: format!("t{}", i),
            name_ja: None,
            is_category: false,
            count: 1,
            kind: "basic".to_string(),
        };
        MergeSuggestion {
            id: id.to_string(),
            target_tag: mk(target),
            source_tags: sources.iter().copied().map(mk).collect(),
            reason: String::new(),
            confidence: String::new(),
            sample_thumbnails: vec![],
            total_images_count: 0,
            rules: vec![rule.to_string()],
        }
    }

    /// **綴りの近さ「だけ」のペアは提案にしない。**
    ///
    /// 層化して測ったところ `spelling` 単独の層だけ適合率23%（他は92〜100%）で、
    /// 中身は `chicken ← chickpea`、`beak ← bear` のように意味が無関係だった。
    /// 併用（`keyphrase + spelling` 等）は100%なので、そちらは残す。
    #[test]
    fn spelling_alone_is_not_a_proposal() {
        let item = |name: &str, ja: Option<&str>| TagItem {
            id: 1,
            name: name.to_string(),
            name_ja: ja.map(|s| s.to_string()),
            is_category: false,
            count: 1,
            kind: "basic".to_string(),
        };
        let rules_for = |a: &str, b: &str, ja_a: Option<&str>, ja_b: Option<&str>| {
            let (ia, ib) = (item(a, ja_a), item(b, ja_b));
            rule_matches(&build_tag_meta(&ia), &build_tag_meta(&ib))
                .iter()
                .map(|h| h.rule.clone())
                .collect::<Vec<_>>()
        };

        // 実際に × と判定された組。**規則としては当たるが提案にしてはいけない**
        for (a, b) in [("chicken", "chickpea"), ("beak", "bear"), ("rock", "dock"), ("card", "cord")] {
            let r = rules_for(a, b, None, None);
            assert_eq!(r, vec!["spelling"], "{a}/{b} は spelling 単独で当たる（提案からは除外される）");
        }

        // 併用は残す。日本語名が同じなら ja_exact も当たる
        let r = rules_for("smartphone", "smart_phone", Some("スマートフォン"), Some("スマートフォン"));
        assert!(r.contains(&"spelling".to_string()), "綴りの近さは当たる: {r:?}");
        assert!(r.len() > 1, "他の規則も当たるので提案として残る: {r:?}");
    }

    /// **適用すると、適用した提案そのものが表示できなくなる。**
    /// ペア単位の①では必ず起きるので、件数が0になることは実質ない。
    /// 「0件だから確認を出さない」経路に落ちていないかを固定する。
    #[test]
    fn applying_a_pair_invalidates_at_least_itself() {
        let suggestions = vec![
            sug("a", 1, &[2], "ja_exact"),
            sug("b", 2, &[3], "singular"), // タグ2 を共有する別の提案
            sug("c", 7, &[8], "spelling"), // 無関係
        ];
        let items = vec![MergePlanItem { target_id: 1, source_ids: vec![2] }];

        let out = count_invalidated_suggestions(items, suggestions);
        let total: usize = out.iter().map(|(_, n)| n).sum();
        assert_eq!(total, 2, "適用したペア自身と、タグ2を含む別のペアが消える: {:?}", out);
        assert!(out.iter().any(|(r, _)| r == "ja_exact"));
        assert!(out.iter().any(|(r, _)| r == "singular"));
        assert!(!out.iter().any(|(r, _)| r == "spelling"), "無関係な提案は数えない");
    }

    /// 大きなグループでも、代表以外が全部消えれば残りは1件になり表示できない
    #[test]
    fn applying_a_hypernym_group_invalidates_it() {
        let suggestions = vec![sug("h", 1, &[2, 3, 4, 5], "hypernym")];
        let items = vec![MergePlanItem { target_id: 1, source_ids: vec![2, 3, 4, 5] }];
        let out = count_invalidated_suggestions(items, suggestions);
        assert_eq!(out, vec![("hypernym".to_string(), 1)]);
    }

    /// 一部のメンバーだけ統合した場合は、残りが2件以上あるので提案は生きる
    #[test]
    fn partially_applied_group_survives() {
        let suggestions = vec![sug("h", 1, &[2, 3, 4, 5], "hypernym")];
        let items = vec![MergePlanItem { target_id: 1, source_ids: vec![2] }];
        let out = count_invalidated_suggestions(items, suggestions);
        assert!(out.is_empty(), "target + 残り3件で成立するので消えない: {:?}", out);
    }

    /// 統合で包括語そのものが消えた場合。**提案は成立させる**（残りを使用数順に）
    #[tokio::test]
    async fn pinned_falls_back_when_the_target_is_gone() {
        let tags = [(2i64, "table", 60i64), (3, "chair", 14)];
        let pool = pool_with_tags(&tags).await;
        let tag_map = map(&tags);
        // 1 (furniture) は削除済み
        let groups = vec![vec![1, 2, 3]];
        let s = build_suggestions(&pool, &groups, &tag_map, TargetPolicy::Pinned, |_| {
            (String::new(), vec![])
        })
        .await;
        assert_eq!(s.len(), 1, "残り2件で提案は成立する");
        assert_eq!(s[0].target_tag.name, "table", "使用数順にフォールバック");
    }
}

#[cfg(test)]
mod text_prompt_tests {
    use super::{
        build_synonym_prompt, build_tag_meta, rule_based_match_reason, rule_candidate_pairs, TagItem,
    };

    fn tag(id: i64, name: &str, ja: Option<&str>) -> TagItem {
        TagItem {
            id,
            name: name.to_string(),
            name_ja: ja.map(|s| s.to_string()),
            is_category: false,
            count: 1,
            kind: "basic".to_string(),
        }
    }

    /// **索引は判定結果を落としてはいけない。**
    ///
    /// 全ペアを判定した結果と、索引で絞ってから判定した結果が一致することを確かめる。
    /// 索引は「判定する必要がある組」を集めるだけなので、
    /// ここが割れたら索引の網に穴がある。
    #[test]
    fn index_does_not_lose_any_rule_match() {
        let tags = vec![
            // 1-A 同一日本語表記
            tag(1, "cat", Some("猫")),
            tag(2, "kitty", Some("猫")),
            // 1-B 単数形正規化
            tag(3, "bench", None),
            tag(4, "benches", None),
            // 1-C 共通キーフレーズ（2語共有）
            tag(5, "dry_leaf", None),
            tag(6, "dry_brown_leaf", None),
            // 1-C 共通キーフレーズ（1語だが7文字以上）
            tag(7, "printed_document", None),
            tag(8, "printed_document_page", None),
            // 1-D 日本語プレフィックス
            tag(9, "esp32_board", Some("ESP32開発ボード")),
            tag(10, "esp32_wroom", Some("ESP32ウルーム")),
            // 1-E 編集距離1
            tag(11, "streetlamp", None),
            tag(12, "streetlight", None),
            // 1-E 編集距離1（短い語）
            tag(13, "bear", None),
            tag(14, "bean", None),
            // どの規則にも当たらない
            tag(15, "zebra", Some("シマウマ")),
            tag(16, "helicopter", Some("ヘリコプター")),
        ];
        let metas: Vec<_> = tags.iter().map(build_tag_meta).collect();

        // 全ペアを判定（索引を使わない基準）
        let mut expected = Vec::new();
        for i in 0..metas.len() {
            for j in (i + 1)..metas.len() {
                if let Some(r) = rule_based_match_reason(&metas[i], &metas[j]) {
                    expected.push((i, j, r));
                }
            }
        }
        assert!(!expected.is_empty(), "基準となる一致が0件ではテストにならない");

        // 索引で絞ってから判定
        let mut actual = Vec::new();
        for (i, j) in rule_candidate_pairs(&metas) {
            let (i, j) = (i.min(j), i.max(j));
            if let Some(r) = rule_based_match_reason(&metas[i], &metas[j]) {
                actual.push((i, j, r));
            }
        }
        actual.sort();
        let mut expected_sorted = expected.clone();
        expected_sorted.sort();

        for e in &expected_sorted {
            assert!(
                actual.contains(e),
                "索引が取りこぼした: {} / {} ({})",
                metas[e.0].item.name,
                metas[e.1].item.name,
                e.2
            );
        }
        assert_eq!(actual, expected_sorted, "索引経由と全ペアで結果が一致すること");
    }

    /// 候補の数が全ペアより十分少ないこと（索引が効いていること）
    #[test]
    fn index_reduces_the_candidate_count() {
        // **互いに規則が発火しないタグを並べる。**
        // `unrelated0` / `unrelated1` のような連番は編集距離1で実際に発火するので、
        // それを「無関係」として使うとテストが成立しない（最初にこれで間違えた）。
        let mut seed: u64 = 12345;
        let mut rand_name = || {
            let mut s = String::new();
            for _ in 0..7 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                s.push((b'a' + ((seed >> 33) % 26) as u8) as char);
            }
            s
        };
        let tags: Vec<TagItem> = (0..200).map(|i| tag(i, &rand_name(), None)).collect();
        let metas: Vec<_> = tags.iter().map(build_tag_meta).collect();

        // 前提: この集合では規則が1件も発火しない
        let mut matches = 0;
        for i in 0..metas.len() {
            for j in (i + 1)..metas.len() {
                if rule_based_match_reason(&metas[i], &metas[j]).is_some() {
                    matches += 1;
                }
            }
        }
        assert_eq!(matches, 0, "無関係なはずの集合で規則が発火している");

        let all_pairs = metas.len() * (metas.len() - 1) / 2;
        let candidates = rule_candidate_pairs(&metas).len();
        assert!(
            candidates < all_pairs / 10,
            "候補 {} が全ペア {} に対して十分減っていない",
            candidates,
            all_pairs
        );
    }

    fn plan(target: i64, sources: &[i64]) -> super::MergePlanItem {
        super::MergePlanItem { target_id: target, source_ids: sources.to_vec() }
    }

    /// **適用の順序で結果が変わってはいけない。**
    ///
    /// 以前は提案ごとに `merge_tags` を呼んでおり、`merge_tags` は削除済みIDを
    /// 渡されてもエラーを返さないので、順番次第で中身だけが黙って変わっていた。
    #[test]
    fn resolution_is_independent_of_order() {
        let a = vec![plan(1, &[2, 3]), plan(4, &[5])];
        let b = vec![plan(4, &[5]), plan(1, &[3, 2])];
        let ra = super::resolve_merge_plan(&a).expect("競合しない");
        let rb = super::resolve_merge_plan(&b).expect("競合しない");
        assert_eq!(ra, rb, "並び順で結果が変わっている");
        assert_eq!(ra.redirects.get(&2), Some(&1));
        assert_eq!(ra.redirects.get(&3), Some(&1));
        assert_eq!(ra.redirects.get(&5), Some(&4));
    }

    /// 鎖は推移的に畳む（`soup_bowl -> bowl -> container` なら container へ）
    #[test]
    fn chains_are_folded_transitively() {
        // 10=soup_bowl -> 20=bowl、20=bowl -> 30=container
        let items = vec![plan(20, &[10]), plan(30, &[20])];
        let r = super::resolve_merge_plan(&items).expect("鎖は競合ではない");
        assert_eq!(r.redirects.get(&10), Some(&30), "推移的に畳まれていない");
        assert_eq!(r.redirects.get(&20), Some(&30));
    }

    /// 同じ鎖の上にある複数の行き先は競合ではない
    #[test]
    fn multiple_targets_on_the_same_chain_are_not_a_conflict() {
        // 10 -> 20 と 10 -> 30、かつ 20 -> 30。どちらを辿っても 30 に落ちる
        let items = vec![plan(20, &[10]), plan(30, &[10]), plan(30, &[20])];
        let r = super::resolve_merge_plan(&items).expect("同じ終点なら競合しない");
        assert_eq!(r.redirects.get(&10), Some(&30));
    }

    /// 鎖でつながらない2つの行き先は競合として返す
    #[test]
    fn genuinely_divergent_targets_are_reported() {
        // bowl(10) を container(20) と tableware(30) の両方に入れようとしている
        let items = vec![plan(20, &[10]), plan(30, &[10])];
        let err = super::resolve_merge_plan(&items).expect_err("競合するはず");
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].tag_id, 10);
        assert_eq!(err[0].target_ids, vec![20, 30]);
    }

    /// 循環しても止まる（提案が矛盾していても無限ループしない）
    #[test]
    fn cycles_terminate() {
        let items = vec![plan(1, &[2]), plan(2, &[1])];
        // 結果の中身は問わない。**落ちないこと**が要件
        let _ = super::resolve_merge_plan(&items);
    }

    /// 自分自身への統合は無視する
    #[test]
    fn self_merge_is_ignored() {
        let items = vec![plan(1, &[1, 2])];
        let r = super::resolve_merge_plan(&items).expect("競合しない");
        assert!(!r.redirects.contains_key(&1), "自分自身が行き先になっている");
        assert_eq!(r.redirects.get(&2), Some(&1));
    }

    /// 索引が自己ペアを作らないこと（同じタグが同一バケットに複数回入る経路がある）
    #[test]
    fn index_never_emits_self_pairs() {
        let tags = vec![
            tag(1, "aaaa", None),        // 削除変種が全部同じ "aaa" になる
            tag(2, "aaaaa", None),
            tag(3, "banana_banana", None), // 同じ語が2回出る
        ];
        let metas: Vec<_> = tags.iter().map(build_tag_meta).collect();
        for (i, j) in rule_candidate_pairs(&metas) {
            assert_ne!(i, j, "自己ペアが出た: {}", metas[i].item.name);
        }
    }

    /// 計測ツール（`tools/text-check/baseline.mjs`）が**現行の提案を丸ごと**取得するための出力。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB=/path/to/snapshot.db \
    ///     cargo test --release generate_merge_baseline -- --ignored --nocapture
    /// ```
    ///
    /// `run_suggest_tag_merges_logic` を**そのまま**呼ぶので、ルール判定・BFS・代表タグ選定の
    /// すべてが本番と同一。タグが301件以上のライブラリでは LLM ブロックがスキップされるため、
    /// 結果は**純粋なルールベースのベースライン**になる（これが比較の分母）。
    ///
    /// **必ずスナップショットを渡すこと。** この関数は先頭で孤立タグの DELETE を実行するので、
    /// 稼働中のユーザー DB を直接渡してはいけない（`tools/embedding-check/snapshot.mjs` 参照）。
    #[test]
    #[ignore]
    fn generate_merge_baseline() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let rt = tokio::runtime::Runtime::new().expect("tokio ランタイムを作れませんでした");
        rt.block_on(async {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .connect(&format!("sqlite:{}", db_path))
                .await
                .expect("スナップショットDBに接続できませんでした");
            // テストは `init_db` を通らないので、テーブルを足したときに
            // 「アプリでは動くのに検証で落ちる」が起きる
            sqlx::query("PRAGMA foreign_keys = ON;").execute(&pool).await.unwrap();
            crate::db::create_tables(&pool).await.expect("スキーマを揃えられません");
            let suggestions = super::run_suggest_tag_merges_logic(&pool)
                .await
                .expect("run_suggest_tag_merges_logic が失敗しました");
            println!("LOMA_BASELINE_BEGIN");
            println!("{}", serde_json::to_string(&suggestions).unwrap());
            println!("LOMA_BASELINE_END");
        });
    }

    /// 計測ツール（`tools/text-check`）が**ルールベース判定そのもの**を使うための出力。
    ///
    /// ```bash
    ///   LOMA_RULE_PAIRS='[[{"id":1,"name":"cat","name_ja":"猫","kind":"basic"},
    ///                      {"id":2,"name":"cats","name_ja":"猫","kind":"basic"}]]' \
    ///     cargo test --release classify_rule_pairs -- --ignored --nocapture
    /// ```
    ///
    /// LLM に価値があるのは**ルールが拾えないペアだけ**なので、モデル評価では必ずここを通す。
    /// 判定を JS に書き写すと必ず乖離するため、ミラーもフォールバックも用意しない。
    ///
    /// 実データで索引の削減効果と結果の同一性を測る。
    ///
    /// ```bash
    ///   LOMA_BASELINE_DB='C:/Users/.../loma.db' \
    ///     cargo test --release index_effect_on_real_data -- --ignored --nocapture
    /// ```
    ///
    /// **全ペア走査との結果一致も確認する。** 索引は候補を絞るだけで
    /// 判定結果を変えてはいけない。単体テストの16件では網羅できない
    /// 実データの分布（共通接頭辞を持つタグ群など）で確かめる。
    #[test]
    #[ignore]
    fn index_effect_on_real_data() {
        let Ok(db_path) = std::env::var("LOMA_BASELINE_DB") else {
            eprintln!("LOMA_BASELINE_DB が未設定のためスキップ");
            return;
        };
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let tags: Vec<TagItem> = rt.block_on(async {
            let pool = sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=ro", db_path))
                .await
                .expect("DB を開けない");
            sqlx::query_as::<_, (i64, String, Option<String>, i64, String)>(
                "SELECT t.id, t.name, t.name_ja, COUNT(mt.media_id), t.tag_kind
                 FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
                 WHERE t.is_category = 0 GROUP BY t.id",
            )
            .fetch_all(&pool)
            .await
            .expect("タグを読めない")
            .into_iter()
            .map(|(id, name, name_ja, count, kind)| TagItem {
                id,
                name,
                name_ja,
                is_category: false,
                count,
                kind,
            })
            .collect()
        });

        let metas: Vec<_> = tags.iter().map(super::build_tag_meta).collect();
        let n = metas.len();
        let all_pairs = n * (n - 1) / 2;

        let t0 = std::time::Instant::now();
        let candidates = rule_candidate_pairs(&metas);
        let index_ms = t0.elapsed().as_millis();

        println!("タグ {} 件 / 全ペア {} / 候補 {}", n, all_pairs, candidates.len());
        println!(
            "削減率 {:.2}%  索引の構築 {}ms",
            (1.0 - candidates.len() as f64 / all_pairs as f64) * 100.0,
            index_ms
        );

        // 索引経由の判定結果
        let mut via_index: Vec<(i64, i64, String)> = Vec::new();
        for &(i, j) in &candidates {
            if metas[i].item.kind != metas[j].item.kind {
                continue;
            }
            if let Some(r) = rule_based_match_reason(&metas[i], &metas[j]) {
                let (a, b) = (metas[i].item.id, metas[j].item.id);
                via_index.push((a.min(b), a.max(b), r));
            }
        }
        via_index.sort();
        via_index.dedup();

        // 全ペア走査の判定結果（基準）
        let t1 = std::time::Instant::now();
        let mut via_all: Vec<(i64, i64, String)> = Vec::new();
        for i in 0..n {
            for j in (i + 1)..n {
                if metas[i].item.kind != metas[j].item.kind {
                    continue;
                }
                if let Some(r) = rule_based_match_reason(&metas[i], &metas[j]) {
                    let (a, b) = (metas[i].item.id, metas[j].item.id);
                    via_all.push((a.min(b), a.max(b), r));
                }
            }
        }
        via_all.sort();
        via_all.dedup();
        println!("全ペア走査 {}ms", t1.elapsed().as_millis());
        println!("一致ペア: 索引 {} / 全ペア {}", via_index.len(), via_all.len());

        let missing: Vec<_> = via_all.iter().filter(|x| !via_index.contains(x)).take(10).collect();
        for m in &missing {
            println!("**取りこぼし** {} / {} : {}", m.0, m.1, m.2);
        }
        assert_eq!(via_index, via_all, "索引が判定結果を変えている");
    }

    /// 出力は 1 行 1 ペアの TSV: `LOMA_RULE_PAIR\t<index>\t<rule|none>\t<reason>`
    #[test]
    #[ignore]
    fn classify_rule_pairs() {
        let Ok(raw) = std::env::var("LOMA_RULE_PAIRS") else {
            eprintln!("LOMA_RULE_PAIRS が未設定のためスキップ");
            return;
        };
        let pairs: Vec<(TagItem, TagItem)> =
            serde_json::from_str(&raw).expect("LOMA_RULE_PAIRS は [[TagItem, TagItem], ...] である必要があります");

        for (i, (a, b)) in pairs.iter().enumerate() {
            // 本番は種別をまたぐペアを判定前に落とす。ここでも同じ順序で確認する
            let verdict = if a.kind != b.kind {
                Some(("none".to_string(), "種別違い（本番では判定前に除外）".to_string()))
            } else {
                rule_based_match_reason(&build_tag_meta(a), &build_tag_meta(b))
                    .map(|reason| ("rule".to_string(), reason))
            }
            .unwrap_or_else(|| ("none".to_string(), String::new()));
            println!("LOMA_RULE_PAIR\t{}\t{}\t{}", i, verdict.0, verdict.1);
        }
    }

    /// 計測ツール（`tools/text-check`）が本番と同じプロンプト文面を得るための出力。
    ///
    /// ```bash
    ///   LOMA_TEXT_TAGS='["cat (猫)", "cats", "dog"]' \
    ///     cargo test --release get_synonym_prompt -- --ignored --nocapture
    /// ```
    ///
    /// タグ一覧を JSON 配列（`name (name_ja)` 形式の記述子）で渡すと、本番と同じ
    /// `build_synonym_prompt` を通した結果を出す。JS 側に文面を書き写さない。
    #[test]
    #[ignore]
    fn get_synonym_prompt() {
        let Ok(raw) = std::env::var("LOMA_TEXT_TAGS") else {
            eprintln!("LOMA_TEXT_TAGS が未設定のためスキップ");
            return;
        };
        let descriptors: Vec<String> =
            serde_json::from_str(&raw).expect("LOMA_TEXT_TAGS は文字列のJSON配列である必要があります");
        let prompt = build_synonym_prompt(&descriptors);
        println!("LOMA_TEXT_PROMPT_BEGIN");
        println!("{}", prompt);
        println!("LOMA_TEXT_PROMPT_END");
    }
}

