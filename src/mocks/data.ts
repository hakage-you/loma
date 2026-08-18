import { MediaItem, TagItem, TagPairItem, ScanFolderItem } from '../types';

interface CategoryDef {
  category: string;
  parentFolder: string;
  tags: { name: string; name_ja: string }[];
  count: number;
}

// 記述的タグ(descriptive)のUI確認用サンプル。tag_granularity が atomic 以外の設定で
// 解析された想定のメディアに付与する（先頭の landscape メディア1件のみ）
const SAMPLE_DESCRIPTIVE_TAGS: TagPairItem[] = [
  { name: 'rain_soaked_tree', name_ja: '雨に濡れた木', kind: 'descriptive' },
  { name: 'sunset_beach', name_ja: '夕日の海岸', kind: 'descriptive' },
];

const CATEGORY_DEFS: CategoryDef[] = [
  { category: 'screenshot', parentFolder: 'Screenshots', tags: [{ name: 'ui', name_ja: 'UI' }, { name: 'app', name_ja: 'アプリ' }, { name: 'window', name_ja: 'ウィンドウ' }], count: 3 },
  { category: 'document', parentFolder: 'WorkDocs', tags: [{ name: 'text', name_ja: 'テキスト' }, { name: 'paper', name_ja: '書類' }, { name: 'table', name_ja: '表' }], count: 3 },
  { category: 'landscape', parentFolder: '2024_Travel', tags: [{ name: 'nature', name_ja: '自然' }, { name: 'sky', name_ja: '空' }, { name: 'mountain', name_ja: '山' }], count: 3 },
  { category: 'food', parentFolder: '2024_Travel', tags: [{ name: 'meal', name_ja: '食事' }, { name: 'dessert', name_ja: 'デザート' }, { name: 'plate', name_ja: '皿' }], count: 3 },
  { category: 'character', parentFolder: 'Portraits', tags: [{ name: 'person', name_ja: '人物' }, { name: 'portrait', name_ja: 'ポートレート' }, { name: 'smile', name_ja: '笑顔' }], count: 3 },
  { category: 'text_heavy', parentFolder: 'Manga', tags: [{ name: 'manga', name_ja: '漫画' }, { name: 'subtitle', name_ja: '字幕' }, { name: 'panel', name_ja: 'コマ' }], count: 3 },
  { category: 'tech', parentFolder: 'WorkDocs', tags: [{ name: 'device', name_ja: 'デバイス' }, { name: 'code', name_ja: 'コード' }, { name: 'screen', name_ja: '画面' }], count: 3 },
  { category: 'other', parentFolder: 'Misc', tags: [{ name: 'misc', name_ja: 'その他' }, { name: 'object', name_ja: '物体' }, { name: 'indoor', name_ja: '屋内' }], count: 2 },
];

// 解析済みは 23 件。概念スペクトラム検索は基準とタグを共有する候補を外すので、
// カテゴリ内の兄弟（ここでは同じタグを持つ2件）が引かれて候補は 20 件になる。
// これは3ゾーン表示の最小値（FULL_SPECTRUM_MIN）とちょうど同じで、
// **ここを下回るとモックが縮退モードに落ちて3ゾーンのテストが壊れる**。
// カテゴリの件数を減らすときはこの数を確認すること。

