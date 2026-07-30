/**
 * ゾーンの「帯幅」を決めるための分布計測。
 *
 * `src-tauri/src/embedding.rs` の各ゾーンは、順位の帯（既定で候補数の 10%）から
 * `ZONE_SIZE` 件を無作為抽出する。帯を順位で切ると、**帯が覆う類似度の幅は
 * 分布上の位置によって桁で変わる**。分布の裾（最類似・最非類似）は疎なので、
 * 同じ 10% でも中央では 0.0x、裾では 0.5 超を覆ってしまう。
 * つまり「タグの類似度が高い」枠に、平均より少し上の凡庸な候補が入り込む。
 *
 * このスクリプトは帯幅の候補ごとに
 *   - 帯が覆う類似度の幅（裾がどれだけ薄まるか）
 *   - 帯の下端が平均から何σ離れているか
 *   - 最類似の 1 件が 4 件の抽出に入る確率
 * を実データで出す。定数を動かす前にこれを見ること。
 *
 * 使い方:
 *   node tools/embedding-check/band-width.mjs --db tools/embedding-check/results/snapshot-bge-m3.db
 *   node tools/embedding-check/band-width.mjs                 # 稼働中DBのスナップショットを取って計測
 *   オプション: --model bge-m3 --bases 40 --seed 42 --no-centering --include-descriptive
 *
 * 重心の作り方（IDF 重み付け・basic 下限・centering）は embedding.rs の
 * `build_library` と一致させてある。片方を変えたら両方直すこと。
 */

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultDbPath, snapshot } from './snapshot.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

// embedding.rs の定数と揃えること
const MIN_BASIC_TAGS = 3;
const ZONE_SIZE = 4;
const ZONE_BAND_RATIO = 0.1;

const model = arg('model', 'bge-m3');
const baseCount = Number(arg('bases', 40));
const seed = BigInt(arg('seed', '42'));
const centering = !flag('no-centering');
const includeDescriptive = flag('include-descriptive');

let dbPath = arg('db', null);
if (!dbPath) {
  const src = defaultDbPath(repoRoot);
  if (!src) throw new Error('この OS では既定パスを解決できません。--db <path> を指定してください');
  const r = snapshot(src, path.join(repoRoot, 'tools/embedding-check/results/snapshot.db'));
  console.log(`snapshot: ${src} -> ${r.dest}\n`);
  dbPath = r.dest;
}

const db = new DatabaseSync(dbPath, { readOnly: true });

// --- タグベクトル ---
const vectors = new Map();
let dim = 0;
for (const row of db.prepare('SELECT tag_id, vector FROM tag_embeddings WHERE model = ?').all(model)) {
  const buf = Buffer.from(row.vector);
  const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
  const norm = Math.hypot(...v);
  if (norm === 0) continue;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  vectors.set(row.tag_id, v);
  dim = v.length;
}
if (!dim) throw new Error(`モデル ${model} のベクトルが無い`);

// --- メディアのタグ構成 ---
const perMedia = new Map();
const rows = db
  .prepare(
    `SELECT mt.media_id, mt.tag_id, t.is_category, t.tag_kind
     FROM media_tags mt JOIN tags t ON t.id = mt.tag_id JOIN media m ON m.id = mt.media_id
     WHERE m.analysis_status = 'completed'`,
  )
  .all();
for (const r of rows) {
  let e = perMedia.get(r.media_id);
  if (!e) perMedia.set(r.media_id, (e = { tagIds: [], basic: 0 }));
  const isCategory = r.is_category !== 0;
  if (!isCategory && r.tag_kind === 'basic') e.basic++;
  if (isCategory || r.tag_kind === 'basic' || (includeDescriptive && r.tag_kind === 'descriptive')) {
    e.tagIds.push(r.tag_id);
  }
}
const eligible = [...perMedia.entries()].filter(([, p]) => p.basic >= MIN_BASIC_TAGS).sort((a, b) => a[0] - b[0]);
const n = eligible.length;

// --- df と重心 ---
const df = new Map();
for (const [, p] of eligible) {
  for (const id of new Set(p.tagIds)) df.set(id, (df.get(id) ?? 0) + 1);
}
const ids = [];
const centroids = [];
for (const [mediaId, p] of eligible) {
  const acc = new Float32Array(dim);
  let used = 0;
  let weightSum = 0;
  for (const tagId of p.tagIds) {
    const v = vectors.get(tagId);
    if (!v) continue;
    used++;
    const w = Math.max(0, Math.log(n / Math.max(1, df.get(tagId) ?? 1)));
    weightSum += w;
    for (let i = 0; i < dim; i++) acc[i] += w * v[i];
  }
  if (!used || weightSum <= Number.EPSILON) continue;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += acc[i] * acc[i];
  norm = Math.sqrt(norm);
  if (norm === 0) continue;
  for (let i = 0; i < dim; i++) acc[i] /= norm;
  ids.push(mediaId);
  centroids.push(acc);
}

