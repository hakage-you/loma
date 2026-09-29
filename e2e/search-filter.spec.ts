import { test, expect, Page } from '@playwright/test';

// 絞り込みの検証（サイドバー / 検索バー / 詳細検索）。
//
// **絞り込みは2箇所で効く。** バックエンドへ送る条件（categoryFilter など）と、
// フロント側で結果を削る疑似ステータス（未解析・タグ不足・解析対象外）。
// どちらで効いているかを取り違えると、「送っているのに絞られない」
// 「送っていないのに絞られる」が両方起きる。ここでは
// `window.__mockInvokeLog` で送った引数を、カードの数で結果を見る。

type InvokeEntry = { cmd: string; args: Record<string, any>; at: number };

/** 直近の get_media の引数 */
const lastGetMedia = async (page: Page): Promise<Record<string, any>> => {
  const log = await page.evaluate(
    () => (window as unknown as { __mockInvokeLog: InvokeEntry[] }).__mockInvokeLog
  );
  const calls = log.filter((e) => e.cmd === 'get_media');
  return calls[calls.length - 1]?.args ?? {};
};

const cards = (page: Page) => page.locator('div.grid.gap-4 > div.group');
const sidebar = (page: Page) => page.locator('aside');

test.describe('サイドバーの絞り込み', () => {
  test('カテゴリを選ぶと categoryFilter が送られ、結果が絞られる', async ({ page }) => {
    await page.goto('/');
    await expect(cards(page)).toHaveCount(28);

    await sidebar(page).getByRole('button', { name: /風景・自然/ }).click();

    await expect(cards(page)).toHaveCount(3);
    expect((await lastGetMedia(page)).categoryFilter).toEqual(['landscape']);
  });

  test('カテゴリの複数選択は OR で足し合わせる', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: /風景・自然/ }).click();
    await expect(cards(page)).toHaveCount(3);

    await sidebar(page).getByRole('button', { name: /料理・食べ物/ }).click();

    // **AND にすると 0件になる。** 1枚のメディアは1カテゴリしか持たない
    await expect(cards(page)).toHaveCount(6);
    expect((await lastGetMedia(page)).categoryFilter).toEqual(['landscape', 'food']);
  });

  test('未解析は実ステータス pending として送る', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: '解析ステータス' }).click();
    await sidebar(page).getByRole('button', { name: '未解析' }).click();

    // モックの pending は2件
    await expect(cards(page)).toHaveCount(2);
    expect((await lastGetMedia(page)).statusFilter).toBe('pending');
  });

  test('疑似ステータスはバックエンドへ送らない', async ({ page }) => {
    // タグ不足も解析対象外も `analysis_status` に存在しない値。
    // **送るとバックエンドが 0件を返す**ので、絞るのは取得したあとのフロント側。
    // モックはどちらも該当0件なので、ここで見るのは「何を送ったか」
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: '解析ステータス' }).click();

    await sidebar(page).getByRole('button', { name: /タグ不足/ }).click();
    expect((await lastGetMedia(page)).statusFilter).toBeNull();
    await expect(page.getByText('該当するメディアがありません')).toBeVisible();

    await sidebar(page).getByRole('button', { name: '解析対象外' }).click();
    expect((await lastGetMedia(page)).statusFilter).toBeNull();
  });

  test('仕分けで解析対象外にしたものが、その絞り込みで辿れる', async ({ page }) => {
    // **除外したことを忘れて「解析されない」と読まれないための導線。**
    // 画面をまたぐので、仕分け側が壊れてもここで落ちる
    await page.goto('/');
    await page.getByRole('button', { name: /解析失敗 \(\d+\)/ }).click();
    await page
      .locator('div.glass-panel')
      .filter({ hasText: '解析できなかったファイル' })
      .getByTitle('このグループを今後解析しない')
      .first()
      .click();
    await page.getByTitle('閉じる').first().click();

    await sidebar(page).getByRole('button', { name: '解析ステータス' }).click();
    await sidebar(page).getByRole('button', { name: '解析対象外' }).click();

    await expect(cards(page)).toHaveCount(2);
  });

  test('解析失敗は実ステータス。statusFilter として送る', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: '解析ステータス' }).click();
    await sidebar(page).getByRole('button', { name: '解析失敗' }).click();

    await expect(cards(page)).toHaveCount(3);
    expect((await lastGetMedia(page)).statusFilter).toBe('failed');
  });

  test('メディア種別と拡張子はそれぞれの引数で送る', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: 'メディア種別' }).click();
    await sidebar(page).getByRole('button', { name: '画像', exact: true }).click();
    expect((await lastGetMedia(page)).mediaTypeFilter).toBe('image');

    await sidebar(page).getByRole('button', { name: 'ファイル拡張子' }).click();
    // ボタンの表示は `.jpg`、送る値は `jpg`
    await sidebar(page).getByRole('button', { name: '.jpg', exact: true }).click();
    expect((await lastGetMedia(page)).extensionFilter).toEqual(['jpg']);
  });

  test('すべてリセットは、掛けた条件を全部落とす', async ({ page }) => {
    await page.goto('/');
    await sidebar(page).getByRole('button', { name: /風景・自然/ }).click();
    await sidebar(page).getByRole('button', { name: 'メディア種別' }).click();
    await sidebar(page).getByRole('button', { name: '画像', exact: true }).click();
    await expect(cards(page)).toHaveCount(3);

    await sidebar(page).getByRole('button', { name: 'すべてリセット' }).click();

    await expect(cards(page)).toHaveCount(28);
    const args = await lastGetMedia(page);
    expect(args.categoryFilter).toBeNull();
    expect(args.mediaTypeFilter).toBeNull();
    // 条件が無くなればリセットのボタン自体も消える
    await expect(sidebar(page).getByRole('button', { name: 'すべてリセット' })).toHaveCount(0);
  });
});

