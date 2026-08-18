#!/usr/bin/env node
// 2つの実行結果を比べ、**差分だけ**を人手で判定する。
//
// 共通して出るペアは比較に寄与しないので見ない。見るのは2つだけ:
//
//   消えたペア  ×だったなら改善 / ○だったなら退化
//   増えたペア  ○なら改善 / ×なら退化
//
// **判定は台帳（judgments.tsv）に貯まる。** 一度判定したペアは次回以降
// 自動で適用されるので、比較を重ねるほど聞かれる件数が減る。
//
//   node tools/text-check/label-diff.mjs --before <db> --after <db> \
//     [--method hypernym] [--sample 30] [--report]
//
// **これは適合率の測定ではない。** 前後どちらが良いかの判定。

import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { loadJudgments, appendJudgment, loadPairs, prng, pick } from './judgments.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes(`--${n}`);

const method = arg('method', 'hypernym');
const beforeDb = arg('before');
const afterDb = arg('after');
const perSide = Number(arg('sample', 30));
const seed = Number(arg('seed', 4242));

if (!beforeDb || !afterDb) {
  console.error('使い方: --before <db> --after <db> [--method hypernym] [--sample 30]');
  process.exit(1);
}

const A = loadPairs(DatabaseSync, beforeDb, method);
const B = loadPairs(DatabaseSync, afterDb, method);
const gone = [...A.pairs.keys()].filter((k) => !B.pairs.has(k));
const added = [...B.pairs.keys()].filter((k) => !A.pairs.has(k));
const kept = [...A.pairs.keys()].filter((k) => B.pairs.has(k));

const judged = loadJudgments();

// 標本は毎回同じ（seed 固定）。台帳に既にあるものは聞かずに使う
const rnd = prng(seed);
const sample = [
  ...pick(gone, perSide, rnd).map((k) => ({ side: 'gone', k, ...A.pairs.get(k), gsize: A.size.get(k.split('<-')[0]) })),
  ...pick(added, perSide, rnd).map((k) => ({ side: 'added', k, ...B.pairs.get(k), gsize: B.size.get(k.split('<-')[0]) })),
];

function report() {
  const blank = () => ({ good: 0, bad: 0, hold: 0, unknown: 0 });
  const c = { gone: blank(), added: blank() };
  let reused = 0;
  for (const s of sample) {
    const j = judged.get(s.k);
    if (!j) continue;
    c[s.side][j.verdict] = (c[s.side][j.verdict] ?? 0) + 1;
    reused++;
  }
  const nGone = c.gone.good + c.gone.bad;
  const nAdded = c.added.good + c.added.bad;
  if (!nGone && !nAdded) {
    console.log('\nまだ判定がありません。');
    return;
  }
  console.log(`\n=== 差分の判定（${method}）===`);
  const extra = (x) => `保留${x.hold}${x.unknown ? ` 不明${x.unknown}` : ''}`;
  console.log(`消えた ${nGone}件  ○${c.gone.good}（退化＝拾えていたものを落とした）  ×${c.gone.bad}（改善＝消して正解）  ${extra(c.gone)}`);
  console.log(`増えた ${nAdded}件  ○${c.added.good}（改善）  ×${c.added.bad}（退化＝ゴミが増えた）  ${extra(c.added)}`);

  // 標本比を母集団に引き伸ばす。**目安であって実数ではない**
  const scale = (v, n, total) => (n ? Math.round((v / n) * total) : 0);
  const win = scale(c.gone.bad, nGone, gone.length) + scale(c.added.good, nAdded, added.length);
  const lose = scale(c.gone.good, nGone, gone.length) + scale(c.added.bad, nAdded, added.length);
  const d = win - lose;
  console.log(`\n母集団に引き伸ばした目安（消えた${gone.length}件 / 増えた${added.length}件）`);
  console.log(`  改善  約${win}件`);
  console.log(`  退化  約${lose}件`);
  console.log(`  差引  ${d >= 0 ? '+' : ''}${d}件 → ${d > 0 ? 'after が良い' : d < 0 ? 'before が良い' : '互角'}`);
  console.log(`\n判定 ${reused}件（うち台帳から再利用したぶんを含む）。`);
  console.log('保留・不明は分母から外している。**不明は方式の質ではなくタグ生成側の問題**');
  console.log('（VLM が画像内の文字や固有名詞を拾った結果。どの方式でも同じように出る）。');
  console.log('引き伸ばしは標本比からの推定であって実数ではない。');
}

if (flag('report')) {
  report();
  process.exit(0);
}

const todo = sample.filter((s) => !judged.has(s.k));
console.log(`before ${A.pairs.size}ペア → after ${B.pairs.size}ペア`);
console.log(`  共通 ${kept.length} / 消えた ${gone.length} / 増えた ${added.length}`);
console.log(`標本 ${sample.length}件（各側 最大${perSide}件）`);
console.log(`  台帳から再利用 ${sample.length - todo.length}件 / これから判定 ${todo.length}件\n`);
console.log('判定は **どちらの版かに関係なく、その提案が出す価値があるか**。');
console.log('  「同義・包括だと確定した」ではない。多少広くても価値があれば ○。');
console.log('  「意味は近いが統合先として無意味」「まったく無関係」なら ×。\n');
console.log('  y = ○良い   n = ×悪い   s = 保留（意味は分かるが決められない）');
console.log('  u = タグの意味が分からない   q = 中断して集計\n');

if (!todo.length) {
  report();
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim().toLowerCase())));
const tagStr = (t) => `${t.name}${t.ja ? `（${t.ja}）` : ''}[${t.cnt}]`;

for (let i = 0; i < todo.length; i++) {
  const s = todo[i];
  console.log('─'.repeat(70));
  console.log(`(${i + 1}/${todo.length})  ${s.side === 'gone' ? '消えた側' : '増えた側'}  ${s.gsize}件のグループ`);
  console.log(`  統合先  ${tagStr(s.t)}`);
  console.log(`  まとめる ${tagStr(s.m)}`);
  let v = null;
  while (!v) {
    const a = await ask('  y / n / s / u / q > ');
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
  judged.set(s.k, { verdict: v });
  appendJudgment(s.k, v, method);
}
rl.close();
report();
