/**
 * **まだ本番に入っていない**候補プロンプトと候補実行パラメータ。
 *
 * `prompt.mjs` は本番の文面を実物から取得する（ミラーを持たない）。こちらはその逆で、
 * **これから採用するかを決めるための案**を置く場所。`tools/prompt-check` の
 * `candidateVariants()` と同じ役割。
 *
 * **採用して Rust に取り込んだら、対応する候補はここから削除すること。**
 * 残すと本物と候補の二重管理になる。
 *
 * ## 候補実行パラメータも候補として扱う理由
 *
 * 本番の同義語検出は `options` を送っていないので num_ctx は Ollama 既定（通常4096）。
 * 大きな入力を測るには num_ctx を明示するしかないが、**それは本番に存在しない条件**。
 * 曖昧にすると「計測では通ったのに本番で壊れる」が再発するので、
 * プロンプトと同じく「候補」として明示的に持つ。
 */

import { HIERARCHY_SEEDS } from './seeds.mjs';

/**
 * プロンプト内の例に使っているタグ名。
 *
 * **モデルが例をそのままコピーして返す failure mode を検出するために持つ。**
 * 実測: `qwen2:1.5b` は入力タグを一切見ず、プロンプトの例をそのまま返した。
 * これは「入力に無いタグを発明した」のとは診断が違う（プロンプトの例が強すぎる）ので分けて数える。
 *
 * **ここを変えたら例の本文も一緒に直すこと。**
 */
export const EXAMPLE_TAG_NAMES = new Set([
  'pathway', 'sidewalk', 'pedestrian_walkway',
  'street_lamp', 'streetlamp', 'streetlight',
  'printed_document', 'printed_document_page',
  'dry_leaf', 'dry_brown_leaf',
  'tagA', 'tagB', 'tagC', 'tagD', 'tagE',
]);

/**
 * **例文に評価シードが混入していないことを読み込み時に強制する。**
 *
 * 一度は「例はルールが既に拾える組に限る」という条件だけを置いていたが、
 * `footwear`/`shoe`/`boot` は**その条件を満たしつつ階層シード3組と重なっていた**
 * （footwear⊃shoe / ⊃boot / ⊃sneaker）。条件が1つ足りず、目視でも気付けなかった。
 *
 * シード回収率を合格条件にした以上、例文にシードが1語でも入っていれば
 * **コピーするだけで点が入る**。人間のレビューに頼らず、ここで落とす。
 */
function assertNoSeedLeak() {
  const leaked = [...new Set(HIERARCHY_SEEDS.flat())].filter((n) => EXAMPLE_TAG_NAMES.has(n));
  if (leaked.length) {
    throw new Error(
      `プロンプトの例に評価シードが混入しています: ${leaked.join(', ')}\n` +
        '  例をコピーするだけでシード回収率に点が入るため、計測が成立しません。\n' +
        '  seeds.mjs と重ならない、かつルールが既に拾える組に差し替えてください。'
    );
  }
}
assertNoSeedLeak();

/**
 * **例に評価用のテストケースを使ってはいけない。**
 *
 * 当初は `container`⊃`bowl`（階層シード）や `greenhouse`↔`structure`（既知ケース）を
 * 例に書いていたが、それでは**「モデルが見つけた」のか「例をコピーした」のかを
 * 永久に区別できない**。入力が十分大きければそれらのタグは実在するので、
 * コピー検出も効かない。
 *
 * ここで使う例には**2つの条件**があり、両方を満たす組しか使えない。
 *
 *   1. **ルールベースが既に拾える組**であること
 *      （＝LLM が出しても増分価値が無く、評価対象にならない）
 *   2. **`seeds.mjs` のシードと重ならない**こと
 *      （重なると「見つけた」のか「例をコピーした」のかが区別できなくなる）
 *
 * 2 は下の `assertNoSeedLeak()` が読み込み時に強制する。
 * **かつて `footwear`/`shoe`/`boot` を例に使っており、これは階層シード3組と重なっていた。**
 * 1 だけを条件にしていたので気付けなかった。
 *
 * `classify_rule_pairs` で確認済み:
 * pathway/sidewalk/pedestrian_walkway（同一日本語表記「歩道」）、
 * street_lamp/streetlamp（同一日本語表記「街灯」）、
 * printed_document/printed_document_page・dry_leaf/dry_brown_leaf = 共通キーフレーズ。
 */
