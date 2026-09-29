import { test, expect, Page } from '@playwright/test';

// 同期を押してから、画面が反応するまでの検証。
//
// **押しても何も起きない時間があってはいけない。**
// `sync_folders` は Rust 側で tokio::spawn して即 Ok を返すため、
// 呼び出しの完了を待っても「始まった」ことは分からない。
// 実測では、押してから最初の進捗が出るまで11秒あり、その間は
// 全画面ブロックも進捗もキャンセルも出ていなかった（2026-09-29 に報告）。
//
// 時間の内訳（実データ・メディア4,948件・登録4フォルダ）:
//   ファイルの存在確認 9,896回 ...  0.35秒
//   フォルダを歩く 186,899件   ... 10.8秒  ← ここが沈黙のほぼ全部

const cards = 'div.grid.gap-4 > div.group';
const syncButton = (page: Page) => page.getByRole('button', { name: '同期', exact: true });

async function openApp(page: Page) {
  await page.goto('/');
  await expect(page.locator(cards).first()).toBeVisible();
}

test.describe('同期の手応え', () => {
  test('押した直後から進捗が出る', async ({ page }) => {
    await openApp(page);
    await syncButton(page).click();

    // **「解析処理中」の札と、探索中の件数が出ること。**
    // 総数は歩き終わるまで分からないので「0 / 0 (0%)」ではなく件数だけを出す
    await expect(page.getByText('解析処理中')).toBeVisible();
    await expect(page.getByText(/^[\d,]+件$/)).toBeVisible();
  });

  test('探索中でも中止と一時停止を押せる', async ({ page }) => {
    // 刻みを増やして、探索の段階を確実に捕まえる
    await page.goto('/?debugSyncSteps=40');
    await expect(page.locator(cards).first()).toBeVisible();
    await syncButton(page).click();

    // **押せるのに効かないボタンを出さない。** 探索の段階から中止できる
    await expect(page.getByRole('button', { name: '中止' })).toBeVisible();
    await expect(page.getByRole('button', { name: '一時停止' })).toBeVisible();
  });

  test('探索中は、何をしているかが文字で出る', async ({ page }) => {
    await openApp(page);
    // 刻みを増やして、探索の段階を確実に捕まえる
    await page.goto('/?debugSyncSteps=40');
    await expect(page.locator(cards).first()).toBeVisible();
    await syncButton(page).click();

    // Rust が返す status をそのまま出す（既存の表示と同じ作り）
    await expect(page.getByText(/Checking for moved or deleted files|Scanning folders/)).toBeVisible();
  });

  test('同期が終われば進捗は消える', async ({ page }) => {
    await openApp(page);
    await syncButton(page).click();
    await expect(page.getByText('解析処理中')).toBeVisible();

    // **出しっぱなしにしない。** 終了イベントで引っ込むこと
    await expect(page.getByText('解析処理中')).toBeHidden({ timeout: 10_000 });
    await expect(syncButton(page)).toBeVisible();
  });
});
