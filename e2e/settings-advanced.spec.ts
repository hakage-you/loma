import { test, expect, Page, Locator } from '@playwright/test';

// 設定モーダルのうち、**これまで E2E が一度も触っていなかった範囲**の検証。
//
// 対象は4つ:
//   1. 似ているメディアの検索（タグのベクトル化）
//   2. おすすめモデルのカード
//   3. モデルのダウンロード
//   4. タグ粒度の比較
//
// この範囲はファイル分割の前に押さえておく必要がある。分割は「動きは変えずに
// 置き場所だけ変える」作業なので、動きを確かめる手段が無いまま動かすのが
// 一番まずい。
//
// `?debugOpen=settings` はモックモード用のフック（App.tsx）で、起動時に設定を開く。

const settingsHeading = (page: Page) => page.getByRole('heading', { name: '設定', exact: true });

/** 設定モーダル本体。**背景のギャラリーやサイドバーに同じ文字があるため必ずこの中で探す** */
const modal = (page: Page) => page.locator('div.fixed.inset-0.z-50').first();

async function openSettings(page: Page, extraQuery = '') {
  await page.goto(`/?debugOpen=settings${extraQuery}`);
  await expect(settingsHeading(page)).toBeVisible();
}

/**
 * 10B以上のモデルが入っている状態にする問い合わせ。
 *
 * **モックの既定の2つ（qwen3-vl:8b-instruct / qwen2.5:7b）はどちらも10B未満。**
 * タグ粒度は `get_effective_prompt_type` が DETAILED のときしか押せないので、
 * これが無いと粒度まわりの経路を一度も通せない。
 */
const WITH_BIG_MODEL = '&debugModels=gemma4:12b,qwen3-vl:8b-instruct';

const advancedToggle = (page: Page) => page.getByRole('button', { name: /詳細設定/ });

/**
 * 詳細設定を開いた状態にする。
 * モーダルは閉じても内部状態を保持するので、無条件にクリックすると畳んでしまう。
 */
