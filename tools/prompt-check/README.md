# VLM プロンプト回帰チェック

VLM 解析プロンプトを改修したときに、**改修前後を同じ画像で流して品質の変化を計測する**開発用ツール。

Ollama とローカルの VLM モデルが必要なため **CI では回せない**。開発 PC で手動実行する。

## なぜ必要か

`VLM_ANALYSIS_PROMPT_LIGHT` は「軽量・小型モデル向けの高速・**安定化**プロンプト」であり、
**極小であること自体が設計意図**。指示を1行足すだけで小型モデルの出力が不安定化しうる。

そのため「タグが増えたか」だけを見て採用してはいけない。**3つを別軸で同時に見る**:

| 軸 | 見落とすと何が起きるか |
|---|---|
| **タグ本数の分布** | タグ数不足でメディアが機能から除外される |
| **JSON パース失敗率** | 解析が丸ごと失敗する |
| **空文字応答率** | `format:"json"` の可否がここに出る（後述） |

## `format:"json"` について

**Ollama の `format: "json"` は thinking 対応モデルの出力を破壊する。** 2026-07-29 に本ツールで実測確認済み。

| モデル | thinking | 画像 | `format:"json"` | 結果 |
|---|---|---|---|---|
| qwen3-vl:4b | YES | あり | 無 | 正常 |
| qwen3-vl:4b | YES | あり | 有 | **空応答（57/57）** |
| qwen3-vl:4b | YES | なし | 有 | **空応答** |
| qwen2:1.5b | NO | なし | 有 | 正常 |

画像を外しても再現し、非 thinking モデルでは再現しない。**要因はプロンプトでも画像でもなく
thinking 対応の有無。** VLM では空文字、テキストモデルでは `{}` という縮退値が返る。

**特に危険な点:** `done_reason` が `"length"` ではなく **`"stop"`（正常終了）** で返るため、
`ollama.rs` の `analyze_with_ctx_escalation` にある再試行ガードが**発動しない**。静かに抜ける。

Loma の既定モデル（`qwen3-vl:*`, `gemma4:*`, `qwen3:14b`）はいずれも thinking 対応。
モデルの対応状況は `/api/tags` の `capabilities` に `"thinking"` が含まれるかで判定できる。

将来 Ollama 側で改善される可能性はあるので、`--format-json both` で**推測ではなく実測で**再確認すること。

## 動画マルチフレーム経路（`--frames 3`）

**Loma には Ollama 呼び出しの実装が2つある。**

| 経路 | 実装 | 温度 | num_ctx | num_ctx 拡張リトライ |
|---|---|---|---|---|
| 画像・動画サムネイルの通常解析 | `llm/ollama.rs` | 0.2 | `recommended_num_ctx` | **あり** |
| 動画の「指定場面で解析」 | `batch.rs` `analyze_multi_frame_with_ollama` | 0.1 | 16384 | **なし** |

`--frames 1`（既定）は前者、`--frames 2` 以上は後者を再現する。マルチフレーム時は
連続する画像をひと組にして同時に送り、注記・温度・num_ctx を **`batch.rs` から抽出**する
（`prompts.mjs` の `loadMultiFrameConfig`）。本番に無い num_ctx 拡張も意図的に無効化する。
救済を効かせると欠陥が隠れるため。

**この経路を覆っていなかったために、本流で 2026-07-29 に直した `format:"json"` の欠陥が
`batch.rs` 側に残り続けた**（2026-07-30 修正）。Ollama 呼び出しを直すときは両方を測ること。

### `num_predict` について

**`num_predict` を指定してはいけない。** 生成トークンの上限だが、**thinking の消費分も
同じ枠から引かれる**ため、答えを書く前に打ち切られる。

実測（`qwen3-vl:4b` / サムネイル3枚 / 4試行）:

| オプション | 空応答 | `done_reason` |
|---|---|---|
| `num_predict: 2048` | **3/4** | length（`eval_count` がちょうど 2048 で停止） |
| 無指定 | 0/4 | stop |

`--num-predict` は**この回帰を再現するためだけ**にある。既定値は `batch.rs` の実値
（現在は無指定）なので、本番に `num_predict` が復活すれば計測側にも自動で現れる。

