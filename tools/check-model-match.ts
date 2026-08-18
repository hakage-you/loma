// `resolveInstalledModel` の検証。**JS 側に単体テストの仕組みが無いので単独で走る形にした。**
//
//   node tools/check-model-match.ts
//
// ビルドや tsc では捕まらない種類の不具合（サイズ違いのモデルを掴む）を固定する。

import { resolveInstalledModel, isModelInstalled } from '../src/utils/modelMatch.ts';

let failed = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '  ok  ' : '  NG  '}${label}${ok ? '' : `  got=${got} want=${want}`}`);
};

// 実環境の一覧（`ollama list` の並び順そのまま）。**26b が 12b より先に来る**
const INSTALLED = [
  'hf.co/unsloth/gemma-4-26B-A4B-it-GGUF:UD-IQ4_XS',
  'nomic-embed-text-v2-moe:latest',
  'snowflake-arctic-embed2:latest',
  'embeddinggemma:latest',
  'translategemma:4b',
  'translategemma:12b',
  'bge-m3:latest',
  'gemma4:26b',
  'gemma4:12b',
  'gemma4:e4b',
  'nomic-embed-text:latest',
  'qwen3-embedding:8b',
  'gemma4:e2b',
];

console.log('実際に起きた不具合の再現');
eq('gemma4:12b は 12b を選ぶ（26b が先に並んでいても）', resolveInstalledModel('gemma4:12b', INSTALLED), 'gemma4:12b');
eq('gemma4:26b は 26b を選ぶ', resolveInstalledModel('gemma4:26b', INSTALLED), 'gemma4:26b');
eq('gemma4:e4b は e4b を選ぶ', resolveInstalledModel('gemma4:e4b', INSTALLED), 'gemma4:e4b');

console.log('\n入っていないサイズは null（ダウンロードを促すため）');
eq('gemma4:9b は入っていない', resolveInstalledModel('gemma4:9b', INSTALLED), null);
eq('qwen3.5:9b は入っていない', resolveInstalledModel('qwen3.5:9b', INSTALLED), null);
eq('  同上（バッジも false）', isModelInstalled('qwen3.5:9b', INSTALLED), false);

console.log('\nタグ無しの推奨は :latest と対応する');
eq('bge-m3 ⇔ bge-m3:latest', resolveInstalledModel('bge-m3', INSTALLED), 'bge-m3:latest');
eq('embeddinggemma ⇔ :latest', resolveInstalledModel('embeddinggemma', INSTALLED), 'embeddinggemma:latest');

console.log('\nタグの前方一致は許す（量子化・派生の違い）');
eq('gemma4:12b ⇔ gemma4:12b-it-q4', resolveInstalledModel('gemma4:12b', ['gemma4:12b-it-q4']), 'gemma4:12b-it-q4');
eq('完全一致を優先する', resolveInstalledModel('gemma4:12b', ['gemma4:12b-it-q4', 'gemma4:12b']), 'gemma4:12b');

console.log('\n紛らわしい組み合わせ');
eq('translategemma:12b は gemma4:12b ではない', resolveInstalledModel('gemma4:12b', ['translategemma:12b']), null);
eq('サイズ指定に :latest は当てない', resolveInstalledModel('gemma4:12b', ['gemma4:latest']), null);
eq('空の一覧は null', resolveInstalledModel('gemma4:12b', []), null);

console.log(failed === 0 ? '\n全て通過' : `\n★ ${failed}件 失敗`);
process.exit(failed === 0 ? 0 : 1);