async function ensureAdvancedOpen(page: Page) {
  const toggle = advancedToggle(page);
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** そのコマンドが何回呼ばれたか */
async function invokeCount(page: Page, cmd: string): Promise<number> {
  return page.evaluate(
    (c) =>
      ((window as unknown as { __mockInvokeLog: { cmd: string }[] }).__mockInvokeLog || []).filter(
        (e) => e.cmd === c
      ).length,
    cmd
  );
}

/**
 * おすすめモデルのカード。
 *
 * **見出しで区画を絞ってから引く。** `gemma4:12b` は VLM と Text LLM の
 * 両方に出るので、名前だけで引くと取り違える。
 *
 * **カードの全文ではなく「モデル名だけの要素」で絞る。** `gemma4:12b` の
 * 説明文には `qwen3-vl:8b-instruct` という文字列が入っているので、
 * 全文一致だと qwen3-vl のカードを引いたつもりで2枚に当たる。
 */
function presetCard(page: Page, sectionHeading: string, name: string): Locator {
  const section = modal(page)
    .locator('div.space-y-1\\.5')
    .filter({ hasText: sectionHeading })
    .last();
  return section.locator('div.grid > div').filter({ has: page.getByText(name, { exact: true }) });
}

const VLM_SECTION = 'おすすめ VLM プリセット';
const TEXT_SECTION = 'おすすめ Text LLM プリセット';

/** ダウンロード確認のダイアログ（設定モーダルとは別の層） */
// **設定モーダルの内側に描かれる**ので、絞ると設定モーダル自身も当たる。後ろの層を取る
const downloadConfirm = (page: Page) =>
  page.locator('div.fixed.inset-0.z-50').filter({ hasText: 'モデルのダウンロード確認' }).last();

test.describe('設定 — 似ているメディアの検索（ベクトル化）', () => {
  test('ベクトル化の現在の状態が件数で出る', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    const m = modal(page);
    await expect(m.getByText('似ているメディアの検索（タグのベクトル化）')).toBeVisible();
    // **未生成の件数と、対象メディアの件数を別々に見る。**
    // まとめて「表示された」だけ見ると、全部0でも通ってしまう
    await expect(m.getByText(/ベクトル化済みタグ: \d+ \/ \d+/)).toBeVisible();
    await expect(m.getByText(/未生成: 0/)).toBeVisible();
    await expect(m.getByText(/検索対象メディア: [1-9]/)).toBeVisible();
  });

  test('タグ不足で対象外になったメディアの件数を隠さない', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);
    // 「対象は12件」だけ出して、残りが落ちた事実を伏せないこと
    await expect(modal(page).getByText(/個未満で対象外: \d+/)).toBeVisible();
  });

  test('未生成があるときだけ「未生成のタグをベクトル化」が押せる', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);
    // 既定は未生成0件。**全部済んでいるのに押せると、無駄に走らせることになる**
    await expect(modal(page).getByRole('button', { name: /未生成のタグをベクトル化/ })).toBeDisabled();
  });

  test('「未生成のタグをベクトル化」を押すと生成が走る', async ({ page }) => {
    // 未生成が0件だとボタンが押せないので、5件ある状態を作る
    await openSettings(page, '&debugMissingEmbeddings=5');
    await ensureAdvancedOpen(page);

    await expect(modal(page).getByText(/未生成: 5/)).toBeVisible();
    expect(await invokeCount(page, 'generate_tag_embeddings')).toBe(0);
    await modal(page).getByRole('button', { name: /未生成のタグをベクトル化/ }).click();
    await expect.poll(() => invokeCount(page, 'generate_tag_embeddings')).toBe(1);
  });

  test('「類似度分布を計測」を押すと計測が走る', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    await modal(page).getByRole('button', { name: /類似度分布を計測/ }).click();
    await expect.poll(() => invokeCount(page, 'get_embedding_diagnostics')).toBe(1);
  });

  test('ベクトルの保存量が、使用中とそれ以外に分かれて出る', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    const m = modal(page);
    await expect(m.getByText('ベクトルの保存量')).toBeVisible();
    // モックは「使用中の bge-m3」と「使われていない qwen3-embedding:8b」を返す。
    // **使用中の印が付いていること**が、消してよい方の判別に要る
    await expect(m.getByText('使用中', { exact: true })).toBeVisible();
    await expect(m.getByRole('button', { name: /使用中以外のモデルのベクトルを削除/ })).toBeVisible();
  });

  test('使用中以外のベクトルを削除すると、消えた件数が出る', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    await modal(page).getByRole('button', { name: /使用中以外のモデルのベクトルを削除/ }).click();
    await expect.poll(() => invokeCount(page, 'cleanup_unused_embeddings')).toBe(1);
    await expect(modal(page).getByText(/件のベクトルを削除しました/)).toBeVisible();
  });

  test('使用中のベクトルの破棄は、確認してからでないと実行されない', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    await modal(page).getByRole('button', { name: /使用中のモデルのベクトルを破棄して作り直す/ }).click();
    await expect(page.getByText('ベクトルを破棄しますか')).toBeVisible();
    // **確認を出しただけで実行してはいけない**
    expect(await invokeCount(page, 'discard_embeddings')).toBe(0);

    await page.getByRole('button', { name: 'やめる' }).click();
    await expect(page.getByText('ベクトルを破棄しますか')).toBeHidden();
    expect(await invokeCount(page, 'discard_embeddings')).toBe(0);
  });

  test('破棄を確認すると実行される', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    await modal(page).getByRole('button', { name: /使用中のモデルのベクトルを破棄して作り直す/ }).click();
    await page.getByRole('button', { name: '破棄する' }).click();
    await expect.poll(() => invokeCount(page, 'discard_embeddings')).toBe(1);
  });

  test('ハブ化対策と記述的タグの切り替えが保存され、開き直しても残る', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    const m = modal(page);
    const centering = m.locator('label').filter({ hasText: 'ハブ化対策' }).locator('input[type="checkbox"]');
    const descriptive = m
      .locator('label')
      .filter({ hasText: '記述的タグも類似度計算に含める' })
      .locator('input[type="checkbox"]');

    // モックの既定は centering = 有効 / descriptive = 無効。両方を逆にする
    await expect(centering).toBeChecked();
    await expect(descriptive).not.toBeChecked();
    await centering.uncheck();
    await descriptive.check();

    await m.getByRole('button', { name: '設定を保存' }).click();
    await expect(settingsHeading(page)).toBeHidden();

    await page.getByRole('button', { name: '設定', exact: true }).click();
    await ensureAdvancedOpen(page);
    await expect(centering).not.toBeChecked();
    await expect(descriptive).toBeChecked();
  });
});

