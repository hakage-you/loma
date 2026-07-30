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

test.describe('類似度分布の計測', () => {
  /** 設定モーダルの詳細設定を開いて、埋め込みセクションまで送る */
  async function openSpectrumSettings(page: Page) {
    await page.goto('/?debugOpen=settings');
    const adv = page.getByRole('button', { name: /詳細設定/ });
    if ((await adv.getAttribute('aria-expanded')) !== 'true') await adv.click();
    await page.getByText('似ているメディアの検索（タグのベクトル化）').scrollIntoViewIfNeeded();
  }

  test('トグルの切り替えが保存せずに計測へ反映される', async ({ page }) => {
    // 以前は計測が保存済み設定をDBから読んでいたため、トグルを切り替えても
    // 結果が変わらず「効かない」ように見えた。画面の値を渡すようにした回帰テスト。
    await openSpectrumSettings(page);
    const measure = page.getByRole('button', { name: '類似度分布を計測' });

    await measure.click();
    await expect(page.getByText(/centering ON \/ descriptive OFF/)).toBeVisible();

    const centering = page
      .locator('label')
      .filter({ hasText: 'ハブ化対策 (centering) を有効にする' })
      .locator('input[type="checkbox"]');
    await centering.uncheck();

    await measure.click();
    // 保存ボタンを押していないのに、計測結果は切り替え後の設定で出る
    await expect(page.getByText(/centering OFF \/ descriptive OFF/)).toBeVisible();
  });

  test('計測結果に判定とヒストグラムが出る', async ({ page }) => {
    await openSpectrumSettings(page);
    await page.getByRole('button', { name: '類似度分布を計測' }).click();
    // 生の数値だけでは評価できないため、判定を必ず添える
    await expect(page.getByText('概念の分離')).toBeVisible();
    await expect(page.getByText('ハブ化', { exact: true })).toBeVisible();
    await expect(page.getByText(/^参考:/).first()).toBeVisible();
  });
});
