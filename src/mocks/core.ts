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
    eligible_media: mediaState.filter((m) => !isTagInsufficient(m)).length,
    excluded_media: mediaState.filter(isTagInsufficient).length,
    completed_media: mediaState.length,
    min_basic_tags: MIN_BASIC_TAGS,
    min_candidates: 5,
    full_spectrum_min: 20,
    include_descriptive: false,
    centering: true,
  }),
  generate_tag_embeddings: () => ({ model: 'bge-m3', generated: 0, dim: 1024, elapsed_ms: 0 }),
  find_similar_media: (args) => {
    // 実データの分布（centering 有効時は 0 中心で min が負）に形だけ寄せる。
    // モックは実際の意味的近さを再現しないので、順位と数値の見た目だけを揃える。
    const others = mediaState.filter((m) => m.id !== args.baseMediaId);
    const degraded = others.length < 20;
    const toItem = (m: MediaItem, similarity: number) => ({
      media_id: m.id,
      similarity,
      file_path: m.file_path,
      thumbnail_path: m.thumbnail_path,
    });
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
