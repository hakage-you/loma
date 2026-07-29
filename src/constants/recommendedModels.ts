export interface RecommendedModel {
  name: string;
  badge: 'Lightweight' | 'Standard' | 'High Performance';
  badgeJa: '軽量' | '標準' | '高精度';
  size: string;
  description: string;
}

export const RECOMMENDED_VLM_MODELS: RecommendedModel[] = [
  {
    name: 'qwen3-vl:4b',
    badge: 'Lightweight',
    badgeJa: '軽量',
    size: '~2.8 GB',
    description: '高速かつ低VRAMで動作する最新小型Visionモデル',
  },
  {
    name: 'qwen3-vl:8b',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~5.5 GB',
    description: '精度と処理速度のバランスに優れた推奨VLM',
  },
  {
    name: 'gemma4:12b',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~8.0 GB',
    description: 'Google Gemma 4ベースの高性能マルチモーダルモデル',
  },
  {
    name: 'qwen3-vl:30b',
    badge: 'High Performance',
    badgeJa: '高精度',
    size: '~19 GB',
    description: '最高水準の画像・動画認識が可能なフラッグシップモデル',
  },
];

/**
 * 概念スペクトラム検索のタグベクトル化に使う埋め込みモデル。
 *
 * 日本語タグ名 (`name_ja`) をそのまま投入するため、多言語対応が必須条件。
 * `nomic-embed-text` は実質英語専用のため候補に含めない。
 */
export const RECOMMENDED_EMBEDDING_MODELS: RecommendedModel[] = [
  {
    name: 'qwen3-embedding:0.6b',
    badge: 'Lightweight',
    badgeJa: '軽量',
    size: '~640 MB',
    description: '低VRAMで動作する多言語埋め込みモデル (1024次元)',
  },
  {
    name: 'bge-m3',
    badge: 'Standard',
    badgeJa: '標準',
    size: '~1.2 GB',
    description: '日本語を含む多言語に強い標準の埋め込みモデル (1024次元)',
  },
  {
    name: 'qwen3-embedding:8b',
    badge: 'High Performance',
    badgeJa: '高精度',
    size: '~5.5 GB',
    description: '概念の分離能力が最も高い大規模埋め込みモデル (4096次元)',
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
