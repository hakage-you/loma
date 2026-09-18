import {
  MOCK_MEDIA,
  MOCK_TAGS,
  MOCK_PARENT_FOLDERS,
  MOCK_SCAN_FOLDERS,
  MOCK_SETTINGS,
  MOCK_AVAILABLE_MODELS,
  MOCK_VISION_MODELS,
  MOCK_VRAM_GB,
  MOCK_LOGS,
} from './data';
import { MediaItem, TagItem, MergeSuggestion } from '../types';
import { isMockScanRunning, setMockScanPaused } from './scanSimulator';
// 進捗イベントの疑似発火に使う。購読者は event.ts が持っている
import { emitMock } from './event';
import { MIN_BASIC_TAGS, isTagInsufficient } from '../constants/spectrum';

// 開発中のスクリーンショット撮影用モック(`vite --mode mock` 時のみ有効)。
// 実際の @tauri-apps/api/core の invoke / convertFileSrc を置き換える。

let mediaState: MediaItem[] = MOCK_MEDIA.map((m) => ({ ...m, tags: [...m.tags], categories: [...m.categories] }));

/**
 * `?debugMediaCount=<件数>` を付けると、その件数になるまで水増しする。
 *
 * 既定は 23件で、**段階描画のように「多いときだけ効く」挙動を検証できない**。
 * 既定値は変えない（概念スペクトラム検索のテストが件数に依存している）。
 */
(() => {
  const raw = new URLSearchParams(window.location.search).get('debugMediaCount');
  const want = raw ? Number(raw) : 0;
  if (!Number.isFinite(want) || want <= mediaState.length) return;
  const base = mediaState[0];
  const padded = [...mediaState];
  for (let i = mediaState.length; i < want; i++) {
    const id = 10_000 + i;
    padded.push({
      ...base,
      id,
      file_path: `mock-asset://padded_${id}.jpg`,
      thumbnail_path: `mock-asset://padded_${id}.jpg`,
      tags: base.tags.map((t) => ({ ...t })),
      categories: [...base.categories],
    });
  }
  mediaState = padded;
})();
let tagState: TagItem[] = MOCK_TAGS.map((t) => ({ ...t }));

/**
 * `?debugTagCount=<件数>` を付けると、その件数になるまでタグを水増しする。
 *
 * 既定は26件で、**タグ管理の段階描画や、件数が多いときだけ効く上限を**
 * **一度も通らない。** 実ライブラリは 10,123件。
 * 水増しぶんはどのメディアにも付かない（count は持つが media_tags は増えない）。
 * 一覧の描画と並べ替えを見るのが目的で、統合の結果を見るものではない。
 */
(() => {
  const raw = new URLSearchParams(window.location.search).get('debugTagCount');
  const want = raw ? Number(raw) : 0;
  if (!Number.isFinite(want) || want <= tagState.length) return;
  const padded = [...tagState];
  let nextId = Math.max(0, ...tagState.map((t) => t.id)) + 1;
  for (let i = tagState.length; i < want; i++) {
    padded.push({
      id: nextId++,
      name: `padded_tag_${i}`,
      // 半分は日本語名なしにして、「日本語名なし」バッジの描画も含める
      name_ja: i % 2 === 0 ? `水増しタグ${i}` : undefined,
      is_category: false,
      // 同点が大量にある実データの形に寄せる
      count: (i % 40) + 1,
      kind: i % 7 === 0 ? 'descriptive' : 'basic',
    });
  }
  tagState = padded;
})();
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
    // **英語名だけで見ない。** 実バックエンドは name と name_ja の両方で照合する
    // （`evaluate_tag_filter` / `get_media` の tag_filter）。ギャラリーのカードは
    // 日本語表示のとき name_ja を送るので、英語名だけだと必ず0件になる
    const matches = (target: string) =>
      item.tags.some(
        (t) => t.name.toLowerCase() === target.toLowerCase() || (t.name_ja ?? '') === target
      );
    if (!tagFilter.some(matches)) return false;
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

/** プロバイダーごとの API キー（モック側の資格情報ストア） */
const apiKeyState: Record<string, string> = { gemini: 'mock-gemini-key' };
// 資格情報ストアの中身は画面に出ないので、e2e から確かめる術がこれしかない。
// 「保存で消えていないこと」は画面では絶対に判定できない
(window as unknown as Record<string, unknown>).__mockApiKeys = apiKeyState;

/** 解析対象から外したパス（モック側の `excluded_paths`） */
const excludedState: { path: string; reason?: string | null; created_at: number }[] = [];


