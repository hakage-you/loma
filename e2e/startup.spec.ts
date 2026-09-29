import { test, expect, Page } from '@playwright/test';

// 起動時に「同じものを何組も作っていない」ことの検証。
//
// **これは性能の計測ではなく、構造の不変条件。** 回数は環境で動かない。
// フックが二重に呼ばれても画面は普通に動いてしまうので、数えないと気付けない。
// 以前は App が言語設定のためだけに `useMedia` を呼び、AppContent が本体として
// もう一度呼んでいて、起動時の取得も batch_progress の購読も2組あった。
//
// 注意: mock モードは Vite の開発ビルドで React が StrictMode で動くため、
// **effect は意図的に2回走る。** ここでの「2回」は「1インスタンスぶん」を意味する。
// 3回以上になったら、どこかでインスタンスが増えている。

type InvokeEntry = { cmd: string; args: Record<string, any>; at: number };

const invokeCounts = async (page: Page): Promise<Record<string, number>> => {
  const log = await page.evaluate(
    () => (window as unknown as { __mockInvokeLog: InvokeEntry[] }).__mockInvokeLog
  );
  const counts: Record<string, number> = {};
  for (const entry of log) counts[entry.cmd] = (counts[entry.cmd] ?? 0) + 1;
  return counts;
};

const listenerCounts = (page: Page): Promise<Record<string, number>> =>
  page.evaluate(() =>
    (window as unknown as { __mockListenerCounts: () => Record<string, number> })
      .__mockListenerCounts()
  );

/** StrictMode で effect が2回走るぶん。1インスタンスならどのコマンドもこれが上限 */
const STRICT_MODE_FACTOR = 2;

test.describe('起動時に同じ取得を重ねない', () => {
  test('一覧とマスタデータを1組ぶんしか取らない', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('div.grid.gap-4 > div.group').first()).toBeVisible();
    await page.waitForTimeout(1000);

    const counts = await invokeCounts(page);
    // **get_media の応答は実データで 5MB。** 1回増えるだけで転送も JS ヒープも増える
    expect(counts.get_media).toBeLessThanOrEqual(STRICT_MODE_FACTOR);
    expect(counts.get_all_tags).toBeLessThanOrEqual(STRICT_MODE_FACTOR);
    expect(counts.get_parent_folders).toBeLessThanOrEqual(STRICT_MODE_FACTOR);
    expect(counts.get_scan_folders).toBeLessThanOrEqual(STRICT_MODE_FACTOR);
    expect(counts.get_settings).toBeLessThanOrEqual(STRICT_MODE_FACTOR);
    expect(counts.get_scan_status).toBeLessThanOrEqual(STRICT_MODE_FACTOR);
  });

  test('進捗イベントの購読は1本だけ', async ({ page }) => {
    // **購読が2本あると、進捗1件につき再取得が2回走る。**
    // スキャン中は1秒ごとに起きるので、そのまま倍の負荷になる
    await page.goto('/');
    await expect(page.locator('div.grid.gap-4 > div.group').first()).toBeVisible();

    const counts = await listenerCounts(page);
    expect(counts.batch_progress).toBe(1);
    expect(counts['ollama-pull-progress']).toBe(1);
  });

  test('絞り込みを変えたときに取り直すのは一覧だけ', async ({ page }) => {
    // タグ一覧やフォルダ一覧は絞り込みで変わらない。
    // **毎回取り直すと、絞り込みのたびに無駄な往復が増える**
    await page.goto('/');
    await expect(page.locator('div.grid.gap-4 > div.group').first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      (window as unknown as { __mockResetInvokeLog: () => void }).__mockResetInvokeLog()
    );

    await page.locator('aside').getByRole('button', { name: /風景・自然/ }).click();
    await expect(page.locator('div.grid.gap-4 > div.group')).toHaveCount(3);

    const counts = await invokeCounts(page);
    expect(counts.get_media).toBe(1);
    expect(counts.get_all_tags ?? 0).toBe(0);
    expect(counts.get_parent_folders ?? 0).toBe(0);
  });
});

test.describe('タグの名前は一覧から引く', () => {
  // **メディア一覧はタグの id しか持っていない。** 名前は get_all_tags の結果から引く。
  // 名前を全件ぶん載せると、実データで応答の半分以上がタグ名になるため。
  //
  // タグ一覧の取得はメディア一覧と同時に走るので、メディアが先に届く瞬間がある。
  // そのとき**タグ欄を空にしてはいけない**（付いているのに「無い」と見せることになる）。

  const cards = 'div.grid.gap-4 > div.group';

  test('タグ一覧が届けば、カードにタグ名が出る', async ({ page }) => {
    await page.goto('/');
    const card = page.locator(cards).filter({ hasText: 'mock_media_1.jpg' }).first();

    await expect(card.getByText('UI', { exact: true })).toBeVisible();
    await expect(card.getByText('アプリ', { exact: true })).toBeVisible();
  });

  test('タグ一覧が届くまでは、タグの形のまま読み込み中を出す', async ({ page }) => {
    // get_all_tags だけ遅らせる。メディアは先に届く
    await page.goto('/?debugSlowCommand=get_all_tags:1500');
    const card = page.locator(cards).filter({ hasText: 'mock_media_1.jpg' }).first();
    await expect(card).toBeVisible();

    // 付いている本数ぶん、タグの形で読み込み中を出す
    await expect(card.locator('div[aria-busy="true"]')).toBeVisible();
    // **空欄にはしない。** 「タグが無い」と読めてしまう
    await expect(card.locator('div[aria-busy="true"] > span')).toHaveCount(3);

    // 届いたら本物に入れ替わる
    await expect(card.getByText('UI', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('div[aria-busy="true"]')).toHaveCount(0);
  });

  test('タグが付いていないメディアには読み込み中を出さない', async ({ page }) => {
    // **「まだ分からない」と「0件」を区別する。** 未解析のメディアはタグが無いので、
    // 読み込み中を出すと永久に出たままに見える
    await page.goto('/?debugSlowCommand=get_all_tags:1500');
    const pending = page.locator(cards).filter({ hasText: 'mock_media_24.jpg' }).first();
    await expect(pending).toBeVisible();

    await expect(pending.locator('div[aria-busy="true"]')).toHaveCount(0);
  });
});
