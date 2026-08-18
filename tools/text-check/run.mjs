#!/usr/bin/env node
/**
 * タグ同義語検出モデル比較（`tools/prompt-check` のテキストモデル版）
 *
 * `RECOMMENDED_TEXT_MODELS`（タグ整理用）の実際の用途は commands.rs
 * `run_suggest_tag_merges_logic` にある「タグ一覧 → 同義語ペアをJSONで返す」
 * 単一タスクのみ（翻訳用途の呼び出しは存在しない）。このツールはその1機能だけを測る。
 *
 * 本番 (src-tauri/src/commands.rs) と同じ条件を再現する:
 *   - POST /api/generate, options 指定なし（temperature 等はOllama既定値）
 *   - format:"json" は既定で送らない（thinking モデルの応答が {} に縮退する既知の欠陥のため）
 *   - JSON抽出は find('{') / rfind('}') と同じ手順
 *
 * 使い方は README.md を参照。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSynonymPrompt } from './prompt.mjs';
import { ensureSnapshot, loadTags, descriptorOf, buildSamples, resolvePair } from './tags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const OLLAMA_URL = arg('url', 'http://localhost:11434');
let MODELS = arg('models', arg('model', 'qwen3:14b')).split(',').map((s) => s.trim()).filter(Boolean);
const MULTI_MODEL = MODELS.length > 1;
// 本番の呼び出し条件（free_tags.len() が 2〜300）を跨いだサイズで比較する
const SIZES = arg('sizes', '10,50,200').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
const REPEAT = parseInt(arg('repeat', '2'), 10);
const FORMAT_MODE = arg('format-json', 'off'); // off | on | both
const DB_PATH = arg('db', null);
const REUSE_SNAPSHOT = has('reuse');
const SIDE_BY_SIDE_SIZE = parseInt(arg('side-by-side-size', String(SIZES[0] ?? 10)), 10);

if (has('help')) {
  console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'));
  process.exit(0);
}

// ---------------------------------------------------------------- パース (本番と同一ロジック)

/** commands.rs の JSON 抽出（find('{') / rfind('}')）と同じ手順 */
function extractJsonText(rawResponse) {
  const clean = (rawResponse ?? '').trim();
  if (!clean) return { ok: false, reason: 'empty_response' };
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  const text = start >= 0 && end >= 0 && start < end ? clean.slice(start, end + 1) : clean;
  return { ok: true, text };
}

/** commands.rs の synonyms 配列取り出しと同じスキーマ検証 */
function parseSynonymResponse(rawResponse) {
  const ex = extractJsonText(rawResponse);
  if (!ex.ok) return { ok: false, reason: ex.reason };
  let obj;
  try {
    obj = JSON.parse(ex.text);
  } catch (e) {
    return { ok: false, reason: 'json_syntax_error', detail: String(e.message).slice(0, 120) };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_an_object' };
  if (!Array.isArray(obj.synonyms)) return { ok: false, reason: 'missing_synonyms' };
  const pairs = [];
  for (const pair of obj.synonyms) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      return { ok: false, reason: 'synonym_pair_malformed' };
    }
    pairs.push([pair[0], pair[1]]);
  }
  return { ok: true, pairs };
}

// ---------------------------------------------------------------- Ollama

