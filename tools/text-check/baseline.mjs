#!/usr/bin/env node
/**
 * 現行（ルールベースのみ）のタグ統合提案を全件生成する。**比較の分母。**
 *
 * **なぜ要るのか。** LLM 経路を評価する計画に、現行との対照が入っていなかった。
 * ベースライン無しでは「新方式の提案は良いか」は言えても
 * **「今より良いか」に答えられない**。しかもこの機能で本当に問われているのは後者。
 *
 * 実行に GPU は要らない。タグが301件以上あると本番の LLM ブロックはスキップされるので
 * （`free_tags.len() <= 300` の条件）、`run_suggest_tag_merges_logic` をそのまま呼べば
 * 純粋なルールベースの結果が得られる。
 *
 * **計測ロジックを JS に持たない。** 本番関数を `#[ignore]` テスト
 * `generate_merge_baseline` 経由で呼び、ルール判定・BFS・代表タグ選定まで
 * すべて本番と同一のものを通す。
 *
 *   node tools/text-check/baseline.mjs
 *   node tools/text-check/baseline.mjs --reuse        # スナップショットを作り直さない
 *   node tools/text-check/baseline.mjs --sample 50    # 人手ラベル用の抽出数
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureSnapshot } from './tags.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const DB_PATH = arg('db', null);
const SAMPLE = parseInt(arg('sample', '50'), 10);
const OUT_DIR = path.join(HERE, 'results');

/**
 * 本番の `run_suggest_tag_merges_logic` を呼ぶ。
 *
 * **スナップショットを渡すこと。** この関数は先頭で孤立タグの DELETE を実行するため、
 * 稼働中のユーザー DB を直接渡してはいけない。
 */
