import { test, expect, Page } from '@playwright/test';

// 排他処理の実行中に、押しても必ず失敗する操作を押させないための検証。
//
// Rust 側は `try_acquire_task_lock` を取るコマンドが19個あり、1つ走っている間
// 残りは必ずエラーを返す。UI がそれを知らないと「押せるが必ず失敗するボタン」が残る。
// 対応表は src/constants/exclusiveCommands.ts（`npm run check:exclusive` が Rust と突き合わせる）。
//
// `?debugSlowCommand=<cmd>:<ms>` と `?debugScan=` はどちらもモック限定の検証用フック。
// **応答が即座に返るモックのままでは、実行中の表示は一瞬も出ない。**

const settingsHeading = (page: Page) => page.getByRole('heading', { name: '設定', exact: true });

/** 1件目のギャラリーカード */
const card = (page: Page) => page.locator('div.group').filter({ hasText: 'mock_media_1.jpg' }).first();

/** 詳細モーダルのタグチップに付く削除ボタン */
const removeTagButton = (page: Page) =>
  page.getByText('UI (ui)', { exact: true }).locator('xpath=following-sibling::button');

test.describe('排他処理中のブロック', () => {
  test('設定の保存中は実行中の表示が出て、背後が不活性になる', async ({ page }) => {
    await page.goto('/?debugOpen=settings&debugSlowCommand=save_settings:800');
    await expect(settingsHeading(page)).toBeVisible();

    await page.getByRole('button', { name: '設定を保存' }).click();

    // 何が走っているかを名前で出す。「処理中」だけでは何を待てばいいのか分からない
    await expect(page.getByText('設定を保存しています')).toBeVisible();
    // 背後は inert。ポインタだけ塞いでもキーボードは通ってしまう
    await expect(page.locator('div[inert]')).toHaveCount(1);

    // 終われば消える
    await expect(page.getByText('設定を保存しています')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator('div[inert]')).toHaveCount(0);
  });

  test('解析の実行中はタグの削除が押せず、理由が出る', async ({ page }) => {
    await page.goto('/?debugScan=mid&debugScanIntervalMs=600');
    await expect(page.getByText('解析処理中')).toBeVisible();

    await card(page).click();
    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();

    await expect(removeTagButton(page)).toBeDisabled();
    // **無反応にしない。** disabled だけだと壊れているようにしか見えない
    await expect(removeTagButton(page)).toHaveAttribute('title', /解析の実行中/);
  });

  test('何も走っていなければタグの削除は押せる', async ({ page }) => {
    // 上のテストが「常に押せない」で通ってしまわないようにする
    await page.goto('/');
    await card(page).click();
    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();

    await expect(removeTagButton(page)).toBeEnabled();
  });
});

test.describe('押せない理由を出す', () => {
  // **`disabled` にするだけで終わらせない。** 理由を出さないと、ユーザーには
  // 「ボタンが壊れた」ようにしか見えない。`npm run check:exclusive` が
  // disabled と理由の対応を静的にも見ている。

  test('解析中のフォルダ管理は、押せないボタンに理由が出る', async ({ page }) => {
    await page.goto('/?debugScan=mid&debugScanIntervalMs=600');
    await expect(page.getByText('解析処理中')).toBeVisible();
    await page.getByRole('button', { name: 'フォルダ管理' }).click();

    const modal = page.locator('div.glass-panel').filter({ hasText: '登録フォルダ管理' });
    const button = modal.getByRole('button', { name: '全メディア再解析' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /解析の実行中/);
  });

  test('解析中のタグ管理も、押せないボタンに理由が出る', async ({ page }) => {
    await page.goto('/?debugScan=mid&debugScanIntervalMs=600');
    await expect(page.getByText('解析処理中')).toBeVisible();
    await page.getByRole('button', { name: 'タグ管理' }).click();

    const modal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'タグ管理・グループ統合' });
    await modal.getByRole('button', { name: /AI提案/ }).click();
    const button = modal.getByRole('button', { name: '類似タグを検出' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /解析の実行中/);
  });
});
