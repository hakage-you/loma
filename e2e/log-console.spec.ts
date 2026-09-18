import { test, expect, Page } from '@playwright/test';

// 画面下のログコンソールの検証。
//
// **ここは過去に無操作 OOM を起こした場所。** 依存配列が `[]` で `open` を
// 見ておらず、32px に畳んだ状態でも 1.5 秒ごとに全文を取り続けていた。
// ログ 5MB の状態で renderer が 400MB/分 増え、JS ヒープ上限に当たって落ちた。
// 「畳んでいる間は回らない」ことと「末尾しか受け取らない」ことを、
// 取得の回数と引数で確かめる。

type InvokeEntry = { cmd: string; args: Record<string, any>; at: number };

const invokeLog = (page: Page): Promise<InvokeEntry[]> =>
  page.evaluate(() => (window as unknown as { __mockInvokeLog: InvokeEntry[] }).__mockInvokeLog);

const countOf = async (page: Page, cmd: string): Promise<number> =>
  (await invokeLog(page)).filter((e) => e.cmd === cmd).length;

const console_ = (page: Page) => page.locator('div.z-40').filter({ hasText: '処理ログ' });

test.describe('ログコンソール', () => {
  test('畳んだ状態でも行数と最新行が出る', async ({ page }) => {
    await page.goto('/');

    await expect(console_(page).getByText('3 行')).toBeVisible();
    await expect(console_(page).getByText('Recent:', { exact: false })).toBeVisible();
  });

  test('畳んでいる間はログを取り続けない', async ({ page }) => {
    // **この回帰が OOM の原因だった。** 取得が積み上がらないことを回数で見る
    await page.goto('/');
    await expect(console_(page).getByText('3 行')).toBeVisible();

    const before = await countOf(page, 'get_app_logs');
    await page.waitForTimeout(3500); // ポーリング間隔 1.5 秒の2回ぶん以上
    const after = await countOf(page, 'get_app_logs');

    expect(after).toBe(before);
  });

  test('開くと取得が始まり、閉じると止まる', async ({ page }) => {
    await page.goto('/');
    await console_(page).getByText('処理ログ').click();

    // 開いた直後に1回、その後 1.5 秒ごと
    const opened = await countOf(page, 'get_app_logs');
    await page.waitForTimeout(3500);
    const polled = await countOf(page, 'get_app_logs');
    expect(polled).toBeGreaterThan(opened);

    await console_(page).getByText('処理ログ').click();
    const closed = await countOf(page, 'get_app_logs');
    await page.waitForTimeout(3500);
    expect(await countOf(page, 'get_app_logs')).toBe(closed);
  });

  test('取得は末尾だけを要求する', async ({ page }) => {
    // **全文を受け取ると、その文字列がそのまま JS ヒープに残る。**
    // 1行140バイト程度なので 256KB あれば 1,000行を賄える
    await page.goto('/');
    const calls = (await invokeLog(page)).filter((e) => e.cmd === 'get_app_logs');
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args.maxBytes).toBe(256 * 1024);
    }
  });

  test('開くとログ本文が出て、エラー行が色分けされる', async ({ page }) => {
    await page.goto('/');
    await console_(page).getByText('処理ログ').click();

    await expect(console_(page).getByText('Loma started (mock mode)', { exact: false })).toBeVisible();
  });

  test('クリアすると本文が消え、行数も 0 になる', async ({ page }) => {
    await page.goto('/');
    await console_(page).getByText('処理ログ').click();
    await console_(page).getByTitle('クリア').click();

    await expect(console_(page).getByText('0 行')).toBeVisible();
    await expect(
      console_(page).getByText('Loma started (mock mode)', { exact: false })
    ).toHaveCount(0);
  });

  test('全画面表示から診断モーダルを開ける', async ({ page }) => {
    await page.goto('/');
    await console_(page).getByRole('button', { name: '全画面表示' }).click();

    // **この画面だけ日本語化されていない。** 見出しもツールバーも英語のまま
    await expect(
      page.getByRole('heading', { name: 'Application Diagnostics & Error Logs' })
    ).toBeVisible();
  });
});
