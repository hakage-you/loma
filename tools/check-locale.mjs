/**
 * ロケール文言の検査。
 *
 * **句点の有無はキー名で宣言する。** 値の書き方（丁寧体の述語で終わるか等）から
 * 推測すると、体言止めの説明文や `<li>` の項目で必ず破綻する。実際、述語で
 * 判定した時点で 258件中5件を誤分類していた（`<h3>` の見出し・`<li>` の項目）。
 *
 * 役割は埋め込み先で決まり、書き手はそれを必ず知っているので、宣言のコストは無い。
 *
 *   label_ で始まる → ラベル（ボタン・タブ・見出し・バッジ・プレースホルダ）→ 句点なし
 *   item_  で始まる → 箇条書きの項目 → 句点なし
 *   どちらでもない  → 文（ツールチップ・通知・警告・空状態・案内）→ 句点あり
 *
 * 「ラベルに句点を付けない」と「箇条書きに句点を付けない」は**別のルール**なので、
 * 接頭辞も分けてある。
 *
 * **付け忘れたときに落ちる向きに倒してある。** 接頭辞の無いキーは文とみなされ、
 * 句点が無ければ検査で落ちる。逆向き（文にマーカーを付ける）にすると、
 * 付け忘れたキーはラベル扱いになって検査をすり抜ける。
 *
 * **使われていないキーも落とす。** 文言を定義しただけで画面に繋いでいないと、
 * その画面はハードコードされた文字列のまま残る。実際に `folder_modal` は
 * ラベルが3つ定義されているのに1つも使われておらず、画面は全部英語だった。
 *
 * 実行: npm run check:locale
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const LOCALES = 'src/locales';
const SRC = 'src';

const flatten = (obj, prefix = '') => {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') out.push(...flatten(v, `${prefix}${k}.`));
    else out.push([`${prefix}${k}`, v]);
  }
  return out;
};

/** 末尾の要素だけを見る。名前空間（`tag_modal.`）は役割と無関係 */
const leafOf = (key) => key.split('.').pop();
const isLabel = (key) => leafOf(key).startsWith('label_');
const isItem = (key) => leafOf(key).startsWith('item_');

const walkFiles = (dir, acc = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, acc);
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
};

/** `locales/<lang>/<namespace>.json` を集めて1つの辞書にする。ファイル名が名前空間 */
const loadLang = (lang) => {
  const dir = join(LOCALES, lang);
  const out = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    out[name.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  }
  return out;
};

const ja = loadLang('ja');
const en = loadLang('en');
const jaRows = flatten(ja);
const jaKeys = new Set(jaRows.map(([k]) => k));
const enKeys = new Set(flatten(en).map(([k]) => k));

const problems = [];

// 1. 句点。日本語だけを見る（英語のピリオドは別の慣行なので混ぜない）
for (const [key, value] of jaRows) {
  if (typeof value !== 'string') continue;
  const label = isLabel(key);
  const item = isItem(key);
  for (const raw of value.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // 差し込みだけの行（`{list}` など）。中身は実行時に入るので句点の判定対象外
    if (/^\{[a-z_]+\}$/i.test(line)) continue;
    // 値の中の箇条書き。接頭辞と同じ理由で句点を付けない
    const bullet = line.startsWith('・');
    const dot = line.endsWith('。');
    if ((label || item || bullet) && dot) {
      const why = label ? 'ラベル' : item ? '箇条書きの項目' : '「・」で始まる行';
      problems.push(`[句点] ${key}\n    ${why}なのに句点がある: ${line.slice(0, 48)}`);
    }
    if (!label && !item && !bullet && !dot) {
      problems.push(
        `[句点] ${key}\n    文なのに句点がない: ${line.slice(0, 48)}\n` +
          `    ラベルなら label_ を、箇条書きの項目なら item_ を接頭辞に付ける`
      );
    }
  }
}

// 2. ja と en のキーの対応
for (const k of jaKeys) if (!enKeys.has(k)) problems.push(`[欠落] en に無い: ${k}`);
for (const k of enKeys) if (!jaKeys.has(k)) problems.push(`[欠落] ja に無い: ${k}`);

// 3. 呼び出し側のキーが実在するか。
//    **改名の安全網。** キーは文字列なので、間違えても tsc は通り、
//    既定値に静かにフォールバックして気付けない
const CALL = /\bt(?:ranslate)?\(\s*'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/gi;
for (const file of walkFiles(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(CALL)) {
    if (!jaKeys.has(m[1])) problems.push(`[未定義] ${file}: t('${m[1]}') が ja に無い`);
  }
}

// 4. 使われていないキー。
//    **定義しただけで繋いでいない文言を落とす。** キーがあるのに画面が
//    ハードコードされた文字列のまま、という状態が実際に起きていた。
//
//    キーを組み立てて呼ぶ場所があるので、静的に辿れないぶんは接頭辞で許す。
//    **増やすときは「どこが組み立てているか」を必ず書くこと。**
const DYNAMIC_PREFIXES = [
  // constants/categories.ts の categoryLabelKey(id)
  'category.label_',
  // TagManagementModal の ruleLabelKey(rule)
  'tag_modal.label_rule_',
  // FailureTriageModal の KIND_LABEL_KEYS
  'failure_modal.label_kind_',
  // constants/recommendedModels.ts の badgeLabelKey(badge)
  'settings.label_badge_',
];

const allSrc = walkFiles(SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

for (const [key] of jaRows) {
  if (DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
  // `t('...')` だけでなく、文字列リテラルとして渡している箇所も使用とみなす
  // （errorModal.messageKey や METHODS の labelKey / hintKey）
  if (allSrc.includes(`'${key}'`) || allSrc.includes(`"${key}"`)) continue;
  problems.push(
    `[未使用] ${key} を呼んでいる場所が無い\n` +
      '    画面がハードコードされた文字列のままになっていないか確認する'
  );
}

if (problems.length === 0) {
  console.log(`ok — ${jaRows.length}件を検査して問題なし`);
  process.exit(0);
}
console.error(problems.join('\n'));
console.error(`\n${problems.length}件`);
process.exit(1);
