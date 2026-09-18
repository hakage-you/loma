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

startScanSimulatorIfRequested(emitMock);
