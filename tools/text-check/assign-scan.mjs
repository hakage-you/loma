#!/usr/bin/env node
/**
 * 段2: 段1で得たカテゴリに残りのタグを**割り当て**、チャンクを跨いで集約する。
 *
 * ## なぜ「グルーピング」ではなく「割り当て」なのか
 *
 * 段1の包括語をそのまま入力に混ぜてグルーピングさせると、モデルは
 * **毎回カテゴリどうしの関係まで解き直す**（`container`/`utensil`/`tableware`、
 * `structure`/`building`/`house`/`room` は互いに関係が濃い）。
 * 実測: 包括語75件＋通常25件で600秒タイムアウト。これを41チャンク繰り返すのは無理。
 *
 * カテゴリ間の関係は一度決めれば済むので、段2は割り当てだけに制約する。
 *
 * ## 大きいグループは「同居」ではなく「集約」で作る
 *
 * これが設計の核心。素の分割では親と子が同じチャンクに落ちないと大きい提案が出ず、
 * 埋め込みで寄せても17〜25%しか同居しない（partition-check.mjs）。
 * **チャンクを跨いで target ごとに members を足し合わせれば、
 * `container` が別々のチャンクから bowl / cup / plate / glass を集めて4件になる。**
 * 同居の確率に依存しなくなる。
 *
 * ## 判定
 *
 *   - **シード回収** — 親は常に入力に居るので、全シードが毎回テスト対象になる。
 *     「子が同じチャンクに来たか」という運の要素が消えた状態での再現率
 *   - 集約後のグループサイズ分布 — UI は件数降順なので、**大きいグループが出るか**が要点
 *   - 発明タグ / カテゴリ外への割り当て
 *
 *   node tools/text-check/assign-scan.mjs --model qwen3:14b --parents results/parent-scan-*.json --chunk 50
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSnapshot, loadTags, descriptorOf } from './tags.mjs';
import { ASSIGN_PROMPT, CANDIDATE_OPTIONS, parseGroupJsonl } from './candidates.mjs';
import { callGenerate, unloadModel, residentSize, modelProfile, listModels, isEnvironmentFailure, gib } from './ollama.mjs';
import { HIERARCHY_SEEDS } from './seeds.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const OLLAMA_URL = arg('url', 'http://localhost:11434');
const MODEL = arg('model', 'qwen3:14b');
const CHUNK = parseInt(arg('chunk', '50'), 10);
const NUM_CTX = parseInt(arg('num-ctx', '32768'), 10);
const TIMEOUT_S = parseInt(arg('timeout', '600'), 10);
const THINK = arg('think', 'auto');
const THINK_FLAG = THINK === 'auto' ? null : THINK === 'on';
const KIND = arg('kind', 'basic');
const PARENTS_JSON = arg('parents', null);
const MAX_CHUNKS = parseInt(arg('max-chunks', '0'), 10); // 0=全部。試運転用
/**
 * 割当0だったチャンクの再試行回数。
 *
 * **実行ごとのばらつきが実測で確認されている。** 同一プロンプト・同一入力・
 * temperature 0.1 で、全件実行時は 0 件、単独再実行では 78 件だった。
 * 21チャンク中3つ（14%）がこの状態になり、**失敗として記録されない**。
 *
 * ユーザーから見ると「毎回違うタグが理由なく提案されない」。
 * **出なかった提案は見えないので取り返せない**一方、**追加の呼び出しは安い**。
 * この非対称から、0件は必ず再試行する。
 */
const RETRY_EMPTY = parseInt(arg('retry-empty', '2'), 10);
const DB_PATH = arg('db', null);

