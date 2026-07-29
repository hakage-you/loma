/**
 * 概念スペクトラム検索（似ているメディアの検索）の共有定数。
 *
 * これらは **バックエンドの `src-tauri/src/embedding.rs` が持つ定数の写し** である。
 * 片方だけ変えると、画面上の件数とバックエンドの候補集合が食い違う。
 * 変更するときは両方を直すこと。
 */

/**
 * 候補集合に入るために必要な basic タグの数。
 * 対応する Rust 側: `embedding::MIN_BASIC_TAGS`
 *
 * これ未満のメディアは重心が実質「そのタグ1個の検索」にしかならないため対象外にする。
 */
export const MIN_BASIC_TAGS = 3;

/** クライアント側だけで解決する疑似ステータス（`analysis_status` には存在しない） */
export const STATUS_TAG_INSUFFICIENT = 'tag_insufficient';

/** そのメディアが basic タグ不足で類似検索の対象外かどうか */
export function isTagInsufficient(item: { analysis_status: string; tags: { kind: string }[] }): boolean {
  if (item.analysis_status !== 'completed') return false;
  return item.tags.filter((t) => t.kind === 'basic').length < MIN_BASIC_TAGS;
}
