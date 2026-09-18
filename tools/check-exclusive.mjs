/**
 * 排他コマンド一覧の検査。
 *
 * `src/constants/exclusiveCommands.ts` の `EXCLUSIVE_COMMANDS` が、
 * Rust 側で実際に `try_acquire_task_lock` を取っている `#[tauri::command]` と
 * 一致しているかを見る。
 *
 * **手で書いた一覧はズレる。** ロックを取るコマンドが増えたのに UI 側が知らないと、
 * 「押せるが必ず失敗するボタン」がまた生える。逆に外したのに残っていると、
 * 押せてよいボタンが押せないままになる。どちらの向きも落とす。
 *
 * あわせて、**`disabled` にした理由を出しているか**も見る。
 * 理由を出さないとユーザーには「ボタンが壊れた」ようにしか見えない
 * （`useExclusiveGuard` の doc コメントにも書いてあるが、25箇所のうち16箇所で
 * 出していなかった）。
 *
 * 実行: npm run check:exclusive
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const RUST_DIR = 'src-tauri/src';
const TS_FILE = 'src/constants/exclusiveCommands.ts';

const walk = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.rs')) acc.push(p);
  }
  return acc;
};

/** `#[tauri::command]` ごとに、関数名と本文（列0の `}` まで）を取り出す */
const commandsIn = (text) => {
  const out = [];
  const marker = '#[tauri::command]';
  let at = text.indexOf(marker);
  while (at !== -1) {
    const rest = text.slice(at + marker.length);
    const name = rest.match(/\n\s*pub (?:async )?fn (\w+)/);
    if (name) {
      // 列0の `}` が関数の終わり。rustfmt が整形している前提
      const end = rest.search(/\n\}/);
      out.push({ name: name[1], body: end === -1 ? rest : rest.slice(0, end) });
    }
    at = text.indexOf(marker, at + marker.length);
  }
  return out;
};

const fromRust = new Set();
for (const file of walk(RUST_DIR)) {
  for (const { name, body } of commandsIn(readFileSync(file, 'utf8'))) {
    if (body.includes('try_acquire_task_lock')) fromRust.add(name);
  }
}

/** `.tsx` を集める（理由の検査用） */
const walkTsx = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTsx(p, acc);
    else if (name.endsWith('.tsx')) acc.push(p);
  }
  return acc;
};

const ts = readFileSync(TS_FILE, 'utf8');
const listed = ts.match(/EXCLUSIVE_COMMANDS = \[([\s\S]*?)\] as const;/);
if (!listed) {
  console.error(`[検査不能] ${TS_FILE} に EXCLUSIVE_COMMANDS の配列が見つからない`);
  process.exit(1);
}
const fromTs = new Set([...listed[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));

const problems = [];
for (const name of [...fromRust].sort()) {
  if (!fromTs.has(name)) problems.push(`[漏れ] Rust はロックを取るのに一覧に無い: ${name}`);
}
for (const name of [...fromTs].sort()) {
  if (!fromRust.has(name)) problems.push(`[余分] 一覧にあるが Rust はロックを取らない: ${name}`);
}

// 押せない理由を出しているか。
// **同じ JSX 要素の中を見る。** 属性は複数行に分かれるので、前後の行も含めて探す
let guarded = 0;
for (const file of walkTsx('src')) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!/disabled=\{[^}]*exclusive\.blocked/.test(line)) return;
    const around = lines.slice(Math.max(0, i - 7), i + 9).join('\n');
    if (/title=\{[^}]*exclusive\.reason/.test(around)) {
      guarded += 1;
      return;
    }
    problems.push(
      `[理由なし] ${file}:${i + 1}\n` +
        '    disabled にしているが、押せない理由（exclusive.reason）を title に出していない'
    );
  });
}

if (problems.length === 0) {
  console.log(
    `ok — 排他コマンド ${fromRust.size}件が一覧と一致 / ` +
      `押せない理由を出しているボタン ${guarded}件`
  );
  process.exit(0);
}
console.error(problems.join('\n'));
console.error(`\n${problems.length}件`);
process.exit(1);