async function main() {
  if (!PARENTS_JSON) { console.error('--parents に parent-scan の結果 JSON を指定してください'); process.exit(1); }
  const models = await listModels(OLLAMA_URL);
  if (!models) { console.error(`Ollama (${OLLAMA_URL}) に接続できません。落ちている可能性があります。`); process.exit(1); }
  if (!models.some((m) => m.name === MODEL)) {
    console.error(`モデルが Ollama にありません: ${MODEL}\n利用可能: ${models.map((m) => m.name).join(', ')}`);
    process.exit(1);
  }
  const profile = await modelProfile(OLLAMA_URL, MODEL);

  const categories = new Set();
  for (const p of PARENTS_JSON.split(',')) {
    const j = JSON.parse(fs.readFileSync(path.resolve(p.trim()), 'utf8'));
    (j.parents ?? []).forEach((n) => categories.add(n));
  }

  const snap = path.join(HERE, 'results', 'snapshot.db');
  if (!has('reuse') || !fs.existsSync(snap)) ensureSnapshot(REPO_ROOT, DB_PATH, snap);
  const pool = loadTags(snap).filter((t) => t.kind === KIND && !t.name.includes('_'));
  const catTags = pool.filter((t) => categories.has(t.name));
  const items = pool.filter((t) => !categories.has(t.name));

  let chunks = [];
  for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));
  if (MAX_CHUNKS > 0) chunks = chunks.slice(0, MAX_CHUNKS);

  console.log('\n=== 段2: カテゴリへの割り当て ===');
  console.log(`model    : ${MODEL} (${profile.parameterSize ?? '?'})`);
  console.log(`カテゴリ : ${catTags.length} 件（段1の出力）`);
  console.log(`対象     : ${items.length} 件を ${CHUNK} 件 × ${chunks.length} チャンク`);
  console.log(`think    : ${THINK} / timeout: ${TIMEOUT_S}秒\n`);

  /** target -> Set(member)。**チャンクを跨いでここに集約する** */
  const agg = new Map();
  const rows = [];
  let invented = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    const itemNames = new Set(chunk.map((t) => t.name));
    const prompt = ASSIGN_PROMPT.build(catTags.map(descriptorOf), chunk.map(descriptorOf));
    const row = { chunk: ci, size: chunk.length, elapsedMs: 0, assigned: 0, failReason: null, attempts: 0 };
    let rawResponse = null;
    const t0 = Date.now();
    // 割当0なら再試行する（上のコメント参照）。採れた時点で抜ける。
    // **時間切れも同じ扱いにする。** 未判定のタグはユーザーに存在すら見えないので、
    // 「失敗として正しく記録された」だけでは足りない。ただし同じ条件で再実行しても
    // 同じく時間切れになるだけなので、**thinking を切って条件を変える**
    // （段1では6〜15倍速くなった。割り当ては出力が短く品質劣化のリスクも低い）。
    let thinkNow = THINK_FLAG;
    for (let attempt = 0; attempt <= RETRY_EMPTY; attempt++) {
      row.attempts = attempt + 1;
      const pending = new Map();
      try {
        const r = await callGenerate(OLLAMA_URL, MODEL, prompt, {
          options: { ...CANDIDATE_OPTIONS, num_ctx: NUM_CTX }, think: thinkNow, timeoutMs: TIMEOUT_S * 1000,
        });
        rawResponse = r.response;
        row.evalCount = r.eval_count ?? null;
        row.doneReason = r.done_reason ?? null;
        row.failReason = null;
        const parsed = parseGroupJsonl(r.response);
        row.lines = parsed.lines ?? 0;
        row.badLines = parsed.badLines ?? 0;
        row.rawGroups = (parsed.groups ?? []).length;
        let bad = 0;
        let got = 0;
        for (const g of parsed.groups ?? []) {
          const target = String(g.target ?? '').split('(')[0].trim();
          if (!categories.has(target)) { bad++; continue; }
          for (const m of g.members ?? []) {
            const name = String(m).split('(')[0].trim();
            // **item 側にしか居ない名前だけを受け付ける。**
            // カテゴリ同士を結ばせない制約が効いているかの検査も兼ねる
            if (!itemNames.has(name)) { bad++; continue; }
            if (!pending.has(target)) pending.set(target, new Set());
            pending.get(target).add(name);
            got++;
          }
        }
        if (got > 0 || attempt === RETRY_EMPTY) {
          // 採れた分だけを集約に反映する（再試行して駄目でも最後の結果で確定）
          for (const [t, s] of pending) {
            if (!agg.has(t)) agg.set(t, new Set());
            s.forEach((n) => agg.get(t).add(n));
          }
          row.assigned = got;
          invented += bad;
          break;
        }
      } catch (e) {
        row.failReason = e.code === 'GENERATION_TIMEOUT' ? 'timeout'
          : isEnvironmentFailure(e.message) ? 'env_failure' : 'request_error';
        row.error = String(e.message).slice(0, 140);
        // 時間切れは thinking を切って1度だけやり直す。それでも駄目なら諦める。
        // 環境障害（llama-server 落ち）は Ollama の再起動が要るので繰り返さない
        if (row.failReason === 'timeout' && thinkNow !== false && attempt < RETRY_EMPTY) {
          thinkNow = false;
          row.timeoutFallback = true;
          continue;
        }
        break;
      }
    }
    row.elapsedMs = Date.now() - t0;
    // **割当0は「失敗と記録されない失敗」。** done=stop・eval も出ているのに
    // 有効な割り当てが1件も採れていない状態。ユーザーにはそのチャンクのタグが
    // 存在しないのと同じになり、**出なかった提案は見えない**ので取り返せない。
    // 実測: 21チャンク中3つがこれで、うち1つは bowl/cup/plate/glass/car を含む
    // 最も一般的なタグの塊だった。生応答を残して原因を追えるようにする。
    if (!row.failReason && row.assigned === 0) row.emptyRaw = (rawResponse ?? '').trim().slice(0, 600);
    rows.push(row);
    console.log(`  chunk ${String(ci + 1).padStart(2)}/${chunks.length}  ${String((row.elapsedMs / 1000).toFixed(1)).padStart(6)}s  ` +
      (row.failReason ? `NG ${row.failReason}${row.timeoutFallback ? '（think off でも駄目）' : ''}`
        : row.assigned === 0 ? `**割当0**（${row.attempts}回試行）`
        : `割当 ${String(row.assigned).padStart(3)}` +
          (row.timeoutFallback ? '  時間切れ→think off で成功' : row.attempts > 1 ? `  ${row.attempts}回目で成功` : '')));
  }

  const vram = await residentSize(OLLAMA_URL, MODEL);
  await unloadModel(OLLAMA_URL, MODEL);

  console.log('\n================ 判定 ================\n');
  const failed = rows.filter((r) => r.failReason);
  if (failed.length) {
    console.log(`**失敗: ${failed.length}/${chunks.length} チャンク** — ${[...new Set(failed.map((r) => r.failReason))].join(', ')}`);
    console.log('  <- 失敗分のタグは割り当てられていない。以下は過小評価\n');
  }

  const groups = [...agg.entries()].map(([t, s]) => ({ target: t, members: [...s] }))
    .sort((a, b) => b.members.length - a.members.length);
  const total = groups.reduce((s, g) => s + g.members.length, 0);
  // **割当0のチャンクは最優先の欠陥。** そのチャンクのタグはユーザーに存在すら見えない
  const empty = rows.filter((r) => !r.failReason && r.assigned === 0);
  if (empty.length) {
    console.log(`**割当0のチャンク: ${empty.length}/${chunks.length}** — そのチャンクのタグは提案に一切現れない`);
    empty.forEach((r) => console.log(`  chunk ${r.chunk + 1}: 行${r.lines} 不正${r.badLines} group${r.rawGroups} / ${JSON.stringify((r.emptyRaw ?? '').slice(0, 120))}`));
    console.log('  <- **誤った提案は見えるし除外も安いが、出なかった提案は見えない。** 最優先で潰すこと\n');
  }
  console.log(`提案グループ : ${groups.length}（延べメンバー ${total}）`);
  console.log(`発明・範囲外 : ${invented}`);
  console.log(`所要         : ${(rows.reduce((s, r) => s + r.elapsedMs, 0) / 60000).toFixed(1)} 分`);

  const sizes = groups.map((g) => g.members.length);
  console.log(`\nサイズ分布   : 最大 ${sizes[0] ?? 0} / 3件以上 ${sizes.filter((s) => s >= 3).length} / 2件 ${sizes.filter((s) => s === 2).length} / 1件 ${sizes.filter((s) => s === 1).length}`);
  console.log('  **UI は件数降順なので、大きいグループが出るかが要点。**');
  console.log('  現行ルールのみのベースライン: 365提案 / 延べ1,071 / うち2件のみ209');

  console.log('\n--- 上位の提案（UI に出る順）---');
  groups.slice(0, 15).forEach((g) => console.log(`  ${g.target} <- ${g.members.join(', ')}`));

  // ---- シード回収（親は常に入力に居るので運の要素が無い）----
  console.log('\n--- 階層シードの回収 ---');
  const inPool = (n) => pool.some((t) => t.name === n);
  const testable = HIERARCHY_SEEDS.filter(([p, c]) => categories.has(p) && inPool(c)
    && chunks.some((ch) => ch.some((t) => t.name === c)));
  const got = testable.filter(([p, c]) => agg.get(p)?.has(c));
  testable.forEach(([p, c]) => console.log(`  ${agg.get(p)?.has(c) ? '○' : '**×**'} ${p} ⊃ ${c}`));
  console.log(`\n  ${got.length}/${testable.length} 組`);
  const notTestable = HIERARCHY_SEEDS.filter(([p, c]) => inPool(p) && inPool(c) && !testable.some(([q, d]) => q === p && d === c));
  if (notTestable.length) {
    console.log(`  （対象外: ${notTestable.map(([p, c]) => `${p}⊃${c}`).join(', ')} — 親がカテゴリに無いか子がチャンク範囲外）`);
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `assign-scan-${MODEL.replace(/[:\\/]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({
    model: MODEL, profile, chunk: CHUNK, numCtx: NUM_CTX, think: THINK, kind: KIND,
    categories: [...categories].sort(), groups, invented, vram: vram.sizeVram,
    ranAt: new Date().toISOString(), rows,
  }, null, 2));
  console.log(`\nVRAM: ${gib(vram.sizeVram)}`);
  console.log(`生データ: ${path.relative(REPO_ROOT, out)}`);
}

main().catch((e) => { console.error('\n[FATAL]', e); process.exit(1); });
