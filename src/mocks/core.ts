import {
  MOCK_MEDIA,
  MOCK_TAGS,
  MOCK_PARENT_FOLDERS,
  MOCK_SCAN_FOLDERS,
  MOCK_SETTINGS,
  MOCK_AVAILABLE_MODELS,
  MOCK_VRAM_GB,
  MOCK_LOGS,
} from './data';
import { MediaItem, TagItem } from '../types';
import { isMockScanRunning } from './scanSimulator';
import { MIN_BASIC_TAGS, isTagInsufficient } from '../constants/spectrum';

// 開発中のスクリーンショット撮影用モック(`vite --mode mock` 時のみ有効)。
// 実際の @tauri-apps/api/core の invoke / convertFileSrc を置き換える。

let mediaState: MediaItem[] = MOCK_MEDIA.map((m) => ({ ...m, tags: [...m.tags], categories: [...m.categories] }));
let tagState: TagItem[] = MOCK_TAGS.map((t) => ({ ...t }));
let settingsState: Record<string, string> = { ...MOCK_SETTINGS };
let scanFoldersState = MOCK_SCAN_FOLDERS.map((f) => ({ ...f }));
let scanning = false;

function matchesFilters(item: MediaItem, args: Record<string, any>): boolean {
  const categoryFilter: string[] | null = args.categoryFilter ?? null;
  const tagFilter: string[] | null = args.tagFilter ?? null;
  const parentFolderFilter: string | null = args.parentFolderFilter ?? null;
  const scanFolderFilter: string | null = args.scanFolderFilter ?? null;
  const statusFilter: string | null = args.statusFilter ?? null;
  const mediaTypeFilter: string | null = args.mediaTypeFilter ?? null;

  if (categoryFilter && categoryFilter.length > 0) {
    if (!categoryFilter.some((c) => item.categories.includes(c))) return false;
  }
  if (tagFilter && tagFilter.length > 0) {
    const itemTagNames = item.tags.map((t) => t.name);
    if (!tagFilter.some((t) => itemTagNames.includes(t))) return false;
  }
  if (parentFolderFilter && item.parent_folder !== parentFolderFilter) return false;
  if (scanFolderFilter && !item.file_path.includes(scanFolderFilter)) return false;
  if (statusFilter && statusFilter !== 'unanalyzed' && item.analysis_status !== statusFilter) return false;
  if (mediaTypeFilter && mediaTypeFilter !== 'all') {
    const isVideo = /\.(mp4|mov|webm|gif)$/i.test(item.file_path);
    if (mediaTypeFilter === 'video' && !isVideo) return false;
    if (mediaTypeFilter === 'image' && isVideo) return false;
  }
  return true;
}

