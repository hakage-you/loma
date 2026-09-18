import { test, expect, Page } from '@playwright/test';

// Esc キーで閉じる操作の検証。
//
// **決めたこと3つ:**
//   1. Esc でモーダルを閉じる
//   2. 入力途中の内容があるときは、閉じてよいか確認する
//   3. モーダルの中に確認パネルが開いているときは、**そのパネルだけ**閉じる
//      （モーダルごと閉じると、取り消したいだけの Esc で画面まで消える）
//
// 確認は OS のダイアログなのでブラウザでは開けない。モックは既定で承諾を返し、
// `window.__mockDialogAnswer = false` を置くと拒否を返す。

const setDialogAnswer = (page: Page, answer: boolean) =>
  page.addInitScript((value) => {
    (window as unknown as { __mockDialogAnswer: boolean }).__mockDialogAnswer = value as boolean;
  }, answer);

test.describe('Esc で閉じる', () => {
  test('入力欄の無いモーダルはそのまま閉じる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'フォルダ管理' }).click();
    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toHaveCount(0);
  });

  test('確認パネルが開いているときは、パネルだけ閉じる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'フォルダ管理' }).click();
    const modal = page.locator('div.glass-panel').filter({ hasText: '登録フォルダ管理' });
    await modal.locator('div.group').first().getByTitle('フォルダを削除').click();
    await expect(modal.getByText('登録を解除します。')).toBeVisible();

    await page.keyboard.press('Escape');

    // パネルは閉じ、モーダルは残る
    await expect(modal.getByText('登録を解除します。')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toBeVisible();

    // もう一度押せばモーダルが閉じる
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '登録フォルダ管理' })).toHaveCount(0);
  });

  test('入力途中があるときは確認する。取り消せば閉じない', async ({ page }) => {
    await setDialogAnswer(page, false);
    await page.goto('/');
    await page.locator('div.group').filter({ hasText: 'mock_media_1.jpg' }).first().click();
    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();

    await page.getByPlaceholder('英語タグ (a-Z, _)').fill('kakikake');
    await page.keyboard.press('Escape');

    // 確認で「いいえ」を選んだので閉じない
    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();
    await expect(page.getByPlaceholder('英語タグ (a-Z, _)')).toHaveValue('kakikake');
  });

  test('入力途中でも、確認で承諾すれば閉じる', async ({ page }) => {
    await setDialogAnswer(page, true);
    await page.goto('/');
    await page.locator('div.group').filter({ hasText: 'mock_media_1.jpg' }).first().click();
    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();

    await page.getByPlaceholder('英語タグ (a-Z, _)').fill('kakikake');
    await page.keyboard.press('Escape');

    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toHaveCount(0);
  });

  test('入力途中が無ければ確認せずに閉じる', async ({ page }) => {
    // **常に確認する実装でも通ってしまわないようにする。**
    // 拒否を返す設定にしたうえで、確認が呼ばれないことを「閉じた」ことで確かめる
    await setDialogAnswer(page, false);
    await page.goto('/');
    await page.locator('div.group').filter({ hasText: 'mock_media_1.jpg' }).first().click();
    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toHaveCount(0);
  });

  test('重なっているときは手前の層だけ閉じる', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'タグ管理' }).click();
    const modal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'タグ管理・グループ統合' });
    await modal.getByPlaceholder('タグ名で検索...').fill('person');
    await modal.locator('div.rounded-xl.border').filter({ hasText: '#person' }).first()
      .getByTitle('このタグが付いたメディアを見る').click();

    const preview = page.locator('div.fixed.inset-0.z-60');
    await expect(preview).toBeVisible();

    await page.keyboard.press('Escape');

    // 手前のプレビューだけ閉じ、タグ管理は残る
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'タグ管理・グループ統合' })).toBeVisible();
  });
});
