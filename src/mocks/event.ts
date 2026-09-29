// モック版 @tauri-apps/api/event。
// 通常はバックエンドからのイベントが発生しないため実質 no-op だが、
// `?debugScan=` 指定時のみ進捗イベントを疑似発火し、進捗パネルを描画できるようにする。
import { startScanSimulatorIfRequested } from './scanSimulator';

export type UnlistenFn = () => void;

type Handler = (event: { payload: any }) => void;

const handlers = new Map<string, Set<Handler>>();

export async function listen<T>(
  event: string,
  handler: (event: { payload: T }) => void
): Promise<UnlistenFn> {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler as Handler);
  console.info(`[mock event] listen("${event}") registered`);
  return () => {
    handlers.get(event)?.delete(handler as Handler);
  };
}

/** モックの handler からも進捗イベントを起こせるよう公開する */
export function emitMock(event: string, payload: any): void {
  handlers.get(event)?.forEach((h) => h({ payload }));
}

/**
 * イベント名ごとの購読者数。**フックが二重に呼ばれていないかの確認に使う。**
 * 購読が2組になっても画面は動いてしまうので、数えないと気付けない。
 */
(window as unknown as Record<string, unknown>).__mockListenerCounts = () => {
  const out: Record<string, number> = {};
  for (const [event, set] of handlers) out[event] = set.size;
  return out;
};

startScanSimulatorIfRequested(emitMock);
