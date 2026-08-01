/**
 * 「類似検索がタグ検索と同じ結果になる」問題の計測。
 *
 * 重心はタグベクトルの IDF 重み付き平均なので、**コサインが最大になるのは
 * タグ集合が重なっているとき**である。つまり上位ほどタグ検索で到達できる候補になり、
 * この機能の固有価値（タグ完全一致では届かない類似）が見えなくなる。
 *
 * ここでは3つの指標を同じ基準・同じ候補集合で比べる。
 *
 *   1. plain    現行。重心をそのまま内積する
 *   2. residual 基準と候補で**共有しているタグを両側から外して**から重心を作り直す
 *   3. synonym  さらに、残ったタグ同士でベクトルが近い組（既定 cos >= 0.85）も外す
 *
 * 2 だけでは足りない可能性がある。タグ語彙は揺れており（`缶` と `ビール缶` は別 id）、
 * id の一致でしか省けないため。3 はそれを吸収できるかを見るための対照。
 *
 * 使い方:
 *   node tools/embedding-check/lexical-overlap.mjs --db tools/embedding-check/results/snapshot-bge-m3.db
 *   オプション: --model bge-m3 --bases 40 --seed 42 --examples 3 --syn 0.85
 *              --no-centering --include-descriptive
 */

import path from 'node:path';
import { defaultDbPath, snapshot } from './snapshot.mjs';
import { buildLibrary, sampleBases, dot, MIN_BASIC_TAGS, ZONE_BAND_MAX } from './library.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const model = arg('model', 'bge-m3');
const baseCount = Number(arg('bases', 40));
const seed = arg('seed', '42');
const exampleCount = Number(arg('examples', 3));
const synThreshold = Number(arg('syn', 0.85));
const centering = !flag('no-centering');
const includeDescriptive = flag('include-descriptive');
const BAND = ZONE_BAND_MAX;

let dbPath = arg('db', null);
if (!dbPath) {
  const src = defaultDbPath(repoRoot);
  if (!src) throw new Error('この OS では既定パスを解決できません。--db <path> を指定してください');
  const r = snapshot(src, path.join(repoRoot, 'tools/embedding-check/results/snapshot.db'));
  console.log(`snapshot: ${src} -> ${r.dest}\n`);
  dbPath = r.dest;
}

const lib = buildLibrary({ dbPath, model, centering, includeDescriptive });
const { N, dim, centroids, tagIds, basicIds } = lib;

console.log(`db: ${dbPath}`);
console.log(`model: ${model} (dim ${dim}) / centering ${centering ? 'ON' : 'OFF'} / descriptive ${includeDescriptive ? 'ON' : 'OFF'}`);
console.log(`候補: ${N} 件（解析済み ${lib.completedCount} / basic>=${MIN_BASIC_TAGS} ${lib.eligibleCount}）`);
console.log(`上位帯 ${BAND} 件 / 類義しきい値 cos >= ${synThreshold}\n`);

// --- タグ同士のコサインはキャッシュする（語彙が偏るので効く） ---
const tagCosCache = new Map();
function tagCos(a, b) {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  let v = tagCosCache.get(key);
  if (v === undefined) {
    const va = lib.tagVector(a);
    const vb = lib.tagVector(b);
    v = va && vb ? dot(va, vb) : 0;
    tagCosCache.set(key, v);
  }
  return v;
}

/** 共有タグを外した残差集合。`synonym` なら類義タグの組も貪欲に外す */
function residualSets(bi, j, { synonym }) {
  const shared = new Set();
  const bSet = new Set(tagIds[bi]);
  for (const t of tagIds[j]) if (bSet.has(t)) shared.add(t);
  let a = tagIds[bi].filter((t) => !shared.has(t));
  let b = tagIds[j].filter((t) => !shared.has(t));

  if (synonym) {
    // 貪欲マッチング。最も近い組から外す。組数は高々 min(|a|,|b|)
    for (;;) {
      let best = null;
      for (const x of a) {
        for (const y of b) {
          const c = tagCos(x, y);
          if (c >= synThreshold && (!best || c > best.c)) best = { x, y, c };
        }
      }
      if (!best) break;
      a = a.filter((t) => t !== best.x);
      b = b.filter((t) => t !== best.y);
    }
  }
  return [a, b];
}