test.describe('設定 — おすすめモデルのカード', () => {
  test('導入済みと未導入が、カードの上で見分けられる', async ({ page }) => {
    await openSettings(page);

    // モックが導入済みとして返すのは qwen3-vl:8b-instruct と qwen2.5:7b
    await expect(presetCard(page, VLM_SECTION, 'qwen3-vl:8b-instruct')).toContainText('インストール済');
    await expect(presetCard(page, VLM_SECTION, 'translategemma:4b')).toContainText('要DL');
  });

  test('いま選ばれているモデルには選択中の印が付く', async ({ page }) => {
    await openSettings(page);
    await expect(presetCard(page, VLM_SECTION, 'qwen3-vl:8b-instruct')).toContainText('選択中');
    await expect(presetCard(page, VLM_SECTION, 'translategemma:4b')).not.toContainText('選択中');
  });

  test('導入済みのカードを押すと、ダウンロードではなく選択になる', async ({ page }) => {
    await openSettings(page, WITH_BIG_MODEL);

    await presetCard(page, VLM_SECTION, 'gemma4:12b').click();
    // **確認が出てはいけない。** 既に入っているものを押しただけ
    await expect(downloadConfirm(page)).toBeHidden();
    expect(await invokeCount(page, 'pull_ollama_model')).toBe(0);
    await expect(presetCard(page, VLM_SECTION, 'gemma4:12b')).toContainText('選択中');
  });

  test('未導入のカードを押すとダウンロードの確認が出る', async ({ page }) => {
    await openSettings(page);

    await presetCard(page, VLM_SECTION, 'translategemma:4b').click();
    // 何を落とすのかが確認の中に出ていること
    await expect(downloadConfirm(page)).toContainText('translategemma:4b');
  });

  test('Text LLM 側にもカードが並ぶ', async ({ page }) => {
    await openSettings(page);
    await expect(presetCard(page, TEXT_SECTION, 'qwen3.5:9b')).toBeVisible();
    await expect(presetCard(page, TEXT_SECTION, 'gemma4:12b')).toBeVisible();
  });

  test('埋め込みモデルのカードも3枚並ぶ', async ({ page }) => {
    await openSettings(page);
    await ensureAdvancedOpen(page);

    // **`bge-m3` は選択欄の option にも出る。** カードの枠ごと絞ってから中を見る
    const grid = modal(page)
      .locator('div.grid')
      .filter({ has: page.getByText('embeddinggemma', { exact: true }) })
      .first();
    await expect(grid.locator('> div')).toHaveCount(3);
    for (const name of ['embeddinggemma', 'bge-m3', 'qwen3-embedding:8b']) {
      await expect(grid.locator('> div').filter({ has: page.getByText(name, { exact: true }) })).toBeVisible();
    }
  });
});

