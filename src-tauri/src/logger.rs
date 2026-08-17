use chrono::Local;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;

pub struct Logger {
    log_file_path: PathBuf,
}

static LOGGER_INSTANCE: Mutex<Option<Logger>> = Mutex::new(None);

/// LLM 詳細デバッグログの有効フラグ。
/// 設定 `llm_debug_logging` もしくは環境変数 `LOMA_DEBUG_LLM=1` で有効化される。
static LLM_DEBUG_ENABLED: AtomicBool = AtomicBool::new(false);

/// 設定値に基づいて LLM デバッグログの ON/OFF を切り替える。
/// 環境変数 `LOMA_DEBUG_LLM=1` が設定されている場合は設定値によらず常に有効。
pub fn set_llm_debug_enabled(enabled: bool) {
    let forced = std::env::var("LOMA_DEBUG_LLM")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    LLM_DEBUG_ENABLED.store(enabled || forced, Ordering::Relaxed);
}

pub fn is_llm_debug_enabled() -> bool {
    LLM_DEBUG_ENABLED.load(Ordering::Relaxed)
}

/// LLM デバッグログ出力（有効時のみログファイルに書き込まれる）
pub fn log_debug(message: &str) {
    if is_llm_debug_enabled() {
        write_log("DEBUG", message);
    }
}

pub fn init_logger(app_handle: &AppHandle) {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));
    
    if !app_dir.exists() {
        let _ = fs::create_dir_all(&app_dir);
    }

    let log_file_path = app_dir.join("loma.log");
    let logger = Logger { log_file_path };

    let mut instance = LOGGER_INSTANCE.lock().unwrap();
    *instance = Some(logger);
}

#[allow(dead_code)]
pub fn log_info(message: &str) {
    write_log("INFO", message);
}

pub fn log_error(message: &str) {
    write_log("ERROR", message);
}

fn write_log(level: &str, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let log_line = format!("[{}] [{}] {}\n", timestamp, level, message);

    // デバッグ出力
    println!("{}", log_line.trim_end());

    let instance = LOGGER_INSTANCE.lock().unwrap();
    if let Some(ref logger) = *instance {
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&logger.log_file_path)
        {
            let _ = file.write_all(log_line.as_bytes());
        }
    }
}

/// `read_logs` を上限なしで呼ぶときの既定。
///
/// 全画面のログ表示は検索と全文コピーができるのである程度の量が要るが、
/// **「無制限」にはしない。** ログファイルはローテーションされないため、
/// 上限を外すとファイルサイズがそのまま WebView の負荷になる。
pub const DEFAULT_LOG_READ_BYTES: u64 = 8 * 1024 * 1024;

/// ログの**末尾**を最大 `max_bytes` だけ読む。
///
/// **全文を返してはいけない。** `LogBottomConsole` がこれを 1.5 秒ごとに呼ぶため、
/// 返した文字列がそのまま WebView の JS ヒープに積み上がる。
///
/// 実測（2026-08-17）: ログを 5MB にして無操作で放置すると、renderer プロセスが
/// 400MB/分 で増え、JS ヒープ上限 4,192MB に当たって落ちた。DOM 要素数は
/// 125,925 のまま横ばい、Rust 側は 63MB のまま横ばいで、増えていたのは
/// JS ヒープだけだった。400MB/分 = 40回/分 × 10MB で、**JS 文字列は UTF-16 なので
/// UTF-8 のログの2倍**になる。ログ 1.2KB での対照では 4時間で 21MB しか増えない。
pub fn read_logs(app_handle: &AppHandle, max_bytes: u64) -> String {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));
    let log_file_path = app_dir.join("loma.log");

    let mut file = match fs::File::open(&log_file_path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };

    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len <= max_bytes {
        let mut text = String::new();
        let _ = file.read_to_string(&mut text);
        return text;
    }

    if file.seek(SeekFrom::Start(len - max_bytes)).is_err() {
        return String::new();
    }
    let mut buf = Vec::with_capacity(max_bytes as usize);
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }

    // 途中のバイトから読み始めているので、マルチバイト文字が割れている可能性がある
    let text = String::from_utf8_lossy(&buf).into_owned();
    // 同じ理由で最初の1行は途中から始まっている。丸ごと捨てる
    let tail = match text.find('\n') {
        Some(i) => &text[i + 1..],
        None => text.as_str(),
    };

    format!(
        "… 古いログを省略しました（全 {} KB 中、末尾 {} KB を表示）\n{}",
        len / 1024,
        max_bytes / 1024,
        tail
    )
}

pub fn clear_logs(app_handle: &AppHandle) {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));
    let log_file_path = app_dir.join("loma.log");

    if log_file_path.exists() {
        let _ = fs::remove_file(log_file_path);
    }
}
