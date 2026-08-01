# VLM プロンプト回帰チェック / モデル比較

VLM 解析プロンプトを改修したときに、**改修前後を同じ画像で流して品質の変化を計測する**開発用ツール。
`--models` に複数並べると、**同じ画像・同じプロンプトでモデルを横断比較**する用途にもなる
（埋め込みモデル側の同じ役割は `tools/embedding-check`）。

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

## 引数を覚えていないとき

**引数なしで起動すると対話で聞いてくる。**

```bash
npm run vlm-check
```

```
  1) モデルを比較する    — どのモデルを使うか決めたいとき
  2) プロンプトを比べる  — プロンプトを改修したとき（従来の回帰チェック）

Ollama にある vision 対応モデル（小さい順）:

   1  qwen3-vl:4b                4.4B    3.1GB  thinking
   2  gemma4:e2b                 5.1B    6.7GB  thinking
   ...

比較するモデル — 番号を複数（例: 1 3 5 / 1-3 / all） [既定 1-3]:
```

Ollama に**実際に入っている** vision 対応モデルだけを小さい順に出すので、モデル名を
打ち込む必要も、何が入っていたかを思い出す必要もない。実行前に呼び出し回数を出す。

プロンプトも対話で選べる。**LIGHT で揃える / 本番と同じ判定 / LIGHT と DETAILED の両方 /
全パターン（LIGHT と粒度3種）/ 一覧から選ぶ**の5択で、本番と同じ判定と両方の場合は
続けて DETAILED の粒度を聞く。

**実行の最後に、この実行を再現する1行を全オプション付きで表示する。**

```
この実行を再現するコマンド:
  node tools/prompt-check/run.mjs --models "qwen3-vl:4b,qwen3-vl:8b" --variants detailed_balanced \
    --sample 8 --repeat 1 --format-json off --frames 1 --limit 0 --side-by-side 3 --url http://localhost:11434
```

既定値も省かずに書く。対話で選んだ内容は引数として残らないので、これが無いと
**何を測った結果なのかが後から分からなくなる**。同じ1行は HTML レポートのフッターにも残る。

一覧は端末の高さに合わせて多段組みに畳む（縦に長いと**先頭の番号が画面外へ流れて選べない**）。
畳んだときは名前を省略するが、区別が付くよう `hf.co/<org>/` 側を落として末尾を残し、
確定前に選んだモデルの全名を表示する。

引数を1つでも渡すと対話には入らない。パイプ実行や CI では自動的に非対話になる。
強制するなら `--interactive` / `--no-interactive`。

## モデルを比較する（`--models`）

```bash
node tools/prompt-check/run.mjs --models qwen3-vl:4b,qwen3-vl:8b,gemma4:12b --sample 8
```

**4軸を同時に出す。どれか1つで決めない。**

| 軸 | 出どころ | 落とし穴 |
|---|---|---|
| **タグの質** | 横並び出力（目視） | **本数では測れない。** 数値の表だけで決めると、タグが多いだけのモデルを選ぶ |
| **生成量** | `eval_count`（生成トークン数） | 下記。**速度差はここに強く相関する** |
| **速度** | Ollama の `eval_duration` / `eval_count` → 生成 tok/s | 壁時計だけ見るとロード時間と画像枚数に引きずられる |
| **VRAM** | `/api/ps` の `size_vram` | 他のモデルが常駐していると混ざる |
| **安定性** | パース失敗率・空文字応答率 | 質が良くても失敗するモデルは使えない |

### 生成トークン数

**同じタグ数を返していても、生成トークン数はモデル間で桁が違う。**
そして速度はモデルの大きさより生成量に強く相関する。

実測（2026-07-30 / 同一12枚 / DETAILED atomic / 中央値）:

