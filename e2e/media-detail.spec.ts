import { test, expect, Page } from '@playwright/test';

// メディア詳細モーダルのタグ編集が、押したその場で画面に反映されるかを見る。
//
// ここが壊れていた（2026-07-30 報告）。削除自体は DB に届いていたのに、
// App が詳細モーダルへ「クリックした時点のオブジェクト」を渡し続けていたため、
// 再取得した新しいタグ配列が詳細画面に出てこなかった。
// **モックが実 IPC と同じく毎回コピーを返すようになって初めて再現する**ので、
// このテストは src/mocks/core.ts の structuredClone とセットで意味を持つ。

/** 1件目のギャラリーカード。サムネイル画像は mock でも読めないことがあるのでファイル名で引く */
const card = (page: Page) => page.locator('div.group').filter({ hasText: 'mock_media_1.jpg' }).first();

/** 1件目のカードから詳細モーダルを開く */
async function openDetail(page: Page) {
  await page.goto('/');
  await card(page).click();
  // モーダルの見出しはファイル名
  await expect(page.getByRole('heading', { name: 'mock_media_1.jpg' })).toBeVisible();
}

/** 詳細モーダルのタグチップ。ギャラリー側は日本語名だけなので、この表記はここにしか出ない */
const chip = (page: Page, label: string) => page.getByText(label, { exact: true });

test.describe('メディア詳細のタグ編集', () => {
  test('タグを削除すると詳細画面から即座に消える', async ({ page }) => {
    await openDetail(page);

    const target = chip(page, 'UI (ui)');
    await expect(target).toBeVisible();

    await target.locator('xpath=following-sibling::button').click();

    // 閉じて開き直さなくても消えていること
    await expect(target).toHaveCount(0);
    // 消えたのは押したタグだけ（tagId をタグ表の id として引けているか）
    await expect(chip(page, 'アプリ (app)')).toBeVisible();
    await expect(chip(page, 'ウィンドウ (window)')).toBeVisible();
  });

  test('削除は背後のギャラリーカードにも反映される', async ({ page }) => {
    await openDetail(page);
    await expect(card(page).getByText('UI', { exact: true })).toHaveCount(1);

    await chip(page, 'UI (ui)').locator('xpath=following-sibling::button').click();

    await expect(card(page).getByText('UI', { exact: true })).toHaveCount(0);
    await expect(card(page).getByText('アプリ', { exact: true })).toHaveCount(1);
  });

  test('タグを追加すると詳細画面に即座に出る', async ({ page }) => {
    await openDetail(page);

    await page.getByPlaceholder('英語タグ (a-Z, _)').fill('regression');
    await page.getByPlaceholder('日本語訳 (例: 山脈)').fill('回帰');
    await page.getByRole('button', { name: '追加', exact: true }).click();

    await expect(chip(page, '回帰 (regression)')).toBeVisible();
  });
});