```bash
# 修正前の設定を再現する（空応答になる）
node tools/prompt-check/run.mjs --frames 3 --sample 3 --repeat 2 --num-predict 2048
```

## プロンプトの取得方法

プロンプト本文は**このディレクトリにコピーしていない**。`prompts.mjs` が
`src-tauri/src/llm/mod.rs` から**実物を抽出**する。コピーを持つと必ず乖離し、
「テストは通るが本番と違うものを測っていた」という最悪の失敗をするため。

`num_ctx` も `recommended_num_ctx()` から抽出する。

> **注意**: `mod.rs` は CRLF で保存されているが、**Rust は文字列リテラル（生文字列リテラルを含む）内の
> CRLF を LF に正規化する**。`prompts.mjs` は同じ正規化を行う。ここを忘れると本番と1バイト単位で
> 異なるプロンプトを測ることになる。

`descriptive_rules_section` だけは `format!` マクロのため生文字列として抽出できず、
JS 側にミラーを置いている。Rust 側の変更を検知できるよう、結果 JSON に関数のハッシュを記録する。

## 使い方

```bash
# 現行 LIGHT の実力を測る（改修候補が無いときのベースライン取得）
node tools/prompt-check/run.mjs --variants light --repeat 3 --sample 12

# 改修案と比較する（候補を candidateVariants() に足してから）
node tools/prompt-check/run.mjs --variants light,my_candidate --repeat 3 --sample 12

# format:"json" の on/off を比較する
node tools/prompt-check/run.mjs --variants light --format-json both

# DETAILED 側の粒度を比較する
node tools/prompt-check/run.mjs --variants detailed_atomic,detailed_balanced,detailed_descriptive --model qwen3-vl:30b

# 動画の「指定場面で解析」の経路を測る（batch.rs / 画像3枚を同時に送る）
node tools/prompt-check/run.mjs --frames 3 --sample 6 --repeat 2
```

### オプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--model` | `qwen3-vl:4b` | 使用する VLM |
| `--url` | `http://localhost:11434` | Ollama のエンドポイント |
| `--variants` | `light` | 比較するプロンプト（カンマ区切り） |
| `--format-json` | `off` | `off` / `on` / `both` |
| `--repeat` | `1` | 同一画像あたりの試行回数 |
| `--sample` | `5` | `test_assets/100files` から拾う枚数 |
| `--limit` | `0` | 画像総数の上限（動作確認用） |
| `--frames` | `1` | `1` = 単画像経路（`llm/ollama.rs`）／`2` 以上 = 動画マルチフレーム経路（`batch.rs`） |
| `--num-predict` | なし | `num_predict` を上書きする。**回帰の再現専用**（下記参照） |

### プロンプト variant

| 名前 | 内容 |
|---|---|
| `light` | mod.rs の実物 |
| `detailed_atomic` / `detailed_balanced` / `detailed_descriptive` | mod.rs の実物（粒度別） |

候補は `prompts.mjs` の `candidateVariants()` に定義すると自動で variant 一覧に並ぶ。
**採用して Rust に取り込んだら、対応する候補エントリは削除すること**（本物と候補の二重管理を避ける）。
現在、未採用の候補は無い（Phase 0 の2案は検証を終えて mod.rs に取り込み済み）。

## 検証用画像

- `test_assets/3files`, `test_assets/100files` から拾う（等間隔サンプリングなので実行間で比較可能）
- **低情報量画像（単色・白地に点・グラデーション・空白UI風）を自動生成して必ず混ぜる。**
  タグ本数の下限は実写だけを測っても観測できないため

`test_assets/` は `.gitignore` されており各自の環境で中身が違う。存在する画像だけを拾う。

## 判定の目安

- タグ本数が改善しても、**パース失敗率・空文字応答率が改修前より悪化していれば採用しない**
- パース判定は `AnalysisResult` と同じ厳格さ（`categories`/`tags` 必須、各タグに `en`/`ja` 必須。
  `"tags": ["cat"]` のような文字列配列は構文が正しくても失敗扱い）

結果は `results/` に JSON で保存される（gitignore 済み）。
