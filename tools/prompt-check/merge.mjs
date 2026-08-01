#!/usr/bin/env node
/**
 * 壊れた計測を、モデル単位で撮り直した結果で上書きして1つにまとめる。
 *
 * 全モデルの計測は長い。途中で止めたいときは **Ollama を落とす**のが唯一の安全な止め方で、
 * 残りは `request_error` として記録されたうえで計測自体は完走し、JSON が残る。
 * （Ctrl+C でプロセスを殺すと JSON は書き出し前なので**全部消える**。）
 *
 * そのあと壊れたモデルだけ測り直し、ここで差し替える。
 *
 *   node tools/prompt-check/merge.mjs <全体.json>                 # 壊れているモデルを一覧する
 *   node tools/prompt-check/merge.mjs <全体.json> <再試験.json> ...  # 差し替えて1つにする
 *
 * **合成したことは結果にも画面にも残す。** 1回の通し計測と見分けが付かなくなると、
 * 条件が揃っているかを後から検証できなくなる。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReport } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, def) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (argv[i] === '--out' || argv[i] === '--models') i++;
    continue;
  }
  positional.push(argv[i]);
}

const read = (p) => JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
const modelsOf = (d) => d.models ?? [d.model];
const brokenModels = (d) =>
  [...new Set((d.results ?? []).filter((r) => r.failReason === 'request_error').map((r) => r.model))];

/**
 * `cond` はモデルが1つのときモデル名を含まない（run.mjs の規則）。
 * 単独で測り直した結果をそのまま混ぜると、条件名が他と揃わず集計が割れる。**必ず作り直す。**
 */
const rebuildCond = (row, multi, frames) =>
  `${multi ? `${row.model} ` : ''}${row.variant}${row.formatJson ? '+fmt' : ''}${frames > 1 ? `+f${frames}` : ''}`;

