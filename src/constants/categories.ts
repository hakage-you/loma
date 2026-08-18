/**
 * メディアのカテゴリ。
 *
 * **表示名はここに持たない。** 以前は `GalleryGrid` と `Sidebar` が同じ12件の
 * 日本語名を別々に定義しており、片方だけ直すと2画面で表示が食い違う状態だった。
 * 識別子だけをここで持ち、表示名はロケールの `category` 名前空間が持つ。
 */
export const CATEGORY_IDS = [
  'screenshot',
  'document',
  'landscape',
  'food',
  'character',
  'animal',
  'person',
  'item_product',
  'art_illustration',
  'text_heavy',
  'tech',
  'other',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

/**
 * 識別子 → ロケールキー。
 *
 * バックエンドは未知のカテゴリを返しうるので、呼ぶ側は既定値に識別子そのものを渡す
 * （`t()` は未定義キーで既定値を返す）。
 */
export const categoryLabelKey = (id: string) => `category.label_${id}`;
