# loma リリース手順

バージョンを上げてから GitHub Releases に配布用 ZIP（インストーラ版とポータブル版の 2 つ）を上げるまでの手順。
`X.Y.Z` の部分は実際のバージョンに読み替えること。

## 前提

- **`gh` CLI が認証済み** — `gh auth status` で `repo` スコープがあることを確認する。
- **Windows** — NSIS / MSI インストーラの生成は Windows 上でしか行えない。
- Node / npm と Rust ツールチェーンが入っていること（`README.md` の「4.1 前提条件」を参照）。

## 1. バージョンを更新する

**`package.json` の `version` が正本。** 通常はここだけ書き換える。

| ファイル | 役割 |
| --- | --- |
| `package.json` | **正本。** ここだけを更新する |
| `src-tauri/tauri.conf.json` | `"version": "../package.json"` を指定してあり、`package.json` から継承する |
| `src-tauri/Cargo.toml` | crate のバージョン。Cargo が必須とするため残っているが、配布物にも UI にも出ない |

`package.json` が正本なのは、UI 側もそこから読んでいるため。`vite.config.ts` が
ビルド時に `package.json` の `version` を `__APP_VERSION__` へ埋め込み、`AboutModal.tsx` が
それを表示している。ここを分けると、**インストーラのファイル名と About ダイアログの表示が
食い違う**ことになる。

`src-tauri/Cargo.toml` の `version` は上記の 2 つとは独立しているが、外から見える箇所には
出てこない。気になるなら揃えてよい。`package-lock.json` と `Cargo.lock` は次のビルドで
自動更新されるので手で触らない。

> **注意**: `src/locales/*.json` にかつて `app.version` というキーがあり、ハードコードされた
> バージョンが 2 リリース分古いまま放置されていた。どこからも参照されていなかったため削除済み。
> **バージョン番号をロケールファイルに書かないこと。**

## 2. テストと型チェック

```powershell
npm run build          # フロントエンドの TypeScript チェック
cd src-tauri
cargo check
cargo test
cd ..
npm run test:e2e       # 初回のみ npx playwright install chromium
```

## 3. コミットして push

```powershell
git add -A
git commit -F <UTF-8 で書いたメッセージファイル>
git push origin main
```

注意点が 2 つある。

- **`main` は PR 必須のルールセットが設定されている。** 直 push しても管理者権限で通るが、
  リモートから `Bypassed rule violations for refs/heads/main` が返り、バイパス履歴が GitHub に残る。
  PR 運用を守るならブランチを切って PR を経由すること。
- **日本語を含むコミットメッセージを PowerShell の here-string（`@'...'@`）で渡すと解析に失敗し、
  メッセージが `git add` の引数として解釈されることがある。** UTF-8 のファイルに書いて
  `git commit -F <file>` で渡すのが確実。

## 4. 注釈付きタグを作成して push

軽量タグではなく **注釈付きタグ**（`-a`）を使う。

```powershell
git tag -a vX.Y.Z -F <UTF-8 で書いたタグメッセージファイル>
git push origin vX.Y.Z
```

## 5. プロダクションビルド

タグを打った状態からビルドする。配布物とタグの内容を確実に一致させるため。

```powershell
npm install            # 依存が変わっていれば
npm run tauri build
```

生成物は `src-tauri/target/release/bundle/` 配下に出る。

| 形式 | パス |
| --- | --- |
| NSIS（**インストーラ版として配布**） | `src-tauri/target/release/bundle/nsis/loma_X.Y.Z_x64-setup.exe` |
| 実行ファイル（**ポータブル版として配布**） | `src-tauri/target/release/loma.exe` |
| MSI | `src-tauri/target/release/bundle/msi/` |

`bundle.targets` が `"all"` のため MSI も生成されるが、**リリースに上げているのは NSIS と実行ファイルのみ**。

ポータブル版のために別途ビルドし直す必要はない。ビルドログに
`Patching ...\loma.exe with bundle type information: nsis` と出るとおり、バンドル後の `loma.exe` には
バンドル種別の印が書き込まれるが、これを読むのは updater プラグイン（`bundle_type()`）だけで、
loma は使っていないので動作に影響しない。updater を入れる場合は、ポータブル版を
`npx tauri build --no-bundle` で別に作ること。

`tauri.conf.json` の `bundle.licenseFile` に `../LICENSE` を設定してあるため、NSIS インストーラには
ライセンス同意画面が出る。`bundle.license` は未設定でよい（`Cargo.toml` の `license` から継承される）。

