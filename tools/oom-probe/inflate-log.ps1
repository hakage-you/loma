<#
.SYNOPSIS
  【一時】無操作OOMの再現を早めるため、loma.log を指定サイズまで太らせる。
  **原因が分かったら消すこと。**

.DESCRIPTION
  「起動後に無操作で放置するだけで WebView が Out of Memory で落ちる」の再現用。

  疑っているのは LogBottomConsole の 1.5 秒ポーリング（logger.rs `read_logs` が
  ログ全文を毎回読む）。**放置中は loma.log に誰も書かない**ので、ポーリングが読む量は
  一定。それでも数時間かけて落ちるなら、1回の invoke ごとに応答が解放されずに
  残っていることになる。

  つまり **ログのサイズ = 漏れる速度の倍率**。
  1.5 秒間隔なので毎分 40 回、ログ 1MB なら毎分 40MB のペースになる。

    ログ  1KB → 毎分 0.04MB  … 数時間放置しても落ちない（＝観測時の状態ではない）
    ログ  1MB → 毎分   40MB  … 1時間程度
    ログ  5MB → 毎分  200MB  … 十数分で判定できる

  素の放置は数時間かかるので、太らせて短時間で決着をつける。
  **これで落ちなければ、ポーリング説は捨ててよい。**

.PARAMETER SizeMB
  目標サイズ。既定 5MB（十数分で判定できる想定）

.PARAMETER LogPath
  対象。既定は %APPDATA%\com.hakageyou.loma\loma.log

.EXAMPLE
  # アプリを終了させてから実行すること
  pwsh -File tools/oom-probe/inflate-log.ps1 -SizeMB 5

.NOTES
  既存の loma.log は loma.log.bak-<timestamp> へ退避してから書き換える。
  戻すときはその .bak をリネームすればよい。
#>

param(
    [double]$SizeMB = 5,
    [string]$LogPath = (Join-Path $env:APPDATA 'com.hakageyou.loma\loma.log')
)

$ErrorActionPreference = 'Stop'

$liveLogPath = Join-Path $env:APPDATA 'com.hakageyou.loma\loma.log'

# 実行中に書き換えるとアプリ側の追記と競合する。
# **本物のログを狙ったときだけ**止める（動作確認で別パスを渡す場合は素通し）
if ($LogPath -eq $liveLogPath) {
    $running = @(Get-Process -Name 'loma' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Error "loma が起動中。終了させてから実行すること（PID: $($running.Id -join ', ')）"
        exit 1
    }
}

$dir = Split-Path -Parent $LogPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

if (Test-Path $LogPath) {
    $backup = "$LogPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Move-Item -Path $LogPath -Destination $backup
    Write-Host "既存ログを退避: $backup"
}

$targetBytes = [long]($SizeMB * 1MB)

# 実物と同じ形の行を並べる。長さの分布を合わせたいので INFO と DEBUG を混ぜる
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$templates = @(
    "[$stamp] [INFO] [Ollama] Analyzing ({0}/3839): IMG_2025092{1}_1{2}.jpg"
    "[$stamp] [DEBUG] [Ollama Debug] Request: model='qwen3-vl:2b' file='IMG_2025092{1}_1{2}.jpg' prompt_style=DETAILED (High-Precision) granularity=descriptive prompt_chars=2637 base_num_ctx=16384 image_b64_bytes=100540"
    "[$stamp] [INFO] [Ollama] Tagged ({0}/3839) in 4.2s: 12 tags / category=screenshot"
)

$writer = [System.IO.StreamWriter]::new($LogPath, $false, [System.Text.Encoding]::UTF8)
try {
    $i = 0
    while ($writer.BaseStream.Length -lt $targetBytes) {
        $t = $templates[$i % $templates.Count]
        $writer.WriteLine(($t -f $i, ($i % 10), ((100000 + $i * 137) % 90000)))
        $i++
        # Length は内部バッファを反映しないので定期的に流す
        if ($i % 2000 -eq 0) { $writer.Flush() }
    }
    $writer.Flush()
    Write-Host "生成: $i 行"
} finally {
    $writer.Dispose()
}

$actual = (Get-Item $LogPath).Length
Write-Host ("完了: {0}  {1:N2} MB" -f $LogPath, ($actual / 1MB))
Write-Host ''
Write-Host ("毎分の読み込み量の見込み: {0:N0} MB/分 (1.5秒間隔 = 毎分40回)" -f ($actual / 1MB * 40))
