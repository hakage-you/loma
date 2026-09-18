import { test, expect, Page } from '@playwright/test';

// 失敗の伝え方の検証。
//
// **押した操作が失敗したら必ず画面に出す。** 以前は console.error だけで
// 握り潰しているものが混ざっていて、押しても何も起きないように見えた
// （一時停止・再開・中止・フォルダの登録解除・ログのクリア・VRAM の解放）。
// 文言が英語のままのものもあった。
//
// 背景の取得（タグ一覧・モデル一覧・ログの読み出し）は**出さない**。
// 解析中は1秒ごとに走るので、出すとモーダルが並ぶ。
//
// `?debugFailCommand=<コマンド名>` はモック限定の検証用フック。

const errorModal = (page: Page) =>
  page.locator('div.glass-panel').filter({ hasText: 'お知らせ / エラー' });

test.describe('失敗を画面に出す', () => {
  test('フォルダの登録解除に失敗したら、何に失敗したかを日本語で出す', async ({ page }) => {
    await page.goto('/?debugFailCommand=remove_scan_folder');
    await page.getByRole('button', { name: 'フォルダ管理' }).click();
    const modal = page.locator('div.glass-panel').filter({ hasText: '登録フォルダ管理' });
    await modal.locator('div.group').first().getByTitle('フォルダを削除').click();
    await modal.getByRole('button', { name: '登録を解除' }).click();

    await expect(errorModal(page)).toBeVisible();
    await expect(errorModal(page).getByText('フォルダの登録解除に失敗しました。')).toBeVisible();
    // **生のエラーも残す。** 見出しだけだと原因を調べる手がかりが無い
    await expect(errorModal(page).getByText('debugFailCommand', { exact: false })).toBeVisible();
  });

  test('解析の一時停止に失敗したら、押しても無反応にはしない', async ({ page }) => {
    await page.goto('/?debugScan=mid&debugScanIntervalMs=600&debugFailCommand=pause_scan');
    await expect(page.getByText('解析処理中')).toBeVisible();

    await page.getByRole('button', { name: '一時停止' }).click();

    await expect(errorModal(page).getByText('解析の一時停止に失敗しました。')).toBeVisible();
  });

  test('フォルダを開けなかったら、その旨を出す', async ({ page }) => {
    await page.goto('/?debugFailCommand=open_folder');
    await page.getByRole('button', { name: /解析失敗 \(\d+\)/ }).click();
    const triage = page.locator('div.glass-panel').filter({ hasText: '解析できなかったファイル' });
    await triage.locator('div.border.border-white\\/5').first().getByRole('button').first().click();
    await triage.getByTitle('フォルダを開く').first().click();

    await expect(errorModal(page).getByText('フォルダを開けませんでした。')).toBeVisible();
  });

  test('ログのクリアに失敗したら、消えたように見せない', async ({ page }) => {
    await page.goto('/?debugFailCommand=clear_app_logs');
    const console_ = page.locator('div.z-40').filter({ hasText: '処理ログ' });
    await console_.getByText('処理ログ').click();
    await console_.getByTitle('クリア').click();

    await expect(errorModal(page).getByText('ログのクリアに失敗しました。')).toBeVisible();
  });

  test('背景の取得が失敗しても、モーダルは出さない', async ({ page }) => {
    // **ここを出すようにすると、解析中に1秒ごとにモーダルが並ぶ。**
    // 取れなかったことは、サイドバーが空になることで分かる
    await page.goto('/?debugFailCommand=get_all_tags');
    await expect(page.locator('div.grid.gap-4 > div.group').first()).toBeVisible();
    await page.waitForTimeout(1000);

    await expect(errorModal(page)).toHaveCount(0);
  });
});
