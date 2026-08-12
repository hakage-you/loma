/**
 * タグ同義語検出プロンプトの取得。
 *
 * 重要: プロンプト本文をこのファイルにコピーしない。必ず
 * `src-tauri/src/commands.rs` の `build_synonym_prompt` を cargo test 経由で呼ぶ。
 * JS 側にミラーを持つと必ず乖離し、「テストは通るが本番と違うものを測っていた」
 * という失敗をする（tools/prompt-check の prompts.mjs と同じ理由）。
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `descriptors`（`name (name_ja)` 形式の文字列配列）に対する本番プロンプトを取得する。
 *
 * ミラーもフォールバックも用意しない。cargo が無ければ失敗させる —
 * 静かに近似値へ落ちる方が、動かないより悪い。
 */
export function getSynonymPrompt(repoRoot, descriptors) {
  const env = { ...process.env, LOMA_TEXT_TAGS: JSON.stringify(descriptors) };
  const r = spawnSync(
    'cargo',
    ['test', '--release', 'get_synonym_prompt', '--', '--ignored', '--nocapture'],
    { cwd: path.join(repoRoot, 'src-tauri'), env, encoding: 'utf8', timeout: 30 * 60 * 1000 }
  );
  if (r.error) {
    throw new Error(`cargo を起動できませんでした (${r.error.message})。本番のプロンプトを使うため Rust のツールチェインが要る。`);
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => /error|panicked|failed/i.test(l)).slice(0, 10).join('\n'));
    throw new Error(`cargo test get_synonym_prompt が失敗しました (exit ${r.status})`);
  }
  const start = out.indexOf('LOMA_TEXT_PROMPT_BEGIN\n');
  const end = out.indexOf('LOMA_TEXT_PROMPT_END');
  if (start < 0 || end < 0) throw new Error('get_synonym_prompt の出力からプロンプトを抽出できませんでした');
  return out.slice(start + 'LOMA_TEXT_PROMPT_BEGIN\n'.length, end).replace(/\r\n/g, '\n').replace(/\n$/, '');
}