/**
 * 比べる指標。
 *
 * `filter@τ` は指標ではなく**候補の絞り込み**で、Jaccard が τ 以上の候補を上位ゾーンから外す。
 * 「タグ検索で到達できるものは出さない」を直接書いたもの。
 *
 * `residual` と `plain` は、**共有タグが 0 の候補では数学的に一致する**（省くものが無い）。
 * つまり残差指標の効果は、部分的に重なっている候補の扱いにしか現れない。
 *
 * `synonym` は既定で外してある（`--with-synonym` で復活）。残差の中の類義タグ組も省く案だが、
 * 「缶」と「サバ缶」のような**価値のあるヒットの根拠そのものを消す**。
 * 計測でも共有0件率は 67% → 68% で、コスト2倍に対して効果が無かった。
 */
const TAUS = (arg('taus', '0.5,0.25,0.1,0.001') ?? '').split(',').map(Number);
const METRICS = [
  { key: 'plain', label: '現行（そのまま）' },
  { key: 'residual', label: '同タグを省く' },
  ...(flag('with-synonym') ? [{ key: 'synonym', label: '同タグ+類義を省く' }] : []),
  ...TAUS.map((t) => ({ key: `filter@${t}`, label: `Jaccard>=${t} を除外` })),
];

/** 基準 bi に対する全候補のスコア。除外された候補は含まない */
function scoreAll(bi, metric) {
  const out = [];
  if (metric === 'plain' || metric.startsWith('filter@')) {
    const tau = metric.startsWith('filter@') ? Number(metric.slice('filter@'.length)) : Infinity;
    for (let j = 0; j < N; j++) {
      if (j === bi) continue;
      if (overlap(bi, j).jaccard >= tau) continue;
      out.push([j, dot(centroids[bi], centroids[j])]);
    }
    return out;
  }
  const synonym = metric === 'synonym';
  for (let j = 0; j < N; j++) {
    if (j === bi) continue;
    const [a, b] = residualSets(bi, j, { synonym });
    if (!a.length || !b.length) continue; // 片側が空 = 比べるものが残っていない
    const ca = lib.centroidOf(a);
    const cb = lib.centroidOf(b);
    if (!ca || !cb) continue;
    out.push([j, dot(ca, cb)]);
  }
  return out;
}

/** 基準の basic タグと候補の basic タグの重なり */
function overlap(bi, j) {
  const a = basicIds[bi];
  const b = basicIds[j];
  let inter = 0;
  for (const t of b) if (a.has(t)) inter++;
  return { shared: inter, jaccard: inter / (a.size + b.size - inter) };
}

const bases = sampleBases(N, baseCount, seed);

// --- 1. 現行指標で、順位ごとにどれだけタグが重なっているか ---
console.log('=== 現行指標: 順位ごとのタグ重複（基準 %d 件平均 / basic タグのみ） ===', bases.length);
console.log('順位  類似度  共有タグ数  Jaccard  共有0件の割合');
{
  // 上位帯と最下位帯の両方を見る。最下位帯で共有タグが 0 なら、
  // 「同タグを省く」指標に替えても最下位ゾーンは実質変わらない（残差 = 全体）
  const ranks = [...Array(BAND).keys(), ...Array(BAND).keys()].map((r, i) => (i < BAND ? r : N - 1 - BAND + (i - BAND)));
  const rows = new Map(ranks.map((r) => [r, { sim: 0, shared: 0, jac: 0, zero: 0 }]));
  for (const bi of bases) {
    const ranked = scoreAll(bi, 'plain').sort((x, y) => y[1] - x[1]);
    for (const r of ranks) {
      const [j, s] = ranked[r];
      const o = overlap(bi, j);
      const row = rows.get(r);
      row.sim += s;
      row.shared += o.shared;
      row.jac += o.jaccard;
      if (o.shared === 0) row.zero++;
    }
  }
  const B = bases.length;
  for (const r of ranks) {
    if (r === ranks[BAND]) console.log('  --- 最下位帯 ---');
    const row = rows.get(r);
    console.log(
      `${String(r + 1).padStart(4)}  ${(row.sim / B).toFixed(3).padStart(6)}  ${(row.shared / B).toFixed(1).padStart(10)}` +
        `  ${(row.jac / B).toFixed(2).padStart(7)}  ${((row.zero / B) * 100).toFixed(0).padStart(12)}%`,
    );
  }
}

