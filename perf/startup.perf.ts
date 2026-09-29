import { test, expect } from '@playwright/test';
import { record, invokeCounts, invokeLog, domNodes, heapMb, payloadBytes } from './measure';

// 起動から画面が出るまでの計測。**合否は問わない。**
//
// 見るのは「何本 IPC が飛んだか」「どれだけ転送したか」「DOM がどれだけ出たか」。
// どれも画面には出ないので、ここでしか数えられない。
//
// 注意: mock モードは Vite の開発ビルドで、React は StrictMode で動く。
// **開発ビルドでは effect が 2 回走る**ので、ここで出る回数は本番の約2倍になる。
// 比較のためだけに使うこと（同じ条件の前後差を見る）。

const cards = 'div.grid.gap-4 > div.group';

test('起動時の IPC と描画', async ({ page }) => {
  await page.goto('/?debugMeasurePayload=1');
  await expect(page.locator(cards).first()).toBeVisible();
  // 起動直後の取得が一巡するまで待つ
  await page.waitForTimeout(1500);

  const counts = await invokeCounts(page);
  const log = await invokeLog(page);
  const bytes = await payloadBytes(page);

  record('起動 / IPC の回数', {
    'invoke 合計': log.length,
    'コマンドの種類': Object.keys(counts).length,
    get_media: counts.get_media ?? 0,
    get_all_tags: counts.get_all_tags ?? 0,
    get_parent_folders: counts.get_parent_folders ?? 0,
    get_scan_folders: counts.get_scan_folders ?? 0,
    get_settings: counts.get_settings ?? 0,
    get_scan_status: counts.get_scan_status ?? 0,
    get_app_logs: counts.get_app_logs ?? 0,
  });

  record('起動 / 応答サイズ (文字)', {
    get_media: bytes.get_media ?? -1,
    get_all_tags: bytes.get_all_tags ?? -1,
    get_app_logs: bytes.get_app_logs ?? -1,
  });

  record('起動 / 画面', {
    'DOM ノード': await domNodes(page),
    'ギャラリーのカード': await page.locator(cards).count(),
    'JS ヒープ MB': await heapMb(page),
    '最初の invoke から最後まで ms': Math.round(log[log.length - 1].at - log[0].at),
  });
});

test('メディア 5,000 件での起動', async ({ page }) => {
  // 実ライブラリの規模（実DBは media 4,941件）に合わせる。
  // **ここが重いと、起動のたびに毎回その代償を払う。**
  await page.goto('/?debugMediaCount=5000&debugMeasurePayload=1');
  await expect(page.locator(cards).first()).toBeVisible();
  await page.waitForTimeout(2000);

  const bytes = await payloadBytes(page);
  record('5,000件 / 起動', {
    'get_media の応答 (文字)': bytes.get_media ?? -1,
    'get_media の応答 (MB)': Math.round(((bytes.get_media ?? 0) / 1024 / 1024) * 100) / 100,
    'DOM ノード': await domNodes(page),
    'ギャラリーのカード': await page.locator(cards).count(),
    'JS ヒープ MB': await heapMb(page),
  });
});

test('絞り込みを掛け直したときの再取得', async ({ page }) => {
  await page.goto('/?debugMediaCount=5000');
  await expect(page.locator(cards).first()).toBeVisible();
  await page.waitForTimeout(1000);
  await page.evaluate(() =>
    (window as unknown as { __mockResetInvokeLog: () => void }).__mockResetInvokeLog()
  );

  const started = Date.now();
  await page.locator('aside').getByRole('button', { name: /スクリーンショット/ }).click();
  await expect(page.locator(cards).first()).toBeVisible();
  const elapsed = Date.now() - started;

  const counts = await invokeCounts(page);
  record('絞り込み1回あたり', {
    'invoke 合計': Object.values(counts).reduce((a, b) => a + b, 0),
    get_media: counts.get_media ?? 0,
    get_all_tags: counts.get_all_tags ?? 0,
    '反映まで ms': elapsed,
    'DOM ノード': await domNodes(page),
  });
});

test('マスタデータ4本を同時に投げているか', async ({ page }) => {
  // **同時に投げているかどうかは、遅らせないと差が出ない。**
  // 4本をそれぞれ 200ミリ秒遅らせる。1本ずつ待つ作りなら約800ミリ秒、
  // 同時に投げる作りなら約200ミリ秒で揃う。
  const DELAY = 200;
  const slow = [
    'get_all_tags',
    'get_parent_folders',
    'get_scan_folders',
    'get_settings',
  ]
    .map((c) => `${c}:${DELAY}`)
    .join(',');

  await page.goto(`/?debugSlowCommand=${slow}`);
  await expect(page.locator(cards).first()).toBeVisible();
  // **全部出揃うまで待つ。** 1本ずつ待つ作りなら最後の1本は 600ミリ秒後なので、
  // 4本そろった時点で測ると差が出ない
  await page.waitForTimeout(DELAY * 6);

  // 最初の4本を投げ終わるまでにかかった幅
  const elapsed = await page.evaluate(async () => {
    const log = (window as unknown as { __mockInvokeLog: { cmd: string; at: number }[] })
      .__mockInvokeLog;
    const names = ['get_all_tags', 'get_parent_folders', 'get_scan_folders', 'get_settings'];
    const times = log.filter((e) => names.includes(e.cmd)).map((e) => e.at);
    if (times.length < 4) return -1;
    // **最初の1本から最後の1本までの幅。** 同時に投げていれば 0 に近い。
    // 1本ずつ待つ作りなら、遅延 × (本数 - 1) ぶん開く
    const sorted = [...times].sort((a, b) => a - b);
    return Math.round(sorted[sorted.length - 1] - sorted[0]);
  });

  record('起動 / マスタデータの投げ方', {
    '1本あたりの遅延 ms': DELAY,
    '4本を投げ終わるまでの幅 ms': elapsed,
    '（同時なら 0 に近い。1本ずつなら 600 前後）': 0,
  });
});
