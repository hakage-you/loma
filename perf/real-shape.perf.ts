import { test, expect, Page } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { record, invokeCounts, payloadBytes, domNodes, heapMb } from './measure';

// **実データの形**での計測。合否は問わない。
//
// 水増しした合成データは件数を揃えられるが、偏りは作れない。実ライブラリは
// タグ 10,123件のうち **5,711件が1回しか使われていない**（長い裾）、
// 1メディアのタグ本数は中央8・最大16、親フォルダ164、といった形をしている。
// この偏りは `get_media` の応答量やタグ一覧の並べ替えにそのまま効く。
//
// フィクスチャは実DBから作る。**コミットしない**:
//
//   node tools/make-mock-fixture.mjs
//
// 無ければこのファイルは丸ごと飛ばす（他人のマシン・CI では作れない）。
//
// **中身は「あるユーザーのライブラリ」の形であって、標準でも理想でもない。**

const FIXTURE = 'perf-results/fixture.json';
const cards = 'div.grid.gap-4 > div.group';

test.skip(!existsSync(FIXTURE), `${FIXTURE} が無い（node tools/make-mock-fixture.mjs で作る）`);

/** フィクスチャをアプリの読み込み前に置く */
async function useFixture(page: Page) {
  const json = readFileSync(FIXTURE, 'utf8');
  await page.addInitScript((raw) => {
    (window as unknown as { __mockFixture: unknown }).__mockFixture = JSON.parse(raw as string);
  }, json);
}

test('実データの形での起動', async ({ page }) => {
  await useFixture(page);
  await page.goto('/?debugMeasurePayload=1');
  await expect(page.locator(cards).first()).toBeVisible();
  await page.waitForTimeout(1500);

  const counts = await invokeCounts(page);
  const bytes = await payloadBytes(page);

  record('実データの形 / 起動', {
    'invoke 合計': Object.values(counts).reduce((a, b) => a + b, 0),
    get_media: counts.get_media ?? 0,
    'get_media の応答 (MB)': Math.round(((bytes.get_media ?? 0) / 1024 / 1024) * 100) / 100,
    'get_all_tags の応答 (MB)': Math.round(((bytes.get_all_tags ?? 0) / 1024 / 1024) * 100) / 100,
    'DOM ノード': await domNodes(page),
    'ギャラリーのカード': await page.locator(cards).count(),
    'JS ヒープ MB': await heapMb(page),
  });
});

test('実データの形でのタグ管理', async ({ page }) => {
  await useFixture(page);
  await page.goto('/');
  await expect(page.locator(cards).first()).toBeVisible();

  const started = Date.now();
  await page.getByRole('button', { name: 'タグ管理' }).click();
  const modal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'タグ管理・グループ統合' });
  await expect(modal.getByRole('button', { name: /^すべてのタグ/ })).toBeVisible();
  const openMs = Date.now() - started;

  const sortStarted = Date.now();
  await modal.locator('select').first().selectOption('count_asc');
  await page.waitForTimeout(50);
  const sortMs = Date.now() - sortStarted;

  record('実データの形 / タグ管理', {
    '開くまで ms': openMs,
    '並べ替え ms': sortMs,
    'DOM ノード': await domNodes(page),
    'JS ヒープ MB': await heapMb(page),
  });
});

test('実データの形での絞り込み', async ({ page }) => {
  await useFixture(page);
  await page.goto('/?debugMeasurePayload=1');
  await expect(page.locator(cards).first()).toBeVisible();
  await page.waitForTimeout(800);

  const started = Date.now();
  await page.locator('aside').getByRole('button', { name: '解析ステータス' }).click();
  await page.locator('aside').getByRole('button', { name: '未解析' }).click();
  await expect(page.locator(cards).first()).toBeVisible();
  const elapsed = Date.now() - started;

  const bytes = await payloadBytes(page);
  record('実データの形 / 絞り込み1回', {
    '反映まで ms': elapsed,
    'get_media の応答 (MB)': Math.round(((bytes.get_media ?? 0) / 1024 / 1024) * 100) / 100,
    'DOM ノード': await domNodes(page),
  });
});

test('実データの形でのタグ絞り込みの入力', async ({ page }) => {
  // **タグ一覧の並べ替え・絞り込みは transition に包まれていない**（タブの切り替えだけ）。
  // 10,000件を超える一覧で、1文字打つたびに同期で作り直していないかを見る
  await useFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'タグ管理' }).click();
  const modal = page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'タグ管理・グループ統合' });
  const input = modal.getByPlaceholder('タグ名で検索...');
  await expect(input).toBeVisible();

  const perKey: number[] = [];
  for (const ch of ['t', 'a', 'g', '_', '1', '2', '3']) {
    const started = Date.now();
    await input.press(ch);
    perKey.push(Date.now() - started);
  }

  record('実データの形 / タグ絞り込みの入力', {
    '1文字あたり ms（中央）': perKey.sort((a, b) => a - b)[Math.floor(perKey.length / 2)],
    '1文字あたり ms（最大）': perKey[perKey.length - 1],
    'DOM ノード': await domNodes(page),
  });
});
