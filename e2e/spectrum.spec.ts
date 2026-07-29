import { test, expect, Page } from '@playwright/test';

// 概念スペクトラム検索（似ているメディアの検索）のUI検証。
//
// ゾーンの識別は**見出しテキストと位置**が担う設計なので、テストも見出しで引く。
// 色に依存した検証は書かない（色に意味を載せない、という設計判断そのものを守るため）。

const modal = (page: Page) => page.getByRole('heading', { name: '似ているメディア' });

/** ギャラリーの1枚目のカードから探索モーダルを開く */
async function openSpectrum(page: Page) {
  await page.goto('/');
  const trigger = page.locator('button[title="似ているメディアを探す"]').first();
  // トリガーはホバーオーバーレイ内にあるため、まず親カードにホバーする
  await trigger.locator('xpath=ancestor::*[contains(@class,"group")][1]').hover();
  await trigger.click();
  await expect(modal(page)).toBeVisible();
}

test.describe('概念スペクトラム検索', () => {
  test('3つのゾーンが見出しで区別できる', async ({ page }) => {
    await openSpectrum(page);

    await expect(page.getByRole('heading', { name: 'タグの類似度が高い' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '類似度が中くらい' })).toBeVisible();
    // 「まったく違う」「真逆」とは書かない。最低コサイン類似度は意味的な反対ではなく
    // 単なる無関係なので、ラベルが実態以上を約束しないこと
    await expect(page.getByRole('heading', { name: 'タグの類似度が最も低い' })).toBeVisible();
  });

  test('レンジ凡例が実測値を数値で開示する', async ({ page }) => {
    await openSpectrum(page);
    // 生のコサイン類似度をそのまま出す。読み方が分かるよう min/mean/max を併記する
    await expect(page.getByText(/^min -?\d\.\d{3}$/)).toBeVisible();
    await expect(page.getByText(/^mean -?\d\.\d{3}$/)).toBeVisible();
    await expect(page.getByText(/^max -?\d\.\d{3}$/)).toBeVisible();
  });

  test('引き直しが無意味なときはボタンを出さない', async ({ page }) => {
    await openSpectrum(page);
    // モックの候補数は 20（3ゾーン表示の最小値）。このとき帯幅は
    // max(4, ceil(20 * 0.1)) = 4 で表示件数と同じになり、引き直しても
    // 必ず同じ顔ぶれが出る。押しても何も変わらないボタンは出さない。
    // 帯が広がるのは候補が 40 を超えてから（帯 = ceil(N * 0.1) > 4）。
    // 帯幅の増え方と抽出の変化は Rust 側のテストで担保している
    // （zone_bands_widen_as_the_library_grows / sampling_is_deterministic_for_a_given_seed）。
    await expect(page.getByRole('button', { name: '引き直す' })).toHaveCount(0);
  });

  test('結果カードのクリックで基準が切り替わりパンくずが伸びる', async ({ page }) => {
    await openSpectrum(page);
    const before = await page.locator('.glass-panel').getByText(/^基準:/).textContent();

    // ゾーン内のカード（サムネイル付きボタン）を1枚選ぶ
    await page
      .getByRole('heading', { name: 'タグの類似度が高い' })
      .locator('xpath=../following-sibling::div[1]')
      .getByRole('button')
      .first()
      .click();

    await expect(page.locator('.glass-panel').getByText(/^基準:/)).not.toHaveText(before || '');
  });

  test('対象外メディアの件数を隠さない', async ({ page }) => {
    await openSpectrum(page);
    await expect(page.getByText(/比較対象: \d+/)).toBeVisible();
  });
});
