#!/usr/bin/env node
/**
 * タグ埋め込みによるクラスタリングが、LLM へ渡す前段として使えるかを実タグ全件で確認する。
 *
 * 「5,827 タグを1プロンプトに詰めるのは非現実的なので、先に意味が近いタグを集めて
 * クラスタ単位で LLM に渡す」という案の検証用。**採否を決める前に全件で測る**ためのもの。
 *
 * 見るべき点は3つ:
 *   1. **被覆率** — クラスタに入らないタグは LLM が一度も見ない。取りこぼしの規模
 *   2. **粒度** — 閾値を下げると連結が伸びて別概念が混ざり、上げると丸めたい塊が割れる
 *   3. **既知ペアの再現** — 統合したい組が同じクラスタに入り、統合したくない組が分かれるか
 *
 *   node tools/text-check/cluster-check.mjs --db tools/embedding-check/results/snapshot-bge-m3.db --model bge-m3
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WANT_TOGETHER, WANT_APART } from './seeds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DB_PATH = path.resolve(arg('db', path.join(HERE, 'results/snapshot.db')));
const MODEL = arg('model', 'bge-m3');
const THRESHOLDS = arg('thresholds', '0.85,0.88,0.90,0.92,0.95').split(',').map(Number);
/**
 * 単語数で絞る。**Pass S は `multi`（複合語）で測る。**
 *
 * 段2（包括関係）は単語1語 basic、Pass S（同義・粒度）は複合語 basic を対象にする。
 * 全件で測ると両方が混ざり、どちらの経路の性能なのか分からなくなる。
 */
const WORDS = arg('words', 'all'); // single | multi | all
/** 種別。**Pass S の対象は basic の複合語**なので `--kind basic --words multi` で測る */
const KIND = arg('kind', 'all'); // basic | descriptive | all

