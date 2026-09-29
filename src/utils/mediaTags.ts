import { MediaItem, TagItem, TagPairItem } from '../types';

/**
 * タグ id → タグ の索引。
 *
 * **メディア一覧はタグの名前を持っていない。** `get_media` はタグの id だけを返し、
 * 名前はここで引く。名前を全件ぶん載せると、実データ（メディア 4,941件・
 * タグ 31,849本）で応答の半分以上がタグ名になるため。
 *
 * 元になる一覧は `get_all_tags` が返すもので、起動時に1回取っている。
 */
export type TagIndex = Map<number, TagItem>;

export function buildTagIndex(tags: TagItem[]): TagIndex {
  return new Map(tags.map((t) => [t.id, t]));
}

/**
 * メディアに付いているタグを、名前つきで取り出す。
 *
 * **`null` は「まだ分からない」であって「0件」ではない。** タグ一覧の取得と
 * メディア一覧の取得は同時に走るので、メディアが先に届く瞬間がある。
 * 呼ぶ側はこの2つを区別して、`null` のときは読み込み中の見た目を出すこと
 * （0件として扱うと、タグが付いているのに「無い」と見せることになる）。
 */
export function resolveMediaTags(item: MediaItem, index: TagIndex): TagPairItem[] | null {
  if (item.tag_ids.length === 0) return [];
  if (index.size === 0) return null;
  const out: TagPairItem[] = [];
  for (const id of item.tag_ids) {
    const tag = index.get(id);
    // 索引に無い id は飛ばす。統合や改名の直後に、取り直しが済んでいない間だけ起きる
    if (tag) out.push({ name: tag.name, name_ja: tag.name_ja, kind: tag.kind });
  }
  return out;
}
