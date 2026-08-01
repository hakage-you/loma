#!/usr/bin/env node
/**
 * 計測結果（results/*.json）を HTML に組み直す。
 *
 * コンソール出力は**計測しながら眺める**ためのもので、後から人が読んで判断する形になっていない。
 * とくにタグの質は、画像とタグを並べて見ないと決められない。
 *
 * 計測は一切やり直さない。**同じ JSON から何度でも作り直せる**ようにしてあるので、
 * 見せ方を変えたいときはこのファイルだけを触ればよい（計測に数十分かかるため、
 * 見せ方の試行と計測を分けておく必要がある）。
 *
 * いずれ Loma 本体に「モデルを比べて選ぶ」画面を入れるなら、何をどう出せば決められるのかを
 * ここで先に人の目で確かめる。そのための叩き台。
 *
 *   node tools/prompt-check/report.mjs                    # 最新の結果から作る
 *   node tools/prompt-check/report.mjs <results.json>
 *   node tools/prompt-check/report.mjs --embed --open
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const RESULTS_DIR = path.join(HERE, 'results');

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, def) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
// --out の直後の値は位置引数ではない
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (argv[i] === '--out') i++;
    continue;
  }
  positional.push(argv[i]);
}

/** 引数が無ければ results/ の最新 JSON を使う。「さっき測ったやつ」を指定させないため */
function latestResults() {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, m: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(RESULTS_DIR, files[0].f) : null;
}

// ---------------------------------------------------------------- 検証済みパレット
//
// dataviz の参照パレットをそのまま使う。CVD 分離・明度帯・彩度下限を両モードで検証済み
// （light の一部スロットは対サーフェス 3:1 未満なので、**数値は必ず直接ラベルで出す**
// —— 色だけに意味を持たせない）。順序はそれ自体が CVD 安全性の仕組みなので入れ替えない。

const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const SERIES_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

// ---------------------------------------------------------------- 集計

