use chrono::Local;
use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;

/// 1本のログファイルの上限。これを超えたら世代を送る。
///
/// **ローテーションが無いとファイルは無制限に伸びる。** 実際に 5.2MB まで伸びた
/// ものを手で退避した記録が残っている（`loma.log.bak-20260817-213102`）。
/// 伸びたぶんはそのまま読み出しの負荷になり、全画面のログ表示は上限 8MB を
/// 一度に JS ヒープへ載せる。
pub const LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// 残す世代の数（`loma.log.1` … `loma.log.N`）。
/// 上限 5MB × (本体 + 3世代) = 最大 20MB でディスク使用量が頭打ちになる。
pub const LOG_KEEP_FILES: usize = 3;

pub struct Logger {
    log_file_path: PathBuf,
    /// いま書いているファイルのバイト数。
    ///
    /// **1行書くたびに metadata を引かない。** 解析中は毎秒のように書くので、
    /// そのたびに stat するとログを出すこと自体が重くなる。
    /// 起動時に実ファイルから読み、あとは書いたぶんを足していく。
    written_bytes: u64,
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

/// アプリのデータディレクトリ。取れないときは `./data`
fn app_dir_of(app_handle: &AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"))
}

pub fn init_logger(app_handle: &AppHandle) {
    let app_dir = app_dir_of(app_handle);
    if !app_dir.exists() {
        let _ = fs::create_dir_all(&app_dir);
    }
    init_logger_at(&app_dir);
}

/// ディレクトリを直接渡す初期化。**テストはこちらを使う**
/// （`AppHandle` を作るとテストバイナリが Tauri の GUI 経路を引き込む）。
pub fn init_logger_at(dir: &Path) {
    let log_file_path = dir.join("loma.log");
    let written_bytes = fs::metadata(&log_file_path).map(|m| m.len()).unwrap_or(0);

    let mut instance = LOGGER_INSTANCE.lock().unwrap();
    *instance = Some(Logger {
        log_file_path,
        written_bytes,
    });
}

#[allow(dead_code)]
pub fn log_info(message: &str) {
    write_log("INFO", message);
}

pub fn log_error(message: &str) {
    write_log("ERROR", message);
}

/// 世代を1つ送る。`loma.log.2` → `loma.log.3`、`loma.log` → `loma.log.1`。
///
/// 一番古い世代は捨てる。**失敗しても書き込みは止めない** ——
/// ログが出せないことより、ログのために処理が止まる方が困る。
fn rotate(log_file_path: &Path) {
    let numbered = |n: usize| -> PathBuf {
        PathBuf::from(format!("{}.{}", log_file_path.to_string_lossy(), n))
    };

    let oldest = numbered(LOG_KEEP_FILES);
    if oldest.exists() {
        let _ = fs::remove_file(&oldest);
    }
    for n in (1..LOG_KEEP_FILES).rev() {
        let from = numbered(n);
        if from.exists() {
            let _ = fs::rename(&from, numbered(n + 1));
        }
    }
    let _ = fs::rename(log_file_path, numbered(1));
}

fn write_log(level: &str, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let log_line = format!("[{}] [{}] {}\n", timestamp, level, message);

    // デバッグ出力
    println!("{}", log_line.trim_end());

    let mut instance = LOGGER_INSTANCE.lock().unwrap();
    if let Some(ref mut logger) = *instance {
        // **書く前に判定する。** 上限を超えた行まで書いてから送ると、
        // 1行だけ長いログ（LLM の生応答など）で上限を大きく超えうる
        if logger.written_bytes >= LOG_ROTATE_BYTES {
            rotate(&logger.log_file_path);
            logger.written_bytes = 0;
        }
        if let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&logger.log_file_path)
        {
            if file.write_all(log_line.as_bytes()).is_ok() {
                logger.written_bytes += log_line.len() as u64;
            }
        }
    }
}

/// `read_logs` を上限なしで呼ぶときの既定。
///
/// 全画面のログ表示は検索と全文コピーができるのである程度の量が要るが、
/// **「無制限」にはしない。** 返した文字列はそのまま WebView の JS ヒープに載る。
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
    read_logs_at(&app_dir_of(app_handle), max_bytes)
}

