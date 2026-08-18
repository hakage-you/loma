#!/usr/bin/env node
/**
 * S1: 「basic タグを1プロンプトで全件渡す」が成立するかを単独で測る。**go/no-go 判定用。**
 *
 * この設計は「basic 2,287件（約19Kトークン）を1回で処理できる」という一点に賭けている。
 * ×なら方式A・Bの構成が全部書き直しになるので、**重い工程に埋めずに最初に単独で測る。**
 *
 * ## 切り捨てを検出できないと、この計測は全部無意味になる
 *
 * 本番の同義語検出は `options` を送っておらず num_ctx は Ollama 既定（通常4096）。
 * その状態で大きなプロンプトを投げると **Ollama は黙って切り捨てる。しかも切られるのは
 * 先頭＝指示文側**で、`done_reason` は `stop`（正常終了）で返る。
 * `format:"json"` が `{}` に縮退した事故と同じ形の静かな故障。
 *
 * ここでは `prompt_eval_count` を必ず記録し、**入力サイズに比例して伸びなくなった段**を
 * 切り捨て発生点として検出する。切り捨てが起きた回の品質評価は**破棄する**
 * （指示文を失ったモデルの出力を「プロンプトが悪い」と読んではいけない）。
 *
 * ## 何を分離するか
 *
 * 失敗を「プロンプトが悪い」「文脈長で落ちる」「出力が切れる」の3つに分ける。
 * 分けないと、どれを直せばいいのか分からない。
 *
 *   node tools/text-check/ladder.mjs --model qwen3:14b --num-ctx 32768
 *   node tools/text-check/ladder.mjs --model qwen3:14b --num-ctx 4096 --sizes 2287  # 切り捨ての再現
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureSnapshot, loadTags, descriptorOf } from './tags.mjs';
import { CANDIDATE_PROMPTS, CANDIDATE_OPTIONS, parseGroupJson, parseGroupJsonl, validateGroups } from './candidates.mjs';
import { callGenerate, unloadModel, residentSize, modelProfile, listModels, isEnvironmentFailure, ns2ms, gib } from './ollama.mjs';
import { classifyByRules } from './rules.mjs';
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
const SIZES = arg('sizes', '100,300,600,1200,2287').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const NUM_CTX = parseInt(arg('num-ctx', '32768'), 10);
const KIND = arg('kind', 'basic');
/**
 * 入力を単語数で絞る。**Pass H（包括関係）は `single` で回す。**
 * 階層シード18組のうち14組が「単語1語 ⊃ 単語1語」で、単語1語 basic は
 * 全体の35%（1,094件 / 14,786文字）しかない。包括関係のために全件を
 * 1プロンプトに入れる必要はない、という測定結果に基づく（partition-check.mjs）。
 */
const WORDS = arg('words', 'all'); // single | multi | all
const VARIANT = arg('variant', 'group_jsonl');
const REPEAT = parseInt(arg('repeat', '1'), 10);
/** `name (name_ja)` を付けるか。日本語はトークン効率が悪いので、落とした場合も測る */
const JA_MODE = arg('ja', 'on'); // on | off | both
const DB_PATH = arg('db', null);
/**
 * 階層シードのタグを必ずサンプルに含める。**既定で有効。**
 *
 * これが無いと、小さい段では等間隔サンプリングが `container` と `bowl` の両方を
 * 引く確率がほぼ無く、再現率が最大段でしか測れない。固定すれば
 * **「プロンプトが大きすぎる」と「邪魔なタグが多すぎる」を分離できる**
 * — 同じシードを、周りのタグ数だけ変えて何度も探させることになるため。
 */
const PIN_SEEDS = !has('no-pin-seeds');
/**
 * thinking を止めるか。`auto`（既定）はモデル任せ＝本番と同じ。
 * **所要時間を支配する軸なので独立して振れるようにする。**
 */
const THINK = arg('think', 'auto'); // auto | on | off
const THINK_FLAG = THINK === 'auto' ? null : THINK === 'on';
/**
 * 1回の生成に許す時間（秒）。0 で無制限。
 *
 * **これが唯一の歯止め。** 生成長は Ollama 側で止められない
 * （num_ctx は文脈シフトで素通り・num_predict は thinking を壊す）。
 * 実測: qwen3:14b は n=200 で 98分・32万トークン生成して空応答を返した。
 * 上限が無いと、発散1回につき1時間半が溶ける。
 */
