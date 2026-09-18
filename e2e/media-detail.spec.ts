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

test.describe('メディア詳細のその他の操作', () => {
  type SideEffect = { command: string; args: Record<string, unknown> };
  const sideEffects = (page: Page): Promise<SideEffect[]> =>
    page.evaluate(
      () => (window as unknown as { __mockSideEffects: SideEffect[] }).__mockSideEffects
    );

  test('画像の単体再解析がバックエンドまで届く', async ({ page }) => {
    // **一度この経路が必ず失敗していた**（2026-09 に修正）。
    // 押せるかではなく、どのメディアIDで呼ばれたかまで見る
    await openDetail(page);
    await page.getByRole('button', { name: 'この画像を再解析' }).click();

    const call = (await sideEffects(page)).find((e) => e.command === 'reanalyze_single_media');
    expect(call).toBeDefined();
    expect(call!.args.mediaId).toBe(1);
  });

  test('ファイルとフォルダを開く操作は、そのメディアのパスを送る', async ({ page }) => {
    await openDetail(page);
    await page.getByRole('button', { name: 'ファイルを開く' }).click();
    await page.getByRole('button', { name: 'フォルダを開く' }).click();

    const calls = await sideEffects(page);
    const file = calls.find((e) => e.command === 'open_file');
    const folder = calls.find((e) => e.command === 'open_folder');
    expect(String(file?.args.filePath)).toContain('mock_media_1.jpg');
    expect(String(folder?.args.filePath)).toContain('mock_media_1.jpg');
  });

  test('解析に失敗したメディアでは再試行が出る', async ({ page }) => {
    await page.goto('/');
    // モックの失敗メディアは mock_media_26.jpg（server_unavailable / 一時的な失敗）
    await page.locator('div.group').filter({ hasText: 'mock_media_26.jpg' }).first().click();
    await expect(page.getByRole('heading', { name: 'mock_media_26.jpg' })).toBeVisible();

    await expect(page.getByRole('button', { name: '解析を再試行' })).toBeVisible();
  });

  test('解析済みのメディアには再試行を出さない', async ({ page }) => {
    await openDetail(page);
    await expect(page.getByRole('button', { name: '解析を再試行' })).toHaveCount(0);
  });
});
