#!/usr/bin/env node
/**
 * 「basic タグを1プロンプトに全部入れる」という賭けに**負けた場合**の代案を、GPU を使わずに判定する。
 *
 * **問い。** 分割が必須になったとき、問題は「分割するか」ではなく
 * 「**どう分ければ、統合すべき組が同じ区画に入るか**」になる。
 * 区画に分かれてしまった組は、LLM が何をしようと永久に提案されない。
 *
 * **なぜ閾値クラスタでは駄目なのか。** `greenhouse` ↔ `structure` は cos 0.3528 で、
 * 誤爆である `bear` ↔ `bean` (0.3815) より低い。閾値で切る限り絶対に同居しない
 * （`cluster-check.mjs` で計測済み）。**しかしそれは「0.90 で切ったら」の話であって、
 * 「粗く N 件ずつに割ったら同じ区画か」は別の問い。** 包括語は埋め込み空間でハブに
 * なりやすく、個々の類似度が低くても領域の中心付近に居る可能性がある。逆に
 * 「包括語だけが集まった区画」ができて子と全部離れる失敗もありえる。**測れば決まる。**
 *
 * **判定の非対称性。** 区画の仕事は同居させること（再現率）だけ。
 * 統合すべきでない組が同居しても失敗ではない — 区画の中で棄却するのが LLM の仕事。
 * よって WANT_APART は情報として出すだけで、合否には数えない。
 *
 * **ランダム基準を必ず併記する。** 上限300件なら区画は8個前後で、
 * でたらめに割っても 12% 程度は同居する。この分母なしに同居率は読めない。
 *
 *   node tools/text-check/partition-check.mjs --db tools/embedding-check/results/snapshot-bge-m3.db --model bge-m3
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { HIERARCHY_SEEDS, WANT_TOGETHER, WANT_APART } from './seeds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DB_PATH = path.resolve(arg('db', path.join(HERE, 'results/snapshot.db')));
const MODEL = arg('model', 'bge-m3');
const KIND = arg('kind', 'basic');
/**
 * 入力を単語数で絞る。**`single` は Pass H の分割可否を測るためのもの。**
 *
 * basic 全件（2,287件）で測ると階層同居は19〜25%で不成立だった。しかし
 * **Pass H の入力は単語1語 basic 1,094件しかない**（階層14/18がここで閉じる）。
 * プールが半分になれば同じ上限でも区画数が減り、同居率は上がりうる。
 * 全件での結果をそのまま Pass H に当てはめてはいけない。**別の問い。**
 */
const WORDS = arg('words', 'all'); // single | multi | all
const CAPS = arg('caps', '100,200,300,500,800').split(',').map(Number);
/** 「埋め込みが既に同意しているペア」の対照実験に使う閾値 */
const EASY_TH = Number(arg('easy-threshold', '0.90'));