if (centering) {
  const mean = new Float64Array(dim);
  for (const c of centroids) for (let i = 0; i < dim; i++) mean[i] += c[i];
  for (let i = 0; i < dim; i++) mean[i] /= centroids.length;
  for (const c of centroids) {
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      c[i] -= mean[i];
      norm += c[i] * c[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < dim; i++) c[i] /= norm;
  }
}

const N = centroids.length;
console.log(`db: ${dbPath}`);
console.log(`model: ${model} (dim ${dim}) / centering ${centering ? 'ON' : 'OFF'} / descriptive ${includeDescriptive ? 'ON' : 'OFF'}`);
console.log(`候補: ${N} 件（解析済み ${perMedia.size} / basic>=${MIN_BASIC_TAGS} ${n}）\n`);

// --- 基準メディアを決定的に選ぶ（embedding.rs の SplitMix64 と同じ）---
let state = seed;
const MASK = (1n << 64n) - 1n;
function nextU64() {
  state = (state + 0x9e3779b97f4a7c15n) & MASK;
  let z = state;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return z ^ (z >> 31n);
}
const bases = [];
const seen = new Set();
while (bases.length < Math.min(baseCount, N)) {
  const i = Number(nextU64() % BigInt(N));
  if (!seen.has(i)) {
    seen.add(i);
    bases.push(i);
  }
}

const bandSizes = [4, 6, 8, 12, 16, 24, 32, Math.max(ZONE_SIZE, Math.ceil((N - 1) * ZONE_BAND_RATIO))];

/** 基準1件ぶんの、全候補との類似度（降順） */
function sortedSims(bi) {
  const a = centroids[bi];
  const out = new Float64Array(N - 1);
  let k = 0;
  for (let j = 0; j < N; j++) {
    if (j === bi) continue;
    const b = centroids[j];
    let s = 0;
    for (let d = 0; d < dim; d++) s += a[d] * b[d];
    out[k++] = s;
  }
  return out.sort().reverse();
}

const stats = new Map(bandSizes.map((b) => [b, { topWidth: 0, botWidth: 0, topLowSigma: 0, botHighSigma: 0 }]));
let meanSd = 0;
let meanMax = 0;
let meanMin = 0;

for (const bi of bases) {
  const sims = sortedSims(bi);
  const m = sims.reduce((s, x) => s + x, 0) / sims.length;
  const sd = Math.sqrt(sims.reduce((s, x) => s + (x - m) * (x - m), 0) / sims.length);
  meanSd += sd;
  meanMax += sims[0];
  meanMin += sims[sims.length - 1];
  for (const b of bandSizes) {
    const st = stats.get(b);
    st.topWidth += sims[0] - sims[b - 1];
    st.botWidth += sims[sims.length - b] - sims[sims.length - 1];
    st.topLowSigma += (sims[b - 1] - m) / sd;
    st.botHighSigma += (sims[sims.length - b] - m) / sd;
  }
}
const B = bases.length;
console.log(`基準 ${B} 件の平均: max ${(meanMax / B).toFixed(3)} / min ${(meanMin / B).toFixed(3)} / sd ${(meanSd / B).toFixed(3)}\n`);

console.log('帯幅  上位帯が覆う幅  下端σ   最下位帯が覆う幅  上端σ   最類似が出る確率');
for (const b of bandSizes) {
  const st = stats.get(b);
  const p = ((Math.min(ZONE_SIZE, b) / b) * 100).toFixed(0);
  const label = b === bandSizes[bandSizes.length - 1] ? `${String(b).padStart(4)}*` : String(b).padStart(4);
  console.log(
    `${label}  ${(st.topWidth / B).toFixed(3).padStart(13)}  ${(st.topLowSigma / B).toFixed(2).padStart(5)}σ  ` +
      `${(st.botWidth / B).toFixed(3).padStart(15)}  ${(st.botHighSigma / B).toFixed(2).padStart(5)}σ  ` +
      `${p.padStart(14)}%`,
  );
}
console.log(`\n* 現在の実装（候補数の ${ZONE_BAND_RATIO * 100}%）`);
console.log('「下端σ」は上位帯の最も似ていない1件が平均から何σ離れているか。小さいほど凡庸な候補が混じる。');
