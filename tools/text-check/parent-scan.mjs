#!/usr/bin/env node
/**
 * 段1: 包括語（上位概念になりうるタグ）を抽出し、**2段構成が成立するかを判定する。**
 *
 * ## なぜこれが要るのか
 *
 * 実測で2つの制約が確定し、単純な解が全部塞がった:
 *
 *   1. **1回に渡せるのは約100件** — n=200 で qwen3:14b は32万トークン生成して空応答
 *      （発散）、qwen2.5:7b は249提案中219件が発明タグ。**どちらも不成立。**
 *   2. **埋め込み分割は包括関係を17〜25%しか保存しない** — プールを
 *      basic 全2,287件から単語1語1,094件に絞っても改善しない（partition-check.mjs）。
 *
 * 1,094件を11分割すると 2 に、分割しないと 1 に引っかかる。
 *
 * ## 逃げ道は「非対称性」にある
 *
 * グルーピングは O(n²) の突き合わせなので分割できない。しかし
 * **「このタグは包括語か」の判定はタグ単位で独立**なので、任意に分割してよい。
 * 段1で包括語 P 件を確定し、段2では **P 件を全チャンクに注入する**。
 * これで親と子の同居が構造的に保証され、埋め込みの17%に依存しなくなる。
 *
 * ## 何を判定するか
 *
 *   - **P（包括語の件数）** — 段2の呼び出し回数と所要時間がこれで決まる
 *   - **既知の親の再現率** — container / footwear / vehicle / structure / furniture / bowl。
 *     手で実在を確認した親で、**見落とすとその下の階層が丸ごと永久に出ない**
 *   - 発明タグ率 — 入力に無い語を返していないか
 *
 * P が大きすぎると段2が現実的でなくなる。**そのときは2段構成ごと不成立。**
 *
 *   node tools/text-check/parent-scan.mjs --model qwen3:14b --chunk 100
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSnapshot, loadTags, descriptorOf } from './tags.mjs';
import { PARENT_PROMPT, CANDIDATE_OPTIONS } from './candidates.mjs';
import { callGenerate, unloadModel, residentSize, modelProfile, listModels, isEnvironmentFailure, gib } from './ollama.mjs';
import { HIERARCHY_SEEDS } from './seeds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const OLLAMA_URL = arg('url', 'http://localhost:11434');
const MODEL = arg('model', 'qwen3:14b');
const CHUNK = parseInt(arg('chunk', '100'), 10);
const NUM_CTX = parseInt(arg('num-ctx', '32768'), 10);
const TIMEOUT_S = parseInt(arg('timeout', '600'), 10);
const KIND = arg('kind', 'basic');
const LIMIT = parseInt(arg('limit', '0'), 10); // 0=全件。試運転用
/** 段1は出力がタグ名の列挙だけなので、thinking の要否をグルーピングとは別に測る */
const THINK = arg('think', 'auto');
const THINK_FLAG = THINK === 'auto' ? null : THINK === 'on';
/**
 * 1チャンクから選ばせる件数。0 で絶対判断（包括語か否か）。
 *
 * **絶対判断は閾値が振れる**（同条件で thinking on 4% / off 52%）。
 * P は段2の実行可能性を直接決めるので、相対判断（上位N件）で制御する。
 */
const TOP_N = parseInt(arg('top', '0'), 10);
const DB_PATH = arg('db', null);

