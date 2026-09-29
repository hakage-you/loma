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
/// 実データに対する検証。**テストのときだけ組み込む**
#[cfg(test)]
mod real_db;
/// タグ整理の提案を判定の記録として保存する（中断再開・却下・未判定）
mod suggestion_store;
/// タグ整理の提案生成（ルール検出以外の、明示実行の方式群）
mod tag_organize;

use std::backtrace::Backtrace;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

/// エラーの原因の連鎖を ` <- 原因` の形で並べる。
///
/// **`Box<dyn Error>` は表示しても一番外側しか出ない。** sqlx の
/// 「ファイルを開けない」のような本当の原因は `source()` の先にある。
fn error_chain(err: &dyn std::error::Error) -> String {
    let mut out = String::new();
    let mut cur = err.source();
    while let Some(e) = cur {
        out.push_str(&format!("\n  <- 原因: {e}"));
        cur = e.source();
    }
    out
}

/// パニックの内容と呼び出し履歴をログファイルにも残す。
///
/// **既定のパニック表示は標準エラー出力にしか出ない。** 配布ビルドでは
/// コンソールが無いので、何も分からないまま終了したように見える。
fn install_panic_logger() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let where_ = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "場所不明".to_string());
        logger::log_error(&format!(
            "パニックで終了した ({where_}): {info}\n呼び出し履歴:\n{}",
            Backtrace::force_capture()
        ));
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            logger::init_logger(&handle);
            install_panic_logger();
            logger::log_info(&format!(
                "===== Loma v{} started (os: {}, arch: {}) =====",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH
            ));
            tauri::async_runtime::block_on(async move {
                match db::init_db(&handle).await {
                    Ok(pool) => handle.manage(db::DbState { pool }),
                    Err(e) => {
                        // **ここで落ちるとウィンドウが出る前に終わる。**
                        // 標準エラー出力は配布ビルドでは誰も見られないので、
                        // 原因の連鎖と呼び出し履歴をログファイルに残してから落とす。
                        logger::log_error(&format!(
                            "データベースの初期化に失敗した: {}{}\n呼び出し履歴:\n{}",
                            e,
                            error_chain(e.as_ref()),
                            Backtrace::force_capture()
                        ));
                        panic!("Failed to initialize database: {e}");
                    }
                }
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
            commands::log_frontend_error,
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
            commands::load_tag_suggestions_cache,
            commands::dismiss_tag_suggestion,
            commands::get_suggestion_run_status,
            commands::custom_analyze_video,
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


#[cfg(test)]
mod tests {
    use super::error_chain;
    use std::error::Error;
    use std::fmt;

    #[derive(Debug)]
    struct CannotOpenFile;
    impl fmt::Display for CannotOpenFile {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "ファイルを開けない")
        }
    }
    impl Error for CannotOpenFile {}

    #[derive(Debug)]
    struct ConnectFailed(CannotOpenFile);
    impl fmt::Display for ConnectFailed {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            write!(f, "接続に失敗した")
        }
    }
    impl Error for ConnectFailed {
        fn source(&self) -> Option<&(dyn Error + 'static)> {
            Some(&self.0)
        }
    }

    /// **一番外側だけでは何が起きたか分からない。** 内側の原因まで並ぶこと
    #[test]
    fn error_chain_lists_the_inner_cause() {
        let err = ConnectFailed(CannotOpenFile);
        let chain = error_chain(&err);
        assert!(
            chain.contains("ファイルを開けない"),
            "内側の原因が出ていない: {chain}"
        );
        // 一番外側は呼び出し側が別に出すので、ここには含めない
        assert!(
            !chain.contains("接続に失敗した"),
            "一番外側まで重ねて出している: {chain}"
        );
    }

    /// 原因が無いエラーで空文字になること（`None` を踏んでも壊れない）
    #[test]
    fn error_chain_is_empty_when_there_is_no_cause() {
        assert_eq!(error_chain(&CannotOpenFile), "");
    }
}