// ---------------------------------------------------------------------------
// ここから下は「バックエンドを呼んだ結果を画面が使う」経路を mock で走らせるための handler。
//
// **handler が無いコマンドは undefined を返すだけで例外にならない。**
// 画面は成功したものとして進むので、e2e は「押せた」しか見ていない状態になる。
// 三者の食い違いは `npm run check:mock-commands` が落とす。
// ---------------------------------------------------------------------------

/**
 * ログ本文。`clear_app_logs` で空にできるよう状態として持つ。
 *
 * `?debugLogLines=<行数>` で水増しできる。**既定の3行では「多いときだけ効く」
 * 上限（受け取るバイト数・DOM に出す行数）を一度も通らない。**
 */
let logsState: string = (() => {
  const raw = new URLSearchParams(window.location.search).get('debugLogLines');
  const want = raw ? Number(raw) : 0;
  if (!Number.isFinite(want) || want <= 0) return MOCK_LOGS;
  const lines: string[] = [];
  for (let i = 0; i < want; i++) {
    lines.push(`[2026-09-18 10:00:00] [INFO] mock log line ${i}`);
  }
  return lines.join(String.fromCharCode(10));
})();


/**
 * 画面の外へ出ていく操作の記録。
 * ファイルマネージャを開く・モデルを降ろすといった操作は**画面に何も残らない**ので、
 * 呼ばれたことを e2e から確かめる術がこれしかない。
 */
const sideEffectLog: { command: string; args: Record<string, any> }[] = [];
(window as unknown as Record<string, unknown>).__mockSideEffects = sideEffectLog;

/**
 * 一括処理の完了イベント。
 *
 * **これを出さないと画面は「解析中」のまま固まる。** useMedia は
 * startScan / retryMedia / reanalyze* で scanning を立て、降ろすのは
 * batch_progress の status が Completed になったときだけ。
 * 実バックエンドは batch.rs が処理の最後に必ず Completed を送る。
 *
 * イベントは呼び出しが解決したあとに届かせる（実物も同じ順序）。
 */
function emitScanCompleted(total: number): void {
  setTimeout(() => {
    emitMock('batch_progress', {
      total,
      current: total,
      current_file: '',
      status: 'Completed',
      error_count: 0,
    });
  }, 0);
}

const recordSideEffect = (command: string, args: Record<string, any>) => {
  sideEffectLog.push({ command, args });
};

/** タグ表から名前で引く。無ければ採番して足す（バックエンドの get_or_create_tag と同じ） */
function getOrCreateTag(name: string, nameJa?: string): TagItem {
  const existing = tagState.find((t) => t.name === name);
  if (existing) return existing;
  const created: TagItem = {
    id: Math.max(0, ...tagState.map((t) => t.id)) + 1,
    name,
    name_ja: nameJa,
    is_category: false,
    count: 0,
    kind: 'basic',
  };
  tagState = [...tagState, created];
  return created;
}

/**
 * タグ統合。統合元のタグを統合先へ寄せ、どのメディアからも外れた統合元を消す。
 * バックエンドの `merge_tags` と同じく、**既に消えているIDを渡されてもエラーにしない**。
 */
function mergeTagsInto(targetId: number, sourceIds: number[]): number {
  const target = tagState.find((t) => t.id === targetId);
  if (!target) return 0;
  let merged = 0;
  for (const sourceId of sourceIds) {
    const source = tagState.find((t) => t.id === sourceId);
    if (!source || source.id === target.id) continue;
    for (const item of mediaState) {
      if (!item.tags.some((t) => t.name === source.name)) continue;
      item.tags = item.tags.filter((t) => t.name !== source.name);
      if (!item.tags.some((t) => t.name === target.name)) {
        item.tags = [...item.tags, { name: target.name, name_ja: target.name_ja, kind: target.kind }];
      }
    }
    tagState = tagState.filter((t) => t.id !== source.id);
    merged++;
  }
  // 件数を数え直す。統合で同じメディアに2つ付いていたものが1つに畳まれる
  recountTags();
  return merged;
}