function load() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const tags = new Map();
    const byName = new Map();
    for (const r of db.prepare('SELECT id, name, name_ja, tag_kind AS kind FROM tags WHERE is_category = 0').all()) {
      const single = !r.name.includes('_');
      if (WORDS === 'single' && !single) continue;
      if (WORDS === 'multi' && single) continue;
      if (KIND !== 'all' && r.kind !== KIND) continue;
      const t = { id: r.id, name: r.name, nameJa: r.name_ja?.trim() || null, kind: r.kind };
      tags.set(r.id, t);
      byName.set(r.name, r.id);
    }
    const vectors = new Map();
    let dim = 0;
    for (const r of db.prepare('SELECT tag_id, vector FROM tag_embeddings WHERE model = ?').all(MODEL)) {
      if (!tags.has(r.tag_id)) continue;
      const buf = Buffer.from(r.vector);
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
      let n = 0;
      for (let i = 0; i < v.length; i++) n += v[i] * v[i];
      n = Math.sqrt(n);
      if (n === 0) continue;
      for (let i = 0; i < v.length; i++) v[i] /= n;
      vectors.set(r.tag_id, v);
      dim = v.length;
    }
    if (!dim) throw new Error(`モデル ${MODEL} のベクトルが無い`);
    return { tags, byName, vectors, dim };
  } finally {
    db.close();
  }
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function cluster(ids, vectors, dim, threshold) {
  const adj = new Map();
  for (let i = 0; i < ids.length; i++) {
    const va = vectors.get(ids[i]);
    for (let j = i + 1; j < ids.length; j++) {
      if (dot(va, vectors.get(ids[j])) >= threshold) {
        if (!adj.has(ids[i])) adj.set(ids[i], []);
        if (!adj.has(ids[j])) adj.set(ids[j], []);
        adj.get(ids[i]).push(ids[j]);
        adj.get(ids[j]).push(ids[i]);
      }
    }
  }
  const seen = new Set();
  const groups = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const members = [];
    const q = [s];
    seen.add(s);
    while (q.length) {
      const c = q.pop();
      members.push(c);
      for (const nb of adj.get(c) ?? []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    groups.push(members);
  }
  return groups;
}

function main() {
  console.log(`db    : ${DB_PATH}`);
  console.log(`model : ${MODEL} / kind=${KIND} / words=${WORDS}\n`);
  const { tags, byName, vectors, dim } = load();
  const withVec = [...tags.keys()].filter((id) => vectors.has(id));
  console.log(`タグ ${tags.size} 件 / ベクトル有り ${withVec.length} 件 / ${dim} 次元\n`);

  // 本番は種別をまたぐ統合を判定前に落とすので、種別内で閉じる
  const byKind = new Map();
  for (const id of withVec) {
    const k = tags.get(id).kind;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(id);
  }

  console.log('=== 閾値ごとのクラスタ構造（全件） ===\n');
  const head = ['閾値', 'クラスタ数', '最大', '2件のみ', 'クラスタ内タグ', '被覆率', '16件超'];
  const rows = [];
  const groupsByTh = new Map();
  for (const th of THRESHOLDS) {
    let all = [];
    for (const [, ids] of byKind) all = all.concat(cluster(ids, vectors, dim, th));
    groupsByTh.set(th, all);
    const covered = all.reduce((s, g) => s + g.length, 0);
    const sizes = all.map((g) => g.length).sort((a, b) => b - a);
    rows.push([
      th.toFixed(2), String(all.length), String(sizes[0] ?? 0),
      String(sizes.filter((s) => s === 2).length), String(covered),
      `${((covered / withVec.length) * 100).toFixed(1)}%`,
      String(sizes.filter((s) => s > 15).length),
    ]);
  }
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cs) => cs.map((c, i) => c.padStart(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((x) => '-'.repeat(x)).join('  '));
  rows.forEach((r) => console.log(line(r)));
  console.log('\n  被覆率 = 何らかのクラスタに入ったタグの割合。**入らなかったタグは LLM が一度も見ない。**');

  // 既知ペアが同じクラスタに入るか
  const groupOf = (groups) => {
    const m = new Map();
    groups.forEach((g, gi) => g.forEach((id) => m.set(id, gi)));
    return m;
  };
  const check = (title, pairs, expectTogether) => {
    console.log(`\n=== ${title} ===\n`);
    const hd = ['ペア', '類似度', ...THRESHOLDS.map((t) => t.toFixed(2))];
    const rs = [];
    for (const [a, b, why] of pairs) {
      const ia = byName.get(a);
      const ib = byName.get(b);
      if (ia == null || ib == null || !vectors.has(ia) || !vectors.has(ib)) {
        rs.push([`${a} ↔ ${b}`, '取得不可', ...THRESHOLDS.map(() => '-')]);
        continue;
      }
      const s = dot(vectors.get(ia), vectors.get(ib));
      const cells = THRESHOLDS.map((th) => {
        const m = groupOf(groupsByTh.get(th));
        const same = m.has(ia) && m.get(ia) === m.get(ib);
        // 期待通りなら ○、外れたら ×
        return same === expectTogether ? '○' : '×';
      });
      rs.push([`${a} ↔ ${b}`, s.toFixed(4), ...cells, why]);
    }
    const hd2 = [...hd, '種類'];
    const w2 = hd2.map((h, i) => Math.max(h.length, ...rs.map((r) => (r[i] ?? '').length)));
    const l2 = (cs) => cs.map((c, i) => (c ?? '').padEnd(w2[i])).join('  ');
    console.log(l2(hd2));
    console.log(w2.map((x) => '-'.repeat(x)).join('  '));
    rs.forEach((r) => console.log(l2(r)));
  };
  check('統合してほしい組が同じクラスタに入るか（○=入る）', WANT_TOGETHER, true);
  check('統合してほしくない組が分かれるか（○=分かれる）', WANT_APART, false);
}

main();
