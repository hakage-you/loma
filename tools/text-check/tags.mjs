/**
 * 実ライブラリからタグ一覧を取得する。
 *
 * `tools/embedding-check/snapshot.mjs` と同じ手法（WAL を反映した readonly スナップショット）
 * を使い回す。稼働中のDBを単純コピーすると直近の書き込みを取りこぼすため（README参照）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, snapshot } from '../embedding-check/snapshot.mjs';

export { defaultDbPath };

export function ensureSnapshot(repoRoot, srcDb, destDb) {
  const src = srcDb ?? defaultDbPath(repoRoot);
  if (!src) throw new Error('この OS では既定パスを解決できません。--db <path> を指定してください');
  fs.mkdirSync(path.dirname(destDb), { recursive: true });
  const r = snapshot(src, destDb);
  return { src, ...r };
}

/**
 * `run_suggest_tag_merges_logic`（commands.rs）と同じ抽出条件（is_category = 0）で
 * タグ一覧を取る。`id` / `kind` も保持するのは、本番の `find_tag` + `t1.id != t2.id &&
 * t1.kind == t2.kind` フィルタを計測側でも再現するため（下記 `resolvePair` 参照）。
 */
export function loadTags(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(
      `SELECT t.id, t.name, t.name_ja, t.tag_kind AS kind, COUNT(mt.media_id) AS count
       FROM tags t
       LEFT JOIN media_tags mt ON t.id = mt.tag_id
       WHERE t.is_category = 0
       GROUP BY t.id, t.name, t.name_ja, t.tag_kind
       ORDER BY count DESC, COALESCE(t.name_ja, t.name) ASC`
    ).all();
    return rows.map((r) => ({ id: r.id, name: r.name, nameJa: r.name_ja?.trim() || null, kind: r.kind }));
  } finally {
    db.close();
  }
}

/** 本番と同じ記述子（`name (name_ja)` / name_ja が無ければ `name`） */
export function descriptorOf(tag) {
  return tag.nameJa ? `${tag.name} (${tag.nameJa})` : tag.name;
}

/**
 * 本番の呼び出し条件（`free_tags.len()` が 2〜300）を跨いだ複数のサンプルサイズを作る。
 *
 * 全タグから**等間隔サンプリング**で決定的に選ぶ（実行間で比較可能にするため）。
 * 上位（頻出）タグに偏らないよう、全体から均等に間引く。
 */
export function buildSamples(allTags, sizes) {
  const samples = {};
  for (const size of sizes) {
    const n = Math.min(size, allTags.length);
    if (n < 2) continue;
    const step = allTags.length / n;
    const picked = [];
    for (let i = 0; i < n; i++) picked.push(allTags[Math.floor(i * step)]);
    samples[size] = picked;
  }
  return samples;
}

/**
 * commands.rs の `find_tag` を再現する。モデルが返した1つの名前文字列から、
 * サンプル内の該当タグを探す。
 */
function findTag(sample, rawName) {
  const clean = rawName.trim().replace(/^#/, '');
  const keyEn = clean.split('(')[0].trim();
  return sample.find((t) => t.name === keyEn || t.name === clean || t.nameJa === clean) ?? null;
}

/**
 * commands.rs の `t1.id != t2.id && t1.kind == t2.kind` フィルタを再現し、
 * モデルが返したペアが**本番でも実際にマージ候補として残るか**を判定する。
 *
 * これが無いと、モデルが「1つのタグの英語名と日本語訳」を並べただけの自己対応
 * （例: `apple = りんご`）を「有効なペア」として数えてしまう。本番では
 * find_tag が両方とも同じタグに解決し、t1.id == t2.id で弾かれるため実害は無いが、
 * 計測側で弾かないと生成の質を過大評価することになる。
 */
export function resolvePair(sample, name1, name2) {
  const t1 = findTag(sample, name1);
  const t2 = findTag(sample, name2);
  if (!t1 || !t2) return { kind: 'unresolved' };
  if (t1.id === t2.id) return { kind: 'self', tag: t1 };
  if (t1.kind !== t2.kind) return { kind: 'cross_kind', t1, t2 };
  return { kind: 'valid', t1, t2 };
}