const pctNum = (n, d) => (d === 0 ? null : (n / d) * 100);
const fmtPct = (n, d) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}%`);
const gib = (b) => (b == null ? '-' : `${(b / 1024 ** 3).toFixed(1)}GB`);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** タグ "en/ja" の en 側。モデル間でタグが一致しているかの判定キー */
const tagKey = (t) => String(t).split('/')[0].trim().toLowerCase().replace(/[\s_]+/g, '_');

function summarize(rows) {
  const ok = rows.filter((r) => r.parseOk);
  const empty = rows.filter((r) => r.failReason === 'empty_response');
  const counts = ok.map((r) => r.tagCount).sort((a, b) => a - b);
  const evalRows = rows.filter((r) => r.evalCount && r.evalMs);
  const toks = evalRows.reduce((s, r) => s + r.evalCount, 0);
  const ms = evalRows.reduce((s, r) => s + r.evalMs, 0);
  // 生成トークンの中央値。同じタグ数でもモデル間で桁が違い、速度はここに強く相関する。
  // **なぜ増えるのかは未確認**（生成の中身か、トークナイザ効率かを区別できていない）ので、
  // この値から理由を語らないこと。`thinking` が 0 でも多いモデルがある。
  const evalCounts = ok.map((r) => r.evalCount).filter((n) => n != null).sort((a, b) => a - b);
  return {
    evalMedian: evalCounts.length ? evalCounts[Math.floor(evalCounts.length / 2)] : null,
    trials: rows.length,
    failed: rows.length - ok.length,
    failPct: pctNum(rows.length - ok.length, rows.length),
    empty: empty.length,
    emptyPct: pctNum(empty.length, rows.length),
    under3: ok.filter((r) => r.tagCount < 3).length,
    under3Pct: pctNum(ok.filter((r) => r.tagCount < 3).length, ok.length),
    median: counts.length ? counts[Math.floor(counts.length / 2)] : null,
    min: counts.length ? counts[0] : null,
    max: counts.length ? counts[counts.length - 1] : null,
    avgSec: rows.length ? rows.reduce((s, r) => s + r.elapsedMs, 0) / rows.length / 1000 : null,
    tokPerSec: ms ? toks / (ms / 1000) : null,
  };
}

// ---------------------------------------------------------------- 部品

/**
 * 数値 + 帯。**帯は大小の比較用で、良し悪しではない**（短いほど良い列もある）。
 * 数値は必ず文字で出す（色とサイズだけに意味を持たせない）。
 */
function bar(value, max, text, hue, tip) {
  if (value == null) return `<span class="muted">-</span>`;
  const w = max > 0 ? Math.max(1.5, (value / max) * 100) : 0;
  return (
    `<span class="cell" ${tip ? `data-tip="${esc(tip)}"` : ''}>` +
    `<span class="num">${esc(text)}</span>` +
    `<span class="track"><span class="fill" style="width:${w.toFixed(1)}%;background:${hue}"></span></span>` +
    `</span>`
  );
}

function swatch(i) {
  return `<span class="sw" style="background:var(--s${i})"></span>`;
}

// ---------------------------------------------------------------- HTML

function buildHtml(data, opts) {
  const models = data.models ?? [data.model];
  // auto / both はモデルごとに違う variant に展開される。実際に流した名前を使う
  const byModel = data.variantsByModel ?? null;
  const variants = byModel ? [...new Set(Object.values(byModel).flat())] : data.variants ?? [];
  const multiModel = models.length > 1;

  // モデル比較なら系列＝モデル、単独ならプロンプト variant を系列として扱う。
  // どちらの使い方でも「並べて比べる」形は同じなので、系列だけ差し替える。
  const seriesNames = multiModel ? models : variants;
  const seriesOf = (r) => (multiModel ? r.model : r.variant);
  const seriesLabel = multiModel ? 'モデル' : 'プロンプト';
  const hueVar = (name) => `var(--s${seriesNames.indexOf(name) % 8})`;

  const rows = data.results ?? [];
  const units = data.units ?? [];
  const stats = data.modelStats ?? {};

  // 横並びは条件を固定する。混ぜると系列の差か条件の差か読めなくなる
  const baseVariant = variants[0];
  const baseFormat = (data.formatModes ?? [false])[0];
  const baseModel = models[0];

  // ---- ヘッダ
  const cond = [
    `プロンプト: ${variants.join(', ')}`,
    data.promptSelection ? '本番の判定: mod.rs の get_vlm_prompt_info を実行して取得' : null,
    `format:"json": ${(data.formatModes ?? [false]).map((f) => (f ? 'on' : 'off')).join(' / ')}`,
    `繰り返し: ${data.repeat}`,
    data.frames > 1 ? `フレーム: ${data.frames}枚/回（batch.rs 経路）` : null,
    data.numPredictOverride ? `num_predict: ${data.numPredictOverride}` : null,
  ].filter(Boolean);

  // ---- 系列の凡例
  const legend = seriesNames
    .map((name, i) => {
      const st = stats[name];
      const meta = st
        ? [st.parameterSize, st.thinking ? 'thinking' : null, multiModel && byModel ? byModel[name]?.join(' + ') : null]
            .filter(Boolean)
            .join(' / ')
        : '';
      return `<li>${swatch(i % 8)}<span class="name">${esc(name)}</span>${
        meta ? `<span class="muted">${esc(meta)}</span>` : ''
      }</li>`;
    })
    .join('');

  // ---- モデル別（横断のときだけ。VRAM とロードはモデル固有の値）
  let modelTable = '';
  if (multiModel) {
    const per = models.map((m) => ({ m, s: summarize(rows.filter((r) => r.model === m)), st: stats[m] ?? {} }));
    const max = (f) => Math.max(0, ...per.map((p) => f(p) ?? 0));
    const maxTok = max((p) => p.s.tokPerSec);
    const maxSec = max((p) => p.s.avgSec);
    const maxVram = max((p) => p.st.sizeVram);
    const maxLoad = max((p) => (p.st.loadMs ?? 0) / 1000);
    const maxEval = max((p) => p.s.evalMedian);
    const minEval = Math.min(...per.map((p) => p.s.evalMedian).filter((v) => v != null));
    modelTable = `
