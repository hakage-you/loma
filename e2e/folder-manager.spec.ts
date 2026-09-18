import { test, expect, Page } from '@playwright/test';

// 登録フォルダ管理の検証。
//
// この画面の操作はどれも**画面に結果が残らない**（再スキャンも再解析も、
// 押した瞬間にモーダルが閉じて進捗パネルへ移る）。押せたかどうかではなく
// 「どのコマンドがどの引数で飛んだか」を見ないと、取り違えを検出できない。
// モック側が `window.__mockSideEffects` に呼び出しを積んでいるのでそれを読む。

type SideEffect = { command: string; args: Record<string, unknown> };

const sideEffects = (page: Page): Promise<SideEffect[]> =>
  page.evaluate(() => (window as unknown as { __mockSideEffects: SideEffect[] }).__mockSideEffects);

/**
 * モーダル本体。**背後のギャラリーとサイドバーにも同じ文字列が出る**ので、
 * 一覧の行を引くときは必ずここを起点にする（親フォルダ名はサイドバーにもカードにも出る）。
 */
const modal = (page: Page) => page.locator('div.glass-panel').filter({ hasText: '登録フォルダ管理' });

const openManager = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'フォルダ管理' }).click();
  await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toBeVisible();
};

/** 一覧の行。パスの一部で引く */
const folderRow = (page: Page, pathFragment: string) =>
  modal(page).locator('div.group').filter({ hasText: pathFragment }).first();

test.describe('登録フォルダ管理', () => {
  test('登録済みのフォルダが件数つきで並ぶ', async ({ page }) => {
    await openManager(page);

    await expect(page.getByText('登録フォルダ (2)')).toBeVisible();
    await expect(folderRow(page, '2024_Travel')).toBeVisible();
    await expect(folderRow(page, 'Screenshots')).toBeVisible();
  });

  test('未処理のみの実行はバックエンドへ rescan_all_folders を送って閉じる', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '全フォルダ再スキャン' }).click();

    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toHaveCount(0);
    expect((await sideEffects(page)).map((e) => e.command)).toContain('rescan_all_folders');
  });

  test('全メディア再解析は確認を挟む。取り消せば何も実行されない', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '全メディア再解析' }).click();

    // **確認を出すだけでモーダルは閉じない。** 閉じてしまうと押し間違いが通る
    await expect(
      page.getByText('全メディアを強制的に再解析します。')
    ).toBeVisible();
    await page.getByRole('button', { name: 'キャンセル' }).click();

    await expect(
      page.getByText('全メディアを強制的に再解析します。')
    ).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toBeVisible();
    expect((await sideEffects(page)).map((e) => e.command)).not.toContain('reanalyze_all_media');
  });

  test('全メディア再解析を承認すると reanalyze_all_media が飛ぶ', async ({ page }) => {
    await openManager(page);
    await page.getByRole('button', { name: '全メディア再解析' }).click();
    await page.getByRole('button', { name: '再解析を実行' }).click();

    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toHaveCount(0);
    expect((await sideEffects(page)).map((e) => e.command)).toContain('reanalyze_all_media');
  });

  test('行ごとの再解析は、そのフォルダのパスを引数に送る', async ({ page }) => {
    await openManager(page);
    await folderRow(page, '2024_Travel')
      .getByTitle('このフォルダの全項目を強制的に再解析')
      .click();

    const calls = await sideEffects(page);
    const call = calls.find((e) => e.command === 'reanalyze_folder');
    expect(call).toBeDefined();
    // **パスを取り違えると別フォルダが丸ごと再解析される。** 引数まで見る
    expect(String(call!.args.folderPath)).toContain('2024_Travel');
  });

  test('フォルダの登録解除は確認なしで即座に一覧から消える', async ({ page }) => {
    // **これは現状の記録であって「望ましい」ではない。**
    // 同じモーダルの「全メディア再解析」は確認を挟むのに、登録解除は挟まない。
    // 揃える判断をしたときに、この期待値を書き換えること
    await openManager(page);
    await expect(page.getByText('登録フォルダ (2)')).toBeVisible();

    await folderRow(page, '2024_Travel').getByTitle('フォルダを削除').click();

    await expect(page.getByText('登録フォルダ (1)')).toBeVisible();
    await expect(folderRow(page, '2024_Travel')).toHaveCount(0);
  });

  test('登録が0件になると、空の案内と無効なボタンになる', async ({ page }) => {
    await openManager(page);
    await folderRow(page, '2024_Travel').getByTitle('フォルダを削除').click();
    await folderRow(page, 'Screenshots').getByTitle('フォルダを削除').click();

    await expect(page.getByText('登録されているフォルダはありません。')).toBeVisible();
    // 対象が無いのに押せると、押しても何も起きないボタンになる
    await expect(page.getByRole('button', { name: '全フォルダ再スキャン' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '全メディア再解析' })).toBeDisabled();
  });
});
