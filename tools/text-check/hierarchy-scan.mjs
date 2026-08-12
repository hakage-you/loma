#!/usr/bin/env node
/**
 * 階層（包括関係）がこのライブラリに何組成立しうるかを数える。GPU 不要。
 *
 * **なぜ要るのか。** 「LLM が階層提案を出したか」だけを見ても解釈できない。
 * 0件だったとき、プロンプトが効いていないのか・そもそも親タグが存在しないのかを
 * 区別できないため（`animal` をカテゴリタグと知らずに階層の例に使っていた失敗がこれ）。
 * **事前分布を先に押さえてから提案数を読む。**
 *
 * 2種類を分けて数える:
 *
 *   1. **語彙的にマークされた階層** — `soy_sauce` ⊃ `sauce` のように名前を共有する組。
 *      機械的に列挙できるが誤検出が多く（`license_plate` は `plate` の一種ではない）、
 *      **共有語が7文字以上ならルールベースが既に拾う**（共通キーフレーズ規則）。
 *   2. **語彙的に無関係な階層** — `container` ⊃ `bowl`、`structure` ⊃ `greenhouse`。
 *      **機械的には列挙できない。ここが LLM の本命。**
 *      手動でキュレートしたシードを持ち、ルール到達不可であることを検証する。
 *
 * 2 は網羅数を出せない（出せるならLLMが要らない）。**シードが出るかどうかで判定する。**
 *
 *   node tools/text-check/hierarchy-scan.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { classifyByRules } from './rules.mjs';
import { HIERARCHY_SEEDS as SEEDS } from './seeds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const DB_PATH = path.resolve(arg('db', path.join(HERE, 'results/snapshot.db')));

function load() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare(
      `SELECT t.id, t.name, t.name_ja, t.tag_kind AS kind, COUNT(mt.media_id) AS count
       FROM tags t LEFT JOIN media_tags mt ON t.id = mt.tag_id
       WHERE t.is_category = 0 GROUP BY t.id`
    ).all().map((r) => ({
      id: r.id, name: r.name, nameJa: r.name_ja?.trim() || null, kind: r.kind, count: r.count,
    }));
  } finally {
    db.close();
  }
}

function main() {
  console.log(`db: ${DB_PATH}\n`);
  const tags = load();
  const basic = tags.filter((t) => t.kind === 'basic');
  const byName = new Map(tags.map((t) => [t.name, t]));

  // ---- 1. 語彙的にマークされた階層 ----
  const singles = basic.filter((t) => !t.name.includes('_'));
  const lexical = [];
  for (const parent of singles) {
    for (const child of basic) {
      if (child.id === parent.id) continue;
      if (child.name.endsWith(`_${parent.name}`) || child.name.startsWith(`${parent.name}_`)) {
        lexical.push([parent, child]);
      }
    }
  }
  const parentsWithKids = new Set(lexical.map(([p]) => p.name));
  console.log('=== 1. 語彙的にマークされた階層（機械列挙）===');
  console.log(`  basic 単語1語タグ : ${singles.length}`);
  console.log(`  子を持つ親        : ${parentsWithKids.size}`);
  console.log(`  親子ペア          : ${lexical.length}`);

  const lexVerdicts = classifyByRules(REPO_ROOT, lexical.map(([p, c]) => [p, c]));
  const lexRuled = lexVerdicts.filter((v) => v.rule).length;
  console.log(`  うちルールが既に拾う : ${lexRuled} (${((lexRuled / lexical.length) * 100).toFixed(0)}%)`);
  console.log(`  ルール到達不可       : ${lexical.length - lexRuled}`);
  console.log('\n  **この分類は誤検出を含む。** license_plate は plate の一種ではないが列挙される。');
  console.log('  上限の目安であって「正解の数」ではない。');

  // ---- 2. 語彙的に無関係な階層（シード）----
  console.log('\n=== 2. 語彙的に無関係な階層（シード / LLM の本命）===');
  const present = SEEDS.filter(([p, c]) => byName.has(p) && byName.has(c));
  const missing = SEEDS.filter(([p, c]) => !byName.has(p) || !byName.has(c));
  if (missing.length) {
    console.log(`  [警告] タグが見つからないシード: ${missing.map((m) => m.join('⊃')).join(', ')}`);
  }
  const seedVerdicts = classifyByRules(REPO_ROOT, present.map(([p, c]) => [byName.get(p), byName.get(c)]));
  const unreachable = [];
  present.forEach(([p, c], i) => {
    const v = seedVerdicts[i];
    const pt = byName.get(p);
    const ct = byName.get(c);
    const mark = v.rule ? 'ルールが拾う  ' : '**LLM専用**  ';
    console.log(`  ${mark} ${`${p}(${pt.count}) ⊃ ${c}(${ct.count})`.padEnd(38)} ${v.reason}`);
    if (!v.rule) unreachable.push([p, c]);
  });
  console.log(`\n  ルール到達不可 : ${unreachable.length} / ${present.length} 組`);
  console.log('  **S2 でこのうち1組も出なければ、プロンプトが効いていないと言える。**');

  // ---- 3. target の使用数逆転 ----
  // 親のほうが使用数が少ない組がどれだけあるか。「最も一般的なタグを target に」という
  // 指示は、使用数1のタグに20件のタグを吸収させることがある
  const inverted = unreachable.filter(([p, c]) => byName.get(p).count < byName.get(c).count);
  console.log('\n=== 3. 使用数の逆転（target 選定の注意点）===');
  console.log(`  親の使用数 < 子の使用数 : ${inverted.length} / ${unreachable.length} 組`);
  for (const [p, c] of inverted) {
    console.log(`    ${p}(${byName.get(p).count}) <- ${c}(${byName.get(c).count})`);
  }
  console.log('\n  「最も一般的」と「よく使われている」は一致しない。');
  console.log('  target を LLM に決めさせる設計では、使用数比を必ず集計すること（§7.3）。');
}

main();