## 6. 配布用 ZIP を作る

**`LICENSE` の同梱は必須。** MIT ライセンスは著作権表示と条文を「配布物のすべての複製」に
含めることを条件にしているため、インストーラや実行ファイルを単体で資産として上げると条件を満たさない。
v0.3.0 以前は裸の `.exe` を上げていたが、v0.4.0 で ZIP 形式に切り替えた。
v0.5.0 からポータブル版の ZIP も併せて上げている。

| ZIP | 中身 |
| --- | --- |
| `loma_X.Y.Z_x64-setup.zip` | `loma_X.Y.Z_x64-setup.exe` / `LICENSE` / `README.md` |
| `loma_X.Y.Z_x64-portable.zip` | `loma.exe` / `LICENSE` / `README.md` |

```powershell
$ver = "X.Y.Z"
$out = "$env:TEMP\loma-release-out"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $out | Out-Null

$zips = @{
  "loma_${ver}_x64-setup.zip"    = "src-tauri\target\release\bundle\nsis\loma_${ver}_x64-setup.exe"
  "loma_${ver}_x64-portable.zip" = "src-tauri\target\release\loma.exe"
}
foreach ($name in $zips.Keys) {
  $stage = "$env:TEMP\loma-release-stage"
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $stage | Out-Null
  Copy-Item $zips[$name], LICENSE, README.md $stage
  Compress-Archive -Path "$stage\*" -DestinationPath "$out\$name" -CompressionLevel Optimal
}
Get-ChildItem $out
```

### 2 つの違い（リリースノートに書く内容）

どちらも**署名していない**ので、ダウンロードしたものを開くと SmartScreen の
「Windows によって PC が保護されました」が出る（「詳細情報」→「実行」で進める）。これはどちらでも同じ。

- **インストーラ版（推奨）**: WebView2 が無い PC ではインストール時に入れてくれる。
  「アプリと機能」からアンインストールでき、スタートメニューにも登録される。
- **ポータブル版**: 展開して `loma.exe` を起動するだけ。WebView2 が入っていないと起動しない
  （Windows 11 は標準で入っている）。
- **どちらもデータは `%APPDATA%\com.hakageyou.loma` に書く**（DB・ログ。`app_data_dir()`）。
  ポータブル版のフォルダを消してもデータは残るので、「exe の横に全部入っている」とは書かないこと。

## 7. リリースを作成する

**リリースノートは必ずファイル経由（`--notes-file`）で渡す。** PowerShell から native exe へ
日本語を含む引数を直接渡すとエンコーディングが壊れることがあるため、UTF-8 で書いたファイルを
読ませるのが確実。リリースノートの原本は [`docs/release-notes/`](https://github.com/hakage-you/loma/tree/main/docs/release-notes) に置く。

```powershell
gh release create vX.Y.Z `
  "$env:TEMP\loma-release-out\loma_X.Y.Z_x64-setup.zip" `
  "$env:TEMP\loma-release-out\loma_X.Y.Z_x64-portable.zip" `
  --repo hakage-you/loma `
  --title "vX.Y.Z" `
  --notes-file docs\release-notes\vX.Y.Z.md `
  --verify-tag
```

`--verify-tag` を付けると、タグが push されていない場合に新規作成せず中断する。打ち忘れの検知用。

## 8. 検証

```powershell
gh release view vX.Y.Z --repo hakage-you/loma `
  --json tagName,name,isDraft,assets `
  --jq '{tag:.tagName, title:.name, draft:.isDraft, assets:[.assets[]|{name:.name, state:.state}]}'
```

資産が **2 つ**とも `state: uploaded` で、`draft: false` であることを確認する。
リリースノートの文字化けは `gh release view vX.Y.Z --repo hakage-you/loma --json body --jq '.body'` で見る。

## 補足

- **このリポジトリは public。** リリース資産は誰でもダウンロードできるため、
  ライセンス条文の同梱漏れがそのまま第三者に届く。ZIP 化を省略しないこと。
- **リリース資産を差し替える場合**は、`gh release upload` で新しい資産を上げてから
  `gh release delete-asset <tag> <name> --yes` で古い方を消す。削除は取り消せないので、
  消す前に `gh release download <tag>` でローカルに退避しておくこと。
- 既にビルド済みのインストーラは `src-tauri/target/release/bundle/nsis/` に過去分が残る。
  再ビルドしてもビット単位では一致しないため、消す前に必要性を確認すること。
