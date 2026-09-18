# E2E (Playwright)

Tauri のネイティブウィンドウはブラウザ自動操作で扱えないため、
`vite --mode mock`（バックエンドをモックへ差し替えたブラウザ版）を対象に UI を検証する。

```bash
npm run test:e2e          # ヘッドレス実行
npm run test:e2e:headed   # ブラウザを表示して実行
npm run test:e2e:ui       # Playwright UI モードで対話的に実行
npx playwright show-report
```

dev サーバーは Playwright が自動起動する（専用ポート **5199** 固定なので、
開発中の `npm run dev` (5173) と衝突しない）。

初回のみブラウザの取得が必要:

```bash
npx playwright install chromium
```

性能の計測は**別の設定**で回す（合否を問わない）。[`perf/README.md`](../perf/README.md) を参照。

## モックが実物とズレていないかの検査

```bash
npm run check:mock-commands
```

Rust の `invoke_handler` の登録 / フロントの参照 / モックの handler を突き合わせる。

**モックに handler が無いコマンドは、呼んでも `undefined` が返るだけで例外にならない。**
そのため e2e は「押した／落ちなかった」しか見ておらず、画面がバックエンドの応答を
使う経路は一度も走らないまま緑になる。この向きは必ず落とす。

## モックモードのデバッグ用フック

コンポーネント本体には手を入れず、URL パラメータで状態を再現する。

| パラメータ | 内容 |
| --- | --- |
| `?debugOpen=settings` | 設定モーダルを開いた状態で起動 |
| `?debugOpen=search` | 詳細検索モーダルを開いた状態で起動 |
| `?debugOpen=about` | アプリ情報を開いた状態で起動 |
| `?debugScan=mid` | **スキャン実行中にアプリを起動**した状況（起動時 `progress` が未到着） |
| `?debugScan=full` | 登録フェーズ → 解析フェーズ（`current` が 1 に巻き戻る） |
| `?debugScanIntervalMs=600` | 1件あたりの疑似所要時間（既定 1500ms） |
| `?debugSlowCommand=save_settings:800` | そのコマンドだけ応答を遅らせる。**実行中の表示は応答が返るまでしか出ない** |
| `?debugFailCommand=remove_scan_folder` | そのコマンドだけ必ず失敗させる。失敗時の表示は成功しか返さないモックでは描画されない |
| `?debugMediaCount=5000` | メディアを水増しする（既定23件）。**段階描画は多いときしか効かない** |
| `?debugTagCount=10000` | タグを水増しする（既定26件） |
| `?debugSuggestionCount=4000` | AI提案を水増しする（既定3件） |
| `?debugLogLines=30000` | ログを水増しする（既定3行）。受け取りと描画の上限を通す |
| `?debugMeasurePayload=1` | 応答の JSON 長を記録する。**常時やると計りたい時間を押し上げる**ので計測時だけ |

進捗イベントの疑似発火は [`src/mocks/scanSimulator.ts`](../src/mocks/scanSimulator.ts) が担う。
`vite.config.ts` のエイリアスは `mode === "mock"` 限定のため、本番ビルドには一切含まれない。

### 画面に出ないものを確かめる窓口

`window` に生えている。**どれもモック限定**。

| 名前 | 内容 |
| --- | --- |
| `__mockSideEffects` | 画面の外へ出ていく操作の記録（`open_file` / `unload_model` など）。押した結果が画面に残らない操作は、これでしか確かめられない |
| `__mockInvokeLog` | `invoke` の記録（コマンド名・引数・時刻）。`__mockInvokeCounts()` / `__mockResetInvokeLog()` つき |
| `__mockListenerCounts()` | イベント名ごとの購読者数。**フックが二重に呼ばれても画面は動いてしまう**ので、数えないと気付けない |
| `__mockApiKeys` | 資格情報ストアの中身。画面に出ないので、保存で消えていないことはここでしか判定できない |
| `__mockPayloadBytes` | 応答の JSON 長（`?debugMeasurePayload=1` のときだけ） |

## 検証内容

| ファイル | 見ているもの |
| --- | --- |
| `startup.spec.ts` | 起動時に同じ取得を重ねていないこと。進捗イベントの購読が1本であること |
| `scan-progress.spec.ts` | 解析速度と残り時間の算出。**進捗が間引き間隔より速くても再取得が止まらない**こと |
| `gallery-paging.spec.ts` | ギャラリーの段階描画 |
| `search-filter.spec.ts` | サイドバー・検索バー・詳細検索。**何を送って何をフロントで削ったか** |
| `media-detail.spec.ts` | 詳細のタグ編集、単体再解析、ファイル操作、失敗時の表示 |
| `tag-management.spec.ts` | タグの検索・改名・手動統合・AI提案の3方式 |
| `folder-manager.spec.ts` | 再スキャン・再解析・登録解除。**確認を挟む操作と挟まない操作** |
| `failure-triage.spec.ts` | 失敗の束ね方、要確認と一時的な失敗の区別、除外と削除 |
| `log-console.spec.ts` | 畳んでいる間は取り続けないこと。受け取りと描画の上限 |
| `error-reporting.spec.ts` | 押した操作の失敗を必ず出し、背景の取得では出さないこと |
| `settings.spec.ts` | 設定モーダルの構成と保存 |
| `provider-settings.spec.ts` | 外部プロバイダーの設定と API キー |
| `spectrum.spec.ts` | 概念スペクトラム検索の3ゾーンと計測 |
| `busy-blocking.spec.ts` | 排他処理中に押させないこと |

## 注意

- 設定モーダルは閉じても内部状態を保持する（`open` は prop で、コンポーネントは常時マウント）。
  そのため「詳細設定」の開閉状態はモーダルを開き直しても引き継がれる。
  テスト側は `ensureAdvancedOpen()` で冪等に開く。
- 背後のギャラリーとサイドバーにモーダルと同じ文字列が出ることがある。
  一覧の行を引くときは**モーダルを起点にする**（`div.glass-panel` などで絞る）。
- mock モードは Vite の開発ビルドで、React は StrictMode で動く。
  **effect は意図的に2回走る。** 回数を見る検証はこれを前提に書くこと。
