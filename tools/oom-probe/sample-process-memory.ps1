<#
.SYNOPSIS
  【一時】OOM 調査用のプロセスメモリ計測。**原因が分かったら消すこと。**

.DESCRIPTION
  「起動後に無操作で放置するだけで WebView が Out of Memory で落ちる」の調査用。

  アプリ内の計測（src/debug/memProbe.ts）は JS ヒープと DOM しか見えない。
  WebView2 の "Out of Memory" エラーページは **レンダラープロセスの死** なので、
  画像デコードや GPU 側の確保はアプリ内からは観測できない。外から測る。

  msedgewebview2.exe は用途ごとに複数立つ（browser / gpu-process / renderer /
  utility）。コマンドラインの `--type=` を見て区別するので、どれが太っているかが分かる。

  読み方:
    - type=renderer の WorkingSetMB が単調増加  → WebView 描画側の蓄積。
                                                   memprobe 側の dom_nodes / heap と突き合わせる
    - type=gpu-process が増える                 → 画像デコード・合成側
    - loma.exe（Rust側）が増える                → バックエンドのリーク。WebView は巻き添え

.PARAMETER IntervalSeconds
  サンプリング間隔。既定 30 秒（アプリ内計測と揃えてある）

.PARAMETER OutFile
  出力先 CSV。既定は %APPDATA%\com.hakageyou.loma\loma-procmem.csv

.EXAMPLE
  pwsh -File tools/oom-probe/sample-process-memory.ps1
  # アプリを起動してから実行し、落ちるまで放置する。Ctrl+C で停止
#>

param(
    [int]$IntervalSeconds = 30,
    [string]$OutFile = (Join-Path $env:APPDATA 'com.hakageyou.loma\loma-procmem.csv')
)

$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }

Write-Host "計測先: $OutFile"
Write-Host "間隔  : ${IntervalSeconds}秒"
Write-Host "停止  : Ctrl+C"
Write-Host ''

# 対象プロセス。loma.exe は Rust 側、msedgewebview2.exe が WebView
$targets = @('loma', 'msedgewebview2')

while ($true) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $rows = @()

    foreach ($name in $targets) {
        $procs = @()
        try { $procs = Get-Process -Name $name -ErrorAction Stop } catch { continue }

        foreach ($p in $procs) {
            # --type= を取るためにコマンドラインが要る。Get-Process では取れない
            $cmdline = ''
            try {
                $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction Stop).CommandLine
            } catch { }

            $type = 'browser'
            if ($cmdline -and $cmdline -match '--type=([\w-]+)') { $type = $Matches[1] }

            $rows += [pscustomobject]@{
                Timestamp    = $stamp
                Process      = $p.ProcessName
                Type         = $type
                Pid          = $p.Id
                WorkingSetMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
                PrivateMB    = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
                Handles      = $p.HandleCount
                Threads      = $p.Threads.Count
            }
        }
    }

    if ($rows.Count -eq 0) {
        Write-Host "$stamp  対象プロセスが見つからない（アプリは起動している？）"
    } else {
        # 追記。ヘッダーは初回だけ付く
        if (Test-Path $OutFile) {
            $rows | Export-Csv -Path $OutFile -NoTypeInformation -Append -Encoding UTF8
        } else {
            $rows | Export-Csv -Path $OutFile -NoTypeInformation -Encoding UTF8
        }

        $total = ($rows | Measure-Object -Property WorkingSetMB -Sum).Sum
        $renderer = ($rows | Where-Object { $_.Type -eq 'renderer' } |
                     Measure-Object -Property WorkingSetMB -Sum).Sum
        Write-Host ("{0}  合計 {1,7:N1} MB / renderer {2,7:N1} MB  ({3} プロセス)" -f `
                    $stamp, $total, $renderer, $rows.Count)
    }

    Start-Sleep -Seconds $IntervalSeconds
}