/// ディレクトリを直接渡す読み出し。**テストはこちらを使う**
///
/// 世代を送った直後は本体がほぼ空になる。そのままだと「さっきまで出ていたログが
/// 消えた」ように見えるので、**枠が余っていれば1つ前の世代の末尾も足す**。
pub fn read_logs_at(dir: &Path, max_bytes: u64) -> String {
    let log_file_path = dir.join("loma.log");

    // 新しい順に、枠が埋まるまで世代を遡る
    let mut chunks: Vec<String> = Vec::new();
    let mut remaining = max_bytes;
    let mut total_len: u64 = 0;
    let mut truncated = false;

    for n in 0..=LOG_KEEP_FILES {
        let path = if n == 0 {
            log_file_path.clone()
        } else {
            PathBuf::from(format!("{}.{}", log_file_path.to_string_lossy(), n))
        };
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        total_len += meta.len();
        if remaining == 0 {
            truncated = true;
            continue;
        }
        match read_tail(&path, remaining) {
            Some((text, cut)) => {
                remaining = remaining.saturating_sub(text.len() as u64);
                truncated = truncated || cut;
                chunks.push(text);
            }
            None => continue,
        }
    }

    if chunks.is_empty() {
        return String::new();
    }
    // 古い方から並べ直す
    chunks.reverse();
    let body = chunks.join("");

    if !truncated {
        return body;
    }
    format!(
        "… 古いログを省略しました（全 {} KB 中、末尾 {} KB を表示）\n{}",
        total_len / 1024,
        max_bytes / 1024,
        body
    )
}

/// ファイルの末尾を最大 `max_bytes` だけ読む。
/// 返すのは (本文, 途中で切ったか)。
fn read_tail(path: &Path, max_bytes: u64) -> Option<(String, bool)> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len == 0 {
        return None;
    }
    if len <= max_bytes {
        let mut text = String::new();
        file.read_to_string(&mut text).ok()?;
        return Some((text, false));
    }

    file.seek(SeekFrom::Start(len - max_bytes)).ok()?;
    let mut buf = Vec::with_capacity(max_bytes as usize);
    file.read_to_end(&mut buf).ok()?;

    // 途中のバイトから読み始めているので、マルチバイト文字が割れている可能性がある
    let text = String::from_utf8_lossy(&buf).into_owned();
    // 同じ理由で最初の1行は途中から始まっている。丸ごと捨てる
    let tail = match text.find('\n') {
        Some(i) => text[i + 1..].to_string(),
        None => text,
    };
    Some((tail, true))
}

pub fn clear_logs(app_handle: &AppHandle) {
    clear_logs_at(&app_dir_of(app_handle));
}

