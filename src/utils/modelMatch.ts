/**
 * 推奨モデル名 ⇔ インストール済みモデル名の対応。
 *
 * **サイズ違いを同一視してはいけない。** 推奨は実測でサイズまで含めて決めており
 * （`gemma4:12b` は `26b` より速く正確、という測定結果）、`gemma4` という系統名が
 * 一致するだけで別サイズを選ぶと推奨した意味が消える。
 *
 * 実際に起きた不具合（2026-08-12）: 系統名だけで一致させていたため、
 * `gemma4:12b` のボタンを押すと一覧で先に並ぶ `gemma4:26b` が選ばれていた。
 * 「その系統が入っているか」の判定を「どのモデルか」の特定に流用したのが原因。
 */

/** `name:tag` を分解する。タグが無ければ空文字 */
const split = (s: string): [string, string] => {
  const t = s.toLowerCase().trim();
  const i = t.indexOf(':');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
};

/**
 * 推奨モデルに対応する「インストール済みの実際の名前」を返す。無ければ `null`。
 *
 * 許すのはタグの前方一致まで（`gemma4:12b` ⇔ `gemma4:12b-it-q4`）。
 * タグ無しの推奨は `:latest` と対応させる（`bge-m3` ⇔ `bge-m3:latest`）。
 * **`12b` と `26b` は一致しない。**
 */
export function resolveInstalledModel(
  recommendedName: string,
  availableList: string[]
): string | null {
  if (!availableList?.length) return null;
  const [tBase, tTag] = split(recommendedName);

  const score = (installed: string): number => {
    const [iBase, iTag] = split(installed);
    if (iBase !== tBase) return -1;
    if (iTag === tTag) return 3; // 完全一致
    if (!tTag && (iTag === 'latest' || iTag === '')) return 2; // タグ無し ⇔ :latest
    if (!tTag || !iTag) return -1; // 片方だけタグがある＝サイズ不明。当てにしない
    if (iTag.startsWith(tTag) || tTag.startsWith(iTag)) return 1; // 量子化違いなど
    return -1;
  };

  let best: { name: string; s: number } | null = null;
  for (const m of availableList) {
    const s = score(m);
    if (s >= 0 && (!best || s > best.s)) best = { name: m, s };
  }
  return best?.name ?? null;
}

/** その推奨モデルが入っているか。**特定には使わない**（`resolveInstalledModel` を使う） */
export const isModelInstalled = (recommendedName: string, availableList: string[]): boolean =>
  resolveInstalledModel(recommendedName, availableList) !== null;