| モデル | `thinking` 文字 | 生成トークン | タグ数 | 生成秒 |
|---|---|---|---|---|
| `hf.co/unsloth/Qwen3-VL-30B-A3B-Instruct` | 0 | **143** | 6 | 1.0 |
| `hf.co/EnlistedGhost/Pixtral-12B` | 0 | **106** | 6 | 2.0 |
| `gemma4:12b` | **0** | **810** | 6 | 12.6 |
| `gemma4:26b` | **0** | **990** | 7 | 18.7 |
| `hf.co/unsloth/Qwen3.6-27B-MTP` | **0** | **1,383** | 6 | 30.7 |
| `qwen3-vl:4b` | 18,099 | 3,874 | 8 | 31.0 |

**タグ6本を返すのに 106 トークンで済むモデルと、990 トークン使うモデルがある。**
`thinking` が 0 でも生成量が多いモデルがあるので、`thinking` の値では説明が付かない。

> **`/api/show` の `capabilities` にある `thinking` は選別に使えない。**
> 宣言していても `thinking` を 0 で返すモデルがあり、それでも遅い。
> 宣言ではなく **`eval_count` を見ること。** モデル別テーブルに出している
> （HTML では計測内の最小との比も付く）。

**なぜ増えるのかは未確認。** 推論や前置きを本文に吐いていて
パーサが `{...}` を切り出すときに捨てている、というのが有力だが**裏を取っていない**。
日本語のトークナイザ効率の差や、出力の冗長さでも同じ数字になりうる。
**確かめるには成功時の生の応答が要るが、現在は失敗時（`rawSample`）しか保存していない。**
断定せずに使うこと —— この列が言えるのは「生成量が多い」までで、その理由ではない。

### Instruct 版と Thinking 版

**出典のある事実:** Ollama 公式ライブラリの `qwen3-vl` には、全サイズに
`-instruct` と `-thinking` のタグがある（`:2b` / `:4b` / `:8b` / `:30b-a3b` / `:32b`）。
Qwen 公式はこの2系統を **"Instruct and reasoning‑enhanced Thinking editions"** と説明している。

