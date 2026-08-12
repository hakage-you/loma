export interface RecommendedModel {
  name: string;
  badge: 'Lightweight' | 'Standard' | 'High Performance';
  badgeJa: '軽量' | '標準' | '高精度';
  size: string;
  description: string;
}

/**
 * タグ付け用 VLM。
 *
 * **ここには実測したモデルだけを載せる。** 名前やパラメータ数だけでは
 * 安定性（低情報量画像で幻覚しないか等）も速度も判断できない
 * （実測: 12B超のモデルを使っても、8B前後と比べてタグの質・複雑な指示への追従に
 * 有意差が出なかった。逆に 2B まで下げると崩れ始めた）。
 * VRAM は計測ツールでの実測値（`/api/ps` の `size_vram`）。ディスクサイズではない。
 * 計測手順は tools/prompt-check/README.md。
 *
 * `gemma4:12b` は `qwen3-vl:8b-instruct` と精度が同等で速度だけ劣る。
 * VRAM に余裕があるからといって自動では格上げしない
 * （「重い方が高精度」という誤解を UI 側で強化しないため。`getBestVlmModelName` 参照）。
 */
export const RECOMMENDED_VLM_MODELS: RecommendedModel[] = [
  {
    name: 'translategemma:4b',
    badge: 'Lightweight',
    badgeJa: '軽量',
    size: '~2.8 GB',
    description: '低VRAM環境向け。低情報量な画像でも幻覚せず安定して動作する',
  },
  {
    name: 'qwen3-vl:8b-instruct',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~6.1 GB',
    description: '軸となる推奨モデル。速度・精度・複雑な指示への追従、いずれも上位モデルと同等',
  },
  {
    name: 'gemma4:12b',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~7.8 GB',
    description: 'qwen3-vl:8b-instructと同等の精度で低速。安定性を優先したい場合の代替',
  },
];

/**
 * 概念スペクトラム検索のタグベクトル化に使う埋め込みモデル。
 *
 * 日本語タグ名 (`name_ja`) をそのまま投入するため、多言語対応が必須条件。
 * `nomic-embed-text` は実質英語専用のため候補に含めない。
 *
 * **ここには実測したモデルだけを載せる。** 埋め込みモデルは名前や次元数からは
 * 概念の分離能力が判断できず、実際に自分のライブラリで類似度分布を測るまで
 * 良し悪しが分からない。
 *
 * 実測（2026-08-01 / 同一ライブラリ 1,108件 / centering ON / `tools/embedding-check`）:
 *
 * | モデル | sd | ハブ相関 r |
 * |---|---|---|
 * | `qwen3-embedding:8b` | **0.2014** | +0.093 |
 * | `embeddinggemma` | 0.1375 | **-0.077** |
 * | `bge-m3` | 0.1318 | -0.118 |
 * | `snowflake-arctic-embed2` | 0.1650 | -0.254 |
 * | `nomic-embed-text-v2-moe` | 0.1236 | -0.222 |
 *
 * sd は大きいほど概念を分離できている。`snowflake-arctic-embed2` は sd こそ
 * `bge-m3` より高いが、ハブ相関 |r| が 0.25 と大きく、類似度が意味ではなく
 * タグ本数を測ってしまっている疑いが強い（README「小さい r を読みすぎないこと」の
 * 閾値 |r|≲0.1 を大きく超える）。`nomic-embed-text-v2-moe`（多言語対応を謳う nomic 系）
 * も同様に r が大きく、sd も最下位のため候補に加えない。
 * `embeddinggemma` は `bge-m3` よりモデルサイズが小さい（実測 VRAM 0.68GB vs 1024次元）
 * にもかかわらず sd・r ともに同等以上で、軽量な代替になる。
 */
export const RECOMMENDED_EMBEDDING_MODELS: RecommendedModel[] = [
  {
    name: 'embeddinggemma',
    badge: 'Lightweight',
    badgeJa: '軽量',
    size: '~0.7 GB',
    description: '最も軽量 (768次元)。分離能力・ハブ化の少なさともにbge-m3と同等以上',
  },
  {
    name: 'bge-m3',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~570 MB',
    description: '軽量で導入しやすい多言語モデル (1024次元)。まずはこれで十分',
  },
  {
    name: 'qwen3-embedding:8b',
    badge: 'High Performance',
    badgeJa: '高精度',
    size: '~5.5 GB',
    description: '概念の分離能力が明確に高い (4096次元)。VRAMに余裕があるならこちら',
  },
];