function main() {
  if (!positional.length) {
    console.error('使い方: node tools/prompt-check/merge.mjs <全体.json> [<再試験.json> ...]');
    process.exit(1);
  }

  const basePath = path.resolve(positional[0]);
  const base = read(basePath);

  // 引数が1つなら、何を測り直せばいいかを出すだけ
  if (positional.length === 1) {
    const broken = brokenModels(base);
    console.log(`\n${path.relative(REPO_ROOT, basePath)}`);
    console.log(`  モデル: ${modelsOf(base).join(', ')}`);
    if (!broken.length) {
      console.log('  request_error は含まれていない。差し替えは不要。\n');
      return;
    }
    console.log(`\n  request_error を含むモデル (${broken.length}件):`);
    for (const m of broken) {
      const rs = base.results.filter((r) => r.model === m);
      const err = rs.filter((r) => r.failReason === 'request_error').length;
      console.log(`    ${m}  ${err}/${rs.length} 試行`);
    }
    // 元の実行コマンドの --models だけを差し替える。画像の条件（--sample / --limit）を
    // 揃えないと画像ごとの比較が成立しないので、他の引数は動かさない
    console.log('\n  測り直すコマンド（--models 以外は元の実行と同じ）:');
    if (base.command) {
      console.log(`    ${base.command.replace(/--models "[^"]*"/, `--models "${broken.join(',')}"`)}`);
    } else {
      const variants = [...new Set(broken.flatMap((m) => base.variantsByModel?.[m] ?? base.variants ?? []))];
      console.log(
        `    node tools/prompt-check/run.mjs --models "${broken.join(',')}" --variants ${variants.join(',')} ` +
          `--repeat ${base.repeat} --frames ${base.frames}   # --sample と --limit は元の実行に合わせること`
      );
    }
    console.log(`\n  そのあと:\n    node tools/prompt-check/merge.mjs ${path.relative(REPO_ROOT, basePath)} <再試験.json>\n`);
    return;
  }

  const only = opt('models', null)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const merged = structuredClone(base);
  const provenance = [{ file: path.basename(basePath), ranAt: base.ranAt, models: '(ベース)' }];

  for (const p of positional.slice(1)) {
    const patchPath = path.resolve(p);
    const patch = read(patchPath);

    // 画像が違えば別物を並べることになる。ここは黙って進めない
    const baseUnits = (base.units ?? []).map((u) => u.name).join('|');
    const patchUnits = (patch.units ?? []).map((u) => u.name).join('|');
    const same = baseUnits === patchUnits;
    if (!same) {
      console.error(`\n[中止] ${path.basename(patchPath)} の画像がベースと違う。`);
      console.error(`  ベース : ${base.units?.length ?? 0} 組`);
      console.error(`  再試験 : ${patch.units?.length ?? 0} 組`);
      console.error('  --sample / --limit をベースと同じにして測り直すこと。');
      console.error('  それでも混ぜるなら --force（画像ごとの比較は無意味になる）。');
      if (!flag('force')) process.exit(1);
    }
    for (const [k, label] of [['repeat', '繰り返し'], ['frames', 'フレーム']]) {
      if (base[k] !== patch[k]) console.error(`  [警告] ${label} が違う: ベース ${base[k]} / 再試験 ${patch[k]}`);
    }
    if (JSON.stringify(base.formatModes) !== JSON.stringify(patch.formatModes)) {
      console.error(`  [警告] format:"json" の条件が違う`);
    }

    const take = modelsOf(patch).filter((m) => !only || only.includes(m));
    if (!take.length) {
      console.error(`  [警告] ${path.basename(patchPath)} から取るモデルが無い`);
      continue;
    }

    // モデル単位で丸ごと入れ替える。行単位で継ぎ足すと、失敗した試行だけが消えて成功率が歪む
    merged.results = merged.results.filter((r) => !take.includes(r.model));
    merged.results.push(...patch.results.filter((r) => take.includes(r.model)));

    for (const m of take) {
      if (!merged.models.includes(m)) merged.models.push(m);
      if (patch.modelStats?.[m]) (merged.modelStats ??= {})[m] = patch.modelStats[m];
      if (patch.variantsByModel?.[m]) (merged.variantsByModel ??= {})[m] = patch.variantsByModel[m];
    }
    merged.promptSelection ??= patch.promptSelection;
    provenance.push({ file: path.basename(patchPath), ranAt: patch.ranAt, models: take.join(', ') });
    console.log(`  ${path.basename(patchPath)} から ${take.length} モデルを差し替え: ${take.join(', ')}`);
  }

  // 条件名を作り直し、モデル順に並べ直す
  const multi = merged.models.length > 1;
  const order = new Map(merged.models.map((m, i) => [m, i]));
  for (const r of merged.results) r.cond = rebuildCond(r, multi, merged.frames);
  merged.results.sort((a, b) => (order.get(a.model) ?? 99) - (order.get(b.model) ?? 99));

  merged.variants = [...new Set(Object.values(merged.variantsByModel ?? {}).flat())].length
    ? [...new Set(Object.values(merged.variantsByModel).flat())]
    : merged.variants;
  merged.mergedFrom = provenance;
  merged.mergedAt = new Date().toISOString();
  merged.command = null; // 1本のコマンドでは再現できない。出どころは mergedFrom を見る

  const out = path.resolve(
    opt('out', path.join(path.dirname(basePath), `merged-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
  );
  fs.writeFileSync(out, JSON.stringify(merged, null, 2));

  const still = brokenModels(merged);
  console.log(`\n合成: ${path.relative(REPO_ROOT, out)}`);
  console.log(`  モデル ${merged.models.length} / 試行 ${merged.results.length}`);
  if (still.length) console.log(`  [警告] まだ request_error が残っている: ${still.join(', ')}`);

  const html = buildReport(out, { embed: flag('embed') });
  console.log(`レポート: ${path.relative(REPO_ROOT, html)}`);
  console.log(`  ${pathToFileURL(html).href}\n`);
}

main();
