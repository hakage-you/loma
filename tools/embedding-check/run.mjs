/**
 * 埋め込みモデルの比較計測ランナー。
 *
 * 実体は `src-tauri/src/embedding.rs` の `#[ignore]` テスト2本で、
 * このスクリプトはその**段取り**（スナップショット作成 / モデルごとの反復 / 記録）を担う。
 *
 * 計測ロジックを JS 側に持たないのは意図的。ここで重心計算やコサイン類似度を
 * 再実装すると、**本番と違うものを測っていた**という最悪の失敗をする。
 * 実際に走るのは本番と同じ `build_library` / `compute_diagnostics` である。
 *
 *   node tools/embedding-check/run.mjs --models bge-m3,qwen3-embedding:8b
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultDbPath, snapshot } from './snapshot.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const resultsDir = path.join(repoRoot, 'tools/embedding-check/results');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const MODELS = arg('models', 'bge-m3').split(',').map((s) => s.trim()).filter(Boolean);
const URL = arg('url', 'http://localhost:11434');
const ONLY = arg('only', 'both'); // both | dist | examples

const srcDb = arg('db', null) ?? defaultDbPath(repoRoot);
if (!srcDb) throw new Error('この OS では既定パスを解決できません。--db <path> を指定してください');

console.log(`repo   : ${repoRoot}`);
console.log(`db     : ${srcDb}`);
console.log(`models : ${MODELS.join(', ')}\n`);

/**
 * モデルごとに独立したスナップショットを使う。
 * 1つのDBを使い回すと、先に走ったモデルのベクトルが tag_embeddings に残り、
 * 保存量の集計が混ざるうえ「未生成タグ0件」で生成時間が測れなくなる。
 */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.mkdirSync(resultsDir, { recursive: true });

const runCargo = (testName, env) => {
  const r = spawnSync(
    'cargo',
    ['test', '--release', testName, '--', '--ignored', '--nocapture'],
    {
      cwd: path.join(repoRoot, 'src-tauri'),
      env: { ...process.env, ...env },
      encoding: 'utf8',
      // 埋め込み生成は数千タグで数分かかる
      timeout: 60 * 60 * 1000,
    },
  );
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => /error|panicked|failed/i.test(l)).join('\n'));
    throw new Error(`cargo test ${testName} が失敗しました (exit ${r.status})`);
  }
  return out;
};

for (const model of MODELS) {
  const safe = model.replace(/[^a-zA-Z0-9._-]/g, '_');
  const db = path.join(resultsDir, `snapshot-${safe}.db`);
  console.log(`--- ${model} ---`);

  // 既定は毎回取り直す（DBが更新されていれば結果も変わるべきなので）。
  // --reuse は生成済みベクトルを使い回して数分を節約する。出力の見せ方を
  // 調整するときなど、DBが変わっていないと分かっている場合だけ使うこと。
  if (has('reuse') && fs.existsSync(db)) {
    console.log(`snapshot 再利用 (${(fs.statSync(db).size / 1e6).toFixed(2)} MB) -- DBの更新は反映されない`);
  } else {
    const snap = snapshot(srcDb, db);
    console.log(`snapshot ${(snap.destBytes / 1e6).toFixed(2)} MB (WAL ${(snap.walBytes / 1e6).toFixed(2)} MB を反映)`);
  }

  const env = { LOMA_MEASURE_DB: db, LOMA_MEASURE_MODEL: model, LOMA_MEASURE_URL: URL };
  let log = `# ${model}\n# db: ${db}\n# ${new Date().toISOString()}\n\n`;

  /**
   * cargo のノイズ行だけを落とし、残り全部を計測本文として扱う。
   *
   * 「本文の開始マーカーを探して slice する」方式はやめた。マーカーより前に出る
   * 情報（ベクトル生成の所要時間など）が黙って消えるうえ、長時間実行時に cargo が
   * 割り込ませる "has been running for over 60 seconds" の位置に結果が左右される。
   * 落とすものを列挙する方が、取りこぼしが起きない。
   */
  const NOISE = /^(test [\w:]+ (\.\.\.|has been running)|test result:|running \d+ tests?|\s*(Compiling|Finished|Running|Blocking) )/;
  const bodyOf = (out) =>
    out
      .split('\n')
      .filter((l) => !NOISE.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  if (ONLY === 'both' || ONLY === 'dist') {
    const body = bodyOf(runCargo('measure_real_library', env));
    console.log(body);
    log += body;
  }
  if (ONLY === 'both' || ONLY === 'examples') {
    const body = bodyOf(runCargo('similar_examples', env));
    if (has('verbose')) console.log(body);
    log += `\n\n${body}`;
  }

  const logPath = path.join(resultsDir, `${stamp}-${safe}.txt`);
  fs.writeFileSync(logPath, log);
  console.log(`記録: ${path.relative(repoRoot, logPath)}\n`);
}

console.log('比較の読み方は tools/embedding-check/README.md を参照。');
