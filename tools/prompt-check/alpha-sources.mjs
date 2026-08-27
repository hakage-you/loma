#!/usr/bin/env node
/**
 * 実ライブラリから「アルファチャンネルを持つ画像」の候補パスを書き出す。
 *
 * ここでは PNG の IHDR を読むだけで、**実際に透明な画素があるかは見ない**
 * （チャンネルはあるが全面不透明なファイルが多い）。実物の判定は Rust 側の
 * `export_transparent_variants` が decode してから行う。ここは候補を絞るだけ。
 *
 *   node tools/prompt-check/alpha-sources.mjs --out <ファイル> [--limit 400]
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dbPath = arg('db', join(homedir(), 'AppData', 'Roaming', 'com.hakageyou.loma', 'loma.db'));
const outPath = arg('out', join(process.cwd(), 'alpha-sources.txt'));
const limit = parseInt(arg('limit', '400'), 10);
// 機械生成物を計測セットから外す（Unity の PackageCache など）。
// 同じ素材が何プロジェクトにも複製されており、混ぜると計測が偏る
const exclude = (arg('exclude', '') || '').split(',').map((x) => x.trim()).filter(Boolean);

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("SELECT file_path FROM media WHERE LOWER(file_path) LIKE '%.png' ORDER BY id")
  .all();

/** PNG の IHDR カラータイプ。4=グレー+A / 6=RGB+A */
function pngColorType(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const b = Buffer.alloc(26);
    readSync(fd, b, 0, 26, 0);
    if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
    return b[25];
  } finally {
    closeSync(fd);
  }
}

const all = [];
for (const r of rows) {
  const ct = pngColorType(r.file_path);
  if (ct === 4 || ct === 6) all.push(r.file_path);
}

// **先頭から取らない。** 連番で書き出された同一素材が固まっているため、
// 先頭 N 件を取ると「ほぼ同じ画像を8枚」測ることになる（実際にそうなった）。
// ライブラリ全体から等間隔に拾い、同じフォルダからは既定2枚までに抑える。
const perDir = parseInt(arg('per-dir', '2'), 10);
const dirCount = new Map();
const hits = [];
const step = Math.max(1, Math.floor(all.length / Math.max(1, limit)));
for (let pass = 0; pass < step && hits.length < limit; pass++) {
  for (let i = pass; i < all.length && hits.length < limit; i += step) {
    const p = all[i];
    if (exclude.some((x) => p.includes(x))) continue;
    const dir = dirname(p);
    const n = dirCount.get(dir) || 0;
    if (n >= perDir) continue;
    dirCount.set(dir, n + 1);
    hits.push(p);
  }
}
console.log(`アルファチャンネルあり ${all.length} 件 / フォルダ ${dirCount.size} 箇所から抽出`);

writeFileSync(outPath, hits.join('\n') + '\n', 'utf8');
console.log(`PNG ${rows.length} 件を走査 / アルファチャンネルあり ${hits.length} 件 -> ${outPath}`);
