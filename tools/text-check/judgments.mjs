// 人手判定の台帳。**比較ごとではなく1箇所に貯める。**
//
// 「`container ← lid` は提案として出す価値があるか」という判定は、
// **どのモデル・どのプロンプトが出したかに依らない**。ペアの性質の判定だから。
// なので比較ごとにファイルを分けず、1つの台帳に貯めて使い回す。
//
// これがあると、2回目以降の比較で聞くのは**まだ判定していないペアだけ**になる。
// 比較を重ねるほど人手のコストが下がる。
//
// 形式（TSV・追記のみ）:
//   target<-member \t good|bad|hold|unknown \t method \t YYYY-MM-DD
//
// 同じペアが複数行あれば**最後の行が有効**（判定を変えられる）。
//
// ## hold と unknown を分ける理由
//
//   hold     意味は分かるが良し悪しを決められない（`structure ← greenhouse`:
//            正しい包括関係だが統合すると情報が失われる）
//   unknown  **タグの意味が分からない**（`alcohol ← arran`、`berryshka ← raspberry`）
//
// unknown は**方式の質とは無関係**。VLM が画像内の文字や固有名詞を拾った結果で、
// タグ生成側の問題。混ぜると方式の評価が歪むので別に数える。
// unknown の比率そのものが「タグ生成の状態」を示す指標になる。

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEDGER = join(HERE, 'results', 'judgments.tsv');

/** ペアの鍵。タグ名で持つ（IDはDBを作り直すと変わりうる） */
export const pairKey = (targetName, memberName) => `${targetName}<-${memberName}`;

/** 台帳を読む。同じ鍵は後の行で上書き */
export function loadJudgments(path = LEDGER) {
  const map = new Map();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const [key, verdict, method, date] = line.split('\t');
    if (key && verdict) map.set(key, { verdict, method, date });
  }
  return map;
}

/** 1件追記する。**判定のたびに書く**（中断しても失わない） */
export function appendJudgment(key, verdict, method, path = LEDGER) {
  mkdirSync(dirname(path), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  appendFileSync(path, `${key}\t${verdict}\t${method}\t${date}\n`, 'utf8');
}

/** 決定的な擬似乱数。同じ seed なら同じ標本になる（後から追試できる） */
export function prng(seed) {
  let x = seed >>> 0;
  return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** 無作為抽出（決定的） */
export function pick(list, n, rnd) {
  if (n >= list.length) return [...list];
  return list
    .map((v) => ({ v, r: rnd() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, n)
    .map((x) => x.v);
}

/** DB から保存済みのペアを読む。**判定ロジックではなく生データの読み出し** */
export function loadPairs(DatabaseSync, path, method) {
  const db = new DatabaseSync(path, { readOnly: true });
  const tags = new Map(
    db
      .prepare(
        `SELECT t.id, t.name, COALESCE(t.name_ja,'') ja, COUNT(mt.media_id) cnt
         FROM tags t LEFT JOIN media_tags mt ON t.id=mt.tag_id GROUP BY t.id`
      )
      .all()
      .map((r) => [r.id, r])
  );
  const pairs = new Map();
  for (const r of db
    .prepare(
      `SELECT target_id a, member_id b FROM tag_suggestion_pairs WHERE method=? AND dismissed=0`
    )
    .all(method)) {
    const t = tags.get(r.a);
    const m = tags.get(r.b);
    if (t && m) pairs.set(pairKey(t.name, m.name), { t, m });
  }
  // グループの大きさ（target ごとのメンバー数）。判断の文脈として出す
  const size = new Map();
  for (const k of pairs.keys()) {
    const t = k.split('<-')[0];
    size.set(t, (size.get(t) ?? 0) + 1);
  }
  return { pairs, size };
}