<section>
  <h2>モデル別</h2>
  <p class="lead">帯の長さは<strong>大小</strong>を表す。良し悪しではない（短いほど良い列がある）。<br>
  <strong>生成トークン</strong>は実際に生成された量（括弧内はこの計測での最小との比）。
  同じタグ数でも桁が違い、速度はここに強く相関する。
  <strong>増える理由は未確認</strong> —— 捨てられる文章を吐いているのか、トークナイザ効率の差かは
  区別できていない（成功時の生の応答を保存していないため）。</p>
  <div class="scroll"><table>
    <thead><tr>
      <th>モデル</th>
      <th>生成トークン<span class="hint">実際の生成量</span></th>
      <th>生成 tok/s<span class="hint">多いほど速い</span></th>
      <th>平均秒<span class="hint">短いほど速い</span></th>
      <th>VRAM<span class="hint">少ないほど軽い</span></th>
      <th>ロード秒<span class="hint">初回のみ</span></th>
      <th>パース失敗<span class="hint">少ないほど安定</span></th>
      <th>空文字応答</th><th>タグ数 中央値</th>
    </tr></thead>
    <tbody>
    ${per
      .map(
        ({ m, s, st }, i) => `<tr>
      <th scope="row">${swatch(i % 8)}${esc(m)}</th>
      <td>${bar(
        s.evalMedian,
        maxEval,
        s.evalMedian == null ? '-' : `${s.evalMedian}${Number.isFinite(minEval) && minEval > 0 ? ` (×${(s.evalMedian / minEval).toFixed(1)})` : ''}`,
        hueVar(m),
        `${m}: タグ1回あたり中央値 ${s.evalMedian ?? '-'} トークン`
      )}</td>
      <td>${bar(s.tokPerSec, maxTok, s.tokPerSec ? s.tokPerSec.toFixed(1) : '-', hueVar(m), `${m}: ${s.tokPerSec?.toFixed(1) ?? '-'} tok/s`)}</td>
      <td>${bar(s.avgSec, maxSec, s.avgSec != null ? `${s.avgSec.toFixed(1)}s` : '-', hueVar(m), `${m}: 平均 ${s.avgSec?.toFixed(1)}s / 回`)}</td>
      <td>${bar(st.sizeVram, maxVram, gib(st.sizeVram), hueVar(m), `${m}: VRAM ${gib(st.sizeVram)}`)}</td>
      <td>${bar(st.loadMs == null ? null : st.loadMs / 1000, maxLoad, st.loadMs == null ? '-' : `${(st.loadMs / 1000).toFixed(1)}s`, hueVar(m), `${m}: ロード ${((st.loadMs ?? 0) / 1000).toFixed(1)}s`)}</td>
      <td>${s.failed ? `<span class="bad">${s.failed} (${s.failPct.toFixed(0)}%)</span>` : `<span class="good">0</span>`}</td>
      <td>${s.empty ? `<span class="bad">${s.empty} (${s.emptyPct.toFixed(0)}%)</span>` : `<span class="good">0</span>`}</td>
      <td class="numcol">${s.median ?? '-'}<span class="muted"> (${s.min ?? '-'}–${s.max ?? '-'})</span></td>
    </tr>`
      )
      .join('')}
    </tbody>
  </table></div>
</section>`;
  }

  // ---- 条件別（コンソールの集計表と同じ内容）
  const conds = [...new Set(rows.map((r) => r.cond))];
  // 帯は系列色で塗る。グレー同士だと目盛りと塗りの境目が見えず、長さが読めなかった
  const condRows = conds.map((c) => {
    const sub = rows.filter((r) => r.cond === c);
    return { c, s: summarize(sub), hue: sub[0] ? hueVar(seriesOf(sub[0])) : 'var(--muted-fill)' };
  });
  const maxCondSec = Math.max(0, ...condRows.map((r) => r.s.avgSec ?? 0));
  const condTable = `
<section>
  <h2>条件別</h2>
  <div class="scroll"><table>
    <thead><tr><th>条件</th><th>試行</th><th>パース失敗</th><th>空文字応答</th><th>タグ&lt;3</th><th>タグ数 中央値</th><th>min/max</th><th>平均秒</th></tr></thead>
    <tbody>
    ${condRows
      .map(
        ({ c, s, hue }) => `<tr>
      <th scope="row">${esc(c)}</th>
      <td class="numcol">${s.trials}</td>
      <td>${s.failed ? `<span class="bad">${s.failed} (${s.failPct.toFixed(0)}%)</span>` : `<span class="good">0</span>`}</td>
      <td>${s.empty ? `<span class="bad">${s.empty} (${s.emptyPct.toFixed(0)}%)</span>` : `<span class="good">0</span>`}</td>
      <td class="numcol">${s.under3}${s.under3Pct == null ? '' : ` (${s.under3Pct.toFixed(0)}%)`}</td>
      <td class="numcol">${s.median ?? '-'}</td>
      <td class="numcol">${s.min ?? '-'}/${s.max ?? '-'}</td>
      <td>${bar(s.avgSec, maxCondSec, s.avgSec != null ? `${s.avgSec.toFixed(1)}s` : '-', hue, `${c}: 平均 ${s.avgSec?.toFixed(1)}s`)}</td>
    </tr>`
      )
      .join('')}
    </tbody>
  </table></div>
