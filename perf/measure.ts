import { Page, test } from '@playwright/test';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';

// 計測の共通部品。**ここには合否の判定を書かない。**
// 期待値を持たせると、マシンの状態でぶれる数値で落ちる検査になり、
// 「落ちたら数字を上げる」しかしなくなる。

export type InvokeEntry = { cmd: string; args: Record<string, any>; at: number };

const OUT_DIR = 'perf-results';

/** 1回の計測値。名前 → 数値（単位は名前に含める） */
const collected: Record<string, Record<string, number>> = {};

export function record(group: string, values: Record<string, number>): void {
  collected[group] = { ...(collected[group] ?? {}), ...values };
  const width = Math.max(...Object.keys(values).map((k) => k.length));
  console.log(`\n[${group}]`);
  for (const [key, value] of Object.entries(values)) {
    console.log(`  ${key.padEnd(width)}  ${formatNumber(value)}`);
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(2);
}

test.afterAll(() => {
  if (Object.keys(collected).length === 0) return;
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const path = `${OUT_DIR}/latest.json`;
  // 部分実行（-g で絞る）でも前回の値を消さないよう、あるものに重ねる
  let previous: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      previous = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      previous = {};
    }
  }
  const merged = { ...previous, measured_at: new Date().toISOString(), ...collected };
  writeFileSync(path, JSON.stringify(merged, null, 2));
  console.log(`\n計測値を ${path} に書いた`);
});

/** invoke の記録 */
export const invokeLog = (page: Page): Promise<InvokeEntry[]> =>
  page.evaluate(() => (window as unknown as { __mockInvokeLog: InvokeEntry[] }).__mockInvokeLog);

/** コマンド別の回数 */
export async function invokeCounts(page: Page): Promise<Record<string, number>> {
  const log = await invokeLog(page);
  const counts: Record<string, number> = {};
  for (const entry of log) counts[entry.cmd] = (counts[entry.cmd] ?? 0) + 1;
  return counts;
}

/** そのページの DOM ノード数 */
export const domNodes = (page: Page): Promise<number> =>
  page.evaluate(() => document.getElementsByTagName('*').length);

/**
 * JS ヒープの使用量（MB）。Chromium 限定。
 * **絶対値は当てにしない。** 同じ手順の前後差だけを見る。
 */
export const heapMb = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? Math.round((mem.usedJSHeapSize / 1024 / 1024) * 100) / 100 : -1;
  });

/**
 * コマンド別の応答サイズ（文字数）。
 * **IPC は毎回シリアライズされる**ので、返る JSON の長さがそのまま転送量にあたる。
 * `?debugMeasurePayload=1` を付けたページでだけ記録される。
 */
export const payloadBytes = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(
    () => (window as unknown as { __mockPayloadBytes: Record<string, number> }).__mockPayloadBytes
  );
