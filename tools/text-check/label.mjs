#!/usr/bin/env node
// タグ提案の人手ラベル付け。**判定の単位はペア（統合先 ← メンバー1件）。**
//
// ○ は「同義・包括・類語だと確定した」ではなく **提案として出す価値がある**。
// 過剰な包括はユーザーが無視できるので悪いとは言い切れず、逆に
// 「意味は近いが統合先として無意味」なら ×。判定軸は運用上の有用性。
//
// **なぜグループ単位で付けないか。** 20件のグループで10件だけ正しい場合、
// グループ単位の ○/× では表現できず情報が落ちる。ペアで持てば、
// 集約し直すだけで「ペアの適合率」と「グループ内の正解率」の両方が出る。
//
//   # 1. 提案を書き出す（Ollama 不要・数秒）
//   cd src-tauri
//   LOMA_BASELINE_DB='C:/Users/<you>/AppData/Roaming/com.hakageyou.loma/loma.db' \
//     LOMA_LABEL_OUT='../tools/text-check/results/proposals.json' \
//     cargo test --release dump_suggestions_for_labeling -- --ignored --nocapture
//
//   # 2. ラベルを付ける
//   node tools/text-check/label.mjs --method rules
//   node tools/text-check/label.mjs --method hypernym --sample 40
//   node tools/text-check/label.mjs --method related
//
//   # 3. 集計だけ見る
//   node tools/text-check/label.mjs --method rules --report
//
// 判定は台帳 results/judgments.tsv に貯まる（比較でも使い回せる）。
// 中断しても付けたぶんは残る（1件ごとに追記する）。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { loadJudgments, appendJudgment, pairKey, prng } from './judgments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const method = arg('method', 'rules');
const inputPath = arg('input', join(RESULTS, 'proposals.json'));
// 層あたりの上限。母集団がこれより小さい層は全件見る。
// **層の数が多い方式（①は14層）では合計が膨らむ**ので、既定は控えめにする。
// 集計は付いたぶんだけで出るので、途中で止めてよい。
const perStratum = Number(arg('sample', flag('all') ? Infinity : 15));
const seed = Number(arg('seed', 12345));

if (!existsSync(inputPath)) {
  console.error(`提案の書き出しが見つかりません: ${inputPath}`);
  console.error('先に dump_suggestions_for_labeling を実行してください（冒頭のコメント参照）。');
  process.exit(1);
}

const all = JSON.parse(readFileSync(inputPath, 'utf8'));
const pairs = all[`${method}_pairs`];
const groups = all[method];
if (!pairs) {
  const ms = Object.keys(all).filter((k) => k.endsWith('_pairs')).map((k) => k.replace('_pairs', ''));
  console.error(`方式 "${method}" のペアがありません。ある方式: ${ms.join(' / ')}`);
  process.exit(1);
}

// ---- 層の決め方 ----
// ①: 当たった規則の組み合わせ。「4規則なら信用できる」を判断できるようにする
// ②: グループの大きさ（大きいものほど混ざりやすい、が仮説）
// ③: 種別（basic / descriptive で最良のモデルが違う）
function stratumOf(p) {
  if (method === 'rules') return (p.rules ?? []).slice().sort().join('+') || '(なし)';
  if (method === 'related') return p.target.kind ?? 'basic';
  const n = p.group_size ?? 0;
  return n >= 20 ? 'サイズ20以上' : n >= 6 ? 'サイズ6-19' : 'サイズ2-5';
}

const byStratum = new Map();
for (const p of pairs) {
  const k = stratumOf(p);
  if (!byStratum.has(k)) byStratum.set(k, []);
  byStratum.get(k).push(p);
}

