#!/usr/bin/env node
/**
 * VLM プロンプト回帰チェック
 *
 * プロンプトを改修したら必ず回す。改修前後の両方を同じ画像で流し、
 * **タグ本数 / パース失敗率 / 空文字応答率** を別軸で比較する。
 *
 * 本番 (src-tauri/src/llm/ollama.rs, mod.rs) と同じ条件を再現する:
 *   - POST /api/generate, temperature 0.2, num_ctx は recommended_num_ctx 相当
 *   - done_reason="length" かつ response 空 のとき num_ctx を倍増して再試行（上限 32768）
 *   - パース判定は parse_analysis_result と同じ抽出手順 + AnalysisResult と同じ必須フィールド検証
 *
 * 使い方は README.md を参照。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allPrompts } from './prompts.mjs';
import { collectImages } from './images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const NUM_CTX_HARD_CAP = 32768;

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const OLLAMA_URL = arg('url', 'http://localhost:11434');
const MODEL = arg('model', 'qwen3-vl:4b');
const REPEAT = parseInt(arg('repeat', '1'), 10);
const VARIANTS = arg('variants', 'light').split(',').map((s) => s.trim());
const FORMAT_MODE = arg('format-json', 'off'); // off | on | both
const LIMIT = parseInt(arg('limit', '0'), 10);
const SAMPLE = parseInt(arg('sample', '5'), 10); // test_assets/100files から拾う枚数

if (has('help')) {
  console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'));
  process.exit(0);
}

// ---------------------------------------------------------------- パース (本番と同一ロジック)

/** mod.rs parse_analysis_result と同じ抽出手順 */
function extractJsonText(rawResponse) {
  const clean = (rawResponse ?? '').trim();
  if (!clean) return { ok: false, reason: 'empty_response' };

  let jsonStr = clean;
  if (clean.includes('```')) {
    for (const part of clean.split('```')) {
      const p = part.trim();
      if (p.startsWith('json')) {
        jsonStr = p.slice(4).trim();
        break;
      } else if (p.startsWith('{')) {
        jsonStr = p;
        break;
      }
    }
  }
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  const trimmed = start >= 0 && end >= 0 ? jsonStr.slice(start, end + 1) : jsonStr;
  return { ok: true, text: trimmed };
}

/** AnalysisResult と同じ必須フィールド検証 */
function parseAnalysisResult(rawResponse) {
  const ex = extractJsonText(rawResponse);
  if (!ex.ok) return { ok: false, reason: ex.reason };

  let obj;
  try {
    obj = JSON.parse(ex.text);
  } catch (e) {
    return { ok: false, reason: 'json_syntax_error', detail: String(e.message).slice(0, 120) };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_an_object' };
  if (!Array.isArray(obj.categories)) return { ok: false, reason: 'missing_categories' };
  if (!obj.categories.every((c) => typeof c === 'string')) return { ok: false, reason: 'categories_not_strings' };
  if (!Array.isArray(obj.tags)) return { ok: false, reason: 'missing_tags' };
  for (const t of obj.tags) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return { ok: false, reason: 'tag_not_object' };
    if (typeof t.en !== 'string' || typeof t.ja !== 'string') return { ok: false, reason: 'tag_missing_en_or_ja' };
  }
  const desc = Array.isArray(obj.descriptive_tags) ? obj.descriptive_tags : [];
  return { ok: true, categories: obj.categories, tags: obj.tags, descriptiveTags: desc };
}

// ---------------------------------------------------------------- Ollama