// --- 2. 指標を変えると上位帯の重複はどうなるか ---
console.log('\n=== 指標ごとの上位帯 %d 件（基準 %d 件平均） ===', BAND, bases.length);
console.log('指標                 共有タグ数  Jaccard  共有0件の割合  類似度  除外(平均/最大)  所要ms/件');
const summary = new Map();
for (const { key, label } of METRICS) {
  let shared = 0;
  let jac = 0;
  let zero = 0;
  let sim = 0;
  let unusable = 0;
  let worst = 0;
  const t0 = performance.now();
  for (const bi of bases) {
    const all = scoreAll(bi, key);
    unusable += N - 1 - all.length;
    // 平均だけ見ると、共通タグの多い基準（例: 猫）で候補が枯れる事故を見落とす
    worst = Math.max(worst, N - 1 - all.length);
    const ranked = all.sort((x, y) => y[1] - x[1]).slice(0, BAND);
    for (const [j, s] of ranked) {
      const o = overlap(bi, j);
      shared += o.shared;
      jac += o.jaccard;
      if (o.shared === 0) zero++;
      sim += s;
    }
  }
  const ms = (performance.now() - t0) / bases.length;
  const n = bases.length * BAND;
  summary.set(key, { shared: shared / n, jac: jac / n, zero: zero / n, sim: sim / n, unusable: unusable / bases.length, worst, ms });
  const s = summary.get(key);
  console.log(
    `${label.padEnd(21)}${s.shared.toFixed(1).padStart(10)}  ${s.jac.toFixed(2).padStart(7)}  ` +
      `${(s.zero * 100).toFixed(0).padStart(12)}%  ${s.sim.toFixed(3).padStart(6)}  ` +
      `${s.unusable.toFixed(0).padStart(6)}/${String(s.worst).padStart(4)}  ${s.ms.toFixed(0).padStart(9)}`,
  );
}

// --- 3. 目視用の実例 ---
// 全指標を並べると読めないので、目視は現行・残差・代表的なしきい値の3つに絞る
const exampleTau = arg('example-tau', '0.25');
const exampleMetrics = METRICS.filter((m) => m.key === 'plain' || m.key === 'residual' || m.key === `filter@${exampleTau}`);

console.log('\n=== 実例（★ = 基準と共有しているタグ） ===');
for (const bi of bases.slice(0, exampleCount)) {
  const names = (j) => tagIds[j].map((t) => (basicIds[bi].has(t) ? `★${lib.tagName(t)}` : lib.tagName(t))).join(', ');
  console.log(`\n■ 基準: ${lib.fileName(lib.ids[bi])}`);
  console.log(`  [${[...basicIds[bi]].map((t) => lib.tagName(t)).join(', ')}]`);
  for (const { key, label } of exampleMetrics) {
    console.log(`  --- ${label} ---`);
    const ranked = scoreAll(bi, key).sort((x, y) => y[1] - x[1]).slice(0, 4);
    for (const [j, s] of ranked) {
      const o = overlap(bi, j);
      console.log(
        `    ${s >= 0 ? '+' : ''}${s.toFixed(3)} 共有${o.shared}  ${lib.fileName(lib.ids[j])}`,
      );
      console.log(`            [${names(j)}]`);
    }
  }
}

console.log('\n読み方は tools/embedding-check/README.md の「タグ重複」を参照。');
