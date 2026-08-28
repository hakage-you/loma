mod batch;
mod commands;
mod credentials;
mod db;
mod embedding;
/// 画像のデコード。拡張子ではなく中身でデコーダを選ぶ
mod image_io;
mod llm;
mod logger;
mod proc;
/// タグ整理の提案を判定の記録として保存する（中断再開・却下・未判定）
mod suggestion_store;
/// タグ整理の提案生成（ルール検出以外の、明示実行の方式群）
mod tag_organize;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            logger::init_logger(&handle);
            logger::log_info(&format!(
                "===== Loma v{} started (os: {}, arch: {}) =====",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            tauri::async_runtime::block_on(async move {
                let pool = db::init_db(&handle)
                    .await
                    .expect("Failed to initialize database");
                handle.manage(db::DbState { pool });
            });

            app.manage(commands::ScanState {
                cancel_flag: Arc::new(AtomicBool::new(false)),
                pause_flag: Arc::new(AtomicBool::new(false)),
                is_running: Arc::new(AtomicBool::new(false)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_media,
            commands::start_scan,
            commands::cancel_scan,
            commands::pause_scan,
            commands::resume_scan,
            commands::get_scan_status,
            commands::get_settings,
            commands::update_setting,
            commands::save_settings,
            commands::get_available_models,
            commands::get_vision_capable_models,
            commands::get_all_tags,
            commands::get_parent_folders,
            commands::get_scan_folders,
            commands::rescan_all_folders,
            commands::reanalyze_all_media,
            commands::reanalyze_folder,
            commands::remove_scan_folder,
            commands::retry_media,
            commands::exclude_media,
            commands::delete_media,
            commands::unexclude_paths,
            commands::get_excluded_paths,
            commands::unload_model,
            commands::get_app_logs,
            commands::clear_app_logs,
            commands::rename_tag,
            commands::merge_tags,
            commands::suggest_tag_merges,
            commands::suggest_related_tags,
            commands::suggest_hypernyms,
            commands::apply_tag_merges,
            commands::count_invalidated_suggestions,
            commands::get_media_by_tag,
            commands::get_tag_sample_thumbnails,
            commands::get_or_create_tag,
            commands::add_tag_to_media,
            commands::remove_tag_from_media,
            commands::open_file,
            commands::open_folder,
            commands::check_and_open_file,
            commands::load_tag_suggestions_cache,
            commands::dismiss_tag_suggestion,
            commands::get_suggestion_run_status,
            commands::custom_analyze_video,
            commands::save_provider_api_key,
            commands::get_provider_api_key,
            commands::reanalyze_single_media,
            commands::cleanup_missing_media,
            commands::pull_ollama_model,
            commands::cancel_ollama_pull,
            commands::check_ffmpeg_installed,
            commands::sync_folders,
            commands::get_system_vram_gb,
            commands::get_effective_prompt_type,
            commands::compare_granularity_levels,
            embedding::get_embedding_status,
            embedding::generate_tag_embeddings,
            embedding::find_similar_media,
            embedding::get_embedding_diagnostics,
            embedding::get_embedding_storage_info,
            embedding::cleanup_unused_embeddings,
            embedding::discard_embeddings,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // ウィンドウを閉じる等でアプリ終了が要求された時点。
            // スキャン実行中なら解析中のメディアが中断されるため、その事実を残す。
            tauri::RunEvent::ExitRequested { .. } => {
                let scan_state = app_handle.state::<commands::ScanState>();
                if scan_state.is_running.load(Ordering::Relaxed) {
                    // 終了要求はキャンセル操作を経由しないため、ここでフラグを立てて
                    // バックグラウンドのループを速やかに畳ませる
                    scan_state.cancel_flag.store(true, Ordering::Relaxed);
                    logger::log_error(
                        "[App Exit] Exit requested while a scan was still running. The scan was cancelled; \
                         media left in 'pending' will be analyzed on the next scan.",
                    );
                } else {
                    logger::log_info("[App Exit] Exit requested.");
                }
            }
            tauri::RunEvent::Exit => {
                logger::log_info("===== Loma exited =====");
            }
            _ => {}
        });
}