const TIMEOUT_S = parseInt(arg('timeout', '900'), 10);
/**
 * 段2の検証: `parent-scan.mjs` が出した包括語を JSON から読み、**全チャンクに注入する。**
 *
 * これが設計の要。素の分割では親と子が別チャンクに落ちて
 * 2件ペアの断片しか出ない（実測: 固定なし n=100 で3件、うち1件はルールが拾う組）。
 * 包括語を毎回入れれば同居が構造的に保証される。
 */
const PARENTS_JSON = arg('parents', null);

if (has('help')) {
  console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'));
  process.exit(0);
}

/**
 * 切り捨ての検出。
 *
 * トークナイザを持たないので絶対値では判定できない。代わりに
 * **入力文字数あたりの prompt_eval_count（トークン密度）が急落した段**を切り捨てとみなす。
 * 加えて num_ctx にほぼ張り付いた場合も切り捨て扱いにする。
 */
function detectTruncation(rows, numCtx) {
  const ok = rows.filter((r) => r.promptEvalCount != null && r.inputChars > 0);
  if (ok.length < 2) return;
  // 最小サイズの密度を基準にする（そこは切り捨てられていないはず）
  const base = ok[0].promptEvalCount / ok[0].inputChars;
  for (const r of ok) {
    const density = r.promptEvalCount / r.inputChars;
    r.tokenDensity = density;
    const ratio = density / base;
    // 密度が基準の85%を下回る＝入力が伸びた分だけトークンが増えていない
    const densityDrop = ratio < 0.85;
    const nearCap = r.promptEvalCount >= numCtx * 0.95;
    r.truncated = densityDrop || nearCap;
    r.truncationReason = r.truncated
      ? [densityDrop ? `密度が基準の${(ratio * 100).toFixed(0)}%` : null, nearCap ? `num_ctx に張り付き` : null]
          .filter(Boolean).join(' / ')
      : '';
  }
}

/**
 * シード回収率。**これが合格条件の本体。**
 *
 * 「切り捨てゼロ・パース成功」は必要条件でしかなく、それだけを見ると
 * 「安全に3グループだけ出すモデル」が最高得点になる。手で実在を確認した
 * 階層シードを入力に入れておき、**そのうち何組を実際に拾ったか**を数える。
 * 埋め込みで作った正解セットと違い、自己採点にならない。
 *
 * 回収の定義: 提案されたどれかのグループが、親と子の両方を含むこと。
 * target がどちらかは問わない（ユーザーが入れ替える前提のため）。
 *
 * **target を members に入れないモデルがある**（`{"target":"container","members":["bowl"]}`）。
 * members だけを見ると `container ⊃ bowl` を回収漏れと数えてしまうので、必ず和を取る。
 */
function seedRecovery(groups, sampleNames) {
  const present = HIERARCHY_SEEDS.filter(([p, c]) => sampleNames.has(p) && sampleNames.has(c));
  const sets = (groups ?? []).map((g) => new Set([...g.members, g.target]));
  const found = present.filter(([p, c]) => sets.some((s) => s.has(p) && s.has(c)));
  return { present: present.length, found: found.length, foundPairs: found.map((x) => x.join('⊃')) };
}