const TARGET_RULE = `For each group, "target" is the tag that remains after merging.
Choose the most general tag of the group. It MUST be one of the listed members.
Never invent a tag that is not in the input list.`;

const HIERARCHY_RULE = `When a hierarchy exists, propose groups at EVERY level of granularity.
Given "pathway", "sidewalk", "pedestrian_walkway" and "dry_leaf", output BOTH:
  {"target": "pathway", "members": ["sidewalk", "pedestrian_walkway"]}
  {"target": "sidewalk", "members": ["pedestrian_walkway"]}
if "pedestrian_walkway" is also a kind of "sidewalk", so the user can choose how aggressively to merge.
A tag may appear in more than one group when it genuinely fits several.`;

/**
 * 否定例。**具体名を挙げる形は VLM 側でも効いている**が、
 * ここでも評価対象の負例（bear/bean 等）は書かない。書くと「例を見て避けた」のか
 * 「自力で判断した」のか分からなくなる。抽象的な言い方にとどめる。
 */
const NEGATIVE_RULE = `Do NOT group tags that merely look similar, share a word, or differ by
a few letters, when they refer to different things. Spelling similarity alone is never
a reason to merge.
Do NOT merge sibling tags directly into each other: two different kinds of the same
thing must stay separate. Siblings MAY both be merged into a common parent tag when
that parent is in the input list. If no parent tag exists, do not merge them.`;

const POSITIVE_RULE = `Group tags together when either:
- They refer to the same thing in different words
  (e.g. "street_lamp" and "streetlamp" and "streetlight").
- One is a kind of the other, or a more specific wording of the other
  (e.g. "printed_document_page" is a more specific "printed_document";
   "dry_brown_leaf" is a more specific "dry_leaf").`;

const HEAD = 'Analyze the following list of tags and group tags that should be merged into one.';

/**
 * 候補プロンプト。
 *
 * `jsonl` 版は**1グループ1行**で出させる。1個の巨大な JSON だと、出力が途中で切れたときに
 * 全部が失われて「パース失敗1件」としか記録できない。行単位なら (a) 直前まで使える、
 * (b) 失敗が二値でなく率になる、(c) 原因を行単位で特定できる。
 */
export const CANDIDATE_PROMPTS = {
  group_json: {
    label: '候補: グループ形式（単一JSON）',
    build: (tags) =>
      `${HEAD}\n\nTags: ${JSON.stringify(tags)}\n\n${POSITIVE_RULE}\n\n${NEGATIVE_RULE}\n\n${HIERARCHY_RULE}\n\n${TARGET_RULE}\n\n` +
      `Output ONLY valid JSON:\n{"groups": [{"target": "tagA", "members": ["tagB", "tagC"]}, ...]}\n` +
      `using exact tag names from the input list.`,
  },
  group_jsonl: {
    label: '候補: グループ形式（1行1グループ / JSONL）',
    build: (tags) =>
      `${HEAD}\n\nTags: ${JSON.stringify(tags)}\n\n${POSITIVE_RULE}\n\n${NEGATIVE_RULE}\n\n${HIERARCHY_RULE}\n\n${TARGET_RULE}\n\n` +
      `Output ONE group per line as JSON, nothing else. No array, no wrapper object:\n` +
      `{"target": "tagA", "members": ["tagB", "tagC"]}\n` +
      `{"target": "tagD", "members": ["tagE"]}\n` +
      `Use exact tag names from the input list.`,
  },
};

/**
 * 段1: 包括語（上位概念になりうるタグ）の抽出。
 *
 * **なぜ分けるのか。** グルーピングは O(n²) の突き合わせなので分割できない
 * （分けると親と子が別チャンクに落ち、埋め込みで寄せても17〜25%しか同居しない）。
 * 一方**「このタグは包括語か」の判定はタグ単位で独立**なので、任意に分割してよい。
 * 段1で包括語 P 件を確定し、段2では P 件を全チャンクに注入する。
 * これで co-location が構造的に保証される。
 *
 * **再現率を優先する。** 見落とした包括語はその下の階層が丸ごと永久に出なくなるが、
 * 余分に拾っても段2のチャンクが少し重くなるだけ。ただし P が大きいほど
 * 段2の呼び出し回数が増えるので、際限なく緩めてよいわけではない。
 *
 * 出力は**該当するものだけを1行1件**。100件全部に真偽を書かせると出力が4倍になり、
 * 発散の危険が上がる（n=200 で32万トークン生成した実測がある）。
 *
 * ## 件数を指定する理由
 *
 * 「包括語か否か」という**絶対判断はモデルの閾値が大きく振れる** —
 * 同じプロンプト・同じ入力で thinking on なら 4%、off なら 52% だった（実測）。
 * P が段2の実行可能性を直接決めるので、この振れ幅は許容できない。
 *
 * **「最も包括的な N 件を選べ」という相対判断に変える。** LLM は閾値判断より
 * 順位付けの方が安定し、しかも P を直接制御できる。出力長も N 行に有界になるので
 * 発散の余地が減る。
 */