/** タグの count をメディア側から数え直す */
function recountTags(): void {
  const counts = new Map<string, number>();
  for (const item of mediaState) {
    for (const tag of item.tags) counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
    for (const cat of item.categories) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  tagState = tagState.map((t) => ({ ...t, count: counts.get(t.name) ?? 0 }));
}

/**
 * 統合候補。**タグ表の実IDを使う**（画面は id で承認・除外を持つので、
 * 固定値を返すと「選んだのに適用されない」状態になる）。
 *
 * 中身は実データではなく、3方式それぞれの表示（規則チップ / 確信度 / 類似度）を
 * 画面に出すための最小限の組。
 */
function buildMockSuggestions(method: string): MergeSuggestion[] {
  const pick = (name: string) => tagState.find((t) => t.name === name);
  const group = (
    id: string,
    targetName: string,
    sourceNames: string[],
    reason: string,
    confidence: string,
    rules?: string[]
  ): MergeSuggestion | null => {
    const target = pick(targetName);
    const sources = sourceNames.map(pick).filter((t): t is TagItem => !!t);
    if (!target || sources.length === 0) return null;
    const thumbs = mediaState
      .filter((m) => m.tags.some((t) => t.name === targetName) && m.thumbnail_path)
      .slice(0, 5)
      .map((m) => m.thumbnail_path);
    return {
      id,
      target_tag: target,
      source_tags: sources,
      reason,
      confidence,
      rules,
      sample_thumbnails: thumbs,
      total_images_count: target.count,
    };
  };

  // `?debugSuggestionCount=<件数>` で提案を水増しする。
  // **提案カードは一覧の行の約4倍重い**（規則チップ・メンバー全員ぶんの option・
  // メンバーチップ2ボタン・サムネ最大5枚）。実データは表記ゆれだけで 4,215件。
  const padCount = Number(new URLSearchParams(window.location.search).get('debugSuggestionCount')) || 0;
  const padded: MergeSuggestion[] = [];
  if (padCount > 0) {
    const pool = tagState.filter((t) => !t.is_category);
    for (let i = 0; i < padCount && pool.length >= 3; i++) {
      const target = pool[i % pool.length];
      const members = [pool[(i + 1) % pool.length], pool[(i + 2) % pool.length]];
      padded.push({
        id: `padded-${method}-${i}`,
        target_tag: target,
        source_tags: members,
        reason: '水増し',
        confidence: 'medium',
        rules: i % 3 === 0 ? ['spelling', 'singular'] : ['spelling'],
        sample_thumbnails: [],
        total_images_count: target.count ?? 0,
      });
    }
  }

  const table: Record<string, (MergeSuggestion | null)[]> = {
    rules: [
      group('rules-1', 'person', ['portrait'], '日本語表記が一致', 'high', ['ja_exact']),
      group('rules-2', 'screen', ['window'], '綴りが近い', 'medium', ['spelling', 'keyphrase']),
    ],
    hypernym: [
      group('hyp-1', 'nature', ['sky', 'mountain'], '「〜の一種」と判定', 'high', ['hypernym']),
    ],
    related: [
      group('rel-1', 'meal', ['dessert', 'plate'], 'ベクトルが近い', 'medium', ['embedding']),
    ],
  };
  return [...(table[method] ?? []).filter((s): s is MergeSuggestion => s !== null), ...padded];
}

/**
 * 方式ごとの提案の保存先。
 *
 * **実バックエンドは `suggest_*` が `tag_suggestion_pairs` へ書き、
 * 画面は `load_tag_suggestions_cache` で読み戻す2段構え。**
 * モックが `suggest_*` の戻り値だけを返して保存しないと、検出を回しても
 * 読み戻しが空になり、提案タブは永久に「提案はまだありません」のままになる。
 */
const suggestionStore: Record<string, MergeSuggestion[]> = {};

/** その方式の実行記録。未実行なら null（画面は状態の帯を出さない） */
const suggestionRuns: Record<
  string,
  { started_at: number; finished_at: number | null; pair_count: number; judged_count: number; unjudged_count: number }
> = {};

/** 却下済みのペア。再実行しても戻らないよう、方式ごとに覚える */
const dismissedPairs: Record<string, Set<string>> = {};

const pairKey = (targetId: number, memberId: number) => `${targetId}:${memberId}`;

/** 検出を1回走らせる。却下済みのペアは候補から外す */
function runSuggestScan(method: string): MergeSuggestion[] {
  const dismissed = dismissedPairs[method] ?? new Set<string>();
  const built = buildMockSuggestions(method)
    .map((sug) => ({
      ...sug,
      source_tags: sug.source_tags.filter((t) => !dismissed.has(pairKey(sug.target_tag.id, t.id))),
    }))
    .filter((sug) => sug.source_tags.length > 0);
  suggestionStore[method] = built;
  const pairCount = built.reduce((n, s) => n + s.source_tags.length, 0);
  suggestionRuns[method] = {
    started_at: Math.floor(Date.now() / 1000) - 1,
    finished_at: Math.floor(Date.now() / 1000),
    pair_count: pairCount,
    judged_count: tagState.length,
    unjudged_count: 0,
  };
  return built;
}

/**
 * モデルのダウンロード進捗の疑似発火。
 *
 * **完了するまで解決しない Promise を返す。** 実バックエンドの `pull_ollama_model` は
 * ダウンロードが終わるまで返らず、呼び出し側（SettingsModal）は `finally` で
 * 進捗イベントの購読を外す。即座に解決すると購読が先に外れ、
 * 進捗バーが一度も描画されない。
 */
let pullTimer: ReturnType<typeof setInterval> | null = null;
let pullReject: ((reason: unknown) => void) | null = null;

const PULL_TOTAL_BYTES = 4_200_000_000;
const PULL_STEPS = 8;
const PULL_STEP_MS = 150;

function startMockPull(model: string): Promise<void> {
  cancelMockPull();
  return new Promise<void>((resolve, reject) => {
    pullReject = reject;
    let completed = 0;
    pullTimer = setInterval(() => {
      completed = Math.min(PULL_TOTAL_BYTES, completed + PULL_TOTAL_BYTES / PULL_STEPS);
      const done = completed >= PULL_TOTAL_BYTES;
      emitMock('ollama-pull-progress', {
        model,
        status: done ? 'success' : 'downloading',
        completed,
        total: PULL_TOTAL_BYTES,
        percent: (completed / PULL_TOTAL_BYTES) * 100,
        done,
      });
      if (done) {
        clearPullTimer();
        pullReject = null;
        resolve();
      }
    }, PULL_STEP_MS);
  });
}

function clearPullTimer(): void {
  if (pullTimer !== null) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
}

/** 中断。実バックエンドは pull 側をエラーで終わらせるので、ここも reject する */
function cancelMockPull(): void {
  clearPullTimer();
  if (pullReject) {
    const reject = pullReject;
    pullReject = null;
    reject(new Error('[mock] pull cancelled'));
  }
}

/**
 * invoke の呼び出し記録。**性能の計測に使う。**
 * 起動時に何本 IPC が飛ぶかは画面に出ないので、ここでしか数えられない。
 * 合否は問わない（計測とデバッグ用）。
 */
const invokeLog: { cmd: string; args: Record<string, any>; at: number }[] = [];
(window as unknown as Record<string, unknown>).__mockInvokeLog = invokeLog;
(window as unknown as Record<string, unknown>).__mockInvokeCounts = () => {
  const counts: Record<string, number> = {};
  for (const entry of invokeLog) counts[entry.cmd] = (counts[entry.cmd] ?? 0) + 1;
  return counts;
};
/**
 * `?debugMeasurePayload=1` を付けたときだけ、応答の JSON 長を記録する。
 *
 * **常時やらない。** 応答のたびに JSON.stringify が走り、計りたい時間そのものを
 * 押し上げてしまう。実 IPC は毎回シリアライズするので、この長さが転送量にあたる。
 */
const measurePayload = new URLSearchParams(window.location.search).has('debugMeasurePayload');
const payloadBytes: Record<string, number> = {};
(window as unknown as Record<string, unknown>).__mockPayloadBytes = payloadBytes;

(window as unknown as Record<string, unknown>).__mockResetInvokeLog = () => {
  invokeLog.length = 0;
};

const handlers: Record<string, (args: Record<string, any>) => any> = {
  // --- スキャン制御 ---
  pause_scan: () => {
    setMockScanPaused(true);
  },
  resume_scan: () => {
    setMockScanPaused(false);
  },
  rescan_all_folders: () => {
    recordSideEffect('rescan_all_folders', {});
    emitScanCompleted(mediaState.length);
  },
  reanalyze_all_media: () => {
    recordSideEffect('reanalyze_all_media', {});
    for (const item of mediaState) item.analysis_status = 'pending';
    emitScanCompleted(mediaState.length);
  },
  reanalyze_folder: (args) => {
    recordSideEffect('reanalyze_folder', args);
    for (const item of mediaState) {
      if (item.file_path.includes(args.folderPath) || item.parent_folder === args.folderPath) {
        item.analysis_status = 'pending';
      }
    }
    emitScanCompleted(mediaState.length);
  },
  /**
   * 1件だけ再解析する。実バックエンドは解析が終わってから返るので、
   * ここでも**返る時点で結果が反映されている**ようにする
   * （解析中の表示を見たいときは `?debugSlowCommand=reanalyze_single_media:800`）。
   */
  reanalyze_single_media: (args) => {
    const item = mediaState.find((m) => m.id === args.mediaId);
    if (!item) return;
    item.analysis_status = 'completed';
    item.analysis_error = undefined;
    item.analysis_error_kind = undefined;
    item.consecutive_failures = 0;
    item.needs_attention = false;
    recordSideEffect('reanalyze_single_media', args);
  },
  custom_analyze_video: (args) => {
    recordSideEffect('custom_analyze_video', args);
    const item = mediaState.find((m) => m.id === args.mediaId);
    if (item) item.analysis_status = 'completed';
  },
  /**
   * 失敗したものを解析し直す。
   * **`needs_attention` のものは直らない。** 実物と同じく失敗のまま残し、
   * 「まとめて再試行したのにリストから消えない」状況を再現できるようにする。
   */
  retry_media: (args) => {
    const ids: number[] = args.mediaIds ?? [];
    for (const item of mediaState.filter((m) => ids.includes(m.id))) {
      if (item.needs_attention) {
        item.consecutive_failures = (item.consecutive_failures ?? 0) + 1;
        continue;
      }
      item.analysis_status = 'completed';
      item.analysis_error = undefined;
      item.analysis_error_kind = undefined;
      item.consecutive_failures = 0;
    }
    emitScanCompleted(ids.length);
  },
  cleanup_missing_media: () => {
    recordSideEffect('cleanup_missing_media', {});
    return 0;
  },

  // --- タグ編集 ---
  rename_tag: (args) => {
    const tag = tagState.find((t) => t.id === args.tagId);
    if (!tag) return;
    const oldName = tag.name;
    tag.name = args.newName;
    tag.name_ja = args.newNameJa ?? undefined;
    tagState = tagState.map((t) => (t.id === tag.id ? { ...tag } : t));
    for (const item of mediaState) {
      item.tags = item.tags.map((t) =>
        t.name === oldName ? { ...t, name: tag.name, name_ja: tag.name_ja } : t
      );
      item.categories = item.categories.map((c) => (c === oldName ? tag.name : c));
    }
  },
  merge_tags: (args) => mergeTagsInto(args.targetTagId, args.sourceTagIds ?? []),
  get_or_create_tag: (args) => getOrCreateTag(args.name, args.nameJa),
  /**
   * 統合をまとめて適用する。
   * **同じタグが2つ以上の統合先へ割り当てられていたら何も適用しない**（実物と同じ）。
   * 競合を返すだけで状態は変えない。
   */
  apply_tag_merges: (args) => {
    const items: { target_id: number; source_ids: number[] }[] = args.items ?? [];
    const assignedTo = new Map<number, number[]>();
    for (const item of items) {
      for (const sourceId of item.source_ids) {
        const list = assignedTo.get(sourceId) ?? [];
        if (!list.includes(item.target_id)) list.push(item.target_id);
        assignedTo.set(sourceId, list);
      }
    }
    const conflicts = [...assignedTo.entries()]
      .filter(([, targets]) => targets.length > 1)
      .map(([tag_id, target_ids]) => ({ tag_id, target_ids }));
    if (conflicts.length > 0) return { merged_tags: 0, targets: 0, conflicts };

    let merged = 0;
    for (const item of items) merged += mergeTagsInto(item.target_id, item.source_ids);
    return { merged_tags: merged, targets: items.length, conflicts: [] };
  },
  /**
   * 適用で消える提案の数。実物は規則ごとの内訳を返す。
   * 統合元・統合先に触れる提案は、適用後に意味を失う
   */
  count_invalidated_suggestions: (args) => {
    const items: { target_id: number; source_ids: number[] }[] = args.items ?? [];
    const suggestions: MergeSuggestion[] = args.suggestions ?? [];
    const touched = new Set<number>();
    for (const item of items) {
      touched.add(item.target_id);
      for (const id of item.source_ids) touched.add(id);
    }
    const applying = new Set(items.map((i) => i.target_id));
    const byRule = new Map<string, number>();
    for (const sug of suggestions) {
      const ids = [sug.target_tag.id, ...sug.source_tags.map((t) => t.id)];
      // いま適用するもの自身は「消える提案」に数えない
      if (applying.has(sug.target_tag.id) && ids.every((id) => touched.has(id))) continue;
      if (!ids.some((id) => touched.has(id))) continue;
      for (const rule of sug.rules ?? ['unknown']) {
        byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      }
    }
    return [...byRule.entries()];
  },
  get_media_by_tag: (args) => {
    const tag = tagState.find((t) => t.id === args.tagId);
    if (!tag) return [];
    return mediaState.filter(
      (m) => m.tags.some((t) => t.name === tag.name) || m.categories.includes(tag.name)
    );
  },
  /** タグIDごとのサンプルサムネ。キーは実バックエンドと同じく文字列 */
  get_tag_sample_thumbnails: (args) => {
    const ids: number[] = args.tagIds ?? [];
    const out: Record<string, string[]> = {};
    for (const id of ids) {
      const tag = tagState.find((t) => t.id === id);
      if (!tag) continue;
      out[String(id)] = mediaState
        .filter(
          (m) =>
            (m.tags.some((t) => t.name === tag.name) || m.categories.includes(tag.name)) &&
            m.thumbnail_path
        )
        .slice(0, 5)
        .map((m) => m.thumbnail_path);
    }
    return out;
  },
  suggest_tag_merges: () => runSuggestScan('rules'),
  suggest_hypernyms: () => runSuggestScan('hypernym'),
  suggest_related_tags: () => runSuggestScan('related'),

  // --- ログ ---
  clear_app_logs: () => {
    logsState = '';
  },

  // --- 画面の外へ出る操作 ---
  open_file: (args) => recordSideEffect('open_file', args),
  open_folder: (args) => recordSideEffect('open_folder', args),
  unload_model: () => recordSideEffect('unload_model', {}),

  // --- モデルのダウンロード ---
  /**
   * 進捗イベントを疑似発火する。**即座に done を返さない** ——
   * ダウンロード中の表示（進捗バー・設定を開くボタン）は
   * 途中の状態でしか描画されないため。
   */
  pull_ollama_model: (args) => {
    const model = String(args.modelName ?? args.model ?? 'mock-model');
    recordSideEffect('pull_ollama_model', args);
    return startMockPull(model);
  },
  cancel_ollama_pull: () => {
    recordSideEffect('cancel_ollama_pull', {});
    cancelMockPull();
  },
  get_media: (args) => mediaState.filter((item) => matchesFilters(item, args)),
  get_excluded_paths: () => excludedState,
  exclude_media: (args) => {
    const ids: number[] = args.mediaIds ?? [];
    let n = 0;
    for (const item of mediaState.filter((m) => ids.includes(m.id))) {
      if (excludedState.some((e) => e.path === item.file_path)) continue;
      excludedState.push({
        path: item.file_path,
        reason: args.reason ?? null,
        created_at: Math.floor(Date.now() / 1000),
      });
      item.excluded = true;
      n++;
    }
    return n;
  },
  delete_media: (args) => {
    const ids: number[] = args.mediaIds ?? [];
    const targets = mediaState.filter((m) => ids.includes(m.id));
    for (const item of targets) {
      if (!excludedState.some((e) => e.path === item.file_path)) {
        excludedState.push({
          path: item.file_path,
          reason: args.reason ?? null,
          created_at: Math.floor(Date.now() / 1000),
        });
      }
      const at = mediaState.indexOf(item);
      if (at >= 0) mediaState.splice(at, 1);
    }
    return targets.length;
  },
  unexclude_paths: (args) => {
    const paths: string[] = args.paths ?? [];
    let n = 0;
    for (const path of paths) {
      const at = excludedState.findIndex((e) => e.path === path);
      if (at >= 0) {
        excludedState.splice(at, 1);
        n++;
      }
      const item = mediaState.find((m) => m.file_path === path);
      if (item) item.excluded = false;
    }
    return n;
  },
  get_all_tags: () => tagState,
  get_parent_folders: () => MOCK_PARENT_FOLDERS,
  get_scan_folders: () => scanFoldersState,
  get_settings: () => settingsState,
  get_available_models: () => MOCK_AVAILABLE_MODELS,
  get_vision_capable_models: () => MOCK_VISION_MODELS,
  // `?debugScan=mid` では「起動時点で既にスキャン実行中」を再現する
  get_scan_status: () => scanning || isMockScanRunning(),
  /**
   * **末尾しか返さない。** 実バックエンドの `read_logs` と同じで、
   * 全文を返すモックのままだと「上限を渡しているのに効いていない」不具合を
   * 一度も再現できない。
   */
  get_app_logs: (args) => {
    const maxBytes: number | undefined = args.maxBytes;
    if (!maxBytes || logsState.length <= maxBytes) return logsState;
    const tail = logsState.slice(logsState.length - maxBytes);
    const nl = tail.indexOf(String.fromCharCode(10));
    return nl >= 0 ? tail.slice(nl + 1) : tail;
  },
  get_system_vram_gb: () => MOCK_VRAM_GB,
  update_setting: (args) => {
    settingsState = { ...settingsState, [args.key]: args.value };
  },
  save_settings: (args) => {
    // 実バックエンドは1トランザクション。途中まで入った状態は作らない
    const entries: { key: string; value: string }[] = args.entries ?? [];
    const next = { ...settingsState };
    for (const entry of entries) next[entry.key] = entry.value;
    settingsState = next;
    // 渡された API キーだけを書く。渡されなかったものには触らない
    const apiKeys: { provider: string; api_key: string }[] = args.apiKeys ?? [];
    for (const key of apiKeys) apiKeyState[key.provider] = key.api_key;
    return {
      settings_saved: entries.length,
      api_keys_saved: apiKeys.length,
      api_key_failures: [],
    };
  },
  remove_scan_folder: (args) => {
    scanFoldersState = scanFoldersState.filter((f) => f.id !== args.folderId);
  },
  add_tag_to_media: (args) => {
    // タグ表（tagState）にも登録する。実バックエンドの get_or_create_tag と同じく、
    // 既にあれば使い回し、無ければ採番する。ここを飛ばすと get_all_tags に出てこず、
    // 追加した直後のタグを削除できない
    let tag = tagState.find((t) => t.name === args.tagName);
    if (!tag) {
      // 手動追加タグは常に basic 種別（バックエンド get_or_create_tag と同じ挙動）
      tag = {
        id: Math.max(0, ...tagState.map((t) => t.id)) + 1,
        name: args.tagName,
        name_ja: args.tagNameJa,
        is_category: false,
        count: 0,
        kind: 'basic',
      };
      tagState = [...tagState, tag];
    }
    // let のままだとコールバック内で型が絞れないので const に写す
    const resolved = tag;
    const item = mediaState.find((m) => m.id === args.mediaId);
    if (item && !item.tags.some((t) => t.name === resolved.name)) {
      item.tags = [...item.tags, { name: resolved.name, name_ja: resolved.name_ja, kind: resolved.kind }];
      resolved.count++;
    }
    return { ...resolved };
  },
  remove_tag_from_media: (args) => {
    // 実バックエンドは media_tags を (media_id, tag_id) で消す。
    // ここも **tagId をタグ表の id として引く**。以前は item.tags の添字として
    // 扱っていて、関係のないタグが消えていた
    const tag = tagState.find((t) => t.id === args.tagId);
    const item = mediaState.find((m) => m.id === args.mediaId);
    if (!tag || !item) return;
    const before = item.tags.length;
    item.tags = item.tags.filter((t) => t.name !== tag.name);
    if (item.tags.length === before) return;
    tag.count--;
    // 実バックエンドは、どのメディアからも外れた非カテゴリタグを tags 表から消す
    if (tag.count <= 0 && !tag.is_category) tagState = tagState.filter((t) => t.id !== tag.id);
  },
  start_scan: () => {
    scanning = false;
    emitScanCompleted(mediaState.length);
  },
  sync_folders: () => {},
  cancel_scan: () => {
    scanning = false;
  },
  load_tag_suggestions_cache: (args) => suggestionStore[String(args.method ?? "")] ?? [],
  dismiss_tag_suggestion: (args) => {
    const method = String(args.method ?? "");
    const set = dismissedPairs[method] ?? new Set<string>();
    for (const memberId of (args.memberIds ?? []) as number[]) {
      set.add(pairKey(args.targetId, memberId));
    }
    dismissedPairs[method] = set;
    const store = suggestionStore[method] ?? [];
    suggestionStore[method] = store
      .map((sug) => ({
        ...sug,
        source_tags: sug.source_tags.filter((t) => !set.has(pairKey(sug.target_tag.id, t.id))),
      }))
      .filter((sug) => sug.source_tags.length > 0);
  },
  get_suggestion_run_status: (args) => suggestionRuns[String(args.method ?? "")] ?? null,
  // API キーの保存先は OS の資格情報ストア。モックはプロセス内に持つだけ
  get_provider_api_key: (args) => apiKeyState[args.provider] ?? '',
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
  // 上の storage_info と揃えた値を返す。0 のままだと結果表示が「削除するベクトルは
  // ありませんでした」しか出ず、件数と解放量の表示を確認できない。
  // discard 側は VACUUM が走らなかった場合（ファイルが縮まない）の表示を出す
  cleanup_unused_embeddings: () => ({
    deleted_rows: tagState.length,
    freed_bytes: tagState.length * 16384,
    vacuumed: true,
  }),
  discard_embeddings: () => ({
    deleted_rows: tagState.length,
    freed_bytes: tagState.length * 4096,
    vacuumed: false,
  }),
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
    const base = mediaState.find((m) => m.id === args.baseMediaId);
    const baseBasic = new Set(
      (base?.tags ?? []).filter((t) => t.kind === 'basic').map((t) => t.name),
    );
    const eligible = mediaState.filter(
      (m) => m.id !== args.baseMediaId && m.analysis_status === 'completed' && !isTagInsufficient(m),
    );
    // 基準と basic タグを1つでも共有する候補は外す（バックエンドと同じ規則）。
    // これが無いと上位ゾーンが近似重複で埋まり、タグ検索の劣化版になる
    const sharesTag = (m: MediaItem) =>
      m.tags.some((t) => t.kind === 'basic' && baseBasic.has(t.name));
    const others = eligible.filter((m) => !sharesTag(m));
    const sharedTagExcluded = eligible.length - others.length;
    const degraded = others.length < 20;
    // 帯幅はバックエンドの zone_bands と同じ規則（比率 10% / 下限 4 / 上限 8）。
    // 上限があるのは、順位で切った帯が覆う類似度の幅が分布の裾で桁違いに広がるため
    const bandSize = Math.min(8, Math.max(4, Math.ceil(others.length * 0.1)));
    const toItem = (m: MediaItem, similarity: number) => ({ media_id: m.id, similarity, media: m });
    const take = (from: number, sim: (i: number) => number) =>
      others.slice(from, from + 4).map((m, i) => toItem(m, sim(i)));

    const zones = degraded
      ? [{ key: 'similar', band_size: Math.min(4, others.length), items: take(0, (i) => 0.72 - i * 0.06) }]
      : [
          { key: 'similar', band_size: bandSize, items: take(0, (i) => 0.72 - i * 0.06) },
          { key: 'middle', band_size: bandSize, items: take(4, (i) => 0.02 - i * 0.01) },
          { key: 'distant', band_size: bandSize, items: take(8, (i) => -0.24 - i * 0.02) },
        ];

    return {
      status: degraded ? 'degraded' : 'ok',
      base_media_id: args.baseMediaId,
      base_media: base ?? null,
      model: 'bge-m3',
      zones,
      seed: args.seed ?? 0,
      range_min: -0.31,
      range_mean: -0.002,
      range_max: 0.78,
      candidate_count: others.length,
      excluded_media: mediaState.filter(isTagInsufficient).length,
      shared_tag_excluded: sharedTagExcluded,
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

/**
 * `?debugSlowCommand=<コマンド名>:<ミリ秒>` を付けると、そのコマンドだけ応答を遅らせる。
 *
 * 実行中の表示やブロックは**応答が返るまでの間しか出ない**ので、即座に返るモックのままでは
 * 検証できない。`scanSimulator` の `?debugScan=` と同じ、モック限定の検証用フック。
 */
const slowCommand: { cmd: string; ms: number } | null = (() => {
  const raw = new URLSearchParams(window.location.search).get('debugSlowCommand');
  if (!raw) return null;
  const [cmd, ms] = raw.split(':');
  const delay = Number(ms);
  if (!cmd || !Number.isFinite(delay) || delay <= 0) return null;
  return { cmd, ms: delay };
})();

/**
 * `?debugFailCommand=<コマンド名>` を付けると、そのコマンドだけ必ず失敗させる。
 * 失敗したときの表示（保存できなかった／APIキーを読み出せなかった）は、
 * 成功しか返さないモックのままでは一度も描画されない。
 */
const failCommand = new URLSearchParams(window.location.search).get('debugFailCommand');

export async function invoke<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
  if (failCommand === cmd) {
    throw new Error(`[mock] ${cmd} を失敗させています (debugFailCommand)`);
  }
  if (slowCommand && slowCommand.cmd === cmd) {
    await new Promise((resolve) => setTimeout(resolve, slowCommand.ms));
  }
  invokeLog.push({ cmd, args, at: performance.now() });
  const handler = handlers[cmd];
  if (!handler) {
    console.warn(`[mock invoke] unhandled command "${cmd}"`, args);
    return undefined as unknown as T;
  }
  // handler は Promise を返してよい（実バックエンドと同じく、処理が終わるまで返らない
  // コマンドがある）。await せずに structuredClone すると DataCloneError になる
  const result = await handler(args);
  if (measurePayload) {
    payloadBytes[cmd] = JSON.stringify(result ?? null).length;
  }
  // 実際の Tauri IPC は戻り値を毎回シリアライズするので、呼び出し側は
  // 毎回別のオブジェクトを受け取る。モックが内部 state の参照をそのまま返すと、
  // 画面が抱えている古いオブジェクトまで一緒に書き換わり、
  // 「更新しないと画面が追従しない」種類の不具合をモックだけが隠してしまう。
  // （詳細モーダルのタグ削除が追従しなかった不具合が、まさにこれで再現しなかった）
  return structuredClone(result) as T;
}

export function convertFileSrc(filePath: string, _protocol = 'asset'): string {
  const prefix = 'mock-asset://';
  if (filePath.startsWith(prefix)) {
    return `/mock-assets/${filePath.slice(prefix.length)}`;
  }
  return filePath;
}
