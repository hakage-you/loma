// 【一時】OOM 調査用の計測。**原因が分かったら消すこと。**
//
// 「起動後に無操作で放置するだけで WebView が Out of Memory で落ちる」の調査用。
// 数時間かかって落ちるため、落ちた瞬間に devtools のコンソールごと消えてしまう。
// ファイルに追記して、落ちた後から増え方を読めるようにする。
//
// **`loma.log` とは別ファイルにしてある。** 疑っているのは
// `LogBottomConsole` が 1.5 秒ごとに `read_logs`（= loma.log の全文読み込み）を
// 呼び続けることなので、計測自身が loma.log を太らせると測りたいものが歪む。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

fn app_dir(app_handle: &AppHandle) -> PathBuf {
    app_handle
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"))
}

/// 【一時】フロントの計測値を `loma-memprobe.log` へ追記する。
///
/// `loma.log` のサイズはフロントではなくここで測る。フロント側から知ろうとすると
/// `get_app_logs` を呼ぶことになり、疑っている全文読み込みを計測のたびに
/// 再現してしまうため。
#[tauri::command]
pub async fn append_mem_probe(app_handle: AppHandle, line: String) -> Result<(), String> {
    let dir = app_dir(&app_handle);
    let log_bytes = std::fs::metadata(dir.join("loma.log"))
        .map(|m| m.len())
        .unwrap_or(0);

    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let row = format!("[{}] {} loma_log_bytes={}\n", timestamp, line, log_bytes);

    let path = dir.join("loma-memprobe.log");
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(row.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}
