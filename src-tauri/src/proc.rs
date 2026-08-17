// 外部プロセス起動の共通ヘルパ。
//
// Windows で `std::process::Command` をそのまま使うと、起動したプロセス 1 つにつき
// コンソールウィンドウが 1 枚開く。スキャンは動画 1 本あたり ffmpeg を最大 2 回起動し、
// さらに `run_scan_and_batch` の `files_to_process.par_iter()` が rayon でコア数ぶん
// 並列に走るため、新規フォルダのスキャンでウィンドウが大量に開いていた。
//
// 起動フラグの付け忘れを防ぐため、**外部プロセスの起動は必ずこの関数を経由させる**。
// `std::process::Command::new` を直接呼ぶ場所を新しく増やさないこと。

/// CREATE_NO_WINDOW: コンソールウィンドウを作らずにプロセスを起動する。
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// コンソールウィンドウを表示せずに外部プロセスを起動する `Command` を返す。
/// Windows 以外では `std::process::Command::new` と同じ。
#[allow(unused_mut)]
pub fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