- [Ollama: qwen3-vl のタグ一覧](https://ollama.com/library/qwen3-vl/tags)
- [Qwen 公式: Qwen3-VL-8B-Instruct モデルカード](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct)

**一次情報で言えるのはここまで。** モデルカードに「Instruct は推論しない」とは書かれていない。

**こちらの実測:** 手元の**素のタグ**（`qwen3-vl:4b` / `:8b` / `:30b`）は
`thinking` を出力した（それぞれ 12,671 / 7,472 / 3,562 文字）。
ただし**素のタグが `-thinking` の別名かどうかは確認していない** ——
実測でそう振る舞ったことと、タグの対応関係は別の話。

引くときは `-instruct` / `-thinking` を明示した方が確実。素のタグでは名前から判断できない。

### 公平に測るためにやっていること

- **モデルは1つずつ載せて降ろす。** 並べて常駐させると VRAM も速度も互いに影響する。
  各モデルのブロックが終わったら `keep_alive: 0` で降ろす
- **ウォームアップの1回を計測に入れない。** 初回にはモデルのロード時間が乗るため、
  混ぜると大きいモデルほど不当に遅く見える。ロード時間は別の列として出す
- **速度は Ollama 自身の計測値で出す。** `load_duration` / `prompt_eval_duration` /
  `eval_duration` を分けて記録するので、ロード・画像の読み込み・生成を切り分けられる
- **画像は等間隔サンプリングで決定的に選ぶ。** モデルを跨いでも同じ画像を使う

**他のモデルが常駐していると警告が出る。** Loma 本体や他のツールが Ollama を使っていると
VRAM と速度がその分ずれる。勝手には降ろさない（実行中の処理を巻き添えにするため）ので、
厳密に測るなら他の利用を止めてから回すこと。

### 質は目視でしか決まらない

最後に**同じ画像に対する各モデルのタグを横並びで出す**。条件は最初の variant / format に固定する
（条件を混ぜて並べるとモデルの差か条件の差か読めなくなる）。表示枚数は `--side-by-side`。
全件は `results/` の JSON に入っている。

これは `tools/embedding-check` が「分布の数値が良くても結果が無意味ということはあり得る。
必ず目視すること」としているのと同じ理由による。

### モデル比較で見つかること

実行するとモデル側の欠陥がそのまま出る。実測例（2026-07-30）:

| モデル | 出たもの |
|---|---|
| `llama3.2-vision:11b` | `unknown model architecture: 'mllama'` でロードできない（この Ollama では動かない） |
| `gemma4:e4b` | **極めて不安定。** 同じ12枚で LIGHT 6/12 成功・DETAILED atomic 1/12 成功。失敗は `json_syntax_error` |

いずれもツール側の異常ではない。ウォームアップの警告と `request_error` / パース失敗として記録され、
他のモデルの計測は続行される。

> **1〜2枚で結論を出さないこと。** `gemma4:e4b` は最初に2枚だけ試したとき 2/2 失敗し、
> 生の応答が「no image was provided」だったため「画像が渡っていない」と判断した。
> **12枚で測り直したら成功する場合があり、その判断は誤りだった。**
> 成功率はプロンプトでも変わる。`--sample` を絞った試運転の結果をモデルの性質として読まない。

## 途中で止める / 結果を合成する

全モデルの計測は長い。**途中で止めたくなったら Ollama を落とす。**

| 止め方 | 結果 |
|---|---|
| **Ollama を落とす** | 残りは `request_error` として記録され、**計測は完走して JSON が残る** |
| Ctrl+C でプロセスを殺す | JSON は最後にまとめて書くので、**そこまでの結果が全部消える** |

そのあと壊れたモデルだけ測り直し、`merge.mjs` で差し替える。

```bash
# 1. 何を測り直せばいいかを出す（--models 以外は元の実行と同じコマンドが出る）
npm run vlm-merge -- results/compare-8models_....json

# 2. 出たコマンドで測り直す

# 3. 差し替えて1つにする
npm run vlm-merge -- results/compare-8models_....json results/compare-1models_....json
```

**差し替えはモデル単位。** 行単位で継ぎ足すと、失敗した試行だけが消えて成功率が歪む。

**画像がベースと違う patch は受け付けない**（`--sample` / `--limit` を揃えること）。
揃っていないと画像ごとの比較が成立しない。どうしても混ぜるなら `--force`。

`cond` は**作り直す**。単独モデルで測り直すと `cond` にモデル名が付かないため、
そのまま混ぜると条件名が揃わず集計が割れる。

### 合成物であることは隠さない

結果 JSON に `mergedFrom`（どのモデルがどのファイル由来か）が入り、HTML レポートの先頭にも出る。

> **速度と VRAM はモデル間で厳密に比較できない。** 別々の実行を跨いでいるため、
> ハードウェアの状態や Ollama の再起動の影響を受ける。タグの内容と失敗率は比較してよい。

## HTML レポート

計測すると `results/` に JSON と**同名の HTML** が並んで出る（`--no-html` で抑止）。
既存の JSON からいつでも作り直せる:

```bash
node tools/prompt-check/report.mjs                 # 最新の結果から
node tools/prompt-check/report.mjs <results.json> --open
node tools/prompt-check/report.mjs --embed         # 画像を base64 で埋め込む（単体で配れる）
```

**計測はやり直さない。** 見せ方を変えたいときは `report.mjs` だけを触ればよい
（1回の計測に数十分かかるので、見せ方の試行と計測は分けておく必要がある）。

外部依存もビルドも無い。CSS は1ファイルにインライン、画像は既定で相対パス参照、
`--embed` なら data URI。ライト/ダーク両対応。

### 何を出しているか

| セクション | 何のため |
|---|---|
| モデル別 | 生成 tok/s・平均秒・VRAM・ロード秒・失敗率を帯付きで並べる。**帯は大小であって良し悪しではない**ので、列見出しにどちらが良いかを書く |
| 条件別 | コンソールの集計表と同じ内容 |
| **画像ごとのタグ** | 画像の隣に各モデルのタグを並べる。**この報告の主役** |
| | `both` のときはモデルごとにまとめ、その下に LIGHT / DETAILED を並べる |
| 失敗の内訳 | 生の応答つき（折りたたみ） |

**画像ごとのタグでは、全モデルが出したタグを沈め、1つのモデルだけが出したタグに色帯を付ける。**
一致したタグは無難なだけで判断材料にならない。差が出るのは後者だけなので、そこだけを見れば決められる。

一致は**同じプロンプトを流したモデル同士**で数える（表示の入れ子とは別）。
LIGHT と DETAILED はタグの本数が元々違うので、混ぜて数えると DETAILED が色帯だらけになる。

> **descriptive タグ（破線）は既定では出ない。** `detailed_atomic` は現行仕様で
> `descriptive_tags` セクション自体を出さず、LIGHT も出さない。既定粒度が `atomic` である以上、
> `light` / `auto` / `both` のどれで回しても 0 件になる（`both` の DETAILED 側も本番の既定粒度を使う）。
> 見たいなら `--variants detailed_balanced` か `detailed_descriptive` を明示すること。
> レポートは実体が無いときは凡例も出さない。

色は検証済みのカテゴリカル配色をスロット順のまま使う（順序自体が色覚差への安全性の仕組みなので
入れ替えない）。ライトでは一部の色が対サーフェス 3:1 未満なので、**数値は必ず文字でも出す**。

### Loma に組み込む前の叩き台として

将来 Loma 本体に「モデルを比べて選ぶ」画面を入れるなら、何をどう出せば人が決められるのかを
先にここで確かめる。現時点で分かっていること:

- **タグ本数と失敗率だけでは決められない。** 画像とタグを並べて初めて判断できる
- **一致したタグは見なくていい。** 情報は差分にしかない
- **速度は2つ要る。** 生成 tok/s と実測の平均秒は逆転する（thinking が短いモデルは
  tok/s が低くても速い。実測で `qwen3-vl:8b` が 4b の 0.7 倍の tok/s で 1.4 倍速かった）

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

# モデルを比較する（タグの質・速度・VRAM・安定性）
node tools/prompt-check/run.mjs --models qwen3-vl:4b,qwen3-vl:8b --sample 8

# モデル × 粒度（どのモデルならどこまで細かく書けるか）
node tools/prompt-check/run.mjs --models qwen3-vl:8b,qwen3-vl:30b --variants detailed_atomic,detailed_descriptive
```

### オプション

| オプション | 既定 | 説明 |
|---|---|---|
| `--models` | `qwen3-vl:4b` | 使用する VLM（カンマ区切りで**モデル横断比較**になる） |
| `--model` | — | `--models` の単数の別名。従来の書き方 |
| `--granularity` | 本番の既定 | `auto` / `both` が使う DETAILED の粒度（`atomic` / `balanced` / `descriptive`） |
| `--side-by-side` | `3` | モデル横断時に、タグを横並び表示する画像の組数（`0` で無効） |
| `--interactive` | 引数なしのとき自動 | 対話で選ぶ。`--no-interactive` で常に無効 |
| `--no-html` | — | HTML レポートを出さない |
| `--embed` | — | HTML に画像を埋め込む（単体で配れるが重くなる） |
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
| `auto` | **モデルごとに本番と同じ判定でプロンプトを選ぶ**（下記） |
| `both` | **各モデルで LIGHT と DETAILED の両方を測る**（下記） |
| `all` | **LIGHT と粒度3種すべて**（下記） |

### `auto` と `both` — 本番のプロンプト選択

**本番はモデルごとに LIGHT / DETAILED を選ぶが、計測は既定で全モデルに同じプロンプトを送る。**
揃えないとモデルの差なのかプロンプトの差なのか読めなくなるため。ただしそれは
「同じプロンプトを与えたときの素の実力」であって、「本番で使ったときどうなるか」ではない。

| 指定 | 何を測るか |
|---|---|
| `--variants light`（既定） | 全モデルを LIGHT で揃える。素の実力 |
| `--variants auto` | 本番と同じ判定。実際に使ったときどうなるか |
| `--variants both` | 各モデルで LIGHT と DETAILED の両方。判定を変える価値があるかが分かる |
| `--variants all` | **LIGHT と粒度3種すべて。**目を付けたモデルを絞り込むときはこれ |

`both` / `all` は**エラーになる組み合わせもそのまま記録する**（該当セルが失敗として出るだけで、
他の条件の計測は続行する）。

### 粒度（`--granularity`）

`auto` と `both` が使う DETAILED の粒度を指定する。**未指定なら本番の既定に従う**
（既定値をツール側に書かない。`TagGranularity` の `#[default]` がそのまま効く）。

```bash
# 本番の判定のまま、粒度だけ descriptive にした状態を測る
node tools/prompt-check/run.mjs --models qwen3-vl:8b,gemma4:12b --variants auto --granularity descriptive
```

粒度はアプリ側でユーザーが設定できる項目なので、**「粒度を変えた状態の本番」も現実に存在する条件**。
`--variants all` を使うときは粒度3種すべてを流すので `--granularity` は効かない。

不正な値は**既定に落とさず停止する**。黙って別の条件を測るのが一番まずいため。

### 判定は本番のコードに聞く（ミラーを持たない）

**しきい値もキーワードも名前の解析も JS に書き写していない。**
`mod.rs` の `#[ignore]` テスト `resolve_prompt_selection` を呼び、
`get_vlm_prompt_info` が返した判定をそのまま使う
（`tools/embedding-check` が計測ロジックを Rust テスト経由で回しているのと同じ理由）。

書き写せば必ず乖離し、**「本番と違うものを測っていた」に行き着く。**
そのため**フォールバックも用意していない** —— cargo が無ければ失敗する。
静かに近似値へ落ちる方が、動かないより悪い。

```bash
# ツールを通さず直接見ることもできる
LOMA_PROMPT_MODELS=qwen3-vl:4b,gemma4:12b \
  cargo test --release resolve_prompt_selection -- --ignored --nocapture
```

実行時に何が選ばれたかを必ず表示する:

```
本番の判定を取得中 (cargo test resolve_prompt_selection) ...

variants  : auto
  本番の判定 (mod.rs get_vlm_prompt_info を cargo test 経由で実行):
    qwen3-vl:4b (4B) -> light
    llama3.2-vision:11b (11B) -> detailed_atomic
```

**プロンプト本文も同時に受け取り、`prompts.mjs` が抽出した本文と1文字ずつ突き合わせる。**
ズレていれば差分位置つきで警告する。文字数の比較では足りない —— `detailed_balanced` と
`detailed_descriptive` は差が数字1文字ずつで**長さが同じ**になるため、長さだけ見ても区別できない。

この照合は `descriptive_rules_section` の JS ミラー（`format!` マクロなので生文字列として
抽出できない唯一の箇所）が本番と一致しているかの検査も兼ねる。

実測例（`qwen3-vl:4b` / 同じ画像）: LIGHT はタグ 3〜4本、DETAILED は 8〜9本。
**プロンプトの差はモデルの差より大きいことがある。** モデルを比べる前にどちらで比べるかを決める。

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
モデル横断のときは `compare-<N>models_<時刻>.json`、単独のときは従来どおり `<model>_<時刻>.json`。

> **モデル比較の導入で単独実行にも1点だけ変化がある。** 計測前にウォームアップを1回入れるように
> したため、**最初の1枚がモデルのロード時間を被らなくなった**。以前の結果 JSON と平均秒を
> 突き合わせるときは、旧側の先頭セルだけロード分だけ遅いことに注意する。