/** 1行1タグ。番号や記号が混ざっても拾えるようにする */
function parseTagLines(raw, allowed) {
  const lines = String(raw ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found = [];
  const invented = [];
  for (const line of lines) {
    // "1. container" / "- container" / "container (コンテナ)" を許容
    const m = line.replace(/^[\s\-*\d.)]+/, '').split('(')[0].trim().replace(/^["']|["',]+$/g, '');
    if (!m) continue;
    if (allowed.has(m)) { if (!found.includes(m)) found.push(m); }
    else invented.push(m);
  }
  return { found, invented, lines: lines.length };
}

async function main() {
  const models = await listModels(OLLAMA_URL);
  if (!models) { console.error(`Ollama (${OLLAMA_URL}) に接続できません。落ちている可能性があります。`); process.exit(1); }
  if (!models.some((m) => m.name === MODEL)) {
    console.error(`モデルが Ollama にありません: ${MODEL}\n利用可能: ${models.map((m) => m.name).join(', ')}`);
    process.exit(1);
  }
  const profile = await modelProfile(OLLAMA_URL, MODEL);

  const snap = path.join(HERE, 'results', 'snapshot.db');
  if (!has('reuse') || !fs.existsSync(snap)) {
    console.log('スナップショットを作成中...');
    ensureSnapshot(REPO_ROOT, DB_PATH, snap);
  }
  let pool = loadTags(snap).filter((t) => t.kind === KIND && !t.name.includes('_'));
  if (LIMIT > 0) pool = pool.slice(0, LIMIT);

  // **チャンクの母集団を均す。**
  //
  // 既定の並びはタグID順＝登録順なので、先頭チャンクに一般的な語が密集し、
  // 後ろのチャンクは固有名詞だらけになる（実測: chunk 1 は
  // "counter tree wood hand bowl building..."、chunk 10 は
  // "taiwan sympathy mukogawa kimono..."）。**相対判断なのに母集団が偏る**ので、
  // 良い包括語が集中したチャンクでは枠が足りず、薄いチャンクでは `diagonal` のような
  // 語が選ばれる。実際 `furniture` はこれで落ちた。
  //
  // 乱数は使わない（同じ入力で結果が変わると後から検証できない）。
  // タグ名のハッシュで決定的に並べ替える。
  if (!has('no-shuffle')) {
    const hash = (s) => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
      return h >>> 0;
    };
    pool = pool.slice().sort((a, b) => hash(a.name) - hash(b.name));
  }

  const chunks = [];
  for (let i = 0; i < pool.length; i += CHUNK) chunks.push(pool.slice(i, i + CHUNK));

  console.log('\n=== 段1: 包括語の抽出 ===');
  console.log(`model  : ${MODEL} (${profile.parameterSize ?? '?'}${profile.thinking ? ' / thinking' : ''})`);
  console.log(`対象   : ${KIND} かつ単語1語 ${pool.length} 件`);
  console.log(`分割   : ${CHUNK} 件 × ${chunks.length} チャンク`);
  console.log(`num_ctx: ${NUM_CTX} / timeout: ${TIMEOUT_S}秒 / think: ${THINK}`);
  console.log(`選抜   : ${TOP_N > 0 ? `1チャンクあたり上位 ${TOP_N} 件（相対判断）` : '該当するもの全部（絶対判断・閾値が振れる）'}\n`);
  console.log('  **この段はタグ単位で独立なので、分割の切り方は結果に影響しない。**\n');

  const parents = new Set();
  const rows = [];
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const allowed = new Set(chunk.map((t) => t.name));
    const prompt = PARENT_PROMPT.build(chunk.map((t) => descriptorOf(t)), TOP_N);
    const row = { chunk: ci, size: chunk.length, elapsedMs: 0, found: 0, invented: 0, failReason: null };
    const t0 = Date.now();
    try {
      const r = await callGenerate(OLLAMA_URL, MODEL, prompt, {
        options: { ...CANDIDATE_OPTIONS, num_ctx: NUM_CTX },
        think: THINK_FLAG,
        timeoutMs: TIMEOUT_S * 1000,
      });
      row.elapsedMs = Date.now() - t0;
      row.promptEvalCount = r.prompt_eval_count ?? null;
      row.evalCount = r.eval_count ?? null;
      row.doneReason = r.done_reason ?? null;
      const p = parseTagLines(r.response, allowed);
      p.found.forEach((n) => parents.add(n));
      row.found = p.found.length;
      row.invented = p.invented.length;
      row.names = p.found;
    } catch (e) {
      row.elapsedMs = Date.now() - t0;
      row.failReason = e.code === 'GENERATION_TIMEOUT' ? 'timeout'
        : isEnvironmentFailure(e.message) ? 'env_failure' : 'request_error';
      row.error = String(e.message).slice(0, 160);
    }
    rows.push(row);
    console.log(
      `  chunk ${String(ci + 1).padStart(2)}/${chunks.length}  ${String((row.elapsedMs / 1000).toFixed(1)).padStart(6)}s  ` +
        (row.failReason ? `NG ${row.failReason}` : `包括語 ${String(row.found).padStart(3)}/${row.size}` +
          (row.invented ? `  発明 ${row.invented}` : ''))
    );
  }

  const vram = await residentSize(OLLAMA_URL, MODEL);
  await unloadModel(OLLAMA_URL, MODEL);

  const failed = rows.filter((r) => r.failReason);
  const P = parents.size;

  console.log('\n================ 判定 ================\n');
  if (failed.length) {
    console.log(`**失敗したチャンク: ${failed.length}/${chunks.length}**`);
    failed.forEach((r) => console.log(`  chunk ${r.chunk + 1}: ${r.failReason} — ${r.error ?? ''}`));
    console.log('  <- 失敗分のタグは判定されていない。P は過小評価になっている\n');
  }
  console.log(`P（包括語）: **${P} 件** / 対象 ${pool.length} 件（${((P / pool.length) * 100).toFixed(1)}%）`);
  const inv = rows.reduce((s, r) => s + (r.invented ?? 0), 0);
  console.log(`発明タグ    : ${inv} 件`);
  const totalS = rows.reduce((s, r) => s + r.elapsedMs, 0) / 1000;
  console.log(`段1の所要   : ${(totalS / 60).toFixed(1)} 分（${chunks.length} 回）`);

  // ---- 既知の親を拾えたか（非循環の再現率）----
  //
  // **分母は「子がこのプールに居る親」だけ。** 段1が見つける必要があるのは親であって、
  // 子は段2に通常のタグとして現れる。`bowl` を落としても `container ⊃ bowl` は失われない
  // （`bowl` が親として要るのは `bowl ⊃ soup_bowl` など複合語の子だけで、それは Pass S 側）。
  // ここを間違えると、実際には問題の無い見落としを不合格として数える。
  console.log('\n--- 既知の親の再現（見落とすとその下の階層が永久に出ない）---');
  const inPool = (n) => pool.some((t) => t.name === n);
  const seedParents = [...new Set(
    HIERARCHY_SEEDS.filter(([p, c]) => inPool(p) && inPool(c)).map(([p]) => p)
  )];
  const parentOnlyElsewhere = [...new Set(HIERARCHY_SEEDS.map(([p]) => p))]
    .filter((p) => inPool(p) && !seedParents.includes(p));
  if (parentOnlyElsewhere.length) {
    console.log(`  （子がプール外なので合否に数えない: ${parentOnlyElsewhere.join(', ')}）`);
  }
  const hit = seedParents.filter((n) => parents.has(n));
  seedParents.forEach((n) => console.log(`  ${parents.has(n) ? '○' : '**×**'} ${n}`));
  console.log(`\n  ${hit.length}/${seedParents.length} 組`);
  if (hit.length < seedParents.length) {
    console.log('  **落とした親は段2でも絶対に出ない。** 抽出条件を緩めるか、方式を見直すこと。');
  }

  // ---- 段2の実行可能性 ----
  console.log('\n--- 段2の見積り（P 件を全チャンクに注入する）---');
  const perCall = 100; // 実測での実用単位
  console.log(`  1回の実用単位を ${perCall} 件とする（n=200 は発散または品質崩壊。実測）`);
  if (P >= perCall) {
    console.log(`  **P=${P} が実用単位 ${perCall} 以上。包括語だけで1回分を使い切るので 2段構成は成立しない。**`);
    console.log('  包括語をさらに絞る（階層の上位だけに限る）か、別方式が要る。');
  } else {
    const slots = perCall - P;
    const calls = Math.ceil((pool.length - P) / slots);
    console.log(`  1チャンク = 包括語 ${P} + 残り ${slots} 件`);
    console.log(`  段2の呼び出し回数: ${calls} 回`);
    console.log(`  段1+段2の合計    : ${chunks.length + calls} 回 ≒ ${(((chunks.length + calls) * 100) / 60).toFixed(0)} 分（1回100秒想定）`);
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `parent-scan-${MODEL.replace(/[:\\/]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({
    model: MODEL, profile, chunk: CHUNK, numCtx: NUM_CTX, kind: KIND, think: THINK, topN: TOP_N,
    poolSize: pool.length, parents: [...parents].sort(), seedParents, seedParentsFound: hit,
    vram: vram.sizeVram, ranAt: new Date().toISOString(), rows,
  }, null, 2));
  console.log(`\nVRAM: ${gib(vram.sizeVram)}`);
  console.log(`生データ: ${path.relative(REPO_ROOT, out)}`);
}

main().catch((e) => { console.error('\n[FATAL]', e); process.exit(1); });
