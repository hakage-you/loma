/**
 * ゾーンの「帯幅」を決めるための分布計測。
 *
 * `src-tauri/src/embedding.rs` の各ゾーンは、順位の帯（既定で候補数の 10%）から
 * `ZONE_SIZE` 件を無作為抽出する。帯を順位で切ると、**帯が覆う類似度の幅は
 * 分布上の位置によって桁で変わる**。分布の裾（最類似・最非類似）は疎なので、
 * 同じ 10% でも中央では 0.0x、裾では 0.4 超を覆ってしまう。
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
 */

import path from 'node:path';
import { defaultDbPath, snapshot } from './snapshot.mjs';
import { buildLibrary, sampleBases, dot, MIN_BASIC_TAGS, ZONE_SIZE, ZONE_BAND_RATIO } from './library.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const model = arg('model', 'bge-m3');
const baseCount = Number(arg('bases', 40));
const seed = arg('seed', '42');
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

const lib = buildLibrary({ dbPath, model, centering, includeDescriptive });
const { N, dim, centroids } = lib;

console.log(`db: ${dbPath}`);
console.log(`model: ${model} (dim ${dim}) / centering ${centering ? 'ON' : 'OFF'} / descriptive ${includeDescriptive ? 'ON' : 'OFF'}`);
console.log(`候補: ${N} 件（解析済み ${lib.completedCount} / basic>=${MIN_BASIC_TAGS} ${lib.eligibleCount}）\n`);

const bases = sampleBases(N, baseCount, seed);
const bandSizes = [4, 6, 8, 12, 16, 24, 32, Math.max(ZONE_SIZE, Math.ceil((N - 1) * ZONE_BAND_RATIO))];

/** 基準1件ぶんの、全候補との類似度（降順） */
function sortedSims(bi) {
  const a = centroids[bi];
  const out = new Float64Array(N - 1);
  let k = 0;
  for (let j = 0; j < N; j++) {
    if (j !== bi) out[k++] = dot(a, centroids[j]);
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
console.log(`\n* 比率のみ（候補数の ${ZONE_BAND_RATIO * 100}%）で切った場合`);
console.log('「下端σ」は上位帯の最も似ていない1件が平均から何σ離れているか。小さいほど凡庸な候補が混じる。');