function buildMedia(): MediaItem[] {
  const items: MediaItem[] = [];
  let id = 1;
  let fileIndex = 1;

  for (const def of CATEGORY_DEFS) {
    for (let i = 0; i < def.count; i++) {
      const fileName = `mock_media_${fileIndex}.jpg`;
      const basicTags: TagPairItem[] = def.tags.map((t) => ({ ...t, kind: 'basic' }));
      // landscape カテゴリの先頭1件だけ記述的タグ(descriptive)を併記して見た目を確認できるようにする
      const isDescriptiveSample = def.category === 'landscape' && i === 0;
      items.push({
        id: id++,
        file_path: `mock-asset://${fileName}`,
        parent_folder: def.parentFolder,
        thumbnail_path: `mock-asset://${fileName}`,
        file_size: 200_000 + fileIndex * 1234,
        analysis_status: 'completed',
        categories: [def.category],
        tags: isDescriptiveSample ? [...basicTags, ...SAMPLE_DESCRIPTIVE_TAGS] : basicTags,
      });
      fileIndex++;
    }
  }

  // 未解析(pending)の2件 — タグ・カテゴリなしで「未解析」バッジ確認用
  for (let i = 0; i < 2; i++) {
    const fileName = `mock_media_${fileIndex}.jpg`;
    items.push({
      id: id++,
      file_path: `mock-asset://${fileName}`,
      parent_folder: 'Screenshots',
      thumbnail_path: `mock-asset://${fileName}`,
      file_size: 180_000 + fileIndex * 999,
      analysis_status: 'pending',
      categories: [],
      tags: [],
    });
    fileIndex++;
  }

  // 解析失敗の1件 — エラー表示確認用
  {
    const fileName = `mock_media_${fileIndex}.jpg`;
    items.push({
      id: id++,
      file_path: `mock-asset://${fileName}`,
      parent_folder: 'Misc',
      thumbnail_path: `mock-asset://${fileName}`,
      file_size: 210_000,
      analysis_status: 'failed',
      analysis_error: 'Ollama への接続がタイムアウトしました(モックデータ)',
      categories: [],
      tags: [],
    });
    fileIndex++;
  }

  return items;
}

export const MOCK_MEDIA: MediaItem[] = buildMedia();

export const MOCK_MEDIA_FILE_COUNT = MOCK_MEDIA.length;

function buildTags(): TagItem[] {
  const counts = new Map<string, { name_ja?: string; is_category: boolean; kind: 'basic' | 'descriptive'; count: number }>();

  for (const item of MOCK_MEDIA) {
    for (const cat of item.categories) {
      const entry = counts.get(cat) || { is_category: true, kind: 'basic' as const, count: 0 };
      entry.count++;
      counts.set(cat, entry);
    }
    for (const tag of item.tags) {
      const entry = counts.get(tag.name) || { name_ja: tag.name_ja, is_category: false, kind: tag.kind, count: 0 };
      entry.count++;
      counts.set(tag.name, entry);
    }
  }

  let id = 1;
  return Array.from(counts.entries()).map(([name, v]) => ({
    id: id++,
    name,
    name_ja: v.name_ja,
    is_category: v.is_category,
    count: v.count,
    kind: v.kind,
  }));
}

export const MOCK_TAGS: TagItem[] = buildTags();

export const MOCK_PARENT_FOLDERS: string[] = Array.from(new Set(MOCK_MEDIA.map((m) => m.parent_folder)));

export const MOCK_SCAN_FOLDERS: ScanFolderItem[] = [
  { id: 1, path: 'C:\\Users\\demo\\Pictures\\2024_Travel', created_at: 1732000000 },
  { id: 2, path: 'C:\\Users\\demo\\Pictures\\Screenshots', created_at: 1732500000 },
];

export const MOCK_SETTINGS: Record<string, string> = {
  llm_provider: 'ollama',
  ollama_url: 'http://localhost:11434',
  ollama_model: 'qwen3-vl:8b-instruct',
  ollama_text_model: 'qwen2.5:7b',
  force_detailed_prompt: 'false',
  tag_granularity: 'balanced',
  ui_language: 'ja',
  ffmpeg_notice_enabled: 'true',
};

// qwen3-vl:8b-instruct のみインストール済みにして、他の推奨カード（要DL）と
// 混在した表示を mock モードでも確認できるようにする
export const MOCK_AVAILABLE_MODELS: string[] = ['qwen3-vl:8b-instruct', 'qwen2.5:7b'];

// vision を宣言しているのは片方だけ。VLM プルダウンの絞り込みと
// 「vision 未宣言のモデルも表示」トグルを mock モードで確認できるようにする
export const MOCK_VISION_MODELS: string[] = ['qwen3-vl:8b-instruct'];

export const MOCK_VRAM_GB = 12.0;

export const MOCK_LOGS = [
  '[INFO] Loma started (mock mode)',
  '[INFO] Loaded 24 mock media items',
  '[INFO] Ollama model: qwen3-vl:8b-instruct',
].join('\n');