async function callGenerate(model, prompt, useFormatJson) {
  const body = { model, prompt, stream: false };
  // format:"json" は既定 off。thinking 対応モデルに対して指定すると応答が {} に縮退する
  // 既知の欠陥があるため（README「format:"json" について」）、条件として切り替えて実測する。
  if (useFormatJson) body.format = 'json';
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama API Error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function unloadModel(model) {
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch {
    // 降ろせなくても計測は続行できる
  }
}

async function residentSize(model) {
  const ps = await fetch(`${OLLAMA_URL}/api/ps`).then((r) => r.json()).catch(() => null);
  const list = ps?.models ?? [];
  const hit = list.find((m) => m.name === model || m.model === model);
  return {
    sizeVram: hit?.size_vram ?? null,
    sizeTotal: hit?.size ?? null,
    others: list.filter((m) => m !== hit).map((m) => m.name),
  };
}

async function modelProfile(model) {
  const r = await fetch(`${OLLAMA_URL}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  }).then((x) => x.json()).catch(() => null);
  const caps = Array.isArray(r?.capabilities) ? r.capabilities : [];
  return {
    capabilities: caps,
    thinking: caps.includes('thinking'),
    parameterSize: r?.details?.parameter_size ?? null,
    quantization: r?.details?.quantization_level ?? null,
  };
}

// ---------------------------------------------------------------- 実行

const ns2s = (n) => (n == null ? null : n / 1e9);
const gib = (b) => (b == null ? '-' : `${(b / 1024 ** 3).toFixed(1)}GB`);
const pct = (n, d) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}%`);
const medianEvalCount = (rows) => {
  const v = rows.map((r) => r.evalCount).filter((n) => n != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

function equivalentCommand() {
  const parts = [
    'node tools/text-check/run.mjs',
    `--models "${MODELS.join(',')}"`,
    `--sizes ${SIZES.join(',')}`,
    `--repeat ${REPEAT}`,
    `--format-json ${FORMAT_MODE}`,
    `--url ${OLLAMA_URL}`,
  ];
  if (DB_PATH) parts.push(`--db "${DB_PATH}"`);
  if (REUSE_SNAPSHOT) parts.push('--reuse');
  if (has('no-html')) parts.push('--no-html');
  return parts.join(' ');
}

async function main() {
  const formatModes = FORMAT_MODE === 'both' ? [false, true] : FORMAT_MODE === 'on' ? [true] : [false];

  const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.json()).catch(() => null);
  if (!tagsRes) {
    console.error(`Ollama (${OLLAMA_URL}) に接続できません。起動しているか確認してください。`);
    process.exit(1);
  }
  const names = tagsRes.models.map((m) => m.name);
  const missing = MODELS.filter((m) => !names.includes(m));
  if (missing.length) {
    console.error(`モデルが Ollama にありません: ${missing.join(', ')}\n利用可能: ${names.join(', ')}`);
    process.exit(1);
  }

  const snapDest = path.join(HERE, 'results', 'snapshot.db');
  if (!REUSE_SNAPSHOT || !fs.existsSync(snapDest)) {
    console.log('ライブラリのスナップショットを作成中...');
    const r = ensureSnapshot(REPO_ROOT, DB_PATH, snapDest);
    console.log(`  src : ${r.src} (${(r.srcBytes / 1e6).toFixed(2)} MB, WAL ${(r.walBytes / 1e6).toFixed(2)} MB)`);
  } else {
    console.log(`既存スナップショットを再利用: ${path.relative(REPO_ROOT, snapDest)}（--reuse。DBの更新は反映されない）`);
  }
  const allTags = loadTags(snapDest);
  console.log(`ライブラリのタグ数（is_category=0）: ${allTags.length}`);

  const samples = buildSamples(allTags, SIZES);
  const actualSizes = Object.keys(samples).map(Number);
  if (!actualSizes.length) {
    console.error('タグが2件未満のため同義語検出を計測できません（本番の呼び出し条件と同じ）。');
    process.exit(1);
  }

  console.log('本番プロンプトを取得中 (cargo test get_synonym_prompt) ...');
  const prompts = {};
  for (const size of actualSizes) prompts[size] = getSynonymPrompt(REPO_ROOT, samples[size].map(descriptorOf));

  const profiles = Object.fromEntries(await Promise.all(MODELS.map(async (m) => [m, await modelProfile(m)])));

  const cells = actualSizes.length * formatModes.length * REPEAT * MODELS.length;
  console.log(`\n=== タグ同義語検出 ${MULTI_MODEL ? 'モデル比較' : '計測'} ===`);
  for (const m of MODELS) {
    const pf = profiles[m];
    const spec = [pf.parameterSize, pf.quantization].filter(Boolean).join(' ');
    console.log(`model   : ${m}${spec ? ` (${spec})` : ''}${pf.thinking ? ' [thinking]' : ''}`);
  }
  console.log(`sizes   : ${actualSizes.join(', ')} 件（本番の呼び出し条件は2〜300件）`);
  console.log(`format  : ${formatModes.map((f) => (f ? 'json' : 'none')).join(', ')}`);
  console.log(`repeat  : ${REPEAT}`);
  console.log(`calls   : ${cells} (+ ウォームアップ ${MODELS.length})\n`);

  const results = [];
  const modelStats = {};

  for (const model of MODELS) {
    const warmPrompt = prompts[actualSizes[0]];
    let loadMs = null;
    try {
      const t0 = Date.now();
      const warm = await callGenerate(model, warmPrompt, false);
      loadMs = ns2s(warm.load_duration) != null ? ns2s(warm.load_duration) * 1000 : Date.now() - t0;
    } catch (e) {
      console.error(`  [警告] ${model} のウォームアップに失敗: ${String(e.message).slice(0, 120)}`);
    }
    const size = await residentSize(model);
    modelStats[model] = { ...profiles[model], loadMs, ...size };
    if (size.others.length) {
      console.log(
        `  [警告] 他のモデルが常駐しています: ${size.others.join(', ')}\n` +
          `         VRAM と速度がその分の影響を受けます。厳密に測るなら他の利用を止めてから回してください。`
      );
    }
    if (MULTI_MODEL) {
      console.log(`### ${model}  VRAM ${gib(size.sizeVram)}  ロード ${loadMs == null ? '-' : (loadMs / 1000).toFixed(1)}s\n`);
    }

    for (const tagSize of actualSizes) {
      const prompt = prompts[tagSize];
      for (const useFormatJson of formatModes) {
        const condId = `${MULTI_MODEL ? `${model} ` : ''}n=${tagSize}${useFormatJson ? '+fmt' : ''}`;
        console.log(`--- ${condId}${useFormatJson ? ' [format:"json"]' : ''} ---`);
        for (let rep = 0; rep < REPEAT; rep++) {
          const t0 = Date.now();
          const row = {
            model, tagSize, formatJson: useFormatJson, cond: condId, rep,
            elapsedMs: 0, parseOk: false, failReason: null,
            pairCount: 0, pairs: [],
            // 本番の find_tag + (t1.id!=t2.id && t1.kind==t2.kind) フィルタを通した後の値。
            // 生成された生ペアには「1タグの英語名と日本語訳を並べただけ」の自己対応が混ざるため
            // （本番では t1.id==t2.id で弾かれ実害は無いが、raw の pairCount だけでは
            // 見かけの生成量を質と誤認する）、こちらを実際の候補数として扱う。
            validPairCount: 0, validPairs: [], selfCount: 0, crossKindCount: 0, unresolvedCount: 0,
            doneReason: null, thinkingChars: 0, rawSample: null,
            loadMs: null, promptEvalCount: null, promptEvalMs: null, evalCount: null, evalMs: null,
          };
          try {
            const r = await callGenerate(model, prompt, useFormatJson);
            row.elapsedMs = Date.now() - t0;
            row.doneReason = r.done_reason ?? null;
            row.thinkingChars = (r.thinking ?? '').length;
            row.loadMs = ns2s(r.load_duration) * 1000 || 0;
            row.promptEvalCount = r.prompt_eval_count ?? null;
            row.promptEvalMs = ns2s(r.prompt_eval_duration) * 1000 || null;
            row.evalCount = r.eval_count ?? null;
            row.evalMs = ns2s(r.eval_duration) * 1000 || null;

            const p = parseSynonymResponse(r.response);
            if (p.ok) {
              row.parseOk = true;
              row.pairCount = p.pairs.length;
              row.pairs = p.pairs;
              const sample = samples[tagSize];
              for (const [a, b] of p.pairs) {
                const resolved = resolvePair(sample, a, b);
                if (resolved.kind === 'valid') {
                  row.validPairs.push([resolved.t1.name, resolved.t2.name]);
                } else if (resolved.kind === 'self') {
                  row.selfCount++;
                } else if (resolved.kind === 'cross_kind') {
                  row.crossKindCount++;
                } else {
                  row.unresolvedCount++;
                }
              }
              row.validPairCount = row.validPairs.length;
            } else {
              row.failReason = p.reason;
              row.rawSample = (r.response ?? '').trim().slice(0, 300);
            }
          } catch (e) {
            row.elapsedMs = Date.now() - t0;
            row.failReason = 'request_error';
            row.rawSample = String(e.message).slice(0, 200);
          }

          results.push(row);
          const status = row.parseOk
            ? `OK  valid=${String(row.validPairCount).padStart(2)} (raw=${row.pairCount}, self=${row.selfCount}, crossKind=${row.crossKindCount})`
            : `NG  ${row.failReason}`;
          console.log(`  rep${rep}  ${String((row.elapsedMs / 1000).toFixed(1)).padStart(6)}s  ${status}`);
        }
        console.log('');
      }
    }

    if (MULTI_MODEL) await unloadModel(model);
  }

  // ------------------------------------------------------------ 集計

  console.log('\n================ 集計 ================\n');
  const conds = [...new Set(results.map((r) => r.cond))];
  // 「有効ペア数」は本番の find_tag + id/kind フィルタを通した後の数（実際にマージ候補として残る数）。
  // raw の生成数だけでは「1タグの英語名と日本語訳を並べただけ」の自己対応を数えてしまう。
  const header = ['条件', '試行', 'パース失敗', '空文字応答', '有効ペア 中央値', '(raw)', '平均秒'];
  const rows = conds.map((c) => {
    const rs = results.filter((r) => r.cond === c);
    const ok = rs.filter((r) => r.parseOk);
    const empty = rs.filter((r) => r.failReason === 'empty_response');
    const validCounts = ok.map((r) => r.validPairCount).sort((a, b) => a - b);
    const rawCounts = ok.map((r) => r.pairCount).sort((a, b) => a - b);
    const median = (arr) => (arr.length ? String(arr[Math.floor(arr.length / 2)]) : '-');
    return [
      c, String(rs.length),
      `${rs.length - ok.length} (${pct(rs.length - ok.length, rs.length)})`,
      `${empty.length} (${pct(empty.length, rs.length)})`,
      median(validCounts), median(rawCounts),
      (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1),
    ];
  });
  const printTable = (hd, rs) => {
    const w = hd.map((h, i) => Math.max(h.length, ...rs.map((r) => r[i].length)));
    const line = (cs) => cs.map((c, i) => c.padEnd(w[i])).join('  ');
    console.log(line(hd));
    console.log(w.map((x) => '-'.repeat(x)).join('  '));
    rs.forEach((r) => console.log(line(r)));
  };
  printTable(header, rows);

  if (MULTI_MODEL) {
    console.log('\n--- モデル別 ---\n');
    const mh = ['モデル', 'パラメータ', 'VRAM', 'ロード秒', '生成トークン', '生成tok/s', 'パース失敗', '空文字応答', '自己対応率', '平均秒'];
    const mrows = MODELS.map((m) => {
      const rs = results.filter((r) => r.model === m);
      const ok = rs.filter((r) => r.parseOk);
      const empty = rs.filter((r) => r.failReason === 'empty_response');
      const evalRows = rs.filter((r) => r.evalCount && r.evalMs);
      const toks = evalRows.reduce((s, r) => s + r.evalCount, 0);
      const ms = evalRows.reduce((s, r) => s + r.evalMs, 0);
      const st = modelStats[m] ?? {};
      // 自己対応率: raw ペアのうち、find_tag が同一タグに解決したもの（本番では無害だが
      // 「1タグの英語名と日本語訳を並べただけ」の空振り生成を示す）の割合
      const rawTotal = ok.reduce((s, r) => s + r.pairCount, 0);
      const selfTotal = ok.reduce((s, r) => s + r.selfCount, 0);
      return [
        m, st.parameterSize ?? '-', gib(st.sizeVram),
        st.loadMs == null ? '-' : (st.loadMs / 1000).toFixed(1),
        String(medianEvalCount(ok) ?? '-'),
        ms ? (toks / (ms / 1000)).toFixed(1) : '-',
        `${rs.length - ok.length} (${pct(rs.length - ok.length, rs.length)})`,
        `${empty.length} (${pct(empty.length, rs.length)})`,
        pct(selfTotal, rawTotal),
        (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1),
      ];
    });
    printTable(mh, mrows);
    console.log('\n  自己対応率 = raw ペアのうち find_tag が同一タグに解決した割合（本番では t1.id==t2.id で弾かれ無害だが、生成の空振りを示す）。');
    console.log('  **有効ペアの妥当性（本当に別々のタグ同士の正しい同義語か）はこの表では決まらない。** 下の横並びを必ず目視すること。');
  }

  const fails = results.filter((r) => !r.parseOk);
  if (fails.length) {
    console.log('\n--- 失敗の内訳 ---');
    const by = {};
    for (const f of fails) by[`${f.cond} / ${f.failReason}`] = (by[`${f.cond} / ${f.failReason}`] || 0) + 1;
    Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}件`));
    console.log('\n  代表的な生レスポンス:');
    fails.filter((f) => f.rawSample).slice(0, 3)
      .forEach((f) => console.log(`  [${f.cond}] ${JSON.stringify(f.rawSample).slice(0, 250)}`));
  }

  // ------------------------------------------------------------ 横並び（目視用）

  if (MULTI_MODEL) {
    const baseFormat = formatModes[0];
    console.log(`\n--- n=${SIDE_BY_SIDE_SIZE} での同義語ペア横並び（format ${baseFormat ? 'json' : 'none'} / rep 0） ---`);
    for (const m of MODELS) {
      const r = results.find(
        (x) => x.model === m && x.tagSize === SIDE_BY_SIDE_SIZE && x.formatJson === baseFormat && x.rep === 0
      );
      if (!r) {
        console.log(`  ${m.padEnd(22)} -`);
      } else if (!r.parseOk) {
        console.log(`  ${m.padEnd(22)} NG ${r.failReason}`);
      } else {
        console.log(`  ${m.padEnd(22)} ${r.validPairs.map(([a, b]) => `${a}=${b}`).join(', ') || '(有効ペア0件)'}`);
      }
    }
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stem = MULTI_MODEL ? `compare-${MODELS.length}models` : MODELS[0].replace(/[:\\/]/g, '_');
  const out = path.join(outDir, `${stem}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({
    models: MODELS, modelStats, sizes: actualSizes, formatModes, repeat: REPEAT,
    libraryTagCount: allTags.length,
    // **何を入力したかを必ず残す。** 出力ペアだけでは「そのペアが入力に存在したのか」
    // 「見逃した同義語があったのか」を後から検証できない。等間隔サンプリングは決定的だが、
    // ライブラリが変われば同じ --sizes でも中身が変わるため、結果と一緒に固定しておく必要がある。
    samples: Object.fromEntries(
      actualSizes.map((size) => [size, samples[size].map((t) => ({ id: t.id, name: t.name, nameJa: t.nameJa, kind: t.kind }))])
    ),
    command: equivalentCommand(), ranAt: new Date().toISOString(), results,
  }, null, 2));
  console.log(`\n生データ: ${path.relative(REPO_ROOT, out)}`);

  if (!has('no-html')) {
    const { buildReport } = await import('./report.mjs');
    const htmlPath = buildReport(out);
    console.log(`レポート: ${path.relative(REPO_ROOT, htmlPath)}`);
    console.log(`  ${pathToFileURL(htmlPath).href}`);
  }

  console.log(`\nこの実行を再現するコマンド:\n  ${equivalentCommand()}\n`);
}

main().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