test.describe('設定 — モデルのダウンロード', () => {
  test('確認を取り消すとダウンロードは始まらない', async ({ page }) => {
    await openSettings(page);

    await presetCard(page, VLM_SECTION, 'translategemma:4b').click();
    await downloadConfirm(page).getByRole('button', { name: 'キャンセル' }).click();
    await expect(downloadConfirm(page)).toBeHidden();
    expect(await invokeCount(page, 'pull_ollama_model')).toBe(0);
  });

  test('確認から開始すると、そのカードが取得中になる', async ({ page }) => {
    await openSettings(page);

    await presetCard(page, VLM_SECTION, 'translategemma:4b').click();
    await downloadConfirm(page).getByRole('button', { name: /ダウンロード開始/ }).click();

    await expect.poll(() => invokeCount(page, 'pull_ollama_model')).toBe(1);
    // **押しただけで見た目が変わらないと、始まったのか分からない**
    await expect(presetCard(page, VLM_SECTION, 'translategemma:4b')).toContainText('インストール中');
  });

  test('ダウンロード中に中止できる', async ({ page }) => {
    await openSettings(page);

    await presetCard(page, VLM_SECTION, 'translategemma:4b').click();
    await downloadConfirm(page).getByRole('button', { name: /ダウンロード開始/ }).click();
    await expect.poll(() => invokeCount(page, 'pull_ollama_model')).toBe(1);

    await modal(page).getByRole('button', { name: 'ダウンロードをキャンセル' }).click();
    await expect.poll(() => invokeCount(page, 'cancel_ollama_pull')).toBe(1);
  });
});

test.describe('設定 — タグ粒度の比較', () => {
  /** 画像を選んだことにする。**選ばないと比較は1行も動かない** */
  async function chooseImage(page: Page, path: string | null) {
    await page.evaluate((p) => {
      (window as unknown as { __mockDialogOpenResult?: string | null }).__mockDialogOpenResult = p;
    }, path);
  }

  /**
   * 粒度を押せる状態にする。
   * **10B以上のモデルを選んで初めて有効になる**（8B のままだと押せない）。
   */
  async function enableGranularity(page: Page) {
    await presetCard(page, VLM_SECTION, 'gemma4:12b').click();
    await expect(page.getByRole('button', { name: /粒度を試す/ })).toBeEnabled();
  }

  test('10B未満のモデルでは粒度を試せない', async ({ page }) => {
    await openSettings(page);
    // 既定は qwen3-vl:8b-instruct。**押せてしまうと、効かない設定を触らせることになる**
    await expect(page.getByRole('button', { name: /粒度を試す/ })).toBeDisabled();
  });

  test('画像を選ぶと、段階ごとに違うタグが並ぶ', async ({ page }) => {
    await openSettings(page, WITH_BIG_MODEL);
    await enableGranularity(page);
    await chooseImage(page, 'C:/mock/sample.png');

    await page.getByRole('button', { name: /粒度を試す/ }).click();
    await expect.poll(() => invokeCount(page, 'compare_granularity_levels')).toBe(1);

    // **段階ごとにタグの出方が違うことが比較の目的。**
    // 画面は日本語名で出る。Lv2 以降にだけ出る記述的タグが並んでいること
    const compare = page.locator('div.fixed.inset-0').filter({ hasText: '粒度を試す（画像を選択）' }).last();
    await expect(compare.getByText('Lv1: 分解重視（現行）')).toBeVisible();
    await expect(compare.getByText('Lv3: 記述重視')).toBeVisible();
    await expect(compare.getByText('雨に濡れた木').first()).toBeVisible();
    // Lv3 にだけ出るもの。**全段階が同じ結果なら比較する意味が無い**
    await expect(compare.getByText('濡れた下草')).toBeVisible();
  });

  test('選んだ画像の名前が出る', async ({ page }) => {
    await openSettings(page, WITH_BIG_MODEL);
    await enableGranularity(page);
    await chooseImage(page, 'C:/mock/sample.png');

    await page.getByRole('button', { name: /粒度を試す/ }).click();
    await expect(page.getByText('sample.png')).toBeVisible();
  });

  test('画像を選ばずに閉じると何も起きない', async ({ page }) => {
    await openSettings(page, WITH_BIG_MODEL);
    await enableGranularity(page);
    await chooseImage(page, null);

    await page.getByRole('button', { name: /粒度を試す/ }).click();
    await page.waitForTimeout(300);
    expect(await invokeCount(page, 'compare_granularity_levels')).toBe(0);
  });
});
