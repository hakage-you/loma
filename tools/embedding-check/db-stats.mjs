/**
 * ライブラリの素性を数える。Ollama も cargo も要らない、純粋な読み取り。
 *
 * 類似度の計測結果を読むときに、**母集団がどうなっているかを知らないと解釈を誤る**。
 * 例: 2026-07-30 の計測では「descriptive 保有群と非保有群の分離度」を測ろうとしたが、
 * 実際には全メディアが descriptive を保有していて対照群が存在せず、
 * 指標は最初から意味を持ち得なかった。それはこのスクリプトを先に走らせれば分かる。
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, snapshot } from './snapshot.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const explicit = arg('db', null);
let dbPath = explicit;
if (!dbPath) {
  // 既定は稼働中のDB。WAL を取りこぼさないようスナップショット経由で読む
  const src = defaultDbPath(repoRoot);
  if (!src) throw new Error('この OS では既定パスを解決できません。--db <path> を指定してください');
  const r = snapshot(src, path.join(repoRoot, 'tools/embedding-check/results/snapshot.db'));
  console.log(`snapshot: ${src} (WAL ${(r.walBytes / 1e6).toFixed(2)} MB を反映) -> ${r.dest}\n`);
  dbPath = r.dest;
}

const db = new DatabaseSync(dbPath);
const q = (s, ...p) => db.prepare(s).all(...p);
const one = (s, ...p) => q(s, ...p)[0];

// アプリ側の定数と揃えること（src-tauri/src/embedding.rs の MIN_BASIC_TAGS）
const MIN_BASIC_TAGS = Number(arg('min-basic', 3));

console.log('=== メディア ===');
for (const r of q('SELECT analysis_status s, COUNT(*) c FROM media GROUP BY analysis_status ORDER BY c DESC')) {
  console.log(`  ${r.s.padEnd(10)} ${r.c}`);
}

console.log('\n=== タグ ===');
console.log(`  合計 ${one('SELECT COUNT(*) c FROM tags').c}`);
for (const r of q('SELECT tag_kind k, is_category ic, COUNT(*) c FROM tags GROUP BY tag_kind, is_category')) {
  console.log(`  ${r.ic ? 'category' : r.k.padEnd(11)} ${r.c}`);
}
const noJa = one("SELECT COUNT(*) c FROM tags WHERE name_ja IS NULL OR TRIM(name_ja) = ''").c;
// 埋め込みには name_ja を投入する（英語名は normalize_tag_en が壊すため）。
// ここが 0 でないと、その分だけ英語フォールバック経路を通る。
console.log(`  name_ja なし ${noJa}${noJa ? '  <- 埋め込みは英語名にフォールバックする' : ''}`);

console.log(`\n=== basic タグ本数の分布（解析済みメディア / カテゴリは数えない） ===`);
const hist = q(`
  SELECT n, COUNT(*) c FROM (
    SELECT mt.media_id, COUNT(DISTINCT mt.tag_id) n
    FROM media_tags mt
    JOIN tags t ON t.id = mt.tag_id
    JOIN media m ON m.id = mt.media_id
    WHERE m.analysis_status = 'completed' AND t.is_category = 0 AND t.tag_kind = 'basic'
    GROUP BY mt.media_id
  ) GROUP BY n ORDER BY n`);
const totalWithBasic = hist.reduce((a, r) => a + r.c, 0);
const completed = one("SELECT COUNT(*) c FROM media WHERE analysis_status = 'completed'").c;
for (const r of hist) {
  const mark = r.n < MIN_BASIC_TAGS ? ' <- 対象外' : '';
  console.log(`  ${String(r.n).padStart(3)}個: ${String(r.c).padStart(5)} ${'#'.repeat(Math.max(1, Math.round((r.c * 40) / Math.max(...hist.map((h) => h.c)))))}${mark}`);
}
// basic タグが1つも無いメディアは上の集計に現れないので、差分から復元する
const zeroBasic = completed - totalWithBasic;
if (zeroBasic > 0) console.log(`  ${String(0).padStart(3)}個: ${String(zeroBasic).padStart(5)} <- 対象外`);
const excluded = zeroBasic + hist.filter((r) => r.n < MIN_BASIC_TAGS).reduce((a, r) => a + r.c, 0);
console.log(`  => 参加 ${completed - excluded} / 除外 ${excluded} (${((excluded * 100) / Math.max(completed, 1)).toFixed(1)}%)`);

console.log('\n=== descriptive タグの保有状況 ===');
const withDesc = one(`
  SELECT COUNT(DISTINCT mt.media_id) c FROM media_tags mt
  JOIN tags t ON t.id = mt.tag_id
  JOIN media m ON m.id = mt.media_id
  WHERE m.analysis_status = 'completed' AND t.tag_kind = 'descriptive'`).c;
console.log(`  保有 ${withDesc} / 非保有 ${completed - withDesc}`);
if (completed - withDesc === 0 || withDesc === 0) {
  // 群分離の指標は両群が存在しないと計算できない。先にここで分かるようにしておく。
  console.log('  !! 片方の群が空のため、群分離（desc 群内 vs 群間）の指標は測定不能');
}

console.log('\n=== 生成済みベクトル ===');
// tag_embeddings は v0.5.0 で追加したテーブル。それ以前のDBには存在しない。
const hasTable = one("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='tag_embeddings'").c > 0;
const emb = hasTable
  ? q('SELECT model, COUNT(*) c, MAX(dim) dim, SUM(LENGTH(vector)) bytes FROM tag_embeddings GROUP BY model')
  : [];
if (!hasTable) {
  console.log('  tag_embeddings テーブルがない（このDBは v0.5.0 より前のアプリで作られている）');
} else if (emb.length === 0) {
  console.log('  なし（設定画面または run.mjs で生成する）');
} else {
  const tags = one('SELECT COUNT(*) c FROM tags').c;
  for (const r of emb) {
    console.log(`  ${r.model.padEnd(24)} ${r.c}/${tags} 件 / ${r.dim}次元 / ${(r.bytes / 1e6).toFixed(1)} MB`);
  }
}

db.close();
