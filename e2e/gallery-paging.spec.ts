import { test, expect, Page } from '@playwright/test';

// ギャラリーの段階描画の検証。
//
// 以前は `items.map` に上限が無く、メディア 4,949件で `dom_nodes` が 125,925 だった。
// 起動直後から常時この状態で、絞り込み直しやタグ編集のたびに全件を照合し直していた。
//
// `?debugMediaCount=<件数>` はモック限定の検証用フック。
// **既定の23件では「多いときだけ効く」挙動を一度も通らない。**

/** ギャラリーのカード。`group` は他の要素にも付くのでグリッドの直下に限定する */
const cards = (page: Page) => page.locator('div.grid.gap-4 > div.group');

/** ギャラリーのスクロール領域 */
const scroller = (page: Page) =>
  page.locator('div.overflow-y-auto').filter({ has: page.locator('div.grid.gap-4') });

test.describe('ギャラリーの段階描画', () => {
  test('件数が多くても最初は一部しか出さない', async ({ page }) => {
    await page.goto('/?debugMediaCount=500');
    await expect(cards(page).first()).toBeVisible();

    const shown = await cards(page).count();
    expect(shown).toBeLessThan(500);
    // 番兵が見えている間は足し続けるので、画面が埋まる程度には出ている
    expect(shown).toBeGreaterThanOrEqual(60);
  });

  test('下までスクロールすると足される', async ({ page }) => {
    await page.goto('/?debugMediaCount=500');
    await expect(cards(page).first()).toBeVisible();
    const before = await cards(page).count();

    await scroller(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(() => cards(page).count()).toBeGreaterThan(before);
  });

  test('件数が少なければ全部出る', async ({ page }) => {
    // 上限が常に効いてしまう実装で通らないようにする
    await page.goto('/');
    await expect(cards(page).first()).toBeVisible();
    // モックの既定は 28件（解析済み23 + 未解析/失敗5）。GALLERY_FIRST の 60 未満なので全部出る
    await expect(cards(page)).toHaveCount(28);
  });

  test('絞り込みを変えると先頭から出し直す', async ({ page }) => {
    await page.goto('/?debugMediaCount=500');
    await expect(cards(page).first()).toBeVisible();

    await scroller(page).evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect.poll(() => cards(page).count()).toBeGreaterThan(60);

    // サイドバーのカテゴリで絞る（この節は既定で開いている）。
    // 水増ししたメディアは全部 screenshot なので、絞ったあとも件数は多いまま
    await page.getByRole('button', { name: /スクリーンショット/ }).click();

    // 先頭から出し直す。スクロール位置も戻る
    await expect.poll(() => cards(page).count()).toBeLessThanOrEqual(120);
    await expect.poll(() => scroller(page).evaluate((el) => el.scrollTop)).toBeLessThan(1000);
  });
});