test.describe('検索バーのタグ絞り込み', () => {
  const searchInput = (page: Page) =>
    page.getByPlaceholder('タグ（英語・日本語）で検索 (例: #cat, #風景)...');

  test('入力すると候補が出て、選ぶとチップになる', async ({ page }) => {
    await page.goto('/');
    await searchInput(page).fill('moun');

    await expect(page.getByText('一致するタグ', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /山 \(mountain\)/ }).click();

    await expect(page.getByText('#山', { exact: true })).toBeVisible();
    await expect(cards(page)).toHaveCount(3);
    // **日本語名で送る。** バックエンドは name と name_ja の両方で照合する
    expect((await lastGetMedia(page)).tagFilter).toEqual(['山']);
  });

  test('チップの × で条件が外れる', async ({ page }) => {
    await page.goto('/');
    await searchInput(page).fill('moun');
    await page.getByRole('button', { name: /山 \(mountain\)/ }).click();
    await expect(cards(page)).toHaveCount(3);

    await page.getByText('#山', { exact: true }).locator('button').click();

    await expect(cards(page)).toHaveCount(28);
    expect((await lastGetMedia(page)).tagFilter).toBeNull();
  });

  test('一致する候補が無いときは、次にできることを出す', async ({ page }) => {
    await page.goto('/');
    await searchInput(page).fill('zzzzz');

    // 見出しの「一致するタグ」と、空表示の「一致するタグがありません。」を取り違えない
    await expect(page.getByText('一致するタグ', { exact: true })).toBeVisible();
    await expect(page.getByText('一致するタグがありません', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: /詳細検索/ })).toBeVisible();
  });
});

test.describe('詳細検索', () => {
  const modal = (page: Page) =>
    page.locator('div.fixed.inset-0').filter({ hasText: '詳細検索' }).last();

  test('AND で組んだ条件が、要約つきで検索バーに出る', async ({ page }) => {
    await page.goto('/?debugOpen=search');
    await expect(modal(page)).toBeVisible();

    await modal(page).getByPlaceholder(/タグ/).first().fill('nature');
    await modal(page).getByPlaceholder(/タグ/).first().press('Enter');
    await modal(page).getByRole('button', { name: /検索|適用/ }).last().click();

    // **何で絞っているかを画面に残す。** 詳細検索は条件が見えないと解除もできない
    await expect(page.getByText('詳細検索条件', { exact: false })).toBeVisible();
    expect((await lastGetMedia(page)).tagFilterTree).toContain('nature');
  });

  test('解除すると条件が落ち、通常のタグ検索に戻る', async ({ page }) => {
    await page.goto('/?debugOpen=search');
    await modal(page).getByPlaceholder(/タグ/).first().fill('nature');
    await modal(page).getByPlaceholder(/タグ/).first().press('Enter');
    await modal(page).getByRole('button', { name: /検索|適用/ }).last().click();
    await expect(page.getByText('詳細検索条件', { exact: false })).toBeVisible();

    await page.getByTitle('解除').click();

    await expect(page.getByText('詳細検索条件', { exact: false })).toHaveCount(0);
    await expect(cards(page)).toHaveCount(28);
    expect((await lastGetMedia(page)).tagFilterTree).toBeNull();
  });
});
