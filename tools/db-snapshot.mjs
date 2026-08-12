#!/usr/bin/env node
// 実DBのスナップショットとタグ一覧の書き出し。
//
// **アプリを起動したまま実行してよい。** `VACUUM INTO` は WAL の内容を取り込んだ
// 単一ファイルを作るので、`-wal` / `-shm` を別途コピーする必要がない
// （素朴に .db だけコピーすると、WAL に残った変更が抜けた壊れた写しになる）。
//
//   node tools/db-snapshot.mjs
//   node tools/db-snapshot.mjs --db <path> --out <dir>
//
// 出力:
//   <dir>/loma.db.backup-YYYYMMDD-HHMM   復元用の完全な写し
//   <dir>/tags-YYYYMMDD-HHMM.tsv         タグ一覧（統合の前後で差分を取るため）

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DEFAULT_DB = join(homedir(), 'AppData', 'Roaming', 'com.hakageyou.loma', 'loma.db');
const dbPath = arg('db', DEFAULT_DB);
const outDir = arg('out', dbPath.replace(/[/\\][^/\\]+$/, ''));

if (!existsSync(dbPath)) {
  console.error(`DB が見つかりません: ${dbPath}`);
  console.error('--db でパスを指定してください。');
  process.exit(1);
}

const d = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
const outDb = join(outDir, `loma.db.backup-${stamp}`);
const outTsv = join(outDir, `tags-${stamp}.tsv`);

if (existsSync(outDb)) {
  console.error(`同じ名前の写しが既にあります: ${outDb}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${outDb.replace(/\\/g, '/')}'`);

const rows = db.prepare(`
  SELECT t.id, t.name, COALESCE(t.name_ja, '') AS ja, t.is_category, t.tag_kind,
         COUNT(mt.media_id) AS cnt
  FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
  GROUP BY t.id ORDER BY t.id
`).all();

writeFileSync(
  outTsv,
  'id\tname\tname_ja\tis_category\ttag_kind\tcount\n' +
    rows.map((r) => [r.id, r.name, r.ja, r.is_category, r.tag_kind, r.cnt].join('\t')).join('\n'),
  'utf8'
);

const byKind = {};
for (const r of rows) byKind[r.tag_kind] = (byKind[r.tag_kind] || 0) + 1;
const mb = (f) => (statSync(f).size / 1024 / 1024).toFixed(1);

console.log(`タグ ${rows.length}件  ${Object.entries(byKind).map(([k, v]) => `${k}: ${v}件`).join(' / ')}`);
console.log(`カテゴリ ${rows.filter((r) => r.is_category).length}件 / メディア紐付け ${rows.reduce((a, r) => a + r.cnt, 0)}件`);
console.log(`\n${outDb}  ${mb(outDb)}MB`);
console.log(`${outTsv}  ${mb(outTsv)}MB`);
