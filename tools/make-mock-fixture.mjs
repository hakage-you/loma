/**
 * 実DBから、性能計測用の**匿名化した**フィクスチャを作る。
 *
 * **出力はコミットしない。** `perf-results/` に置く（gitignore 済み）。
 * 中身は「あるユーザーのライブラリ」の形であって、標準でも理想的な分布でもない。
 * 件数を稼ぎやすく、合成データでは作れない偏り（タグの長い裾・使用数の同点が
 * 大量にあること・1メディアあたりのタグ本数のばらつき）を持つので計測に使える。
 *
 * 匿名化の方針:
 *   - ファイルパスと親フォルダ名は捨て、連番に置き換える
 *   - タグ名は捨て、`tag_<id>` と `タグ<id>` に置き換える
 *   - **残すのは構造だけ**（何件あるか、どのメディアがどのタグを何本持つか、
 *     カテゴリの分布、解析ステータスの分布）
 *
 * 元のDBは読むだけで、一切書き換えない。
 *
 * 実行:
 *   node tools/make-mock-fixture.mjs
 *   LOMA_TEST_DB=path/to/loma.db node tools/make-mock-fixture.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const OUT_DIR = 'perf-results';
const OUT_FILE = join(OUT_DIR, 'fixture.json');

function sourceDb() {
  if (process.env.LOMA_TEST_DB) return process.env.LOMA_TEST_DB;
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  const path = join(appdata, 'com.hakageyou.loma', 'loma.db');
  return existsSync(path) ? path : null;
}

const source = sourceDb();
if (!source) {
  console.error(
    '実DBが見つからない。LOMA_TEST_DB で場所を指定できる\n' +
      '  既定: %APPDATA%\\com.hakageyou.loma\\loma.db'
  );
  process.exit(1);
}

// **コピーに対して開く。** 読み取り専用で開いても WAL の都合で元へ触りうる
const work = join(tmpdir(), `loma-fixture-${process.pid}`);
mkdirSync(work, { recursive: true });
const copy = join(work, 'loma.db');
copyFileSync(source, copy);
for (const suffix of ['-wal', '-shm']) {
  if (existsSync(source + suffix)) copyFileSync(source + suffix, copy + suffix);
}

let db = null;
try {
  db = new DatabaseSync(copy, { readOnly: true });

  const tagRows = db
    .prepare(
      `SELECT t.id, t.is_category, t.tag_kind,
              (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id) AS count
       FROM tags t`
    )
    .all();

  const mediaRows = db
    .prepare('SELECT id, analysis_status, parent_folder, file_path FROM media')
    .all();

  const linkRows = db.prepare('SELECT media_id, tag_id FROM media_tags').all();

  // 親フォルダは名前を捨てて通し番号にする
  const folderIndex = new Map();
  for (const m of mediaRows) {
    if (!folderIndex.has(m.parent_folder)) folderIndex.set(m.parent_folder, folderIndex.size);
  }

  const tagById = new Map(tagRows.map((t) => [t.id, t]));
  const tagsByMedia = new Map();
  for (const l of linkRows) {
    if (!tagsByMedia.has(l.media_id)) tagsByMedia.set(l.media_id, []);
    tagsByMedia.get(l.media_id).push(l.tag_id);
  }

  const extensionOf = (p) => {
    const m = String(p).match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : 'jpg';
  };

  const fixture = {
    note:
      'あるユーザーのライブラリの形。標準でも理想的な分布でもない。' +
      'ファイルパスとタグ名は捨ててある',
    generated_at: new Date().toISOString(),
    tags: tagRows.map((t) => ({
      id: t.id,
      name: `tag_${t.id}`,
      name_ja: `タグ${t.id}`,
      is_category: t.is_category !== 0,
      count: t.count,
      kind: t.tag_kind || 'basic',
    })),
    media: mediaRows.map((m, i) => {
      const ids = tagsByMedia.get(m.id) ?? [];
      return {
        id: m.id,
        file_index: i,
        extension: extensionOf(m.file_path),
        folder_index: folderIndex.get(m.parent_folder),
        analysis_status: m.analysis_status,
        category_ids: ids.filter((id) => tagById.get(id)?.is_category),
        tag_ids: ids.filter((id) => !tagById.get(id)?.is_category),
      };
    }),
    folder_count: folderIndex.size,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(fixture));

  // 形の要約。**数字はそのまま実データの形を表す**ので、計画の根拠に使える
  const tagCounts = tagRows.map((t) => t.count).sort((a, b) => b - a);
  const perMedia = fixture.media.map((m) => m.tag_ids.length).sort((a, b) => a - b);
  const at = (arr, ratio) => arr[Math.min(arr.length - 1, Math.floor(arr.length * ratio))] ?? 0;
  const statusCounts = {};
  for (const m of mediaRows) statusCounts[m.analysis_status] = (statusCounts[m.analysis_status] ?? 0) + 1;

  console.log(`書き出した: ${OUT_FILE}`);
  console.log(`  メディア            ${fixture.media.length.toLocaleString()}`);
  console.log(`  タグ                ${fixture.tags.length.toLocaleString()}`);
  console.log(`  親フォルダ          ${fixture.folder_count.toLocaleString()}`);
  console.log(`  解析ステータス      ${JSON.stringify(statusCounts)}`);
  console.log(`  タグの使用数        最大 ${tagCounts[0]} / 中央 ${at(tagCounts, 0.5)} / 下位25% ${at(tagCounts, 0.75)}`);
  console.log(`  使用数1回だけのタグ ${tagCounts.filter((c) => c === 1).length.toLocaleString()}件`);
  console.log(
    `  1メディアのタグ本数  中央 ${at(perMedia, 0.5)} / 上位10% ${at(perMedia, 0.9)} / 最大 ${perMedia[perMedia.length - 1]}`
  );
  console.log(`  JSON のサイズ       ${(JSON.stringify(fixture).length / 1024 / 1024).toFixed(2)} MB`);
} finally {
  // **先に閉じる。** 開いたままだと Windows はファイルを掴んだままで消せない
  db?.close();
  rmSync(work, { recursive: true, force: true });
}
