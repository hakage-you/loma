import { test, expect, Page } from '@playwright/test';
import { record, domNodes, heapMb, invokeCounts } from './measure';

// タグ管理・グループ統合の描画の計測。**合否は問わない。**
//
// 実ライブラリは tags 10,123件・表記ゆれの提案 4,215件。
// **提案カードは一覧の行の約4倍重い**（規則チップ・メンバー全員ぶんの option・
// メンバーチップ2ボタン・サムネ最大5枚）。
//
// `?debugTagCount=` と `?debugSuggestionCount=` はモック限定のフック。
//
// **この数字はサムネイルを含まない。** 水増ししたタグはどのメディアにも付かないので、
// サンプルサムネが1枚も出ない。実データでは表示中の200行それぞれに最大5枚の img が
// 付きうるため、DOM ノードはここで出る数より多くなる。
// 既定の26件・3件では、段階描画も上限も一度も通らない。

const TAGS = 10_000;
const SUGGESTIONS = 4_000;

const modal = (page: Page) =>
  page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'タグ管理・グループ統合' });

test('タグ一覧の描画（タグ10,000件）', async ({ page }) => {
  await page.goto(`/?debugTagCount=${TAGS}`);
  await expect(page.locator('div.grid.gap-4 > div.group').first()).toBeVisible();
  const domBefore = await domNodes(page);
  const heapBefore = await heapMb(page);

  const started = Date.now();
  await page.getByRole('button', { name: 'タグ管理' }).click();
  await expect(modal(page).getByRole('button', { name: /^すべてのタグ/ })).toBeVisible();
  const openMs = Date.now() - started;

  const rows = await modal(page)
    .locator('div.overflow-y-auto > div')
    .filter({ has: page.getByRole('checkbox') })
    .count();

  record('タグ管理 / 一覧（タグ10,000件）', {
    '開くまで ms': openMs,
    '一度に出した行数': rows,
    'DOM ノード（開く前）': domBefore,
    'DOM ノード（開いた後）': await domNodes(page),
    'JS ヒープ増 MB': Math.round(((await heapMb(page)) - heapBefore) * 100) / 100,
  });
});

test('タグ一覧の絞り込み（タグ10,000件）', async ({ page }) => {
  await page.goto(`/?debugTagCount=${TAGS}`);
  await page.getByRole('button', { name: 'タグ管理' }).click();
  await expect(modal(page).getByRole('button', { name: /^すべてのタグ/ })).toBeVisible();

  const started = Date.now();
  await modal(page).getByPlaceholder('タグ名で検索...').fill('padded_tag_1234');
  await expect(modal(page).getByText('#padded_tag_1234')).toBeVisible();
  const filterMs = Date.now() - started;

  record('タグ管理 / 絞り込み（タグ10,000件）', {
    '1件に絞るまで ms': filterMs,
    'DOM ノード': await domNodes(page),
  });
});

test('AI提案の描画（提案4,000件）', async ({ page }) => {
  await page.goto(`/?debugTagCount=${TAGS}&debugSuggestionCount=${SUGGESTIONS}`);
  await page.getByRole('button', { name: 'タグ管理' }).click();
  await modal(page).getByRole('button', { name: /AI提案/ }).click();

  const heapBefore = await heapMb(page);
  const started = Date.now();
  await modal(page).getByRole('button', { name: '類似タグを検出' }).click();
  await expect(modal(page).getByRole('button', { name: /選んだ提案を統合する/ })).toBeVisible();
  const scanMs = Date.now() - started;

  const cards = await modal(page).locator('div.rounded-2xl.border').count();
  const counts = await invokeCounts(page);

  record('タグ管理 / AI提案（提案4,000件）', {
    '検出から描画まで ms': scanMs,
    '一度に出したカード数': cards,
    'DOM ノード': await domNodes(page),
    'JS ヒープ増 MB': Math.round(((await heapMb(page)) - heapBefore) * 100) / 100,
    'get_tag_sample_thumbnails': counts.get_tag_sample_thumbnails ?? 0,
  });
});