/**
 * タグ整理（同義語・包括関係の検出）用テキストモデル。
 *
 * **実際の用途はこの1機能のみ。** `commands.rs` の `run_suggest_tag_merges_logic` は
 * 「タグ一覧 → 同義語ペアをJSONで返す」呼び出しにしか `ollama_text_model` を使っておらず、
 * 翻訳用途の呼び出しは存在しない（日本語訳自体は VLM 側のプロンプトで生成されている）。
 *
 * ## 本番経路での実測（2026-08-12）
 *
 * **人手判定でモデル間の差が確定した。** 同じライブラリ・同じプロンプトで
 * ②（包括関係）の提案を人手でラベル付けした結果:
 *
 * | モデル | n | 適合率 | 95%区間 | 通しの所要 |
 * |---|---|---|---|---|
 * | `qwen3:14b` | 42 | 74% | 59〜85% | 9分 |
 * | **`gemma4:12b`** | 74 | **99%** | **93〜100%** | **2.0分** |
 *
 * **区間が重ならない。** 偶然では説明できない差。
 * `db.rs` の初期値が `qwen3:14b` のままだったため、新規インストールは
 * 測っていない構成で動いていた（2026-08-12 に `gemma4:12b` へ変更）。
 *
 * ## 選定時の計測（2026-08-05 / `tools/text-check`）
 *
 * | モデル | VRAM | 段1: 親の再現（3回） | 段2: 発明タグ（3回） | 段2の所要 |
 * |---|---|---|---|---|
 * | `qwen2.5:7b` | 4.4GB | **1/5, 2/5, 2/5** | — | 0.3分 |
 * | `qwen3.5:9b` | 6.1GB | **2/5, 1/5, 1/5** | 1, 0, 0 | 7.6分 |
 * | **`gemma4:12b`** | 7.0GB | **5/5, 5/5, 5/5** | **0, 0, 0** | **6.6分** |
 * | `qwen3:14b` | 8.6GB | 4/5, 4/5, 4/5 | **13, 30, 50** | 10.0分 |
 *
 * **`gemma4:12b` が全指標で最良。しかも `qwen3:14b` より小さく速い。**
 * 「大きいほど高精度」は成り立たなかった。`qwen3:14b` は毎回 `footwear` だけを
 * 落とすという再現性のある癖を持ち、段2では発明タグが平均31件・所要も 4.6〜16.1分と振れる。
 *
 * **7B / 9B は段1（包括語の抽出）に使えない。** 親を1〜2/5 しか選べず、
 * 見落とした親はその下の階層が丸ごと永久に出ない。したがって
 * **`qwen3.5:9b` を軽量枠に置くのは「段2だけなら実用になる」という限定的な意味**で、
 * 単独で機能を成立させられるわけではない。**6GB を下回る環境に推奨できるモデルは無い。**
 *
 * > **単発の測定で順位を付けないこと。** 発明タグ数は同一条件で 124 → 0/0/0、
 * > 20 → 59/41/30 と大きく振れた。一方で親の再現は3回とも完全に一致する。
 * > **振れる指標と振れない指標があり、必要な反復数は指標ごとに違う。**
 *
 * > **モデルを変えたら人手判定で測り直すこと。** プロンプトの効きはモデルごとに違う。
 * > qwen3 のラベルを見て gemma4 のプロンプトを直したところ、-74件の悪化を出した
 * > （qwen3 の失敗8件のうち7件を gemma4 は元から出していなかった）。
 * > 手順は tools/text-check/COMPARE.md、道具は `label-diff.mjs`（差分だけ判定する）。
 *
 * 計測手順と判定基準は tools/text-check/README.md。
 */
export const RECOMMENDED_TEXT_MODELS: RecommendedModel[] = [
  {
    name: 'qwen3.5:9b',
    badge: 'Lightweight',
    badgeJa: '軽量',
    size: '~6.1 GB',
    description: '割り当て精度は高いが、包括語の抽出は苦手（実測 1〜2/5）。VRAMが足りない場合の妥協案',
  },
  {
    name: 'gemma4:12b',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~7.0 GB',
    description: '推奨。包括語の抽出が3回とも完全一致、発明タグ0件。より大きいモデルより速く正確',
  },
];