/// **世代を送ったぶんも消す。** 本体だけ消すと、画面上は空になったのに
/// ディスクには最大 15MB 残り、次の読み出しで古いログが戻って見える。
pub fn clear_logs_at(dir: &Path) {
    let log_file_path = dir.join("loma.log");
    if log_file_path.exists() {
        let _ = fs::remove_file(&log_file_path);
    }
    for n in 1..=LOG_KEEP_FILES {
        let path = PathBuf::from(format!("{}.{}", log_file_path.to_string_lossy(), n));
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    // 次に書くときに送り直されないよう、カウンタも戻す
    let mut instance = LOGGER_INSTANCE.lock().unwrap();
    if let Some(ref mut logger) = *instance {
        if logger.log_file_path == log_file_path {
            logger.written_bytes = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// テスト用の作業ディレクトリ。Drop で消す
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "loma-logger-{}-{}-{}",
                label,
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// `LOGGER_INSTANCE` はプロセス共有なので、ログを書くテストは直列化する
    static WRITE_LOCK: Mutex<()> = Mutex::new(());

    fn numbered(dir: &Path, n: usize) -> PathBuf {
        PathBuf::from(format!("{}.{}", dir.join("loma.log").to_string_lossy(), n))
    }

    /// 上限を超えたら世代が送られ、本体が作り直されること
    #[test]
    fn the_log_rotates_once_it_passes_the_limit() {
        let _guard = WRITE_LOCK.lock().unwrap();
        let temp = TempDir::new("rotate");

        // 上限ぎりぎりまで入ったファイルを用意してから初期化する
        fs::write(temp.0.join("loma.log"), vec![b'x'; LOG_ROTATE_BYTES as usize]).unwrap();
        init_logger_at(&temp.0);

        log_info("次の1行で世代が送られる");

        assert!(numbered(&temp.0, 1).exists(), "1世代目が作られていない");
        let current = fs::read_to_string(temp.0.join("loma.log")).unwrap();
        assert!(
            current.len() < 1024,
            "本体が作り直されていない（{}バイト）",
            current.len()
        );
        assert!(current.contains("次の1行で世代が送られる"));
    }

    /// 世代の数に上限があること。**無いとローテーションしても総量は減らない**
    #[test]
    fn only_a_fixed_number_of_generations_is_kept() {
        let _guard = WRITE_LOCK.lock().unwrap();
        let temp = TempDir::new("keep");
        init_logger_at(&temp.0);

        for _ in 0..(LOG_KEEP_FILES + 3) {
            fs::write(temp.0.join("loma.log"), vec![b'x'; LOG_ROTATE_BYTES as usize]).unwrap();
            init_logger_at(&temp.0);
            log_info("送る");
        }

        assert!(numbered(&temp.0, LOG_KEEP_FILES).exists());
        assert!(
            !numbered(&temp.0, LOG_KEEP_FILES + 1).exists(),
            "残す世代の数を超えている"
        );
    }

    /// 世代を送った直後でも、1つ前の世代の末尾が続けて読めること
    #[test]
    fn reading_spans_the_previous_generation() {
        let _guard = WRITE_LOCK.lock().unwrap();
        let temp = TempDir::new("read-span");

        fs::write(temp.0.join("loma.log.1"), "古い行\n").unwrap();
        fs::write(temp.0.join("loma.log"), "新しい行\n").unwrap();

        let text = read_logs_at(&temp.0, 1024 * 1024);
        assert!(text.contains("古い行"), "1つ前の世代が読めていない");
        assert!(text.contains("新しい行"));
        // 古い方が先
        assert!(text.find("古い行").unwrap() < text.find("新しい行").unwrap());
    }

    /// 枠に収まらないときは、末尾だけを返して省略したことを明示すること
    #[test]
    fn reading_past_the_limit_says_so() {
        let _guard = WRITE_LOCK.lock().unwrap();
        let temp = TempDir::new("read-limit");

        let mut body = String::new();
        for i in 0..2000 {
            body.push_str(&format!("[INFO] line {}\n", i));
        }
        fs::write(temp.0.join("loma.log"), &body).unwrap();

        let text = read_logs_at(&temp.0, 1024);
        assert!(text.contains("古いログを省略しました"));
        assert!(text.contains("line 1999"), "末尾が入っていない");
        assert!(!text.contains("line 0\n"), "先頭まで返している");
    }

    /// クリアは世代も消すこと。**本体だけ消すと次の読み出しで古いログが戻る**
    #[test]
    fn clearing_removes_the_rotated_files_too() {
        let _guard = WRITE_LOCK.lock().unwrap();
        let temp = TempDir::new("clear");
        init_logger_at(&temp.0);

        fs::write(temp.0.join("loma.log"), "いま\n").unwrap();
        for n in 1..=LOG_KEEP_FILES {
            fs::write(numbered(&temp.0, n), "むかし\n").unwrap();
        }

        clear_logs_at(&temp.0);

        assert!(!temp.0.join("loma.log").exists());
        for n in 1..=LOG_KEEP_FILES {
            assert!(!numbered(&temp.0, n).exists(), "{}世代目が残っている", n);
        }
        assert_eq!(read_logs_at(&temp.0, 1024 * 1024), "");
    }
}
