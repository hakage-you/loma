import { test, expect } from '@playwright/test';
import { record, invokeCounts, payloadBytes, domNodes, heapMb } from './measure';

// スキャン実行中の再取得の計測。**合否は問わない。**
//
// 解析中は `batch_progress` が1件ごとに飛ぶ。useMedia はそれを 1秒に間引いて
// `get_media` + `get_all_tags` + `get_parent_folders` + `get_scan_folders` +
// `get_settings` を取り直す。**解析は数時間続くので、この1秒あたりの代償が
// そのまま何時間も積み上がる。**
//
// `?debugScan=mid` はスキャン実行中を再現するモック限定のフック。

const cards = 'div.grid.gap-4 > div.group';
const MEASURE_MS = 10_000;

test('解析中の1秒あたりの再取得', async ({ page }) => {
  await page.goto('/?debugMediaCount=5000&debugScan=mid&debugScanIntervalMs=300&debugMeasurePayload=1');
  await expect(page.locator(cards).first()).toBeVisible();
  // 起動時の取得を数に入れない
  await page.waitForTimeout(2000);
  await page.evaluate(() =>
    (window as unknown as { __mockResetInvokeLog: () => void }).__mockResetInvokeLog()
  );
  const heapBefore = await heapMb(page);

  await page.waitForTimeout(MEASURE_MS);

  const counts = await invokeCounts(page);
  const bytes = await payloadBytes(page);
  const seconds = MEASURE_MS / 1000;
  const perSecond = (n: number) => Math.round(((n ?? 0) / seconds) * 100) / 100;
  const mediaBytes = bytes.get_media ?? 0;

  record(`解析中 ${seconds}秒あたり（メディア5,000件）`, {
    'invoke 合計': Object.values(counts).reduce((a, b) => a + b, 0),
    get_media: counts.get_media ?? 0,
    get_all_tags: counts.get_all_tags ?? 0,
    get_parent_folders: counts.get_parent_folders ?? 0,
    get_scan_folders: counts.get_scan_folders ?? 0,
    get_settings: counts.get_settings ?? 0,
    'get_media / 秒': perSecond(counts.get_media),
    'get_media の転送 MB/秒':
      Math.round(((perSecond(counts.get_media) * mediaBytes) / 1024 / 1024) * 100) / 100,
    'JS ヒープ増 MB': Math.round(((await heapMb(page)) - heapBefore) * 100) / 100,
    'DOM ノード': await domNodes(page),
  });
});
