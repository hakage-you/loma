export type TagKind = 'basic' | 'descriptive';

export interface TagPairItem {
  name: string;
  name_ja?: string;
  kind: TagKind;
}

export interface MediaItem {
  id: number;
  file_path: string;
  parent_folder: string;
  thumbnail_path: string;
  file_size: number;
  analysis_status: 'pending' | 'completed' | 'failed';
  analysis_error?: string;
  categories: string[];
  tags: TagPairItem[];
}

export interface TagItem {
  id: number;
  name: string;
  name_ja?: string;
  is_category: boolean;
  count: number;
  kind: TagKind;
}

export interface ScanFolderItem {
  id: number;
  path: string;
  created_at: number;
}

export interface ProgressPayload {
  total: number;
  current: number;
  current_file: string;
  status: string;
  error_count: number;
  is_paused?: boolean;
}

export interface MergeSuggestion {
  id: string;
  target_tag: TagItem;
  source_tags: TagItem[];
  reason: string;
  confidence: string;
  sample_thumbnails?: string[];
  total_images_count?: number;
}

export interface OllamaPullProgressPayload {
  model: string;
  status: string;
  completed: number;
  total: number;
  percent: number;
  done: boolean;
  error?: string;
}

// --- 詳細検索用の型定義 ---

/** バックエンドに送信する論理フィルタツリー */
export type TagFilterNode =
  | { type: 'tag'; value: string }
  | { type: 'and'; children: TagFilterNode[] }
  | { type: 'or'; children: TagFilterNode[] }
  | { type: 'not'; child: TagFilterNode };

/** 詳細検索UIのグループ1つ */
export interface SearchGroup {
  id: string;
  operator: 'and' | 'or' | 'not';
  tags: string[];
}

// --- タグ付与粒度設定用の型定義 ---

export type TagGranularity = 'atomic' | 'balanced' | 'descriptive';

export interface TagPair {
  en: string;
  ja: string;
}

export interface GranularityComparisonItem {
  granularity: TagGranularity;
  categories: string[];
  tags: TagPair[];
  descriptive_tags: TagPair[];
  error?: string;
}

// --- 概念スペクトラム検索用の型定義 ---

export interface EmbeddingStatus {
  model: string;
  model_available: boolean;
  available_models: string[];
  total_tags: number;
  embedded_tags: number;
  missing_tags: number;
  eligible_media: number;
  excluded_media: number;
  completed_media: number;
  min_basic_tags: number;
  min_candidates: number;
  full_spectrum_min: number;
  include_descriptive: boolean;
  centering: boolean;
}

export interface EmbeddingProgressPayload {
  total: number;
  current: number;
  status: 'running' | 'done' | 'error';
}

export interface EmbeddingGenerateResult {
  model: string;
  generated: number;
  dim: number;
  elapsed_ms: number;
}

export interface SimilarItem {
  media_id: number;
  similarity: number;
  file_path: string;
  thumbnail_path: string;
}

/**
 * `find_similar_media` の結果。
 * `degraded` は候補が `full_spectrum_min` 未満で、Phase 2 の3ゾーン分割に足りない状態。
 */
export type SpectrumStatus =
  | 'ok'
  | 'degraded'
  | 'not_enough_candidates'
  | 'base_not_eligible'
  | 'no_embeddings';

export type ZoneKey = 'similar' | 'middle' | 'distant';

/**
 * スペクトラムの1ゾーン。
 * `band_size` が `items.length` と等しいとき、引き直しても同じ顔ぶれしか出ない。
 */
export interface Zone {
  key: ZoneKey;
  band_size: number;
  items: SimilarItem[];
}

export interface SpectrumResult {
  status: SpectrumStatus;
  base_media_id: number;
  model: string;
  zones: Zone[];
  /** このレスポンスを生成したシード */
  seed: number;
  /** 基準メディアから見た全候補の実測レンジ。0〜1固定軸の凡例に線分として描く */
  range_min: number;
  range_mean: number;
  range_max: number;
  candidate_count: number;
  excluded_media: number;
  centering: boolean;
  include_descriptive: boolean;
  elapsed_ms: number;
}

export interface EmbeddingModelStorage {
  model: string;
  tag_count: number;
  dim: number;
  bytes: number;
  /** 現在の設定で使われているモデル。GC の対象外 */
  in_use: boolean;
}

export interface EmbeddingStorageInfo {
  current_model: string;
  total_tags: number;
  models: EmbeddingModelStorage[];
  /** 使用中でないモデルを削除したときに解放される容量 */
  reclaimable_bytes: number;
}

export interface EmbeddingCleanupResult {
  deleted_rows: number;
  freed_bytes: number;
  vacuumed: boolean;
}

export interface HistogramBin {
  lower: number;
  upper: number;
  count: number;
}

export interface EmbeddingDiagnostics {
  model: string;
  dim: number;
  centering: boolean;
  include_descriptive: boolean;
  eligible_media: number;
  excluded_by_tag_count: number;
  excluded_by_missing_vectors: number;
  sample_size: number;
  pair_count: number;
  sim_min: number;
  sim_mean: number;
  sim_max: number;
  sim_stddev: number;
  histogram: HistogramBin[];
  /** タグ本数と平均類似度の相関。0から離れるほどハブ化している */
  tagcount_similarity_corr: number;
  desc_group_size: number;
  nondesc_group_size: number;
  desc_intra_mean: number | null;
  nondesc_intra_mean: number | null;
  inter_group_mean: number | null;
  load_ms: number;
  centroid_ms: number;
  pairwise_ms: number;
}

