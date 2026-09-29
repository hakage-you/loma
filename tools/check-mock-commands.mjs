/**
 * Tauri コマンドの三者照合。
 *
 * 1. Rust の `invoke_handler![...]` に登録されているコマンド
 * 2. フロントが実際に名前で呼んでいるコマンド
 * 3. `src/mocks/core.ts` の handlers が持っているコマンド
 *
 * **モックに handler が無いコマンドは、呼んでも `undefined` が返るだけで例外にならない。**
 * そのため mock モードの e2e は「押した／落ちなかった」しか見ておらず、
 * 画面がバックエンドの応答を使う経路は一度も走らない。
 * 実装が壊れたままテストが緑になるので、この向きは必ず落とす。
 *
 * 逆に Rust に登録されているのにフロントのどこからも名前が出てこないコマンドは、
 * 呼ぶ経路が無い。消し忘れなのか実装途中なのかを区別できるよう、こちらも出す。
 *
 * 実行: npm run check:mock-commands
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/** Windows のパス区切り。ヒアドキュメント経由で壊れないよう文字コードで書く */
const WIN_SEP = String.fromCharCode(92);

const LIB_RS = 'src-tauri/src/lib.rs';
const MOCK_FILE = 'src/mocks/core.ts';
const SRC_DIR = 'src';

/** 呼び出し側として数えないファイル。名前を並べているだけで invoke はしない */
const NOT_CALL_SITES = new Set([
  'src/constants/exclusiveCommands.ts', // 排他コマンドの一覧
]);

/**
 * フロントから呼ぶ経路が無くてよいコマンド。
 * **安易に足さないこと。** 足すときは「なぜ呼ばれないのか」を必ず書く。
 */
const UNCALLED_ALLOWED = new Map([]);

const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(p.split(WIN_SEP).join('/'));
  }
  return acc;
};

// --- 1. Rust の登録一覧 ---
const libSrc = readFileSync(LIB_RS, 'utf8');
const handlerBlock = libSrc.match(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/);
if (!handlerBlock) {
  console.error(`[検査不能] ${LIB_RS} に invoke_handler が見つからない`);
  process.exit(1);
}
const registered = new Set(
  [...handlerBlock[1].matchAll(/(?:^|\s)(?:\w+::)*(\w+)\s*,/g)].map((m) => m[1])
);

// --- 2. フロントの参照 ---
// `invoke<T>('cmd')` だけでなく、設定オブジェクトへ名前を置いて後から呼ぶ形
// （TagManagementModal の `command: 'suggest_tag_merges'`）も拾うため、
// 登録済みの名前と完全一致する文字列リテラルを参照とみなす。
const referencedBy = new Map();
for (const file of walk(SRC_DIR)) {
  if (file.startsWith('src/mocks/') || NOT_CALL_SITES.has(file)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/['"]([a-z0-9_]+)['"]/g)) {
    if (!registered.has(m[1])) continue;
    if (!referencedBy.has(m[1])) referencedBy.set(m[1], new Set());
    referencedBy.get(m[1]).add(file);
  }
}

// --- 3. モックの handlers ---
const mockSrc = readFileSync(MOCK_FILE, 'utf8');
const handlersBlock = mockSrc.match(
  /const handlers: Record<string, \(args: Record<string, any>\) => any> = \{([\s\S]*?)\n\};/
);
if (!handlersBlock) {
  console.error(`[検査不能] ${MOCK_FILE} に handlers の定義が見つからない`);
  process.exit(1);
}
const mocked = new Set([...handlersBlock[1].matchAll(/^  ([a-z0-9_]+):/gm)].map((m) => m[1]));

// --- 照合 ---
const problems = [];
for (const name of [...referencedBy.keys()].sort()) {
  if (!mocked.has(name)) {
    const where = [...referencedBy.get(name)].sort().join(', ');
    problems.push(`[モック漏れ] フロントが呼ぶのに mock に handler が無い: ${name}  (${where})`);
  }
}
for (const name of [...registered].sort()) {
  if (referencedBy.has(name) || UNCALLED_ALLOWED.has(name)) continue;
  problems.push(`[呼ばれていない] Rust に登録されているがフロントに名前が無い: ${name}`);
}
for (const name of [...mocked].sort()) {
  if (!registered.has(name)) {
    problems.push(`[存在しない] mock に handler があるが Rust に登録が無い: ${name}`);
  } else if (!referencedBy.has(name)) {
    problems.push(`[余分] mock に handler があるがフロントが呼ばない: ${name}`);
  }
}

if (problems.length === 0) {
  console.log(
    `ok — 登録 ${registered.size}件 / フロント参照 ${referencedBy.size}件 / モック ${mocked.size}件が一致`
  );
  process.exit(0);
}
console.error(problems.join('\n'));
console.error(`\n${problems.length}件`);
process.exit(1);