const rnd = prng(seed);
const sample = [];
for (const [k, list] of [...byStratum.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const picked = list
    .map((v) => ({ v, r: rnd() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, perStratum)
    .map((x) => x.v);
  for (const p of picked) sample.push({ stratum: k, p });
}

// **判定は台帳から読む。** 比較（label-diff.mjs）と同じ台帳を共有するので、
// 一度判定したペアは二度と聞かれない
const judged = loadJudgments();
const keyOf = (p) => pairKey(p.target.name, p.member.name);

function report() {
  // (1) ペアの適合率 —— 「ペアのまま出す形」の質
  //
  // **標本ではなく「台帳にある判定のうち、現在の母集団に存在するもの」を全部使う。**
  // 標本だけを見ると、規則を変えて層の構成が変わったときに過去の判定が集計から
  // 落ちる（実測: 84件付けたのに11件しか出なかった）。
  // 判定は層ごとに無作為抽出したものなので、後から母集団が変わっても
  // 残っている層の推定には使える。
  const judgedInPopulation = [];
  for (const p of pairs) {
    if (judged.has(keyOf(p))) judgedInPopulation.push({ stratum: stratumOf(p), p });
  }
  const rows = new Map();
  for (const { stratum, p } of judgedInPopulation) {
    const v = judged.get(keyOf(p))?.verdict;
    if (!v) continue;
    if (!rows.has(stratum)) rows.set(stratum, { good: 0, bad: 0, hold: 0, unknown: 0 });
    rows.get(stratum)[v] = (rows.get(stratum)[v] ?? 0) + 1;
  }
  if (rows.size === 0) {
    console.log('\nまだラベルがありません。');
    return;
  }
  console.log(`\n=== ${method} ペアの適合率（○ = 提案として出す価値がある）===`);
  const w = Math.max(...[...rows.keys()].map((k) => k.length), 10);
  let G = 0, B = 0, H = 0, U = 0;
  for (const [k, r] of [...rows.entries()].sort((a, b) => b[1].good + b[1].bad - (a[1].good + a[1].bad))) {
    const n = r.good + r.bad;
    G += r.good; B += r.bad; H += r.hold; U += r.unknown ?? 0;
    console.log(
      `  ${k.padEnd(w)}  ○${String(r.good).padStart(3)} ×${String(r.bad).padStart(3)} 保留${String(r.hold).padStart(3)} 不明${String(r.unknown ?? 0).padStart(3)}  適合率 ${(n ? ((r.good / n) * 100).toFixed(0) + '%' : '—').padStart(4)}  (母集団 ${byStratum.get(k).length}件)`
    );
  }
  const n = G + B;
  console.log(`  ${'合計'.padEnd(w)}  ○${String(G).padStart(3)} ×${String(B).padStart(3)} 保留${String(H).padStart(3)} 不明${String(U).padStart(3)}  適合率 ${n ? ((G / n) * 100).toFixed(0) + '%' : '—'}`);

  // **母集団で重み付けした推定。** 層ごとの母集団が桁違いのとき（①は
  // ja_prefix 4,248 と ja_exact 65 が同居）、単純合計は実態を表さない
  let pop = 0, est = 0, covered = 0;
  for (const [k, r] of rows) {
    const m = r.good + r.bad;
    if (!m) continue;
    const P = byStratum.get(k).length;
    pop += P;
    est += (P * r.good) / m;
    covered += P;
  }
  const total = pairs.length;
  if (pop) {
    console.log(
      `\n  母集団で重み付けした適合率  ${((est / pop) * 100).toFixed(1)}%` +
        `（判定済みの層 ${covered}ペア / 全体 ${total}ペアの ${((covered / total) * 100).toFixed(0)}%）`
    );
    if (covered < total * 0.9) {
      console.log(`  **未判定の層が ${total - covered}ペア残っている。** 全体の推定としては未完成。`);
    }
  }
  if (U) {
    const all = G + B + H + U;
    console.log(
      `\n  **不明 ${U}件（${((U / all) * 100).toFixed(0)}%）は方式の質ではなくタグ生成側の問題。**`
    );
    console.log(`  VLM が画像内の文字や固有名詞を拾った結果で、②③のどの方式でも同じように出る。`);
  }

  // (2) グループ内の正解率 —— 「集約して出す形」の質。
  //     混ざっているほど、ユーザーは member ごとの除外を強いられる
  const perGroup = new Map();
  for (const { p } of judgedInPopulation) {
    const v = judged.get(keyOf(p))?.verdict;
    if (v !== 'good' && v !== 'bad') continue; // 保留と不明はグループの判定に混ぜない
    if (!p.group_id) continue;
    if (!perGroup.has(p.group_id)) perGroup.set(p.group_id, { good: 0, bad: 0, size: p.group_size });
    perGroup.get(p.group_id)[v === 'good' ? 'good' : 'bad']++;
  }
  // 外側の `judged`（台帳）と名前を衝突させない。同名にすると関数全体が
  // TDZ になり、上の `judged.get(...)` が「初期化前アクセス」で落ちる
  const groupsWithLabels = [...perGroup.values()].filter((g) => g.good + g.bad >= 2);
  if (groupsWithLabels.length) {
    const pure = groupsWithLabels.filter((g) => g.bad === 0).length;
    const dirty = groupsWithLabels.filter((g) => g.good > 0 && g.bad > 0).length;
    const allBad = groupsWithLabels.filter((g) => g.good === 0).length;
    console.log(`\n=== グループの混ざり方（2件以上ラベルが付いた ${groupsWithLabels.length}グループ）===`);
    console.log(`  全部○     ${pure}件 —— そのまま承認できる`);
    console.log(`  混在      ${dirty}件 —— member ごとの除外が要る`);
    console.log(`  全部×     ${allBad}件 —— 丸ごと却下`);
    const big = groupsWithLabels.filter((g) => g.size >= 6);
    if (big.length) {
      const bigDirty = big.filter((g) => g.good > 0 && g.bad > 0).length;
      console.log(`  うちサイズ6以上 ${big.length}件のうち混在 ${bigDirty}件`);
    }
  }
  console.log(`\n保留・不明は分母から外している（判断できないものを○×に寄せない）。`);
}

if (flag('report')) {
  report();
  process.exit(0);
}

const todo = sample.filter(({ p }) => !judged.has(keyOf(p)));
console.log(`方式: ${method}`);
console.log(`ペア ${pairs.length}件（提案 ${groups?.length ?? '?'}件）/ 標本 ${sample.length}件`);
console.log(`  台帳から再利用 ${sample.length - todo.length}件 / これから判定 ${todo.length}件`);
console.log(`層: ${[...byStratum.keys()].join(' / ')}`);
console.log(`記録先: 台帳 results/judgments.tsv\n`);
console.log('判定は **統合先 ← メンバー1件** の単位。');
console.log('○ は「同義だと確定した」ではなく **提案として出す価値がある** かどうか。');
console.log('  統合するかはユーザーが決められるので、多少広くても価値があれば ○。');
console.log('  「意味は近いが統合先として無意味」「まったく無関係」なら ×。\n');
console.log('  y = ○良い   n = ×悪い   s = 保留（意味は分かるが決められない）');
console.log('  u = タグの意味が分からない   q = 中断して集計\n');

if (todo.length === 0) {
  report();
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const askKey = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim().toLowerCase())));

const tagStr = (t) => `${t.name}${t.name_ja ? `（${t.name_ja}）` : ''}[${t.count}]`;

for (let i = 0; i < todo.length; i++) {
  const { stratum, p } = todo[i];
  console.log('─'.repeat(70));
  const extra = [
    p.rules?.length ? p.rules.join('+') : null,
    p.score != null ? `類似度 ${p.score.toFixed(2)}` : null,
    p.group_size > 2 ? `${p.group_size}件のグループの一部` : null,
  ].filter(Boolean);
  console.log(`(${i + 1}/${todo.length})  層: ${stratum}${extra.length ? `  ${extra.join(' / ')}` : ''}`);
  console.log(`  統合先  ${tagStr(p.target)}`);
  console.log(`  まとめる ${tagStr(p.member)}`);

  let v = null;
  while (!v) {
    const a = await askKey('  y / n / s / u / q > ');
    if (a === 'y') v = 'good';
    else if (a === 'n') v = 'bad';
    else if (a === 's') v = 'hold';
    // **意味が分からないものは別に数える。** 方式の質ではなくタグ生成側の問題
    else if (a === 'u') v = 'unknown';
    else if (a === 'q') {
      rl.close();
      report();
      process.exit(0);
    }
  }
  judged.set(keyOf(p), { verdict: v });
  appendJudgment(keyOf(p), v, method); // 1件ごとに追記。中断しても失わない
}

rl.close();
report();
