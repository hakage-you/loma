import { useSyncExternalStore } from 'react';

/**
 * 全画面ブロック中に出す文言の種類。
 *
 * **表示文字列はここに置かない。** `useMedia` は I18nProvider の外側でも呼ばれるため
 * `useTranslation` を使えない（`errorModal.messageKey` と同じ制約）。
 * ここでは「何をしているか」だけを渡し、文言の解決は `BusyOverlay` が行う。
 */
export type BusyKind =
  | 'saving_settings'
  | 'editing_tags'
  | 'applying_tag_merges'
  | 'building_tag_suggestions'
  | 'syncing_folders'
  | 'reanalyzing_media'
  | 'processing_embeddings';

interface BusyState {
  /** 全画面を塞いでいる処理。null なら塞がない */
  kind: BusyKind | null;
  /** スキャン・全件再解析が動いているか */
  scanning: boolean;
  /** 自前の進捗表示を持つ長時間処理の本数（ベクトル生成など） */
  backgroundDepth: number;
}

// React の外に置く。`useMedia` はフックなので Context を張れる位置になく、
// `TagManagementModal` は invoke を直接呼んでいる。両方から同じ状態を触るため。
let state: BusyState = { kind: null, scanning: false, backgroundDepth: 0 };
/** 同時に走った前景の排他処理の数。0 に戻るまでオーバーレイを消さない */
let depth = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshot = () => state;

export interface BusyView {
  /** 全画面を塞いでいる処理。`BusyOverlay` だけが使う */
  kind: BusyKind | null;
  /**
   * 排他ロックを取る操作を押させてよいか。
   * `true` の間は Rust が必ず弾くので、ボタンは `disabled` にする。
   */
  exclusiveBlocked: boolean;
  /** ブロックの理由。文言を出し分けるために使う */
  blockedByScan: boolean;
}

export function useBusy(): BusyView {
  const current = useSyncExternalStore(subscribe, snapshot);
  return {
    kind: current.kind,
    exclusiveBlocked:
      current.kind !== null || current.scanning || current.backgroundDepth > 0,
    blockedByScan: current.scanning,
  };
}

/**
 * Rust 側で `try_acquire_task_lock` を取るコマンドのうち、
 * **完了を待てて、専用の進捗表示を持たない**ものを包む。実行中は画面全体を塞ぐ。
 *
 * 自前の進捗表示があるもの（ベクトル生成）は `runBackground` を使う。
 * 塞ぐとその進捗が見えなくなり、何分待てばいいのか分からなくなる。
 */
export async function runExclusive<T>(kind: BusyKind, fn: () => Promise<T>): Promise<T> {
  depth += 1;
  if (state.kind === null) {
    state = { ...state, kind };
    emit();
  }
  try {
    return await fn();
  } finally {
    depth -= 1;
    if (depth === 0 && state.kind !== null) {
      state = { ...state, kind: null };
      emit();
    }
  }
}

/**
 * 長時間かかるが、自前の進捗表示を持つ排他処理を包む。
 * 画面は塞がないが、Rust のロックは握られたままなので、
 * ほかの排他操作は押させない。
 */
export async function runBackground<T>(fn: () => Promise<T>): Promise<T> {
  state = { ...state, backgroundDepth: state.backgroundDepth + 1 };
  emit();
  try {
    return await fn();
  } finally {
    state = { ...state, backgroundDepth: Math.max(0, state.backgroundDepth - 1) };
    emit();
  }
}

/**
 * スキャン・全件再解析の在／不在を伝える。
 * 数十分かかるので画面は塞がないが、その間ほかの排他操作は必ず失敗する。
 */
export function setScanBusy(scanning: boolean): void {
  if (state.scanning === scanning) return;
  state = { ...state, scanning };
  emit();
}