</section>`;

  // ---- 画像ごとの横並び（この報告の主役）
  //
  // 出す行は「モデル × そのモデルが流した variant」の全部。片方しか出さないと
  // `--variants both` の DETAILED 側が丸ごと消える（実際に消していた）。
  const variantsOf = (model) => byModel?.[model] ?? variants;
  const panels = multiModel
    ? seriesNames.flatMap((m) => variantsOf(m).map((v) => ({ model: m, variant: v, series: m })))
    : seriesNames.map((v) => ({ model: baseModel, variant: v, series: v }));

  /**
   * 表示は**モデルごとにまとめる**（モデルの中にプロンプトが並ぶ）。
   * 1つのモデルが何をどう出すのかを続けて読める方が判断しやすいため。
   *
   * 一方**一致の数え方は表示の入れ子と切り離し、プロンプトごとに数える。**
   * LIGHT と DETAILED を混ぜて数えると、DETAILED でしか出ないタグが軒並み
   * 「1つだけが出したタグ」になって色帯だらけになる（本数が元々違うため）。
   * 比べたいのは同じプロンプトを流したモデル同士。
   */
  const nested = multiModel && seriesNames.some((m) => variantsOf(m).length > 1);
  const groups = nested
    ? seriesNames.map((m) => ({ label: m, series: m, panels: panels.filter((p) => p.model === m) }))
    : [{ label: null, series: null, panels }];

  const pick = (unitName, p) =>
    rows.find(
      (r) =>
        r.image === unitName &&
        r.model === p.model &&
        r.variant === p.variant &&
        r.formatJson === baseFormat &&
        r.rep === 0
    );

  const imgSrc = (relPath) => {
    const abs = path.join(REPO_ROOT, relPath);
    if (opts.embed) {
      try {
        const ext = path.extname(abs).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return `data:image/${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
      } catch {
        return '';
      }
    }
    return path.relative(opts.outDir, abs).replace(/\\/g, '/');
  };

  const cards = units
    .map((u) => {
      // 一致はプロンプト単位で数える（表示の入れ子とは別）
      const scope = new Map();
      for (const v of new Set(panels.map((p) => p.variant))) {
        const got = panels.filter((p) => p.variant === v).map((p) => pick(u.name, p));
        const freq = new Map();
        for (const row of got) {
          if (!row?.parseOk) continue;
          for (const k of new Set([...row.tags, ...row.descriptiveTags].map(tagKey))) {
            freq.set(k, (freq.get(k) ?? 0) + 1);
          }
        }
        scope.set(v, { freq, answered: got.filter((r) => r?.parseOk).length });
      }

      const chips = (tags, hue, kind, variant) => {
        const { freq, answered } = scope.get(variant) ?? { freq: new Map(), answered: 0 };
        return tags
          .map((t) => {
            const [en, ja] = String(t).split('/');
            const n = freq.get(tagKey(t)) ?? 0;
            const shared = answered > 1 && n === answered;
            const uniq = answered > 1 && n === 1;
            return (
              `<span class="chip ${shared ? 'shared' : ''} ${uniq ? 'uniq' : ''} ${kind}" ` +
              `style="--chip:${hue}" data-tip="${esc(en)} — ${
                answered > 1 ? `${variant} を流した ${answered} 件中 ${n} 件が出力` : '1件'
              }">` +
              `<b>${esc(ja ?? en)}</b><i>${esc(en)}</i></span>`
            );
          })
          .join('');
      };

      const bodies = groups
        .map((g) => {
          const idx = g.series ? seriesNames.indexOf(g.series) % 8 : 0;
          const srows = g.panels
            .map((p) => {
              const hue = hueVar(p.series);
              const row = pick(u.name, p);
              // モデルでまとめているときは行頭にプロンプト名、そうでなければモデル名を出す
              const head = nested
                ? `<span class="vtag">${esc(p.variant)}</span>`
                : `${swatch(seriesNames.indexOf(p.series) % 8)}${esc(multiModel ? p.model : p.variant)}`;
              if (!row) {
                return `<div class="srow"><div class="sname">${head}</div><div class="tags muted">（結果なし）</div></div>`;
              }
              if (!row.parseOk) {
                return `<div class="srow"><div class="sname">${head}</div><div class="tags"><span class="fail">失敗: ${esc(
                  row.failReason
                )}</span>${row.rawSample ? `<details><summary>生の応答</summary><pre>${esc(row.rawSample)}</pre></details>` : ''}</div></div>`;
              }
              return `<div class="srow">
        <div class="sname">${head}<span class="muted">${row.tagCount}${
                row.descCount ? `+${row.descCount}` : ''
              }本 / ${(row.elapsedMs / 1000).toFixed(1)}s</span></div>
        <div class="tags">${chips(row.tags, hue, 'basic', p.variant)}${chips(
                row.descriptiveTags,
                hue,
                'desc',
                p.variant
              )}</div>
      </div>`;
            })
            .join('');

          return g.label
            ? `<div class="vgroup"><div class="vhead">${swatch(idx)}${esc(g.label)}</div>${srows}</div>`
            : srows;
        })
        .join('');

      const thumbs = (u.paths ?? []).map((p) => `<img src="${esc(imgSrc(p))}" alt="${esc(u.name)}" loading="lazy">`).join('');
      return `<article class="card">
    <div class="shot">${thumbs || '<div class="noimg">画像なし</div>'}<div class="cap">${esc(u.name)}<span class="muted">${esc(u.group)}</span></div></div>
    <div class="series">${bodies}</div>
  </article>`;
    })
    .join('');

  // ---- 失敗の内訳
  const fails = rows.filter((r) => !r.parseOk);
  const failBy = {};
  for (const f of fails) failBy[`${f.cond} / ${f.failReason}`] = (failBy[`${f.cond} / ${f.failReason}`] ?? 0) + 1;
  const failSection = fails.length
    ? `
<section>
  <h2>失敗の内訳</h2>
  <ul class="fails">${Object.entries(failBy)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<li><span class="fail">${esc(k)}</span> <span class="muted">${v}件</span></li>`)
    .join('')}</ul>
  <details><summary>代表的な生の応答</summary>${fails
    .filter((f) => f.rawSample)
    .slice(0, 8)
    .map((f) => `<pre><b>${esc(f.cond)} / ${esc(f.image)}</b>\n${esc(f.rawSample)}</pre>`)
    .join('')}</details>