async function callGenerate(prompt, imageB64, numCtx, useFormatJson) {
  const body = {
    model: MODEL,
    prompt,
    images: [imageB64],
    stream: false,
    options: { temperature: 0.2, num_ctx: numCtx },
  };
  // format:"json" は過去に空文字応答を起こした経緯があるため既定 off。
  // プロンプト次第で有効になりうるので、条件として切り替えて実測する。
  if (useFormatJson) body.format = 'json';

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama API Error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** 本番の analyze_with_ctx_escalation と同じ num_ctx 拡張リトライ */
async function analyzeWithEscalation(prompt, imageB64, baseNumCtx, useFormatJson) {
  let numCtx = baseNumCtx;
  let escalations = 0;
  for (;;) {
    const resp = await callGenerate(prompt, imageB64, numCtx, useFormatJson);
    if (resp.done_reason === 'length' && !(resp.response ?? '').trim()) {
      const next = Math.min(numCtx * 2, NUM_CTX_HARD_CAP);
      if (next > numCtx) {
        numCtx = next;
        escalations++;
        continue;
      }
      return { resp, numCtx, escalations, exhausted: true };
    }
    return { resp, numCtx, escalations, exhausted: false };
  }
}

// ---------------------------------------------------------------- 実行

const pct = (n, d) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}%`);

async function main() {
  const prompts = allPrompts(REPO_ROOT);
  const formatModes = FORMAT_MODE === 'both' ? [false, true] : FORMAT_MODE === 'on' ? [true] : [false];

  const unknown = VARIANTS.filter((v) => !prompts[v]);
  if (unknown.length) {
    console.error(`未知の variant: ${unknown.join(', ')}`);
    console.error(`利用可能: ${Object.keys(prompts).filter((k) => k !== '_meta').join(', ')}`);
    process.exit(1);
  }

  const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.json()).catch(() => null);
  if (!tagsRes) {
    console.error(`Ollama (${OLLAMA_URL}) に接続できません。起動しているか確認してください。`);
    process.exit(1);
  }
  const names = tagsRes.models.map((m) => m.name);
  if (!names.includes(MODEL)) {
    console.error(`モデル '${MODEL}' が Ollama にありません。\n利用可能: ${names.join(', ')}`);
    process.exit(1);
  }

  const generatedDir = path.join(HERE, 'generated-images');
  let images = collectImages(REPO_ROOT, generatedDir, SAMPLE);
  if (LIMIT > 0) images = images.slice(0, LIMIT);
  if (!images.length) {
    console.error('検証対象の画像がありません。test_assets/ に画像を置いてください。');
    process.exit(1);
  }

  const cells = VARIANTS.length * formatModes.length * images.length * REPEAT;
  console.log(`\n=== VLM プロンプト回帰チェック ===`);
  console.log(`model     : ${MODEL}`);
  console.log(`variants  : ${VARIANTS.join(', ')}`);
  console.log(`format    : ${formatModes.map((f) => (f ? 'json' : 'none')).join(', ')}`);
  console.log(`images    : ${images.length} 枚 (sparse ${images.filter((i) => i.group === 'sparse').length} 枚を含む)`);
  console.log(`repeat    : ${REPEAT}`);
  console.log(`calls     : ${cells}\n`);

  const b64 = new Map();
  const results = [];

  for (const variant of VARIANTS) {
    const { prompt, label, numCtx } = prompts[variant];
    for (const useFormatJson of formatModes) {
      const condId = `${variant}${useFormatJson ? '+fmt' : ''}`;
      console.log(`--- ${condId}: ${label}${useFormatJson ? ' [format:"json"]' : ''} (num_ctx ${numCtx}) ---`);

      for (const img of images) {
        if (!b64.has(img.path)) b64.set(img.path, fs.readFileSync(img.path).toString('base64'));
        for (let rep = 0; rep < REPEAT; rep++) {
          const t0 = Date.now();
          const row = {
            variant, formatJson: useFormatJson, cond: condId,
            image: img.name, group: img.group, rep,
            elapsedMs: 0, parseOk: false, failReason: null,
            tagCount: 0, descCount: 0, categoryCount: 0, tags: [], descriptiveTags: [],
            numCtx, escalations: 0, doneReason: null, thinkingChars: 0, rawSample: null,
          };
          try {
            const r = await analyzeWithEscalation(prompt, b64.get(img.path), numCtx, useFormatJson);
            row.elapsedMs = Date.now() - t0;
            row.numCtx = r.numCtx;
            row.escalations = r.escalations;
            row.doneReason = r.resp.done_reason ?? null;
            row.thinkingChars = (r.resp.thinking ?? '').length;

            if (r.exhausted) {
              row.failReason = 'context_exhausted';
            } else {
              const p = parseAnalysisResult(r.resp.response);
              if (p.ok) {
                Object.assign(row, {
                  parseOk: true,
                  tagCount: p.tags.length,
                  descCount: p.descriptiveTags.length,
                  categoryCount: p.categories.length,
                  tags: p.tags.map((t) => `${t.en}/${t.ja}`),
                  descriptiveTags: p.descriptiveTags.map((t) => `${t.en}/${t.ja}`),
                });
              } else {
                row.failReason = p.reason;
                row.rawSample = (r.resp.response ?? '').trim().slice(0, 300);
              }
            }
          } catch (e) {
            row.elapsedMs = Date.now() - t0;
            row.failReason = 'request_error';
            row.rawSample = String(e.message).slice(0, 200);
          }

          results.push(row);
          const status = row.parseOk
            ? `OK  tags=${String(row.tagCount).padStart(2)}${row.descCount ? `+desc${row.descCount}` : ''}`
            : `NG  ${row.failReason}`;
          console.log(
            `  ${img.name.padEnd(26)} ${String((row.elapsedMs / 1000).toFixed(1)).padStart(6)}s  ${status}` +
              (row.escalations ? `  (num_ctx x${row.escalations} -> ${row.numCtx})` : '')
          );
        }
      }
      console.log('');
    }
  }

  // ------------------------------------------------------------ 集計

  console.log('\n================ 集計 ================\n');
  const conds = [...new Set(results.map((r) => r.cond))];
  const header = ['条件', '試行', 'パース失敗', '空文字応答', 'タグ<3', 'タグ数 中央値', 'min/max', '平均秒'];
  const rows = conds.map((c) => {
    const rs = results.filter((r) => r.cond === c);
    const ok = rs.filter((r) => r.parseOk);
    const empty = rs.filter((r) => r.failReason === 'empty_response');
    const under3 = ok.filter((r) => r.tagCount < 3);
    const counts = ok.map((r) => r.tagCount).sort((a, b) => a - b);
    return [
      c,
      String(rs.length),
      `${rs.length - ok.length} (${pct(rs.length - ok.length, rs.length)})`,
      `${empty.length} (${pct(empty.length, rs.length)})`,
      `${under3.length} (${pct(under3.length, ok.length)})`,
      counts.length ? String(counts[Math.floor(counts.length / 2)]) : '-',
      counts.length ? `${counts[0]}/${counts[counts.length - 1]}` : '-',
      (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1),
    ];
  });
  const w = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cs) => cs.map((c, i) => c.padEnd(w[i])).join('  ');
  console.log(line(header));
  console.log(w.map((x) => '-'.repeat(x)).join('  '));
  rows.forEach((r) => console.log(line(r)));

  console.log('\n--- 画像グループ別 タグ<3 率 ---');
  const groups = [...new Set(results.map((r) => r.group))];
  console.log(['group'.padEnd(14), ...conds.map((c) => c.padEnd(16))].join(''));
  for (const g of groups) {
    console.log([
      g.padEnd(14),
      ...conds.map((c) => {
        const ok = results.filter((r) => r.group === g && r.cond === c && r.parseOk);
        const u = ok.filter((r) => r.tagCount < 3);
        return `${u.length}/${ok.length} ${pct(u.length, ok.length)}`.padEnd(16);
      }),
    ].join(''));
  }

  const fails = results.filter((r) => !r.parseOk);
  if (fails.length) {
    console.log('\n--- 失敗の内訳 ---');
    const by = {};
    for (const f of fails) by[`${f.cond} / ${f.failReason}`] = (by[`${f.cond} / ${f.failReason}`] || 0) + 1;
    Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}件`));
    console.log('\n  代表的な生レスポンス:');
    fails.filter((f) => f.rawSample).slice(0, 3)
      .forEach((f) => console.log(`  [${f.cond} ${f.image}] ${JSON.stringify(f.rawSample).slice(0, 250)}`));
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `${MODEL.replace(/[:\\/]/g, '_')}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({
    model: MODEL, variants: VARIANTS, formatModes, repeat: REPEAT,
    promptMeta: prompts._meta, ranAt: new Date().toISOString(), results,
  }, null, 2));
  console.log(`\n生データ: ${path.relative(REPO_ROOT, out)}\n`);
}

main().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
