import { test, expect, Page } from '@playwright/test';

// 読み込み中の表示が出ても、一覧が動かないことの検証。
//
// **解析中は1秒ごとに取り直すので、出入りのたびに跳ねると跳ね続ける。**
// 以前は帯が `sticky` で流れの中に高さを持っており、出た瞬間に一覧全体が
// その高さぶん下へずれていた（2026-09-29 に報告）。
//
// 取り直しがデバウンスで一度も走らなかった頃は表に出なかった。
// 取り直しを動くようにしたことで見えるようになった問題。

const cards = 'div.grid.gap-4 > div.group';
const loadingPill = (page: Page) => page.getByText('読み込み中', { exact: true });

/** 1枚目のカードの上端。ここが動いたら一覧が跳ねている */
async function firstCardTop(page: Page): Promise<number> {
  const box = await page.locator(cards).first().boundingBox();
  if (!box) throw new Error('カードが見つからない');
  return Math.round(box.y);
}

test.describe('一覧が跳ねないこと', () => {
  test('読み込み中の表示が出ても、カードの位置が変わらない', async ({ page }) => {
    // get_media を遅くして、読み込み中の表示が出ている状態を掴む
    await page.goto('/?debugSlowCommand=get_media:900');
    await expect(page.locator(cards).first()).toBeVisible();
    await expect(loadingPill(page)).toBeHidden();

    const before = await firstCardTop(page);

    // 同期で進捗が流れ、取り直しが走る（解析中と同じ経路）
    await page.getByRole('button', { name: '同期', exact: true }).click();
    await expect(loadingPill(page)).toBeVisible();

    const during = await firstCardTop(page);
    expect(during).toBe(before);

    await expect(loadingPill(page)).toBeHidden({ timeout: 15_000 });
    expect(await firstCardTop(page)).toBe(before);
  });

  test('読み込み中の帯が縦に潰れていない', async ({ page }) => {
    await page.goto('/?debugSlowCommand=get_media:900');
    await expect(page.locator(cards).first()).toBeVisible();
    await page.getByRole('button', { name: '同期', exact: true }).click();
    await expect(loadingPill(page)).toBeVisible();

    // **枠は高さ0だが、中身まで潰してはいけない。**
    // 高さ0の flex は既定で子を stretch するので、items-start が無いと
    // 文字が padding に挟まれて潰れる（実測で 35px が 18px になっていた）
    const box = await loadingPill(page).boundingBox();
    if (!box) throw new Error('帯が見つからない');
    expect(box.height).toBeGreaterThan(28);
  });

  test('読み込み中でも一覧は消えない', async ({ page }) => {
    await page.goto('/?debugSlowCommand=get_media:900');
    await expect(page.locator(cards).first()).toBeVisible();
    const count = await page.locator(cards).count();

    await page.getByRole('button', { name: '同期', exact: true }).click();
    await expect(loadingPill(page)).toBeVisible();

    // **消すと画面が跳ねる。** 薄くするだけで、枚数は保つ
    await expect(page.locator(cards)).toHaveCount(count);
  });
});
