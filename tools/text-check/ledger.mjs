#!/usr/bin/env node
// 判定台帳（results/judgments.tsv）の手入れ。
//
//   node tools/text-check/ledger.mjs stats
//   node tools/text-check/ledger.mjs compact          最後の判定だけ残して整理
//   node tools/text-check/ledger.mjs drop hold        その判定を未判断に戻す
//   node tools/text-check/ledger.mjs drop hold,unknown
//
// 台帳は追記のみで「同じ鍵は最後の行が有効」。`drop` は該当する鍵の行を全部消すので、
// **次回のラベル付けで改めて聞かれる**。実行前に `.bak` を作る。

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { LEDGER } from './judgments.mjs';

const [cmd, param] = process.argv.slice(2);
if (!existsSync(LEDGER)) {
  console.error(`台帳がありません: ${LEDGER}`);
  process.exit(1);
}

const lines = readFileSync(LEDGER, 'utf8').split('\n').filter((l) => l.trim());
const rows = lines.map((l) => {
  const [key, verdict, method, date] = l.split('\t');
  return { key, verdict, method, date, raw: l };
});

// 最後の行が有効
const last = new Map();
for (const r of rows) if (r.key && r.verdict) last.set(r.key, r);

const counts = () => {
  const c = {};
  for (const r of last.values()) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
};

if (!cmd || cmd === 'stats') {
  const c = counts();
  console.log(`台帳 ${LEDGER}`);
  console.log(`  行数 ${rows.length} / 有効な鍵 ${last.size}`);
  for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(8)} ${v}件`);
  }
  const byMethod = {};
  for (const r of last.values()) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
  console.log('  方式別:', Object.entries(byMethod).map(([k, v]) => `${k} ${v}`).join(' / '));
  process.exit(0);
}

const write = (keep, label) => {
  copyFileSync(LEDGER, `${LEDGER}.bak`);
  writeFileSync(LEDGER, keep.map((r) => r.raw).join('\n') + '\n', 'utf8');
  console.log(`${label}`);
  console.log(`  ${rows.length}行 → ${keep.length}行（元は ${LEDGER}.bak）`);
};

if (cmd === 'compact') {
  write([...last.values()], '最後の判定だけ残しました');
} else if (cmd === 'drop') {
  const targets = new Set((param ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!targets.size) {
    console.error('例: node tools/text-check/ledger.mjs drop hold');
    process.exit(1);
  }
  const dropKeys = new Set([...last.values()].filter((r) => targets.has(r.verdict)).map((r) => r.key));
  const keep = [...last.values()].filter((r) => !dropKeys.has(r.key));
  write(keep, `${[...targets].join(' / ')} を未判断に戻しました（${dropKeys.size}件）`);
} else {
  console.error(`不明なコマンド: ${cmd}`);
  console.error('stats / compact / drop <verdict[,verdict]>');
  process.exit(1);
}