export const PARENT_PROMPT = {
  label: '候補: 包括語の抽出（段1）',
  /** `topN` を指定すると相対判断（上位N件）、省略すると絶対判断になる */
  build: (tags, topN = 0) =>
    `You are organizing image tags. From the list below, find the tags that are ` +
    `CATEGORY-LIKE: general terms that other, more specific tags could be grouped under.\n\n` +
    `Tags: ${JSON.stringify(tags)}\n\n` +
    `A tag is category-like if you can name a more specific kind of it that a photo might show.\n` +
    `Example: "pathway" is category-like because "sidewalk" is a kind of pathway.\n` +
    `"streetlamp" is NOT category-like: it is already specific.\n` +
    `A mid-level term still counts (it can be a kind of something broader and still have kinds of its own).\n\n` +
    (topN > 0
      ? `Select exactly the ${topN} MOST category-like tags from the list, most general first.\n` +
        `If fewer than ${topN} qualify, output only those that do.\n\n`
      : `When unsure, include it.\n\n`) +
    `Output ONE tag per line, nothing else. No numbering, no explanation:\n` +
    `pathway\n` +
    `Use exact tag names from the input list. Do not output tags that are not in the list.`,
};

/**
 * 段2: 既知のカテゴリへの**割り当て**（グルーピングではない）。
 *
 * **なぜ形を変えるのか。** 段1で得た包括語をそのまま入力に混ぜてグルーピングさせると、
 * モデルは**毎回カテゴリどうしの関係まで解き直す**（`container`/`utensil`/`tableware`、
 * `structure`/`building`/`house`/`room` は互いに関係が濃い）。
 * 実測: 包括語75件＋通常25件で600秒タイムアウト。41チャンク分これを繰り返すのは無理。
 *
 * **カテゴリ間の関係は一度決めれば済む。** 段2は「新しいタグをカテゴリに割り当てる」
 * だけに制約する。出力は最大でも item 数に収まり、タスクも単純になる。
 *
 * **大きいグループは同居ではなく集約で作る。** チャンクを跨いで target ごとに
 * members を足し合わせれば、`container` が別々のチャンクから
 * bowl / cup / plate / glass を集めて4件のグループになる。
 * これで「親と子が同じチャンクに居ないと大きい提案が出ない」という制約が消える。
 */
export const ASSIGN_PROMPT = {
  label: '候補: カテゴリへの割り当て（段2）',
  build: (categories, items) =>
    `You are organizing image tags.\n\n` +
    `Categories: ${JSON.stringify(categories)}\n\n` +
    `Tags: ${JSON.stringify(items)}\n\n` +
    `For each tag in "Tags" that is a KIND OF one of the categories, output the assignment.\n` +
    `Example: if "pathway" is a category and "sidewalk" is a tag, a sidewalk is a kind of pathway.\n\n` +
    `Rules:\n` +
    `- Only assign a tag when it is genuinely a kind of that category, not merely related.\n` +
    `- A tag may be assigned to more than one category when it genuinely fits several.\n` +
    `- Skip tags that fit no category. Do not force an assignment.\n` +
    `- **Do not relate categories to each other.** Only assign tags from "Tags".\n` +
    `- Never invent a name that is not in the lists.\n\n` +
    `Output ONE assignment per line as JSON, nothing else:\n` +
    `{"target": "pathway", "members": ["sidewalk"]}\n` +
    `Use exact names from the lists.`,
};

