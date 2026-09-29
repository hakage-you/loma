import { test, expect, Page } from '@playwright/test';

// タグ管理・グループ統合の検証。
//
// **統合は取り消せない。** 「どのタグを残し、どれを消すか」を画面が正しく
// 出せていないと、戻せない操作が誤った対象に走る。ここで見るのは主に:
//   - 一覧の絞り込み・並べ替えが、統合の対象選びを誤らせないこと
//   - 手動統合が「残すタグ」を選ぶまで実行できないこと
//   - AI提案が承認したものだけを適用すること
//
// モックのタグは MOCK_MEDIA から数え上げたもの（カテゴリ8 + 自由タグ24 + 修飾語2）。

const modal = (page: Page) =>
  page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'タグ管理・グループ統合' });

/** 一覧の行。`#name` のチップで引く */
const tagRow = (page: Page, name: string) =>
  modal(page).locator('div.rounded-xl.border').filter({ hasText: `#${name}` }).first();

/**
 * 一覧の行を位置で引く。
 * **編集中の行は `#name` のチップが入力欄に置き換わる**ので、名前では引けなくなる。
 * 絞り込んで1件にしてからこちらを使う。
 */
const tagRowAt = (page: Page, index: number) =>
  modal(page)
    .locator('div.overflow-y-auto > div')
    .filter({ has: page.getByRole('checkbox') })
    .nth(index);

const openTagModal = async (page: Page) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'タグ管理' }).click();
  await expect(page.getByRole('heading', { name: 'タグ管理・グループ統合' })).toBeVisible();
};

test.describe('タグ管理 — すべてのタグ', () => {
  test('カテゴリを除いた自由タグが件数つきで並ぶ', async ({ page }) => {
    await openTagModal(page);

    // カテゴリ（screenshot / landscape など）はこのタブに出さない。
    // 消せない・統合できないものを並べても操作できない
    await expect(modal(page).getByRole('button', { name: /^すべてのタグ \(\d+\)$/ })).toBeVisible();
    await expect(tagRow(page, 'person')).toBeVisible();
    await expect(modal(page).getByText('#landscape')).toHaveCount(0);
  });

  test('検索は英語名でも日本語名でも引ける', async ({ page }) => {
    await openTagModal(page);
    const search = modal(page).getByPlaceholder('タグ名で検索...');

    await search.fill('moun');
    await expect(tagRow(page, 'mountain')).toBeVisible();
    await expect(tagRow(page, 'person')).toHaveCount(0);

    // **日本語名でも引けること。** 英語名しか見ないと、日本語で探す人には
    // 「無い」と映る
    await search.fill('人物');
    await expect(tagRow(page, 'person')).toBeVisible();
    await expect(tagRow(page, 'mountain')).toHaveCount(0);
  });

  test('種別で絞ると修飾語だけになる', async ({ page }) => {
    await openTagModal(page);
    await modal(page).getByRole('button', { name: '修飾語', exact: true }).click();

    await expect(tagRow(page, 'rain_soaked_tree')).toBeVisible();
    await expect(tagRow(page, 'person')).toHaveCount(0);
  });

  test('鉛筆から改名すると、一覧の英語名と日本語名が入れ替わる', async ({ page }) => {
    await openTagModal(page);
    await modal(page).getByPlaceholder('タグ名で検索...').fill('person');
    await expect(tagRowAt(page, 0)).toHaveCount(1);
    await tagRowAt(page, 0).getByTitle('タグ名と日本語名を編集').click();

    await tagRowAt(page, 0).getByPlaceholder('英語名').fill('human');
    await tagRowAt(page, 0).getByPlaceholder('日本語名').fill('人間');
    await tagRowAt(page, 0).getByTitle('保存').click();

    await modal(page).getByPlaceholder('タグ名で検索...').fill('human');
    await expect(tagRow(page, 'human')).toBeVisible();
    await expect(tagRow(page, 'human').getByText('人間')).toBeVisible();
  });

  test('目のアイコンで、そのタグが付いたメディアを確認できる', async ({ page }) => {
    await openTagModal(page);
    await modal(page).getByPlaceholder('タグ名で検索...').fill('person');
    await tagRow(page, 'person').getByTitle('このタグが付いたメディアを見る').click();

    // プレビューは一覧の上に別の層として重なる（z-60）
    const preview = page.locator('div.fixed.inset-0.z-60');
    await expect(preview.getByText('#person')).toBeVisible();
    // **件数は見出しの数字と中身が一致していること。** 3件（character カテゴリの3件）
    await expect(preview.getByText('(3件)')).toBeVisible();
    await expect(preview.locator('img')).toHaveCount(3);
  });

  test('手動統合は「残すタグ」を選ぶまで実行できない', async ({ page }) => {
    await openTagModal(page);
    await modal(page).getByPlaceholder('タグ名で検索...').fill('p');

    await tagRow(page, 'person').getByRole('checkbox').check();
    await tagRow(page, 'portrait').getByRole('checkbox').check();

    await expect(modal(page).getByText('選択中')).toBeVisible();
    // **残すタグが未選択のまま押せると、どちらが消えるか分からないまま実行される**
    await expect(modal(page).getByRole('button', { name: '手動で統合' })).toBeDisabled();
  });

  test('手動統合すると、残さなかったタグが一覧から消える', async ({ page }) => {
    await openTagModal(page);
    await modal(page).getByPlaceholder('タグ名で検索...').fill('p');

    await tagRow(page, 'person').getByRole('checkbox').check();
    await tagRow(page, 'portrait').getByRole('checkbox').check();
    // 1つ目の select は並べ替え。2つ目が「残すタグ」
    await modal(page).locator('select').nth(1).selectOption({ label: '人物 (person) (3)' });
    await modal(page).getByRole('button', { name: '手動で統合' }).click();

    await expect(tagRow(page, 'portrait')).toHaveCount(0);
    await expect(tagRow(page, 'person')).toBeVisible();
  });
});