const handlers: Record<string, (args: Record<string, any>) => any> = {
  get_media: (args) => mediaState.filter((item) => matchesFilters(item, args)),
  get_all_tags: () => tagState,
  get_parent_folders: () => MOCK_PARENT_FOLDERS,
  get_scan_folders: () => scanFoldersState,
  get_settings: () => settingsState,
  get_available_models: () => MOCK_AVAILABLE_MODELS,
  // `?debugScan=mid` では「起動時点で既にスキャン実行中」を再現する
  get_scan_status: () => scanning || isMockScanRunning(),
  get_app_logs: () => MOCK_LOGS,
  get_system_vram_gb: () => MOCK_VRAM_GB,
  update_setting: (args) => {
    settingsState = { ...settingsState, [args.key]: args.value };
  },
  remove_scan_folder: (args) => {
    scanFoldersState = scanFoldersState.filter((f) => f.id !== args.folderId);
  },
  add_tag_to_media: (args) => {
    const item = mediaState.find((m) => m.id === args.mediaId);
    if (item && !item.tags.some((t) => t.name === args.tagName)) {
      // 手動追加タグは常に basic 種別（バックエンド get_or_create_tag と同じ挙動）
      item.tags = [...item.tags, { name: args.tagName, name_ja: args.tagNameJa, kind: 'basic' }];
    }
    return { id: 0, name: args.tagName, name_ja: args.tagNameJa, is_category: false, count: 1, kind: 'basic' };
  },
  remove_tag_from_media: (args) => {
    const item = mediaState.find((m) => m.id === args.mediaId);
    if (item) item.tags = item.tags.filter((_, idx) => idx !== args.tagId);
  },
  start_scan: () => {
    scanning = false;
  },
  sync_folders: () => {},
  cancel_scan: () => {
    scanning = false;
  },
  suggest_tag_merges: () => [],
  get_provider_api_key: () => '',
  check_ffmpeg_installed: () => true,
  get_effective_prompt_type: (args) => {
    if (args.forceDetailed) return 'DETAILED';
    const provider = String(args.provider || '').toLowerCase();
    if (provider !== 'ollama') return 'DETAILED';
    const match = String(args.model || '').toLowerCase().match(/(\d+(?:\.\d+)?)b/);
    const paramSize = match ? parseFloat(match[1]) : null;
    return paramSize !== null && paramSize >= 10 ? 'DETAILED' : 'LIGHT';
  },
  // --- 概念スペクトラム検索 ---
  get_embedding_status: () => ({
    model: 'bge-m3',
    model_available: true,
    available_models: MOCK_AVAILABLE_MODELS,
    total_tags: tagState.length,
    embedded_tags: tagState.length,
    missing_tags: 0,
    // 母数は解析済みのみ。未解析・失敗は候補集合の話に入らない
    eligible_media: mediaState.filter((m) => m.analysis_status === 'completed' && !isTagInsufficient(m)).length,
    excluded_media: mediaState.filter(isTagInsufficient).length,
    completed_media: mediaState.filter((m) => m.analysis_status === 'completed').length,
    min_basic_tags: MIN_BASIC_TAGS,
    min_candidates: 5,
    full_spectrum_min: 20,
    include_descriptive: false,
    centering: true,
  }),
  generate_tag_embeddings: () => ({ model: 'bge-m3', generated: 0, dim: 1024, elapsed_ms: 0 }),
  get_embedding_storage_info: () => ({
    current_model: 'bge-m3',
    total_tags: tagState.length,
    // 旧モデルのベクトルが残っている状態を再現して GC ボタンを確認できるようにする
    models: [
      { model: 'bge-m3', tag_count: tagState.length, dim: 1024, bytes: tagState.length * 4096, in_use: true },
      { model: 'qwen3-embedding:8b', tag_count: tagState.length, dim: 4096, bytes: tagState.length * 16384, in_use: false },
    ],
    reclaimable_bytes: tagState.length * 16384,
  }),
  cleanup_unused_embeddings: () => ({ deleted_rows: 0, freed_bytes: 0, vacuumed: false }),
  discard_embeddings: () => ({ deleted_rows: 0, freed_bytes: 0, vacuumed: false }),
  // 実測値（bge-m3 / centering ON / 1,007件）に寄せた形。判定表示を確認できるようにする。
  // 引数の centering / includeDescriptive をそのまま反映して、
  // トグルが即時に効くことを画面で確認できるようにする
  get_embedding_diagnostics: (args) => {
    // 0 中心の正規形 + 右の裾（実データも max 付近まで薄く伸びる）。
    // sim_min / sim_max と矛盾しないよう、両端の非ゼロ位置を揃えておく
    const shape = [0, 0, 0, 0, 0, 0, 1, 3, 20, 34, 25, 11, 5, 2, 1, 1, 1, 1, 1, 0];
    return {
      model: 'bge-m3',
      dim: 1024,
      centering: args.centering ?? true,
      include_descriptive: args.includeDescriptive ?? false,
      eligible_media: 1007,
      excluded_by_tag_count: 1,
      excluded_by_missing_vectors: 0,
      sample_size: 336,
      pair_count: 56280,
      sim_min: -0.346,
      sim_mean: -0.001,
      sim_max: 0.929,
      sim_stddev: 0.132,
      histogram: shape.map((count, i) => ({ lower: -1 + i * 0.1, upper: -1 + (i + 1) * 0.1, count })),
      tagcount_similarity_corr: 0.035,
      desc_group_size: 336,
      nondesc_group_size: 0,
      // 実ライブラリ同様、対照群が無いため群分離は測定不能
      desc_intra_mean: -0.002,
      nondesc_intra_mean: null,
      inter_group_mean: null,
      load_ms: 340,
      centroid_ms: 5,
      pairwise_ms: 147,
    };
  },
  find_similar_media: (args) => {
    // 実データの分布（centering 有効時は 0 中心で min が負）に形だけ寄せる。
    // モックは実際の意味的近さを再現しないので、順位と数値の見た目だけを揃える。
    // 候補集合はバックエンドと同じ条件（解析済み かつ basic タグが足りている）で作る。
    // ここを揃えないと、設定画面が出す「検索対象メディア」の件数と食い違う。
    const others = mediaState.filter(
      (m) => m.id !== args.baseMediaId && m.analysis_status === 'completed' && !isTagInsufficient(m),
    );
    const degraded = others.length < 20;
    const toItem = (m: MediaItem, similarity: number) => ({ media_id: m.id, similarity, media: m });
    const take = (from: number, sim: (i: number) => number) =>
      others.slice(from, from + 4).map((m, i) => toItem(m, sim(i)));

    const zones = degraded
      ? [{ key: 'similar', band_size: Math.min(4, others.length), items: take(0, (i) => 0.72 - i * 0.06) }]
      : [
          { key: 'similar', band_size: Math.max(4, Math.ceil(others.length * 0.1)), items: take(0, (i) => 0.72 - i * 0.06) },
          { key: 'middle', band_size: Math.max(4, Math.ceil(others.length * 0.1)), items: take(4, (i) => 0.02 - i * 0.01) },
          { key: 'distant', band_size: Math.max(4, Math.ceil(others.length * 0.1)), items: take(8, (i) => -0.24 - i * 0.02) },
        ];

    return {
      status: degraded ? 'degraded' : 'ok',
      base_media_id: args.baseMediaId,
      base_media: mediaState.find((m) => m.id === args.baseMediaId) ?? null,
      model: 'bge-m3',
      zones,
      seed: args.seed ?? 0,
      range_min: -0.31,
      range_mean: -0.002,
      range_max: 0.78,
      candidate_count: others.length,
      excluded_media: mediaState.filter(isTagInsufficient).length,
      centering: true,
      include_descriptive: false,
      elapsed_ms: 12,
    };
  },
  compare_granularity_levels: () => [
    {
      granularity: 'atomic',
      categories: ['landscape'],
      tags: [
        { en: 'tree', ja: '木' },
        { en: 'water_drop', ja: '水滴' },
        { en: 'forest', ja: '森' },
      ],
      descriptive_tags: [],
    },
    {
      granularity: 'balanced',
      categories: ['landscape'],
      tags: [
        { en: 'tree', ja: '木' },
        { en: 'water_drop', ja: '水滴' },
        { en: 'forest', ja: '森' },
      ],
      descriptive_tags: [{ en: 'rain_soaked_tree', ja: '雨に濡れた木' }],
    },
    {
      granularity: 'descriptive',
      categories: ['landscape'],
      tags: [
        { en: 'tree', ja: '木' },
        { en: 'water_drop', ja: '水滴' },
        { en: 'rain', ja: '雨' },
        { en: 'leaf', ja: '葉' },
      ],
      descriptive_tags: [
        { en: 'rain_soaked_tree', ja: '雨に濡れた木' },
        { en: 'wet_undergrowth', ja: '濡れた下草' },
      ],
    },
  ],
};

export async function invoke<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  const handler = handlers[cmd];
  if (!handler) {
    console.warn(`[mock invoke] unhandled command "${cmd}"`, args);
    return undefined as unknown as T;
  }
  const result = handler(args);
  return result as T;
}

export function convertFileSrc(filePath: string, _protocol = 'asset'): string {
  const prefix = 'mock-asset://';
  if (filePath.startsWith(prefix)) {
    return `/mock-assets/${filePath.slice(prefix.length)}`;
  }
  return filePath;
}
