/**
 * ルールベース判定を **本番のコードそのもの** に問い合わせる。
 *
 * `commands.rs` の `rule_based_match_reason` を `#[ignore]` テスト経由で呼ぶ。
 * **JS 側にミラーを持たない。** 写せば必ず乖離し、「本番と違うものを測っていた」に行き着く
 * （`tools/prompt-check` が判定を Rust に聞いているのと同じ理由）。
 *
 * LLM に価値があるのはルールが拾えないペアだけなので、モデル評価では必ずここを通す。
 * 実測ではタグ類似度上位400ペアのうち345件（86%）がルールで拾えた。
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 環境変数の長さ制限に当たらないよう分割して呼ぶ（Windows は環境ブロック全体に上限がある） */
const BATCH = 200;

const toRustTag = (t) => ({
  id: t.id,
  name: t.name,
  name_ja: t.nameJa ?? t.name_ja ?? null,
  is_category: false,
  count: 0,
  kind: t.kind,
});

function runBatch(repoRoot, pairs) {
  const payload = JSON.stringify(pairs.map(([a, b]) => [toRustTag(a), toRustTag(b)]));
  const r = spawnSync(
    'cargo',
    ['test', '--release', 'classify_rule_pairs', '--', '--ignored', '--nocapture'],
    {
      cwd: path.join(repoRoot, 'src-tauri'),
      env: { ...process.env, LOMA_RULE_PAIRS: payload },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    }
  );
  if (r.error) throw new Error(`cargo を起動できませんでした (${r.error.message})`);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => /error|panicked/i.test(l)).slice(0, 10).join('\n'));
    throw new Error(`cargo test classify_rule_pairs が失敗しました (exit ${r.status})`);
  }
  const verdicts = new Array(pairs.length).fill(null);
  for (const line of out.split(/\r?\n/)) {
    const m = /^LOMA_RULE_PAIR\t(\d+)\t(rule|none)\t(.*)$/.exec(line);
    if (m) verdicts[Number(m[1])] = { rule: m[2] === 'rule', reason: m[3] };
  }
  if (verdicts.some((v) => v === null)) throw new Error('ルール判定の結果が一部取得できませんでした');
  return verdicts;
}

/**
 * ペアの配列を本番ルールに掛け、`{rule, reason}` の配列を返す（入力と同じ順序）。
 * タグは `{id, name, nameJa|name_ja, kind}` を持つオブジェクト。
 */
export function classifyByRules(repoRoot, pairs) {
  if (!pairs.length) return [];
  const out = [];
  for (let i = 0; i < pairs.length; i += BATCH) {
    out.push(...runBatch(repoRoot, pairs.slice(i, i + BATCH)));
  }
  return out;
}