test.describe('タグ管理 — AI提案', () => {
  const openSuggestions = async (page: Page) => {
    await openTagModal(page);
    await modal(page).getByRole('button', { name: /AI提案 \(\d+\)/ }).click();
  };

  test('検出を回す前は、何をすると何が出るかを空表示で説明する', async ({ page }) => {
    await openSuggestions(page);

    await expect(modal(page).getByText('提案はまだありません')).toBeVisible();
    await expect(
      modal(page).getByText('「類似タグを検出」を押すと', { exact: false })
    ).toBeVisible();
  });

  test('検出すると、当たった規則つきで候補が並ぶ', async ({ page }) => {
    await openSuggestions(page);
    await modal(page).getByRole('button', { name: '類似タグを検出' }).click();

    await expect(modal(page).getByText('日本語名が同一')).toBeVisible();
    // **なぜ候補になったかを出す。** 出ないと妥当性を判断する材料が無い
    await expect(modal(page).getByText('綴りの近さ')).toBeVisible();
    await expect(modal(page).getByText('2規則に該当')).toBeVisible();
  });

  test('方式を切り替えると、その方式の候補に入れ替わる', async ({ page }) => {
    await openSuggestions(page);
    await modal(page).getByRole('button', { name: '類似タグを検出' }).click();
    await expect(modal(page).getByText('日本語名が同一')).toBeVisible();

    await modal(page).getByRole('button', { name: '包括関係' }).click();
    await modal(page).getByRole('button', { name: '類似タグを検出' }).click();

    await expect(modal(page).getByText('AI: 包括関係')).toBeVisible();
    // **方式ごとに別々。** 混ざると、規則の誤爆が AI の結果の質を下げる
    await expect(modal(page).getByText('日本語名が同一')).toHaveCount(0);
  });

  test('承認していない提案は適用ボタンが押せない', async ({ page }) => {
    await openSuggestions(page);
    await modal(page).getByRole('button', { name: '類似タグを検出' }).click();
    await expect(modal(page).getByText('日本語名が同一')).toBeVisible();

    await expect(
      modal(page).getByRole('button', { name: /選んだ提案を統合する \(0\)/ })
    ).toBeDisabled();
  });

  test('承認した提案だけが統合され、結果が件数で出る', async ({ page }) => {
    await openSuggestions(page);
    await modal(page).getByRole('button', { name: '類似タグを検出' }).click();
    await expect(modal(page).getByText('日本語名が同一')).toBeVisible();

    // 1件だけ承認する。もう1件（綴りの近さ）は承認しない
    await modal(page).getByRole('button', { name: '承認' }).first().click();
    await expect(
      modal(page).getByRole('button', { name: /選んだ提案を統合する \(1\)/ })
    ).toBeEnabled();

    await modal(page).getByRole('button', { name: /選んだ提案を統合する \(1\)/ }).click();

    await expect(modal(page).getByText('件のタグを', { exact: false })).toBeVisible();
    // 承認しなかった側のタグは残っている
    await modal(page).getByRole('button', { name: /^すべてのタグ \(\d+\)$/ }).click();
    await modal(page).getByPlaceholder('タグ名で検索...').fill('window');
    await expect(tagRow(page, 'window')).toBeVisible();
  });
});