/**
 * S3: 埋め込みクラスタを LLM に精査させる（Pass S 用）。
 *
 * **測っているのは「LLM を挟む増分」であって、クラスタの質ではない。**
 * クラスタをそのまま提案に出す案と比較して初めて意味を持つ。
 *
 * 判定の要点は2つ:
 *
 *   1. **既知の悪い組を割れるか** — `bright_light` / `bright_screen` は cos 0.9140 で
 *      同じクラスタに入る。光と画面で対象が違うので割れてほしい
 *   2. **ルール未到達ペアを壊さないか** — `glass_of_water` / `water_glass` などは
 *      **Pass S の唯一の価値**（ルールでは原理的に拾えない語順違い・別語彙）。
 *      LLM がこれを弾くなら、挟む意味が反転する
 *
 * 例に使うのは `street_lamp`/`streetlamp`（同一日本語表記）と
 * `dry_leaf`/`dry_brown_leaf`（共通キーフレーズ）。どちらもルール到達済みで、
 * かつ `assertNoSeedLeak()` の対象外であることを確認済み。
 */
export const REFINE_PROMPT = {
  label: '候補: クラスタの精査（Pass S / S3）',
  build: (tags) =>
    `These image tags were grouped automatically because they look similar. Verify the grouping.\n\n` +
    `Tags: ${JSON.stringify(tags)}\n\n` +
    `Keep tags together ONLY when merging them would not lose meaning:\n` +
    `- the same concept written differently (e.g. "street_lamp" and "streetlamp")\n` +
    `- the same thing at different levels of detail (e.g. "dry_leaf" and "dry_brown_leaf")\n\n` +
    `Split off a tag that names a DIFFERENT thing, even when the two are related.\n` +
    `A group needs at least 2 tags. Drop tags that belong with nothing else.\n\n` +
    `Output ONE group per line as JSON, nothing else:\n` +
    `{"members": ["tagA", "tagB"]}\n` +
    `Use exact tag names from the input list.`,
};

/**
 * 候補実行パラメータ。**本番は options を一切送っていない**ので、
 * ここで指定する値はすべて「本番に無い条件」であることを忘れないこと。
 */
export const CANDIDATE_OPTIONS = {
  // num_predict は指定しない。thinking の消費分も同じ枠から引かれ、答えを書く前に
  // 打ち切られる（実測 3/4 が空応答。note-ollama-no-num-predict）
  temperature: 0.1,
};

// ---------------------------------------------------------------- パース

/** `{...}` を切り出す（本番の find('{') / rfind('}') と同じ手順） */
function extractJsonText(raw) {
  const clean = (raw ?? '').trim();
  if (!clean) return null;
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  return start >= 0 && end >= 0 && start < end ? clean.slice(start, end + 1) : clean;
}

/**
 * `target` は用途によって必須でない。
 *
 * - 段2（割り当て）は `{target, members}`。どのカテゴリに入れたかが答えなので **target 必須**
 * - Pass S（同義クラスタの精査）は `{members}`。**同義の集合に主従は無く**、
 *   代表タグは使用数で後から決まるので target を要求してはいけない
 *
 * これを分けずに `target` を必須にしていたため、Pass S の精査結果が全行捨てられ、
 * 「LLM がクラスタを全消しした」ように見えた（実際は1件も採れていなかっただけ）。
 */
const isGroup = (g, requireTarget = true) =>
  g && typeof g === 'object' && !Array.isArray(g) &&
  (requireTarget ? typeof g.target === 'string' : true) &&
  Array.isArray(g.members) &&
  g.members.every((m) => typeof m === 'string');

/**
 * 単一 JSON 形式をパースする。**全か無か**で、途中で切れると全部失われる。
 */
export function parseGroupJson(raw) {
  const text = extractJsonText(raw);
  if (!text) return { ok: false, reason: 'empty_response', groups: [] };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'json_syntax_error', detail: String(e.message).slice(0, 120), groups: [] };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, reason: 'not_an_object', groups: [] };
  }
  if (!Array.isArray(obj.groups)) return { ok: false, reason: 'missing_groups', groups: [] };
  const bad = obj.groups.findIndex((g) => !isGroup(g));
  if (bad >= 0) return { ok: false, reason: 'group_malformed', detail: `index ${bad}`, groups: [] };
  return { ok: true, groups: obj.groups, lines: obj.groups.length, badLines: 0 };
}

/**
 * 波括弧の対応を数えて `{...}` を1つずつ切り出す。
 * 整形済み（複数行にまたがる）JSON からオブジェクトを拾うための復旧経路。
 * 文字列リテラル内の括弧とエスケープを無視しないと誤って切れる。
 */