function generateBaseline(dbPath) {
  const r = spawnSync(
    'cargo',
    ['test', '--release', 'generate_merge_baseline', '--', '--ignored', '--nocapture'],
    {
      cwd: path.join(REPO_ROOT, 'src-tauri'),
      env: { ...process.env, LOMA_BASELINE_DB: dbPath.replace(/\\/g, '/') },
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    }
  );
  if (r.error) throw new Error(`cargo を起動できませんでした (${r.error.message})`);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => /error|panicked/i.test(l)).slice(0, 15).join('\n'));
    throw new Error(`cargo test generate_merge_baseline が失敗しました (exit ${r.status})`);
  }
  const start = out.indexOf('LOMA_BASELINE_BEGIN\n');
  const end = out.indexOf('LOMA_BASELINE_END');
  if (start < 0 || end < 0) throw new Error('ベースラインの出力を抽出できませんでした');
  return JSON.parse(out.slice(start + 'LOMA_BASELINE_BEGIN\n'.length, end).trim());
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const snap = path.join(OUT_DIR, 'snapshot.db');
  if (!has('reuse') || !fs.existsSync(snap)) {
    console.log('スナップショットを作成中...');
    const r = ensureSnapshot(REPO_ROOT, DB_PATH, snap);
    console.log(`  src : ${r.src} (${(r.srcBytes / 1e6).toFixed(2)} MB, WAL ${(r.walBytes / 1e6).toFixed(2)} MB)`);
  } else {
    console.log(`既存スナップショットを再利用: ${path.relative(REPO_ROOT, snap)}（--reuse）`);
  }

  console.log('現行の提案を生成中 (cargo test generate_merge_baseline) ...\n');
  const suggestions = generateBaseline(snap);

  // ---- 集計 ----
  const sizes = suggestions.map((s) => s.source_tags.length + 1).sort((a, b) => b - a);
  const members = sizes.reduce((a, b) => a + b, 0);
  const byReason = {};
  for (const s of suggestions) {
    // reason は "同一日本語表記 (パン) / 類似スペル (編集距離 1)" のように連結されている
    for (const part of s.reason.split(' / ')) {
      const kind = part.replace(/\s*\(.*$/, '').replace(/ など他\d+件$/, '').trim();
      if (kind) byReason[kind] = (byReason[kind] || 0) + 1;
    }
  }

  console.log('================ 現行ベースライン（ルールのみ）================\n');
  console.log(`提案数        : ${suggestions.length}`);
  console.log(`延べメンバー数 : ${members}`);
  console.log(`最大グループ  : ${sizes[0] ?? 0} 件`);
  console.log(
    '\n  提案の総数はそれ自体では問題にならない。UI はグループ件数の降順で並べ、\n' +
      '  既定はどれも未承認なので、全件を確認する必要が無いため（TagManagementModal）。\n' +
      '  **見るべきは上位に来る提案の質。**'
  );
  console.log(`グループサイズ分布:`);
  const hist = {};
  for (const s of sizes) {
    const bucket = s <= 5 ? String(s) : s <= 10 ? '6-10' : s <= 15 ? '11-15' : '16+';
    hist[bucket] = (hist[bucket] || 0) + 1;
  }
  for (const k of ['2', '3', '4', '5', '6-10', '11-15', '16+']) {
    if (hist[k]) console.log(`  ${k.padStart(5)} 件: ${hist[k]}`);
  }
  console.log(`\n判定理由の内訳（提案あたり複数）:`);
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(20)} ${v}`);
  }

  // 上限15で捨てられている分を可視化する。撤廃の影響を見積もるため
  console.log(
    `\n  **本番は member_ids.len() <= 15 のグループしか提案しない。** ` +
      `16件以上のグループは丸ごと捨てられており、ここには現れない（commands.rs）。`
  );

  // ---- 人手ラベル用の抽出 ----
  //
  // **UI と同じ順序の上位から取る。全体からの等間隔サンプリングにしてはいけない。**
  // TagManagementModal はグループ件数の降順で固定表示し（sortedSuggestions）、
  // 既定はどれも未承認（acceptedIds が空）。つまりユーザーが実際に見て判断するのは
  // 上位に来た提案であって、末尾の2件グループではない。
  // 全体から均等に抜くと、**画面に出ない提案の質を測ってしまう**。
  const uiOrder = [...suggestions].sort(
    (a, b) => (b.source_tags.length + 1) - (a.source_tags.length + 1)
  );
  const picked = uiOrder.slice(0, Math.min(SAMPLE, uiOrder.length));
  const lines = [
    '# 現行（ルールベースのみ）の提案 — 人手ラベル用',
    '#',
    '# verdict 列に記入する:',
    '#   y = この提案は妥当（統合してよい）',
    '#   n = この提案は不当（統合すべきでない）',
    '#   p = 一部だけ妥当（members に混ざりものがある）',
    '#',
    '# これが以後すべての比較の分母になる。LLM 経路が「今より良いか」を判定するための基準。',
    `# 全 ${suggestions.length} 提案のうち、**UI と同じ並び（グループ件数の降順）の上位 ${picked.length} 件**。`,
    '# 画面はこの順で出て既定は未承認なので、ユーザーが実際に判断するのはここ。',
    '',
    ['verdict', 'size', 'target', 'target_ja', 'reason', 'members'].join('\t'),
  ];
  for (const s of picked) {
    lines.push([
      '',
      s.source_tags.length + 1,
      s.target_tag.name,
      s.target_tag.name_ja ?? '',
      s.reason,
      s.source_tags.map((t) => t.name).join(' | '),
    ].join('\t'));
  }
  const tsv = path.join(OUT_DIR, 'baseline-label.tsv');
  fs.writeFileSync(tsv, lines.join('\n'));

  const json = path.join(OUT_DIR, 'baseline.json');
  fs.writeFileSync(json, JSON.stringify({ ranAt: new Date().toISOString(), suggestions }, null, 2));

  console.log(`\n生データ       : ${path.relative(REPO_ROOT, json)}`);
  console.log(`人手ラベル用   : ${path.relative(REPO_ROOT, tsv)}（${picked.length} 件）`);
}

main();
