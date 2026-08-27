import { test, expect, Page } from '@playwright/test';

// 設定モーダルのUI検証。
// `?debugOpen=settings` はモックモード用のフック（App.tsx）で、起動時に設定を開いた状態にする。

// モーダル見出しは「一般設定」等の h4 とも部分一致するため厳密一致で指定する
const settingsHeading = (page: Page) => page.getByRole('heading', { name: '設定', exact: true });

async function openSettings(page: Page) {
  await page.goto('/?debugOpen=settings');
  await expect(settingsHeading(page)).toBeVisible();
}

/**
 * ヘッダの歯車ボタン。アイコンだけのボタンなのでアクセシブル名は `title` から来る。
 *
 * **英語リテラルの属性値で待たない。** 以前は `button[title="Settings"]` を指していたが、
 * `title` は `t('app.label_title_settings')` で、モックの既定は ja なので実際の属性値は
 * 「設定」になる。属性値そのものを指すとロケールを増やすたびに壊れる。
 * `exact: true` は「設定を保存」への部分一致を避けるために必要。
 */
const settingsButton = (page: Page) => page.getByRole('button', { name: '設定', exact: true });

/** ページを再読み込みせずに設定モーダルを開き直す（モックの設定状態を保つため） */
async function reopenSettings(page: Page) {
  await settingsButton(page).click();
  await expect(settingsHeading(page)).toBeVisible();
}

const advancedToggle = (page: Page) => page.getByRole('button', { name: /詳細設定/ });

/**
 * 詳細設定を開いた状態にする。
 * モーダルは閉じても内部状態を保持する（open は prop で、コンポーネントは常時マウント）ため、
 * 開き直した際に既に展開済みのことがある。無条件にクリックすると畳んでしまう。
 */
async function ensureAdvancedOpen(page: Page) {
  const toggle = advancedToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
// gemini の option を持つ select はプロバイダー選択だけ
const providerSelect = (page: Page) =>
  page.locator('select').filter({ has: page.locator('option[value="gemini"]') });

test.describe('設定モーダル', () => {
  test('基本設定として言語・タグ粒度・モデル選択のみが表示される', async ({ page }) => {
    await openSettings(page);

    await expect(page.getByText('UI表示言語')).toBeVisible();
    // exact: true が必須。LIGHT プロンプト時の案内文にも「タグ粒度」が部分一致し、
    // 非同期の get_effective_prompt_type 解決タイミング次第で strict mode violation になる
    await expect(page.getByText('タグ粒度', { exact: true })).toBeVisible();
    await expect(page.getByText('使用するVLM (視覚言語) モデル')).toBeVisible();
    await expect(page.getByText('テキスト解析・タグ翻訳モデル')).toBeVisible();

    // 詳細設定は既定で閉じているため、中身は見えない
    await expect(page.getByText('LLMプロバイダー選択')).toBeHidden();
    await expect(page.getByText('Ollama API エンドポイント URL')).toBeHidden();
    await expect(page.getByText('コンテキスト長 (num_ctx)')).toBeHidden();
    await expect(page.getByText('FFmpeg未インストール時のアナウンス通知を表示')).toBeHidden();
  });

  test('詳細設定アコーディオンが開閉する', async ({ page }) => {
    await openSettings(page);
    const toggle = advancedToggle(page);

    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('LLMプロバイダー選択')).toBeVisible();
    await expect(page.getByText('高精度プロンプトモード (DETAILED) を強制適用する', { exact: true })).toBeVisible();
    await expect(page.getByText('手動VRAMメモリ解放')).toBeVisible();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByText('LLMプロバイダー選択')).toBeHidden();
  });

  test('コンテキスト長と最大長辺が縦に並んでいる', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    const numCtx = page.locator('input[type="number"]').first();
    const maxEdge = page.locator('input[type="number"]').nth(1);
    await expect(numCtx).toBeVisible();
    await expect(maxEdge).toBeVisible();

    const a = await numCtx.boundingBox();
    const b = await maxEdge.boundingBox();
    if (!a || !b) throw new Error('入力欄の位置を取得できなかった');

    // 縦並び: 左端が揃っており、最大長辺がコンテキスト長より下にある
    expect(Math.abs(a.x - b.x)).toBeLessThan(2);
    expect(b.y).toBeGreaterThan(a.y + a.height);
  });

  test('タグ粒度が無効な場合、案内文が詳細設定内の項目を指す', async ({ page }) => {
    await openSettings(page);

    // モックの既定モデルは qwen3-vl:8b-instruct (10B未満) のため LIGHT プロンプトになり粒度が無効化される
    const notice = page.getByText(/タグ粒度設定は適用されません/);
    await expect(notice).toBeVisible();

    // 案内先の項目は詳細設定の中にあるため、そこを開くよう明示している必要がある
    await expect(notice).toContainText('詳細設定');
    await expect(notice).toContainText('高精度プロンプトモード (DETAILED) を強制適用する');

    // 実際にその文言どおり操作すると目的のチェックボックスへ到達できる
    await ensureAdvancedOpen(page);
    await expect(
      page.getByText('高精度プロンプトモード (DETAILED) を強制適用する', { exact: true })
    ).toBeVisible();
  });

  test('詳細設定で変更した値が保存され、開き直しても保持される', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    const numCtx = page.locator('input[type="number"]').first();
    await numCtx.fill('20480');

    await page.getByRole('button', { name: '設定を保存' }).click();
    await expect(settingsHeading(page)).toBeHidden();

    // 再読み込みするとモックの状態が初期化されるため、モーダルだけ開き直す
    await reopenSettings(page);
    await ensureAdvancedOpen(page);
    await expect(page.locator('input[type="number"]').first()).toHaveValue('20480');
  });

  test('プロバイダーを外部LLMに切り替えるとOllama専用項目が隠れる', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    await expect(page.getByText('Ollama API エンドポイント URL')).toBeVisible();
    await expect(page.getByText('コンテキスト長 (num_ctx)')).toBeVisible();

    await providerSelect(page).selectOption('gemini');

    await expect(page.getByText('Ollama API エンドポイント URL')).toBeHidden();
    await expect(page.getByText('コンテキスト長 (num_ctx)')).toBeHidden();
    // プロバイダー選択自体は残る
    await expect(page.getByText('LLMプロバイダー選択')).toBeVisible();
  });
});
