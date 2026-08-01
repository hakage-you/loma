/**
 * 「解析設定の混在」を人工的に作り出して、群分離が実在するかを測れるようにする。
 *
 * 背景: 計画 §4.3 は「descriptive タグを重心に入れると、意味ではなく
 * "同じ設定で解析された" でクラスタリングされる」と主張していた。しかし実ライブラリは
 * **全メディアが descriptive を保有**しており対照群が存在せず、支持も否定もできなかった。
 *
 * ここでは解析済みメディアの一部から **descriptive タグの紐付けだけを外し**、
 * 「descriptive 無しで解析されたメディア」を人工的に作る。
 *
 * **これは模擬であって実データではない。** 紐付けを外したメディアの basic タグは
 * DETAILED 由来のまま（5〜10個の的確な語）で、本物の LIGHT 解析メディアの
 * basic タグ（3〜5個のより汎用的な語）とは違う。したがってこの実験が答えるのは
 * **「descriptive の有無だけで群が分かれるか」**という一点に限られる。
 * それはまさに `spectrum_include_descriptive` の是非を決める問いなので、目的には合う。
 *
 * 割り当ては乱択（シード固定）。カテゴリや撮影時期で切ると、群と内容が交絡して
 * 「群が分かれた」のか「内容が違った」のか判別できなくなる。
 *
 *   node tools/embedding-check/make-control-group.mjs --from results/snapshot-bge-m3.db
 *   node tools/embedding-check/run.mjs --db tools/embedding-check/results/control-group.db --models bge-m3 --only dist
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, snapshot } from './snapshot.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const resultsDir = path.join(repoRoot, 'tools/embedding-check/results');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 割合。0.5 で半々に分ける */
const RATIO = Number(arg('ratio', '0.5'));
const SEED = Number(arg('seed', '20260730'));
const dest = path.join(resultsDir, 'control-group.db');

// --from を渡せば、ベクトル生成済みのスナップショットから作れる（再生成の数分を省ける）
const fromArg = arg('from', null);
const src = fromArg ? path.resolve(repoRoot, fromArg) : defaultDbPath(repoRoot);
if (!src) throw new Error('この OS では既定パスを解決できません。--from <db> を指定してください');

const snap = snapshot(src, dest);
console.log(`元: ${src}`);
console.log(`先: ${dest} (${(snap.destBytes / 1e6).toFixed(2)} MB)\n`);

const db = new DatabaseSync(dest);

const completed = db
  .prepare("SELECT id FROM media WHERE analysis_status = 'completed' ORDER BY id")
  .all()
  .map((r) => r.id);

// 決定的な乱択（SplitMix64）。同じシードなら同じ群割りになる
let s = BigInt(SEED);
const M = (1n << 64n) - 1n;
const nextFloat = () => {
  s = (s + 0x9e3779b97f4a7c15n) & M;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
  z = z ^ (z >> 31n);
  return Number(z >> 11n) / 2 ** 53;
};

const control = completed.filter(() => nextFloat() < RATIO);
console.log(`解析済み ${completed.length} 件のうち ${control.length} 件を「descriptive 無し」群にする`);

// descriptive タグの紐付けだけを外す。tags 側は残すので、ベクトルは再生成しなくて済む
const del = db.prepare(
  `DELETE FROM media_tags
   WHERE media_id = ?
     AND tag_id IN (SELECT id FROM tags WHERE tag_kind = 'descriptive')`,
);
db.exec('BEGIN');
let removed = 0;
for (const id of control) removed += del.run(id).changes;
db.exec('COMMIT');

const withDesc = db
  .prepare(
    `SELECT COUNT(DISTINCT mt.media_id) c FROM media_tags mt
     JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
     WHERE m.analysis_status = 'completed' AND t.tag_kind = 'descriptive'`,
  )
  .all()[0].c;

console.log(`紐付けを ${removed} 件削除`);
console.log(`結果: descriptive 保有 ${withDesc} 件 / 非保有 ${completed.length - withDesc} 件`);

// basic タグ3個未満に落ちていないか確認する。落ちていると候補集合から外れ、
// 「群分離を測った」つもりが「除外された群を測った」ことになる
const belowFloor = db
  .prepare(
    `SELECT COUNT(*) c FROM (
       SELECT mt.media_id FROM media_tags mt
       JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
       WHERE m.analysis_status = 'completed' AND t.is_category = 0 AND t.tag_kind = 'basic'
       GROUP BY mt.media_id HAVING COUNT(DISTINCT mt.tag_id) >= 3)`,
  )
  .all()[0].c;
console.log(`basic タグ3個以上のメディア: ${belowFloor} / ${completed.length}`);

db.close();
console.log(`\n次: node tools/embedding-check/run.mjs --db ${path.relative(repoRoot, dest)} --models bge-m3 --only dist`);