async function main() {
  const models = await listModels(OLLAMA_URL);
  if (!models) {
    console.error(`Ollama (${OLLAMA_URL}) に接続できません。`);
    process.exit(1);
  }
  if (!models.some((m) => m.name === MODEL)) {
    console.error(`モデルが Ollama にありません: ${MODEL}\n利用可能: ${models.map((m) => m.name).join(', ')}`);
    process.exit(1);
  }
  const profile = await modelProfile(OLLAMA_URL, MODEL);
  if (profile.contextLength && NUM_CTX > profile.contextLength) {
    console.error(
      `[警告] --num-ctx ${NUM_CTX} はモデルの context_length ${profile.contextLength} を超えています。\n` +
        '        超えた分は効かないので、切り捨てが起きます。'
    );
  }

  const snap = path.join(HERE, 'results', 'snapshot.db');
  if (!has('reuse') || !fs.existsSync(snap)) {
    console.log('スナップショットを作成中...');
    ensureSnapshot(REPO_ROOT, DB_PATH, snap);
  }
  // 段2で注入する包括語。複数ファイルを渡せば和集合になる
  const injectNames = new Set();
  for (const p of (PARENTS_JSON ? PARENTS_JSON.split(',') : [])) {
    const j = JSON.parse(fs.readFileSync(path.resolve(p.trim()), 'utf8'));
    (j.parents ?? []).forEach((n) => injectNames.add(n));
  }

  const kindTags = loadTags(snap).filter((t) => t.kind === KIND);
  const allTags = WORDS === 'single' ? kindTags.filter((t) => !t.name.includes('_'))
    : WORDS === 'multi' ? kindTags.filter((t) => t.name.includes('_'))
    : kindTags;
  if (!allTags.length) {
    console.error(`入力が空です（kind=${KIND} / words=${WORDS}）`);
    process.exit(1);
  }
  console.log(`\n=== S1 実行可能性ラダー ===`);
  console.log(`model    : ${MODEL} (${profile.parameterSize ?? '?'}${profile.thinking ? ' / thinking' : ''}` +
    `${profile.contextLength ? ` / ctx上限 ${profile.contextLength}` : ''})`);
  console.log(`num_ctx  : ${NUM_CTX}   <- **本番は options を送っていないので、これは本番に無い条件**`);
  console.log(`kind     : ${KIND} / words=${WORDS}（${allTags.length} 件 / kind 全体 ${kindTags.length} 件）`);
  console.log(`variant  : ${VARIANT} — ${CANDIDATE_PROMPTS[VARIANT].label}`);
  console.log(`sizes    : ${SIZES.join(', ')}`);
  console.log(`ja       : ${JA_MODE}`);
  console.log(`think    : ${THINK}${THINK === 'auto' ? '（モデル既定＝本番と同じ）' : ''}`);
  if (injectNames.size) {
    console.log(`包括語注入: ${injectNames.size} 件（段2の検証。残り ${SIZES[0] - injectNames.size} 件が通常タグ）`);
  }
  console.log(`seed固定 : ${PIN_SEEDS ? 'あり（各段にシードのタグを必ず入れる）' : 'なし'}\n`);

  const jaModes = JA_MODE === 'both' ? ['on', 'off'] : [JA_MODE];
  const rows = [];

  for (const ja of jaModes) {
    for (const size of SIZES) {
      const n = Math.min(size, allTags.length);
      // 等間隔サンプリングで決定的に選ぶ（実行間で比較可能にするため）
      const step = allTags.length / n;
      const sample = [];
      for (let i = 0; i < n; i++) sample.push(allTags[Math.floor(i * step)]);

      if (injectNames.size) {
        // 段2: 包括語を必ず入れる。**残りの枠だけを通常のタグで埋める。**
        // シード固定と違い、これは**本番でも同じことをする**前提の条件。
        const inject = allTags.filter((t) => injectNames.has(t.name));
        const rest = sample.filter((t) => !injectNames.has(t.name));
        const chosen = new Set([...inject, ...rest.slice(0, Math.max(0, n - inject.length))].map((t) => t.id));
        sample.length = 0;
        sample.push(...allTags.filter((t) => chosen.has(t.id)));
      }

      if (PIN_SEEDS) {
        // シードのタグを必ず入れる。件数 n は変えない。
        // **末尾から pop してはいけない**（直前に足したシードを消してしまう）。
        // 非シード側を削り、最後に元の並び順へ戻す。**先頭に固めるとシードだけが
        // 最良の位置に来て回収率が水増しされる**ため、位置は元の分布のまま保つ。
        const seedNames = new Set(HIERARCHY_SEEDS.flat());
        const seedTags = allTags.filter((t) => seedNames.has(t.name));
        const rest = sample.filter((t) => !seedNames.has(t.name));
        const chosen = new Set([...seedTags, ...rest.slice(0, Math.max(0, n - seedTags.length))].map((t) => t.id));
        sample.length = 0;
        sample.push(...allTags.filter((t) => chosen.has(t.id)));
      }
      const sampleNames = new Set(sample.map((t) => t.name));
      const descriptors = sample.map((t) => (ja === 'on' ? descriptorOf(t) : t.name));
      const prompt = CANDIDATE_PROMPTS[VARIANT].build(descriptors);

      for (let rep = 0; rep < REPEAT; rep++) {
        const row = {
          size: n, ja, rep, inputChars: prompt.length,
          elapsedMs: 0, promptEvalCount: null, evalCount: null, doneReason: null,
          thinkingChars: 0, parseOk: false, failReason: null,
          lines: 0, badLines: 0, rawGroups: 0, validGroups: 0, stats: null, rawSample: null,
          seedsPresent: 0, seedsFound: 0, seedPairs: [],
        };
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
          row.thinkingChars = (r.thinking ?? '').length;

          const parsed = VARIANT === 'group_jsonl' ? parseGroupJsonl(r.response) : parseGroupJson(r.response);
          row.lines = parsed.lines ?? 0;
          row.badLines = parsed.badLines ?? 0;
          row.rawGroups = parsed.groups.length;
          // 「1行1グループ」を守らず整形して出した場合。内容は取れているので失敗ではないが、
          // 形式を守れないこと自体はプロンプト調整の材料になる
          row.formatViolation = parsed.formatViolation === true;
          if (parsed.ok) {
            row.parseOk = true;
            const v = validateGroups(parsed.groups, sample);
            row.validGroups = v.groups.length;
            row.stats = v.stats;
            row.groups = v.groups.map((g) => ({ target: g.target.name, members: g.members.map((m) => m.name) }));
            const rec = seedRecovery(row.groups, sampleNames);
            row.seedsPresent = rec.present;
            row.seedsFound = rec.found;
            row.seedPairs = rec.foundPairs;
            // パースは通ったのに有効グループ0のとき、原因（発明タグ等）を見るには生応答が要る
            if (!v.groups.length) row.rawSample = (r.response ?? '').trim().slice(0, 400);
          } else {
            row.failReason = parsed.reason;
            row.rawSample = (r.response ?? '').trim().slice(0, 400);
          }
        } catch (e) {
          row.elapsedMs = Date.now() - t0;
          // 環境障害をモデルの失敗と混ぜない（Ollama の llama-server 落ちは既知 issue）
          row.failReason = e.code === 'GENERATION_TIMEOUT' ? 'timeout'
            : isEnvironmentFailure(e.message) ? 'env_failure'
            : 'request_error';
          row.rawSample = String(e.message).slice(0, 200);
        }
        rows.push(row);
        console.log(
          `  n=${String(row.size).padStart(4)} ja=${ja} rep${rep}  ` +
            `${String((row.elapsedMs / 1000).toFixed(1)).padStart(6)}s  ` +
            `prompt_eval=${String(row.promptEvalCount ?? '-').padStart(6)}  ` +
            `eval=${String(row.evalCount ?? '-').padStart(5)}  ` +
            `done=${String(row.doneReason ?? '-').padEnd(6)}  ` +
            (row.parseOk
              ? `OK  groups=${row.validGroups}/${row.rawGroups}  seed=${row.seedsFound}/${row.seedsPresent}` +
                (row.badLines ? ` (不正行 ${row.badLines}/${row.lines})` : '')
              : `NG  ${row.failReason}`)
        );
      }
    }
  }

  const size = await residentSize(OLLAMA_URL, MODEL);
  await unloadModel(OLLAMA_URL, MODEL);

  // ---- 切り捨て検出 ----
  for (const ja of jaModes) detectTruncation(rows.filter((r) => r.ja === ja), NUM_CTX);

  console.log('\n================ 判定 ================\n');
  const hd = ['n', 'ja', '入力文字', 'prompt_eval', 'トークン密度', '切り捨て', 'done', '有効group', 'シード回収', '秒'];
  const body = rows.map((r) => [
    String(r.size), r.ja, String(r.inputChars),
    String(r.promptEvalCount ?? '-'),
    r.tokenDensity ? r.tokenDensity.toFixed(4) : '-',
    r.truncated ? `** ${r.truncationReason}` : '',
    String(r.doneReason ?? '-'),
    r.parseOk ? String(r.validGroups) : `NG ${r.failReason}`,
    r.parseOk ? `${r.seedsFound}/${r.seedsPresent}` : '-',
    (r.elapsedMs / 1000).toFixed(1),
  ]);
  const w = hd.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cs) => cs.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(hd));
  console.log(w.map((x) => '-'.repeat(x)).join('  '));
  body.forEach((b) => console.log(line(b)));

  const truncated = rows.filter((r) => r.truncated);
  const clean = rows.filter((r) => !r.truncated);
  const passed = clean.filter((r) => r.parseOk && r.validGroups > 0);
  const maxOk = passed.length ? Math.max(...passed.map((r) => r.size)) : 0;

  console.log('\n--- 失敗の切り分け ---');
  const envFails = rows.filter((r) => r.failReason === 'env_failure');
  if (envFails.length) {
    console.log(`  **環境障害（Ollama側）           : ${envFails.length} 回**`);
    console.log(`    <- モデルの失敗ではない。Ollama を再起動して測り直すこと。`);
    console.log(`    ${envFails[0].rawSample}`);
  }
  console.log(`  文脈長で落ちた（切り捨て検出）   : ${truncated.length} 回`);
  if (truncated.length) {
    console.log(`    <- この回の品質評価は破棄する。指示文を失ったモデルの出力を「プロンプトが悪い」と読まないこと`);
  }
  // **「答えの途中で切れた」と「答えを出さずに発散した」は別物。**
  // 後者は done=length で返るので混ざるが、診断も対策も違う。
  // 実測: qwen3:14b は n=200 で eval=327,680（num_ctx の10倍）を吐き、応答は空だった。
  // 文脈シフトで生成が続くため num_ctx では止まらない（note-ollama-num-ctx-not-a-generation-cap）。
  // 打ち切りも発散の一種（終わらないことを時間で確認した回）
  const timedOut = rows.filter((r) => r.failReason === 'timeout');
  if (timedOut.length) {
    console.log(`  **時間切れ（${TIMEOUT_S}秒）           : ${timedOut.length} 回**`);
    console.log(`    <- この規模では終わらない、という測定値。モデルの故障ではない`);
    timedOut.forEach((r) => console.log(`       n=${r.size}`));
  }
  const diverged = clean.filter(
    (r) => r.doneReason === 'length' && (r.evalCount ?? 0) >= NUM_CTX * 2 && !r.parseOk
  );
  const cutoff = clean.filter((r) => r.doneReason === 'length' && !diverged.includes(r));
  console.log(`  出力が切れた（done=length）      : ${cutoff.length} 回`);
  if (diverged.length) {
    console.log(`  **生成が発散した                 : ${diverged.length} 回**`);
    console.log(`    <- 答えを出さずに生成し続けた。「途中で切れた」とは別物で、プロンプトを`);
    console.log(`       短くしても直らない。この規模がこのモデルの限界という意味`);
    diverged.forEach((r) => console.log(
      `       n=${r.size}: eval=${r.evalCount}（num_ctx の${(r.evalCount / NUM_CTX).toFixed(1)}倍） ${(r.elapsedMs / 60000).toFixed(0)}分`
    ));
  }
  console.log(`  パースできない                  : ${clean.filter((r) => !r.parseOk && r.failReason !== 'env_failure').length} 回`);
  const fmtViol = clean.filter((r) => r.formatViolation).length;
  if (fmtViol) {
    console.log(`  形式違反だが内容は復旧できた    : ${fmtViol} 回`);
    console.log(`    <- 「1行1グループ」を守らず整形して出している。内容の失敗とは別物`);
  }
  // パースは通ったのに有効グループ0、という失敗を取りこぼさない。
  // 極小モデルはテンプレートのプレースホルダ（"tagA" 等）をそのまま返すので、
  // 発明タグとして全部落ちる。これは「パース成功」に見えるが実質は失敗
  const emptyRuns = clean.filter((r) => r.parseOk && r.validGroups === 0);
  console.log(`  パースは通ったが有効グループ0    : ${emptyRuns.length} 回`);
  if (emptyRuns.length) {
    const sum = (k) => emptyRuns.reduce((s, r) => s + (r.stats?.[k] ?? 0), 0);
    console.log(
      `    内訳: 例のコピー ${sum('exampleCopied')} / 発明タグ ${sum('invented')} / ` +
        `実質1件以下 ${sum('degenerate')} / 種別またぎ ${sum('crossKind')}`
    );
    if (sum('exampleCopied')) {
      console.log(`    <- **プロンプト内の例をそのまま返している。** 入力タグを見ていない。`);
      console.log(`       例が強すぎるか、モデルが指示に従えていない（プロンプトの問題）`);
    }
  }
  // 例のコピーは有効グループが出た回でも起きるので全体でも見る
  const copiedAll = clean.reduce((s, r) => s + (r.stats?.exampleCopied ?? 0), 0);
  if (copiedAll && !emptyRuns.length) {
    console.log(`  プロンプトの例をそのまま返した回数 : ${copiedAll}（有効グループは出ているが混入している）`);
  }

  console.log(`\n**通った最大サイズ: ${maxOk} 件 / 入力プール ${allTags.length} 件**`);
  if (maxOk >= allTags.length) {
    console.log(`  -> ${WORDS === 'single' ? 'Pass H（単語1語 basic 全件を1プロンプト）' : '全件1プロンプト'} は「実行できる」。`);
    console.log('     ただしこれは必要条件でしかない。**採否はシード回収率で決める**（下記）。');
  } else if (maxOk > 0) {
    console.log(`  -> 全件は通らない。分割が要る。ただし粗分割は階層を19〜25%しか保存しない`);
    console.log(`     （partition-check.mjs）ので、包括関係は分割では取れない。`);
  } else {
    console.log('  -> 一度も通っていない。num_ctx / モデル / プロンプトのどれが原因かを上の切り分けで確認すること。');
  }

  // ---- シード回収率（合格条件の本体）----
  console.log('\n--- シード回収率（これが合格条件）---');
  const withSeeds = clean.filter((r) => r.parseOk && r.seedsPresent > 0);
  if (!withSeeds.length) {
    console.log('  シードを含む有効な回が無い。上の切り分けを先に潰すこと。');
  } else {
    for (const r of withSeeds) {
      console.log(
        `  n=${String(r.size).padStart(4)} ja=${r.ja}  ${r.seedsFound}/${r.seedsPresent} 組` +
          (r.seedPairs.length ? `  [${r.seedPairs.join(', ')}]` : '')
      );
    }
    console.log('\n  周りのタグ数だけを変えて同じシードを探させている。**回収率が n とともに落ちるなら、');
    console.log('  原因はプロンプト長ではなく「邪魔なタグが多すぎる」側**であり、分割では解決しない。');
    console.log('  0/n が続く場合は、包括関係そのものを LLM が出せていない（プロンプトか方式の作り直し）。');
  }

  if (passed.length) {
    const best = passed[passed.length - 1];
    console.log(`\n--- 最大サイズでの中身（n=${best.size}）---`);
    console.log(`  発明タグ ${best.stats.invented} / 種別またぎ ${best.stats.crossKind} / ` +
      `target が members 外 ${best.stats.targetNotInMembers} / 実質1件以下 ${best.stats.degenerate}`);
    for (const g of (best.groups ?? []).slice(0, 12)) {
      console.log(`    ${g.target} <- ${g.members.filter((m) => m !== g.target).join(', ')}`);
    }
    if ((best.groups ?? []).length > 12) console.log(`    ...他 ${best.groups.length - 12} グループ`);
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `ladder-${MODEL.replace(/[:\\/]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({
    model: MODEL, profile, numCtx: NUM_CTX, kind: KIND, words: WORDS, poolSize: allTags.length,
    variant: VARIANT, pinSeeds: PIN_SEEDS, think: THINK,
    options: { ...CANDIDATE_OPTIONS, num_ctx: NUM_CTX },
    vram: size.sizeVram, ranAt: new Date().toISOString(), rows,
  }, null, 2));
  console.log(`\nVRAM: ${gib(size.sizeVram)}`);
  console.log(`生データ: ${path.relative(REPO_ROOT, out)}`);
  console.log(`\nこの実行を再現するコマンド:\n  node tools/text-check/ladder.mjs --model "${MODEL}" ` +
    `--num-ctx ${NUM_CTX} --sizes ${SIZES.join(',')} --kind ${KIND} --words ${WORDS} ` +
    `--variant ${VARIANT} --ja ${JA_MODE} --think ${THINK} --timeout ${TIMEOUT_S} --repeat ${REPEAT}` +
    `${PIN_SEEDS ? '' : ' --no-pin-seeds'}\n`);
}

main().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
