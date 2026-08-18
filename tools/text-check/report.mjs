#!/usr/bin/env node
/**
 * 計測結果（results/*.json）を HTML に組み直す。
 *
 * コンソール出力は計測しながら眺めるためのもので、同義語ペアの妥当性を後から
 * 判断する形になっていない。モデル×サイズごとに出力ペアを並べ、目視で判断できるようにする。
 *
 * 計測はやり直さない。同じ JSON から何度でも作り直せる（tools/prompt-check/report.mjs と同じ方針）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(HERE, 'results');

function latestResults() {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs.readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(RESULTS_DIR, files[0].f) : null;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (n, d) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}%`);

export function buildReport(jsonPath, opts = {}) {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const { models, modelStats, sizes, results, command, libraryTagCount, ranAt, samples } = data;
  const multi = models.length > 1;

  const conds = [...new Set(results.map((r) => r.cond))];
  const condRows = conds.map((c) => {
    const rs = results.filter((r) => r.cond === c);
    const ok = rs.filter((r) => r.parseOk);
    const empty = rs.filter((r) => r.failReason === 'empty_response');
    return { cond: c, n: rs.length, failN: rs.length - ok.length, failPct: pct(rs.length - ok.length, rs.length),
      emptyN: empty.length, emptyPct: pct(empty.length, rs.length),
      avgSec: (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1) };
  });

  const modelRows = models.map((m) => {
    const st = modelStats[m] ?? {};
    const rs = results.filter((r) => r.model === m);
    const ok = rs.filter((r) => r.parseOk);
    const empty = rs.filter((r) => r.failReason === 'empty_response');
    return {
      model: m, param: st.parameterSize ?? '-', vram: st.sizeVram ? `${(st.sizeVram / 1024 ** 3).toFixed(1)}GB` : '-',
      loadSec: st.loadMs != null ? (st.loadMs / 1000).toFixed(1) : '-',
      failPct: pct(rs.length - ok.length, rs.length), emptyPct: pct(empty.length, rs.length),
      avgSec: (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1),
    };
  });

  const sideBySide = sizes.map((size) => ({
    size,
    rows: models.map((m) => {
      const r = results.find((x) => x.model === m && x.tagSize === size && x.rep === 0 && !x.formatJson);
      return { model: m, r };
    }),
  }));

  const html = `<title>タグ同義語検出 モデル比較</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  h1, h2 { font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); padding: 4px 8px; text-align: left; font-variant-numeric: tabular-nums; }
  th { background: color-mix(in srgb, currentColor 8%, transparent); }
  code, .mono { font-family: ui-monospace, monospace; }
  .meta { opacity: 0.7; font-size: 0.9em; }
  .fail { color: #c0392b; }
  .pairs { white-space: pre-wrap; }
  .cmd { background: color-mix(in srgb, currentColor 6%, transparent); padding: 0.6rem 0.8rem; border-radius: 6px; overflow-x: auto; }
</style>
<h1>タグ同義語検出 モデル比較</h1>
<p class="meta">計測日時: ${esc(ranAt)} / ライブラリタグ数: ${libraryTagCount}</p>
<pre class="cmd mono">${esc(command)}</pre>

<h2>条件別</h2>
<table>
  <tr><th>条件</th><th>試行</th><th>パース失敗</th><th>空文字応答</th><th>平均秒</th></tr>
  ${condRows.map((r) => `<tr><td>${esc(r.cond)}</td><td>${r.n}</td><td>${r.failN} (${r.failPct})</td><td>${r.emptyN} (${r.emptyPct})</td><td>${r.avgSec}</td></tr>`).join('\n  ')}
</table>

${multi ? `<h2>モデル別</h2>
<table>
  <tr><th>モデル</th><th>パラメータ</th><th>VRAM</th><th>ロード秒</th><th>パース失敗</th><th>空文字応答</th><th>平均秒</th></tr>
  ${modelRows.map((r) => `<tr><td>${esc(r.model)}</td><td>${esc(r.param)}</td><td>${esc(r.vram)}</td><td>${esc(r.loadSec)}</td><td>${esc(r.failPct)}</td><td>${esc(r.emptyPct)}</td><td>${esc(r.avgSec)}</td></tr>`).join('\n  ')}
</table>
<p class="meta">同義語ペアの妥当性はこの表では決まらない。下の横並びを必ず目視すること。</p>` : ''}

<h2>同義語ペアの横並び（目視用 / rep 0 / format:none）</h2>
${sideBySide.map((s) => `<h3>n=${s.size}</h3>
<table>
  <tr><th>モデル</th><th>出力ペア</th></tr>
  ${s.rows.map(({ model, r }) => {
    if (!r) return `<tr><td>${esc(model)}</td><td>-</td></tr>`;
    if (!r.parseOk) return `<tr><td>${esc(model)}</td><td class="fail">NG ${esc(r.failReason)}${r.rawSample ? `<br><span class="mono meta">${esc(r.rawSample)}</span>` : ''}</td></tr>`;
    const body = r.validPairs.length ? r.validPairs.map(([a, b]) => `${a} = ${b}`).join('\n') : '(有効ペア0件)';
    return `<tr><td>${esc(model)}</td><td class="pairs mono">${esc(body)}</td></tr>`;
  }).join('\n  ')}
</table>`).join('\n')}

<h2>全試行の有効ペア一覧（目視用 / 本番のfind_tag+id/kindフィルタ通過後）</h2>
<p class="meta">rep0だけでなく全反復・全サイズを対象に、本番で実際にマージ候補として残るペアだけを列挙する。
raw の生成数には「1タグの英語名と日本語訳を並べただけ」の自己対応が混ざるため、それを除いた後の数がここでの妥当性判断の対象になる。</p>
${models.map((m) => {
  const rows = results.filter((r) => r.model === m && r.parseOk && r.validPairCount > 0);
  if (!rows.length) return `<h3>${esc(m)}</h3><p class="meta">有効ペアは1件も出なかった。</p>`;
  return `<h3>${esc(m)}（有効ペア合計 ${rows.reduce((s, r) => s + r.validPairCount, 0)}件）</h3>
<table>
  <tr><th>条件</th><th>ペア</th></tr>
  ${rows.map((r) => `<tr><td>n=${r.tagSize} rep${r.rep}</td><td class="pairs mono">${esc(r.validPairs.map(([a, b]) => `${a} = ${b}`).join('\n'))}</td></tr>`).join('\n  ')}
</table>`;
}).join('\n')}

${samples ? `<h2>入力したタグ一覧</h2>
<p class="meta">出力ペアだけでは「そのペアが入力に存在したか」「見逃した同義語があったか」を検証できないため、
モデルに渡した実タグをそのまま残している。ライブラリ全 ${libraryTagCount} 件からの等間隔サンプリング。</p>
${sizes.map((size) => `<h3>n=${size}</h3>
<p class="mono" style="word-break:break-all">${esc((samples[size] ?? []).map((t) => (t.nameJa ? `${t.name} (${t.nameJa})` : t.name)).join(', '))}</p>`).join('\n')}` : ''}
`;

  const outPath = jsonPath.replace(/\.json$/, '.html');
  fs.writeFileSync(outPath, html);
  return outPath;
}

if (import.meta.filename === process.argv[1]) {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a) => !a.startsWith('--'));
  const target = positional[0] ? path.resolve(positional[0]) : latestResults();
  if (!target) {
    console.error('results/ に JSON が無く、対象を決められません。');
    process.exit(1);
  }
  const out = buildReport(target);
  console.log(`レポート: ${out}`);
  console.log(pathToFileURL(out).href);
}
