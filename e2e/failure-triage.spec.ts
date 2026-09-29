import { test, expect, Page } from '@playwright/test';

// 解析できなかったファイルの仕分けの検証。
//
// この画面は「再試行しても直らないもの」と「時間をおけば通るもの」を分けて出す。
// **分け方を間違えると、直らないものを延々と再試行し続けてリストから消えない。**
// モックの失敗データは3件:
//   - 要確認 2件（not_decodable / 画像として読めない）
//   - 一時的な失敗 1件（server_unavailable / サーバーが応答しない）

type SideEffect = { command: string; args: Record<string, unknown> };

const sideEffects = (page: Page): Promise<SideEffect[]> =>
  page.evaluate(() => (window as unknown as { __mockSideEffects: SideEffect[] }).__mockSideEffects);

const modal = (page: Page) =>
  page.locator('div.glass-panel').filter({ hasText: '解析できなかったファイル' });

const openTriage = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: /解析失敗 \(\d+\)/ }).click();
  await expect(page.getByRole('heading', { name: '解析できなかったファイル' })).toBeVisible();
};

/** 種別の見出しで引いたグループ枠 */
const group = (page: Page, heading: string) =>
  modal(page).locator('div.border.border-white\\/5').filter({ hasText: heading }).first();

test.describe('解析できなかったファイルの仕分け', () => {
  test('種別ごとに束ね、要確認を先頭に出す', async ({ page }) => {
    await openTriage(page);

    await expect(modal(page).getByText('画像として読めない')).toBeVisible();
    await expect(modal(page).getByText('サーバーが応答しない')).toBeVisible();

    // **要確認が先。** 直らないものが下に埋もれると、まとめて再試行を繰り返すことになる
    const headings = await modal(page).locator('span.text-xs.font-semibold').allInnerTexts();
    expect(headings[0]).toBe('画像として読めない');
  });

  test('タブに件数が出て、解析対象外は最初0件', async ({ page }) => {
    await openTriage(page);

    await expect(modal(page).getByRole('button', { name: '解析失敗 (3)' })).toBeVisible();
    await expect(modal(page).getByRole('button', { name: '解析対象外 (0)' })).toBeVisible();
  });

  test('グループを開くと、なぜ直らないのかの説明とファイル名が出る', async ({ page }) => {
    await openTriage(page);
    await group(page, '画像として読めない').getByRole('button').first().click();

    await expect(
      modal(page).getByText('再試行しても同じ結果になる見込みのファイルです', { exact: false })
    ).toBeVisible();
    await expect(modal(page).getByText('mock_broken_', { exact: false }).first()).toBeVisible();
  });

  test('一時的な失敗は再試行で消える', async ({ page }) => {
    await openTriage(page);
    await group(page, 'サーバーが応答しない')
      .getByTitle('このグループを再試行')
      .click();

    await expect(modal(page).getByRole('button', { name: '解析失敗 (2)' })).toBeVisible();
    await expect(modal(page).getByText('サーバーが応答しない')).toHaveCount(0);
  });

  test('要確認は再試行しても消えない', async ({ page }) => {
    // **ここが消えてしまうと、実物で「押すたびに失敗して戻ってくる」挙動を見落とす。**
    // 再試行できること自体は残す（別のモデルに変えれば通る可能性はある）
    await openTriage(page);
    await group(page, '画像として読めない').getByTitle('このグループを再試行').click();

    await expect(modal(page).getByRole('button', { name: '解析失敗 (3)' })).toBeVisible();
    await expect(modal(page).getByText('画像として読めない')).toBeVisible();
  });

  test('今後解析しないに移すと、解析対象外タブに現れる', async ({ page }) => {
    await openTriage(page);
    await group(page, '画像として読めない')
      .getByTitle('このグループを今後解析しない')
      .click();

    await expect(modal(page).getByRole('button', { name: '解析対象外 (2)' })).toBeVisible();
    await modal(page).getByRole('button', { name: '解析対象外 (2)' }).click();
    await expect(modal(page).getByText('mock_broken_', { exact: false }).first()).toBeVisible();
  });

  test('解析対象外は解除で戻せる', async ({ page }) => {
    await openTriage(page);
    await group(page, 'サーバーが応答しない')
      .getByTitle('このグループを今後解析しない')
      .click();
    await modal(page).getByRole('button', { name: '解析対象外 (1)' }).click();

    await modal(page).getByRole('button', { name: '解除' }).click();
    await expect(modal(page).getByRole('button', { name: '解析対象外 (0)' })).toBeVisible();
  });

  test('ライブラリから削除は確認を挟む。閉じれば消えない', async ({ page }) => {
    await openTriage(page);
    await group(page, 'サーバーが応答しない')
      .getByTitle('このグループをライブラリから削除')
      .click();

    await expect(
      modal(page).getByText('1件をライブラリから削除します', { exact: false })
    ).toBeVisible();
    // **確認の取り消しは「キャンセル」。** モーダルを閉じる×は「閉じる」で、
    // 同じ文字にすると「モーダルごと閉じる」のか「削除をやめる」のか読めない
    await modal(page).getByRole('button', { name: 'キャンセル' }).click();

    await expect(modal(page).getByRole('button', { name: '解析失敗 (3)' })).toBeVisible();
  });

  test('削除を承認するとライブラリから消え、解析対象外にも登録される', async ({ page }) => {
    await openTriage(page);
    await group(page, 'サーバーが応答しない')
      .getByTitle('このグループをライブラリから削除')
      .click();
    await modal(page).getByRole('button', { name: 'ライブラリから削除' }).last().click();

    await expect(modal(page).getByRole('button', { name: '解析失敗 (2)' })).toBeVisible();
    // **ファイルは消していない。** 次のスキャンで再登録されないよう除外にも入る
    await expect(modal(page).getByRole('button', { name: '解析対象外 (1)' })).toBeVisible();
  });

  test('フォルダを開くはパスを引数に送る', async ({ page }) => {
    await openTriage(page);
    await group(page, 'サーバーが応答しない').getByRole('button').first().click();
    await modal(page).getByTitle('フォルダを開く').first().click();

    const call = (await sideEffects(page)).find((e) => e.command === 'open_folder');
    expect(call).toBeDefined();
    expect(String(call!.args.filePath)).toContain('mock_media_');
  });
});