function* scanJsonObjects(text) {
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

/**
 * JSONL 形式をパースする。**行単位で失敗を数える**ので、
 * 出力が途中で切れても直前の行までは使える。
 *
 * 行単位で読めなかった場合は**波括弧の対応で復旧を試みる**。
 * 「1行1グループ」を守らず整形して出すモデルがあるため（実測）。
 * ただし復旧したことは `formatViolation` として記録する ——
 * **形式を守れない failure と内容を出せない failure は別物**で、
 * 混ぜるとプロンプトのどこを直せばいいのか分からなくなる。
 */
export function parseGroupJsonl(raw, { requireTarget = true } = {}) {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty_response', groups: [] };
  const groups = [];
  let bad = 0;
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().replace(/^```(?:json|jsonl)?$/i, '').replace(/^```/, '');
    if (!t || t === '```') continue;
    total++;
    try {
      const g = JSON.parse(t);
      if (isGroup(g, requireTarget)) groups.push(g);
      else bad++;
    } catch {
      bad++;
    }
  }
  if (groups.length) {
    return { ok: true, reason: null, groups, lines: total, badLines: bad, formatViolation: false };
  }

  // 行単位で1つも読めなかった。整形済み JSON の可能性があるので括弧対応で拾い直す
  const recovered = [];
  for (const chunk of scanJsonObjects(text)) {
    try {
      const o = JSON.parse(chunk);
      if (isGroup(o, requireTarget)) recovered.push(o);
      else if (Array.isArray(o?.groups)) recovered.push(...o.groups.filter((x) => isGroup(x, requireTarget)));
    } catch {
      /* 切れている末尾など。無視してよい */
    }
  }
  if (recovered.length) {
    return {
      ok: true, reason: null, groups: recovered,
      lines: total, badLines: bad, formatViolation: true,
    };
  }
  return { ok: false, reason: total ? 'all_lines_malformed' : 'no_lines', groups: [], lines: total, badLines: bad };
}

/**
 * 本番の `find_tag` 相当。モデルが返した名前から入力中のタグを引く。
 * 記述子は `name (name_ja)` 形式なので、`(` の手前を英名として扱う。
 */
export function resolveName(byName, byJa, raw) {
  const clean = String(raw).trim().replace(/^#/, '');
  const en = clean.split('(')[0].trim();
  return byName.get(en) ?? byName.get(clean) ?? byJa.get(clean) ?? null;
}

/**
 * グループを検証し、本番で実際に成立する形に落とす。
 *
 * - 入力に無いタグ（＝発明）を弾く
 * - 種別またぎを弾く（本番は `t1.kind == t2.kind` で落とす）
 * - `target` が members に含まれない場合を記録する
 * - 実質1件以下になったグループは候補にならない
 */
export function validateGroups(groups, tags) {
  const byName = new Map(tags.map((t) => [t.name, t]));
  const byJa = new Map(tags.filter((t) => t.nameJa).map((t) => [t.nameJa, t]));
  const out = [];
  const stats = { invented: 0, exampleCopied: 0, crossKind: 0, targetNotInMembers: 0, degenerate: 0 };
  // 入力に無い名前のうち、プロンプトの例に出てくるものは「例のコピー」として別に数える
  const countMissing = (name) => {
    const en = String(name).trim().replace(/^#/, '').split('(')[0].trim();
    if (EXAMPLE_TAG_NAMES.has(en)) stats.exampleCopied++;
    else stats.invented++;
  };

  for (const g of groups) {
    const target = resolveName(byName, byJa, g.target);
    const members = [];
    let missing = 0;
    for (const m of g.members) {
      const t = resolveName(byName, byJa, m);
      if (!t) { countMissing(m); missing++; }
      else if (!members.some((x) => x.id === t.id)) members.push(t);
    }
    if (!target) { countMissing(g.target); missing++; }
    const invented = missing;
    if (!target) continue;

    if (!members.some((m) => m.id === target.id)) {
      stats.targetNotInMembers++;
      members.push(target);
    }
    const same = members.filter((m) => m.kind === target.kind);
    stats.crossKind += members.length - same.length;
    if (same.length < 2) {
      stats.degenerate++;
      continue;
    }
    out.push({ target, members: same, inventedCount: invented });
  }
  return { groups: out, stats };
}
