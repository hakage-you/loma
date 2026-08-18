#!/usr/bin/env node
/**
 * タグ整理（同義語統合＋粒度の丸め）を評価するための「正解グループ候補」を作る。
 *
 * **なぜグループ単位なのか。** この機能のゴールは「正しいペアを当てる」ことではない。
 * 提案はあくまで提案で、実際の統合は人が不要なものを除外してから行う。したがって
 * **1グループが大きくなること自体は害ではなく、同じ概念が小グループに散らばるほうが困る**
 * （数百件の似たグループを人が捌くことになる）。評価軸は次の2つ:
 *
 *   - **断片化**: 本来1つにまとまるべきタグ群が、いくつのグループに割れたか
 *   - **誤統合**: 意味の違うタグが同じグループに混ざっていないか
 *
 * **なぜ類似度の上位だけ見てはいけないか。** 2026-08-01 に上位400ペアを抽出したところ、
 * 「ビールの入ったグラス」「ビールが入ったグラス」のような判断の余地が無い言い換えばかりが
 * 並んだ。実際に判断が割れるのは 0.85〜0.93 の帯で、そこでは正例と負例が入り混じる
 * （実測: 統合したい `bright_light`↔`bright_daytime_scene` が 0.9000 なのに対し、
 * 統合したくない `bright_light`↔`bright_screen` が 0.9140 と**上に来る**）。
 * 類似度の閾値だけでは分離できないので、帯で切ってグループを作り人に判定させる。
 *
 * 出力の読み方・書き方は生成される TSV の先頭コメントを参照。
 *
 *   node tools/text-check/gold-set.mjs --db tools/embedding-check/results/snapshot-bge-m3.db \
 *     --model bge-m3 --threshold 0.87
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
// ルール判定は rules.mjs（本番の #[ignore] テスト経由）に一本化した

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DB_PATH = path.resolve(arg('db', path.join(HERE, 'results/snapshot.db')));
const MODEL = arg('model', 'bge-m3');
/**
 * この値以上の類似度を「同じグループ候補」の辺とみなす。
 *
 * 既定 0.90 は実測で決めた。0.87 まで下げると連結が伸びすぎ、
 * `black_background` と `white_background` が同じ 48 件のグループに入る（正反対なのに）。
 * 0.92 まで上げると最大グループが 12 件に縮み、丸めたい塊が割れ始める。
 */
const THRESHOLD = parseFloat(arg('threshold', '0.90'));
/** ラベル付けは有限の作業なので、大きいグループから順にこの数だけ出す */
const MAX_GROUPS = parseInt(arg('groups', '40'), 10);
const OUT_PATH = path.resolve(arg('out', path.join(HERE, 'results/gold-set-groups.tsv')));

function load() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const tags = new Map();
    for (const r of db.prepare('SELECT id, name, name_ja, tag_kind AS kind FROM tags WHERE is_category = 0').all()) {
      tags.set(r.id, { id: r.id, name: r.name, nameJa: r.name_ja?.trim() || null, kind: r.kind });
    }
    const vectors = new Map();
    let dim = 0;
    for (const r of db.prepare('SELECT tag_id, vector FROM tag_embeddings WHERE model = ?').all(MODEL)) {
      if (!tags.has(r.tag_id)) continue;
      const buf = Buffer.from(r.vector);
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4).slice();
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      vectors.set(r.tag_id, v);
      dim = v.length;
    }
    if (!dim) throw new Error(`モデル ${MODEL} のベクトルが ${DB_PATH} に無い`);
    return { tags, vectors, dim };
  } finally {
    db.close();
  }
}

function main() {
  console.log(`db        : ${DB_PATH}`);
  console.log(`model     : ${MODEL}`);
  console.log(`threshold : ${THRESHOLD}\n`);
  const { tags, vectors, dim } = load();

  // 本番は種別をまたぐ統合を判定前に落とすので、種別ごとに閉じてグループを作る
  const byKind = new Map();
  for (const [id, t] of tags) {
    if (!vectors.has(id)) continue;
    if (!byKind.has(t.kind)) byKind.set(t.kind, []);
    byKind.get(t.kind).push(id);
  }

  // 類似度が閾値以上の辺を張り、連結成分をグループとする（本番の BFS と同じ考え方）
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (const [kind, ids] of byKind) {
    const started = Date.now();
    let edges = 0;
    for (let i = 0; i < ids.length; i++) {
      const va = vectors.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const vb = vectors.get(ids[j]);
        let s = 0;
        for (let d = 0; d < dim; d++) s += va[d] * vb[d];
        if (s >= THRESHOLD) {
          link(ids[i], ids[j]);
          edges++;
        }
      }
    }
    console.log(`${kind.padEnd(12)} ${ids.length} タグ / 辺 ${edges} 本 / ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const seen = new Set();
  const groups = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const members = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const cur = queue.pop();
      members.push(cur);
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    if (members.length > 1) groups.push(members);
  }

  groups.sort((a, b) => b.length - a.length);
  const sizes = groups.map((g) => g.length);
  console.log(`\nグループ ${groups.length} 件 / 最大 ${sizes[0] ?? 0} 件 / 2件のみのグループ ${sizes.filter((s) => s === 2).length} 件`);
  const over15 = sizes.filter((s) => s > 15).length;
  console.log(
    `16件以上のグループ: ${over15} 件` +
      (over15 ? '  <- 本番は member_ids.len() <= 15 でこれを丸ごと捨てている（commands.rs）' : '')
  );

  const shown = groups.slice(0, MAX_GROUPS);
  const lines = [
    '# タグ整理の正解グループ候補（ラベル付けしてください）',
    '#',
    '# この機能のゴールは「同じ概念のタグを1グループにまとめて提案する」こと。',
    '# 1グループが大きいのは害ではない（人が不要なものを除外してから統合するため）。',
    '# 困るのは同じ概念が複数グループに散らばること。評価軸は断片化と誤統合の2つ。',
    '#',
    '# 各行が1タグ。同じ group 番号の行が1グループ。',
    '# member 列に記入する:',
    '#   空 = このグループに入っていて良い',
    '#   x  = このタグはこのグループに入るべきでない（誤統合。負例として使う）',
    '#   T  = このグループの代表タグ（統合先）にすべき',
    '#',
    '# 別グループにあるが本来同じグループであるべきものは、move 列に統合先の group 番号を書く',
    '# （断片化の正解になる）。',
    '#',
    `# 抽出条件: ${MODEL} / コサイン類似度 >= ${THRESHOLD} / 種別内のみ`,
    ['group', 'member', 'move', 'kind', 'tag', 'tag_ja', 'id'].join('\t'),
  ];
  shown.forEach((members, gi) => {
    // 読みやすさのため名前順。代表の判断は人がするので順序に意味は持たせない
    const sorted = members.map((id) => tags.get(id)).sort((a, b) => a.name.localeCompare(b.name));
    for (const t of sorted) {
      lines.push([gi + 1, '', '', t.kind, t.name, t.nameJa ?? '', t.id].join('\t'));
    }
  });
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, lines.join('\n'));
  console.log(`\nラベル付け用ファイル: ${path.relative(REPO_ROOT, OUT_PATH)}`);
  console.log(`  上位 ${shown.length} グループ / 計 ${shown.reduce((s, g) => s + g.length, 0)} タグ`);
}

main();
