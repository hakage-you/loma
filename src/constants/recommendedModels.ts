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
 * 良し悪しが分からない（実測: 類似度の sd は bge-m3 が 0.132、
 * qwen3-embedding:8b が 0.198 で 1.5 倍の開きがあった）。
 * 計測手順は tools/embedding-check/README.md。
 */
export const RECOMMENDED_EMBEDDING_MODELS: RecommendedModel[] = [
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

export const RECOMMENDED_TEXT_MODELS: RecommendedModel[] = [
  {
    name: 'qwen2.5:3b',
    badge: 'Lightweight',
    badgeJa: '軽量',
    size: '~1.9 GB',
    description: '高速で軽量なテキスト処理・タグ統合用モデル',
  },
  {
    name: 'qwen2.5:7b',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~4.7 GB',
    description: '自然な日本語理解と高いタグ統合能力を持つ標準モデル',
  },
  {
    name: 'qwen3:14b',
    badge: 'High Performance',
    badgeJa: '高精度',
    size: '~9.0 GB',
    description: '高度なカテゴリ分けと高精度テキスト処理用モデル',
  },
];