</section>`
    : '';

  const sLight = SERIES_LIGHT.map((h, i) => `    --s${i}: ${h};`).join('\n');
  const sDark = SERIES_DARK.map((h, i) => `    --s${i}: ${h};`).join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VLM ${multiModel ? 'モデル比較' : 'プロンプト比較'} — ${esc(new Date(data.ranAt).toLocaleString('ja-JP'))}</title>
<style>
  :root {
    color-scheme: light;
    --surface: #fcfcfb;
    --plane: #f9f9f7;
    --ink: #0b0b0b;
    --ink2: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --line: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --good: #006300;
    --bad: #d03b3b;
    --muted-fill: #c3c2b7;
${sLight}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --surface: #1a1a19; --plane: #0d0d0d; --ink: #ffffff; --ink2: #c3c2b7;
      --muted: #898781; --grid: #2c2c2a; --line: #383835; --border: rgba(255,255,255,0.10);
      --good: #0ca30c; --bad: #d03b3b; --muted-fill: #383835;
${sDark}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface: #1a1a19; --plane: #0d0d0d; --ink: #ffffff; --ink2: #c3c2b7;
    --muted: #898781; --grid: #2c2c2a; --line: #383835; --border: rgba(255,255,255,0.10);
    --good: #0ca30c; --bad: #d03b3b; --muted-fill: #383835;
${sDark}
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: var(--plane); color: var(--ink);
    font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 10px; }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; margin: 18px 0; }
  .muted { color: var(--muted); font-weight: 400; }
  .lead { color: var(--ink2); margin: -4px 0 14px; font-size: 13px; }
  .hint { display: block; font-weight: 400; font-size: 11px; color: var(--muted); }
  .good { color: var(--good); font-weight: 600; }
  .bad { color: var(--bad); font-weight: 600; }

  .meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--ink2); font-size: 13px; margin-bottom: 18px; }
  .legend { list-style: none; display: flex; flex-wrap: wrap; gap: 8px 22px; padding: 0; margin: 0; }
  .legend li { display: flex; align-items: center; gap: 8px; }
  .legend .name { font-weight: 600; }
  .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex: none; margin-right: 7px;
        box-shadow: 0 0 0 2px var(--surface); }

  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 9px 12px 9px 0; border-bottom: 1px solid var(--grid); vertical-align: middle; white-space: nowrap; }
  thead th { color: var(--ink2); font-size: 12px; border-bottom: 1px solid var(--line); vertical-align: bottom; }
  tbody th { font-weight: 600; }
  .numcol { font-variant-numeric: tabular-nums; }
  .cell { display: flex; align-items: center; gap: 10px; }
  .num { font-variant-numeric: tabular-nums; min-width: 52px; }
  .track { flex: 1; min-width: 60px; height: 6px; background: var(--grid); border-radius: 3px; overflow: hidden; }
  .fill { display: block; height: 100%; border-radius: 3px; }

  .card { display: grid; grid-template-columns: 240px 1fr; gap: 20px; padding: 16px 0; border-bottom: 1px solid var(--grid); }
  .card:last-child { border-bottom: 0; }
  .shot img { width: 100%; border-radius: 8px; border: 1px solid var(--border); display: block; margin-bottom: 6px; }
  .noimg { padding: 40px 0; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; }
  .cap { font-size: 12px; color: var(--ink2); display: flex; justify-content: space-between; gap: 8px; }
  .srow { display: grid; grid-template-columns: 190px 1fr; gap: 12px; padding: 7px 0; align-items: start; }
  .sname { display: flex; align-items: center; font-weight: 600; font-size: 13px; flex-wrap: wrap; gap: 0 8px; }
  .sname .muted { font-size: 11px; width: 100%; padding-left: 17px; }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .vgroup { border-top: 1px dashed var(--line); padding-top: 8px; margin-top: 10px; }
  .vgroup:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
  .vhead { font-size: 13px; font-weight: 600; color: var(--ink); display: flex; align-items: center; margin-bottom: 5px; }
  .vtag { font-size: 10px; font-weight: 400; color: var(--muted); border: 1px solid var(--border);
          border-radius: 4px; padding: 0 5px; }

  .chip { display: inline-flex; flex-direction: column; line-height: 1.25; padding: 3px 9px; border-radius: 6px;
          border: 1px solid var(--border); background: var(--plane); font-size: 12px; }
  .chip b { font-weight: 600; color: var(--ink); }
  .chip i { font-style: normal; font-size: 10px; color: var(--muted); }
  /* 全系列が出したタグは沈め、1 系列だけが出したタグを立てる。差が出るのは後者だけなので。
     不透明度は下げない —— 英語表記が読めなくなる。文字色と面で強弱を付ける */
  .chip.shared { background: transparent; }
  .chip.shared b { color: var(--ink2); font-weight: 400; }
  .chip.uniq { border-color: var(--chip); border-left-width: 3px; }
  .chip.desc { border-style: dashed; }
  .fail { color: var(--bad); font-weight: 600; }

  details { margin-top: 6px; }
  summary { cursor: pointer; color: var(--ink2); font-size: 12px; }
  pre { background: var(--plane); border: 1px solid var(--border); border-radius: 6px; padding: 10px;
        overflow-x: auto; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
  .fails { margin: 0; padding-left: 18px; }

  /* 帯とタグにポインタを合わせたときだけ数値と内訳を出す（常時表示は情報量が多すぎる） */
  [data-tip] { position: relative; }
  [data-tip]:hover::after {
    content: attr(data-tip); position: absolute; bottom: 100%; left: 0; z-index: 5;
    background: var(--ink); color: var(--surface); padding: 4px 8px; border-radius: 5px;
    font-size: 11px; white-space: nowrap; pointer-events: none; margin-bottom: 4px;
  }
  .foot { color: var(--muted); font-size: 12px; margin-top: 22px; }
  .merged { border: 1px solid var(--line); border-left: 3px solid var(--s3); border-radius: 8px;
            padding: 12px 16px; margin-bottom: 18px; font-size: 13px; color: var(--ink2); background: var(--surface); }
  .merged ul { margin: 6px 0; padding-left: 20px; }
  @media (max-width: 760px) {
    .card, .srow { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>VLM ${multiModel ? 'モデル比較' : 'プロンプト比較'}</h1>
  <div class="meta">
    <span>${esc(new Date(data.ranAt).toLocaleString('ja-JP'))}</span>
    ${cond.map((c) => `<span>${esc(c)}</span>`).join('')}
    <span>画像 ${units.length} 組 / 計 ${rows.length} 試行</span>
  </div>
  ${
    // 合成物であることを隠さない。1回の通し計測と見分けが付かないと条件を検証できなくなる
    data.mergedFrom
      ? `<div class="merged"><strong>複数回の計測を合成した結果</strong>（モデル単位で差し替え）
    <ul>${data.mergedFrom
      .map((p) => `<li>${esc(p.models)} — <span class="muted">${esc(p.file)} / ${esc(new Date(p.ranAt).toLocaleString('ja-JP'))}</span></li>`)
      .join('')}</ul>
    ハードウェアの状態や Ollama の再起動を跨いでいる可能性があるため、<strong>速度と VRAM はモデル間で厳密に比較できない</strong>。
    タグの内容と失敗率は比較してよい。</div>`
      : ''
  }

  <section>
    <h2>${esc(seriesLabel)}</h2>
    <ul class="legend">${legend}</ul>
  </section>
${modelTable}${condTable}
<section>
  <h2>画像ごとのタグ</h2>
  <p class="lead">
    ${multiModel ? '流したプロンプトはすべて出している' : `<code>${esc(baseModel)}</code>`}${
      baseFormat ? ' / format:"json"' : ''
    } / 1回目に固定。
    <strong>全部が出したタグは薄く</strong>、<strong>1つだけが出したタグは左に色帯</strong>を付けている。
    差が出るのは後者なので、そこを見て決める。${
      // descriptive タグは粒度が balanced / descriptive のときしか出ない。
      // 既定は atomic なので、light / auto / both では構造的に 0 件になる。
      // 実体が無いのに凡例だけ出すと、出ていないのか見落としたのか区別が付かない
      rows.some((r) => r.descriptiveTags?.length) ? '破線は descriptive タグ。' : ''
    }
    ${
      nested
        ? 'モデルごとにまとめてあるが、<strong>一致は同じプロンプトを流したモデル同士で数えている</strong>。' +
          'LIGHT と DETAILED はタグの本数が元々違うので、混ぜて数えると DETAILED が色帯だらけになる。'
        : ''
    }
  </p>
  ${cards}
</section>
${failSection}
  ${
    data.command
      ? `<p class="foot">この計測を再現するコマンド:</p><pre>${esc(data.command)}</pre>`
      : ''
  }
  <p class="foot">
    元データ: ${esc(opts.sourceName)}<br>
    このページは <code>node tools/prompt-check/report.mjs</code> が生成。計測はやり直していないので、
    見せ方を変えたいときは同じ JSON から作り直せる。
  </p>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------- 実行

/**
 * 結果 JSON から HTML を書き出す。run.mjs からも呼ぶ。
 * @returns 書き出した HTML の絶対パス
 */
export function buildReport(srcJson, { embed = false, out } = {}) {
  const src = path.resolve(srcJson);
  const data = JSON.parse(fs.readFileSync(src, 'utf8'));
  const dest = path.resolve(out ?? src.replace(/\.json$/, '.html'));
  const html = buildHtml(data, { embed, outDir: path.dirname(dest), sourceName: path.basename(src) });
  fs.writeFileSync(dest, html);
  return dest;
}

function main() {
  const src = positional[0] ? path.resolve(positional[0]) : latestResults();
  if (!src || !fs.existsSync(src)) {
    console.error('結果 JSON が見つかりません。先に run.mjs を回すか、パスを引数で渡してください。');
    process.exit(1);
  }
  if (!JSON.parse(fs.readFileSync(src, 'utf8')).units) {
    console.error(
      '注意: この JSON には画像の情報が無い（レポート対応より前に測ったもの）。\n' +
        '      表は出るが画像は出ない。画像付きで見るには測り直すこと。'
    );
  }

  const dest = buildReport(src, { embed: flag('embed'), out: opt('out', null) });
  console.log(`レポート: ${path.relative(REPO_ROOT, dest)}`);
  console.log(`  ${pathToFileURL(dest).href}`);
  if (!flag('embed')) console.log('  画像は相対パスで参照している。単体で配るなら --embed を付ける。');

  if (flag('open')) {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', dest]]
        : process.platform === 'darwin'
        ? ['open', [dest]]
        : ['xdg-open', [dest]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

// run.mjs から import されたときは main を走らせない
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
