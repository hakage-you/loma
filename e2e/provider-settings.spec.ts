import { test, expect, Page } from '@playwright/test';

// Ollama 以外のプロバイダーを選んだときの、モデル欄と API キー欄の検証。
//
// 報告は「プロバイダーを Ollama 以外にするとモデル選択ができない」。
// 実際には選択肢が空だったのではなく、**入力要素が1つも作られていなかった**
// （`setGeminiModel` を呼ぶ箇所が履歴上一度も存在しなかった）。
//
// クラウド VLM は README で非サポートと明記された機能。ここで守るのは
// 「設定はできるのに使えない」状態を作らないことだけ。

const settingsHeading = (page: Page) => page.getByRole('heading', { name: '設定', exact: true });
const settingsButton = (page: Page) => page.getByRole('button', { name: '設定', exact: true });
const providerSelect = (page: Page) =>
  page.locator('select').filter({ has: page.locator('option[value="gemini"]') });

async function openAdvanced(page: Page) {
  const toggle = page.getByRole('button', { name: /詳細設定/ });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** プロバイダーを切り替える。選択欄は詳細設定の中にある */
async function selectProvider(page: Page, value: string) {
  await openAdvanced(page);
  await providerSelect(page).selectOption(value);
}

const modelInput = (page: Page) => page.getByPlaceholder('gemini-2.0-flash');
const apiKeyInput = (page: Page) => page.getByPlaceholder('未設定');

test.describe('外部プロバイダーの設定', () => {
  test('Gemini に切り替えるとモデル欄とAPIキー欄が出る', async ({ page }) => {
    await page.goto('/?debugOpen=settings');
    await expect(settingsHeading(page)).toBeVisible();

    // Ollama のときは出ない
    await expect(modelInput(page)).toHaveCount(0);

    await selectProvider(page, 'gemini');

    await expect(page.getByText('モデルとAPIキー')).toBeVisible();
    await expect(modelInput(page)).toBeVisible();
    await expect(apiKeyInput(page)).toBeVisible();
  });

  test('OpenAI では互換エンドポイントURLも出る', async ({ page }) => {
    await page.goto('/?debugOpen=settings');
    await selectProvider(page, 'openai');

    await expect(page.getByText('OpenAI 互換エンドポイント URL')).toBeVisible();
    await expect(page.getByPlaceholder('gpt-4o-mini')).toBeVisible();
  });

  test('モデル名を変えて保存すると開き直しても保持される', async ({ page }) => {
    await page.goto('/?debugOpen=settings');
    await selectProvider(page, 'gemini');

    await modelInput(page).fill('gemini-2.5-pro');
    await page.getByRole('button', { name: '設定を保存' }).click();
    await expect(settingsHeading(page)).toBeHidden();

    await settingsButton(page).click();
    await expect(settingsHeading(page)).toBeVisible();
    await expect(modelInput(page)).toHaveValue('gemini-2.5-pro');
  });

  test('保存済みのAPIキーが読み込まれる', async ({ page }) => {
    await page.goto('/?debugOpen=settings');
    await selectProvider(page, 'gemini');

    // 伏せ字なので value で見る
    await expect(apiKeyInput(page)).toHaveValue('mock-gemini-key');
    await expect(apiKeyInput(page)).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: '表示する' }).click();
    await expect(apiKeyInput(page)).toHaveAttribute('type', 'text');
  });

  test('APIキーを読み出せなかったときは、空欄の意味を出す', async ({ page }) => {
    // 空欄が「未設定」なのか「読めなかった」なのかは、出さないと区別できない。
    // 読めなかっただけなら、そのまま保存してもキーは消えない（触っていないので送らない）
    await page.goto('/?debugOpen=settings&debugFailCommand=get_provider_api_key');
    await selectProvider(page, 'gemini');

    await expect(apiKeyInput(page)).toHaveValue('');
    await expect(page.getByText(/保存済みのキーを読み出せませんでした/)).toBeVisible();
  });

  test('読み出せなかったAPIキーは、保存しても消えない', async ({ page }) => {
    // ここが元の欠陥。読み出しに失敗すると state は空のままで、保存すると
    // 資格情報ストアの値を空文字で上書きしていた。触っていないキーは送らない
    await page.goto('/?debugOpen=settings&debugFailCommand=get_provider_api_key');
    await selectProvider(page, 'gemini');
    await expect(apiKeyInput(page)).toHaveValue('');

    await page.getByRole('button', { name: '設定を保存' }).click();
    await expect(settingsHeading(page)).toBeHidden();

    const stored = await page.evaluate(() => (window as any).__mockApiKeys.gemini);
    expect(stored).toBe('mock-gemini-key');
  });

  test('入力したAPIキーは保存される', async ({ page }) => {
    // 上のテストが「常に送らない」で通ってしまわないようにする
    await page.goto('/?debugOpen=settings');
    await selectProvider(page, 'gemini');

    await apiKeyInput(page).fill('typed-key');
    await page.getByRole('button', { name: '設定を保存' }).click();
    await expect(settingsHeading(page)).toBeHidden();

    const stored = await page.evaluate(() => (window as any).__mockApiKeys.gemini);
    expect(stored).toBe('typed-key');
  });

  test('保存に失敗したら理由が出て、モーダルは閉じない', async ({ page }) => {
    await page.goto('/?debugOpen=settings&debugFailCommand=save_settings');
    await expect(settingsHeading(page)).toBeVisible();

    await page.getByRole('button', { name: '設定を保存' }).click();

    await expect(page.getByText('保存できませんでした')).toBeVisible();
    await expect(settingsHeading(page)).toBeVisible();
  });
});
