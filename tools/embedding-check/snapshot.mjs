/**
 * 稼働中の Loma DB から、計測用の一貫したスナップショットを作る。
 *
 * **単純なファイルコピーをしてはいけない。** Loma は `PRAGMA journal_mode = WAL` で
 * 動作しており（src-tauri/src/db.rs）、直近の書き込みは `loma.db` ではなく
 * `loma.db-wal` 側に残っている。`loma.db` だけをコピーすると、**WAL に入っている分を
 * まるごと取りこぼした古いDBを計測してしまう**（2026-07-30 に実際にやらかした。
 * 本体 1.4MB に対して WAL が 0.9MB あり、しかも WAL の方が新しかった）。
 *
 * ここでは `VACUUM INTO` を使う。WAL を反映した単一ファイルの複製を、
 * 元のDBを一切変更せずに作れる。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

/** tauri.conf.json から identifier を読む（アプリ側の真実を写経しない） */
export function appIdentifier(repoRoot) {
  const conf = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (!conf.identifier) throw new Error('tauri.conf.json に identifier がありません');
  return conf.identifier;
}

/**
 * OS ごとの app_data_dir を返す。Tauri の `path().app_data_dir()` と同じ場所。
 * 未対応 OS では null を返すので、呼び出し側で --db を要求すること。
 */
export function defaultDbPath(repoRoot) {
  const id = appIdentifier(repoRoot);
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData/Roaming'), id, 'loma.db');
    case 'darwin':
      return path.join(home, 'Library/Application Support', id, 'loma.db');
    case 'linux':
      return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), id, 'loma.db');
    default:
      return null;
  }
}

/**
 * `src` の一貫したスナップショットを `dest` に作る。
 * WAL を含めて反映され、`src` は変更されない。
 */
export function snapshot(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`DBが見つかりません: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  for (const f of [dest, `${dest}-wal`, `${dest}-shm`]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  // **必ず readonly で開くこと。** 書き込み可で開いて close すると SQLite が
  // WAL をチェックポイントし、計測ツールがユーザーのDBファイルを書き換えてしまう
  // （データは失われないが、計測対象を計測が動かすのは筋が悪い）。
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    // VACUUM INTO は WAL を反映した単一ファイルを作り、元のDBには触れない
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const walPath = `${src}-wal`;
  return {
    dest,
    srcBytes: fs.statSync(src).size,
    walBytes: fs.existsSync(walPath) ? fs.statSync(walPath).size : 0,
    destBytes: fs.statSync(dest).size,
  };
}

if (import.meta.filename === process.argv[1]) {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const argDb = process.argv.indexOf('--db');
  const src = argDb >= 0 ? process.argv[argDb + 1] : defaultDbPath(repoRoot);
  if (!src) throw new Error('この OS では既定パスを解決できません。--db <path> を指定してください');
  const dest = path.join(repoRoot, 'tools/embedding-check/results/snapshot.db');
  const r = snapshot(src, dest);
  console.log(`src  : ${src} (${(r.srcBytes / 1e6).toFixed(2)} MB, WAL ${(r.walBytes / 1e6).toFixed(2)} MB)`);
  console.log(`dest : ${r.dest} (${(r.destBytes / 1e6).toFixed(2)} MB)`);
}