function load() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const tags = new Map();
    const byName = new Map();
    for (const r of db.prepare(
      'SELECT id, name, name_ja, tag_kind AS kind FROM tags WHERE is_category = 0'
    ).all()) {
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

/** 正規化された平均ベクトル（球面k-meansの重心） */
function centroid(ids, vectors, dim) {
  const c = new Float32Array(dim);
  for (const id of ids) {
    const v = vectors.get(id);
    for (let i = 0; i < dim; i++) c[i] += v[i];
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += c[i] * c[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) c[i] /= n;
  return c;
}

/**
 * 球面k-means (k=2) で1回分割する。
 * **初期値は決定的**（重心から最も遠い点 → その点から最も遠い点）。
 * 乱数を使うと同じ入力で結果が変わり、後から結論を検証できなくなる。
 */
function bisect(ids, vectors, dim) {
  const c = centroid(ids, vectors, dim);
  let a = ids[0];
  let best = Infinity;
  for (const id of ids) {
    const d = dot(vectors.get(id), c);
    if (d < best) { best = d; a = id; }
  }
  let b = ids[0];
  best = Infinity;
  const va0 = vectors.get(a);
  for (const id of ids) {
    const d = dot(vectors.get(id), va0);
    if (d < best) { best = d; b = id; }
  }

  let ca = vectors.get(a);
  let cb = vectors.get(b);
  let left = [];
  let right = [];
  for (let iter = 0; iter < 25; iter++) {
    const l = [];
    const r = [];
    for (const id of ids) {
      const v = vectors.get(id);
      (dot(v, ca) >= dot(v, cb) ? l : r).push(id);
    }
    // 片側が空になったら重心が退化している。距離順の中央で強制的に割る
    if (!l.length || !r.length) {
      const sorted = [...ids].sort((x, y) => dot(vectors.get(y), ca) - dot(vectors.get(x), ca));
      const mid = sorted.length >> 1;
      return [sorted.slice(0, mid), sorted.slice(mid)];
    }
    const stable = l.length === left.length && r.length === right.length
      && l.every((id, i) => id === left[i]);
    left = l;
    right = r;
    if (stable) break;
    ca = centroid(left, vectors, dim);
    cb = centroid(right, vectors, dim);
  }
  return [left, right];
}

/** どの区画も `cap` 件以下になるまで再帰的に二分する */
function partition(ids, vectors, dim, cap) {
  if (ids.length <= cap) return [ids];
  const [l, r] = bisect(ids, vectors, dim);
  // 分割が進まない（同一ベクトルの塊など）ときは添字で割って停止を保証する
  if (!l.length || !r.length || l.length === ids.length || r.length === ids.length) {
    const mid = ids.length >> 1;
    return [ids.slice(0, mid), ids.slice(mid)];
  }
  return [...partition(l, vectors, dim, cap), ...partition(r, vectors, dim, cap)];
}

/** でたらめに同じ区画へ入ってしまう確率。同居率はこれと比べて初めて読める */
function randomCoLocation(parts, n) {
  let same = 0;
  for (const p of parts) same += p.length * (p.length - 1);
  return same / (n * (n - 1));
}

function pad(rows, head, align = 'start') {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cs) => cs.map((c, i) => (align === 'start' ? (c ?? '').padStart(w[i]) : (c ?? '').padEnd(w[i]))).join('  ');
  return [line(head), w.map((x) => '-'.repeat(x)).join('  '), ...rows.map(line)].join('\n');
}

function main() {
  console.log(`db    : ${DB_PATH}`);
  console.log(`model : ${MODEL}`);
  console.log(`kind  : ${KIND} / words=${WORDS}\n`);

  const { tags, byName, vectors, dim } = load();
  const wordsOk = (id) => {
    const single = !tags.get(id).name.includes('_');
    return WORDS === 'single' ? single : WORDS === 'multi' ? !single : true;
  };
  const ids = [...tags.keys()].filter((id) => tags.get(id).kind === KIND && wordsOk(id) && vectors.has(id));
  const missing = [...tags.keys()].filter((id) => tags.get(id).kind === KIND && wordsOk(id) && !vectors.has(id));
  const N = ids.length;
  console.log(`対象 ${N} 件 / ${dim} 次元${missing.length ? ` （ベクトル欠損 ${missing.length} 件は除外）` : ''}\n`);

  // ---- 区画の構造 ----
  const byCap = new Map();
  const structRows = [];
  for (const cap of CAPS) {
    const parts = partition(ids, vectors, dim, cap);
    byCap.set(cap, parts);
    const sizes = parts.map((p) => p.length).sort((a, b) => b - a);
    const med = sizes[sizes.length >> 1];
    structRows.push([
      String(cap), String(parts.length), String(sizes[0]), String(med), String(sizes[sizes.length - 1]),
      `${(randomCoLocation(parts, N) * 100).toFixed(1)}%`,
    ]);
  }
  console.log('=== 区画の構造（球面k-meansの再帰二分割）===\n');
  console.log(pad(structRows, ['上限', '区画数', '最大', '中央', '最小', 'ランダム同居率']));
  console.log('\n  ランダム同居率 = でたらめに割っても同居してしまう割合。**同居率はこれとの差で読む。**');

  // ---- 区画の割り当てを引ける形に ----
  const assign = new Map();
  for (const cap of CAPS) {
    const m = new Map();
    byCap.get(cap).forEach((p, pi) => p.forEach((id) => m.set(id, pi)));
    assign.set(cap, m);
  }
  const coLocated = (cap, ia, ib) => assign.get(cap).has(ia) && assign.get(cap).get(ia) === assign.get(cap).get(ib);

  // ---- シードごとの同居 ----
  const seedTable = (title, pairs, note) => {
    console.log(`\n=== ${title} ===\n`);
    const rows = [];
    const hits = CAPS.map(() => 0);
    let evaluated = 0;
    for (const p of pairs) {
      const [a, b, why] = p;
      const ia = byName.get(a);
      const ib = byName.get(b);
      if (ia == null || ib == null || !assign.get(CAPS[0]).has(ia) || !assign.get(CAPS[0]).has(ib)) {
        rows.push([`${a} ⊃ ${b}`, '対象外', ...CAPS.map(() => '-'), why ?? '']);
        continue;
      }
      evaluated++;
      const cells = CAPS.map((cap, i) => {
        const same = coLocated(cap, ia, ib);
        if (same) hits[i]++;
        return same ? '○' : '×';
      });
      rows.push([`${a} ⊃ ${b}`, dot(vectors.get(ia), vectors.get(ib)).toFixed(4), ...cells, why ?? '']);
    }
    rows.push(['', '', ...CAPS.map(() => ''), '']);
    rows.push(['同居率', `n=${evaluated}`, ...hits.map((h) => (evaluated ? `${((h / evaluated) * 100).toFixed(0)}%` : '-')), '']);
    console.log(pad(rows, ['ペア', '類似度', ...CAPS.map((c) => `≤${c}`), '種類'], 'end'));
    if (note) console.log(`\n  ${note}`);
    return { hits, evaluated };
  };

  const hier = seedTable(
    '階層シードの同居（○=同じ区画 / これが本命）',
    HIERARCHY_SEEDS.map(([p, c]) => [p, c, '']),
    '**分かれた組は、LLM が何をしようと永久に提案されない。**'
  );
  seedTable(
    '良い例の同居（ユーザーが良いと評価した実例）',
    WANT_TOGETHER,
    'bright_* は descriptive の可能性があり、その場合 basic の区画には現れない（対象外）。'
  );
  seedTable(
    '悪い例の同居（情報のみ・合否に数えない）',
    WANT_APART,
    '同居しても失敗ではない。区画の仕事は同居させることだけで、棄却は区画の中で LLM がやる。'
  );

  // ---- 対照実験: 埋め込みが既に同意しているペアが保存されるか ----
  // ここが低ければ分割方法そのものが壊れている（階層以前の問題）
  console.log(`\n=== 対照実験: cos ≥ ${EASY_TH} のペアが保存されるか ===\n`);
  const easy = [];
  for (let i = 0; i < N; i++) {
    const va = vectors.get(ids[i]);
    for (let j = i + 1; j < N; j++) {
      if (dot(va, vectors.get(ids[j])) >= EASY_TH) easy.push([ids[i], ids[j]]);
    }
  }
  if (!easy.length) {
    console.log(`  cos ≥ ${EASY_TH} のペアが無い`);
  } else {
    const rows = [CAPS.map((cap) => {
      const kept = easy.filter(([a, b]) => coLocated(cap, a, b)).length;
      return `${((kept / easy.length) * 100).toFixed(1)}%`;
    })];
    console.log(pad(rows, CAPS.map((c) => `≤${c}`)));
    console.log(`\n  対象 ${easy.length} ペア。**ここが 95% を切るなら分割方法自体が壊れている**（階層以前の問題）。`);
  }

  // ---- 判定 ----
  console.log('\n=== 判定 ===\n');
  const randoms = CAPS.map((cap) => randomCoLocation(byCap.get(cap), N));
  CAPS.forEach((cap, i) => {
    const rate = hier.evaluated ? hier.hits[i] / hier.evaluated : 0;
    const lift = randoms[i] > 0 ? rate / randoms[i] : 0;
    console.log(`  上限 ${String(cap).padStart(4)} 件: 階層同居 ${(rate * 100).toFixed(0)}%  ランダム ${(randoms[i] * 100).toFixed(1)}%  倍率 ${lift.toFixed(1)}x`);
  });
  console.log('\n  読み方: 倍率が 1.0 付近なら、粗分割は階層を保存していない（＝ただの偶然）。');
  console.log('  その場合、分割方式では包括関係に到達できず、包括語アンカー方式か単一プロンプトの二択になる。');
}

main();
