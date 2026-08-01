/**
 * 対話式のモデル選択。
 *
 * このツールはオプションが多く、**引数を覚えていないと使えない**状態だった。
 * 引数なしで起動したときは、Ollama に入っているモデルを並べて番号で選ばせる。
 *
 * 選んだ内容は最後に「同じことをする引数」として表示する。次からは直接叩けるようにするため
 * （対話を覚える必要も、引数を覚える必要も無い状態にする）。
 */

import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * Ollama にあるモデルを capabilities 付きで取る。
 *
 * **`vision` を宣言していても安定して使えるとは限らない。** 2026-07-30 の実測では `gemma4:e4b` が
 * 宣言ありで成否をばらついた（同一12枚で LIGHT 6/12・DETAILED atomic 1/12 成功）。
 * 宣言は「候補に出す」根拠にしかならない。
 */
export async function listModels(ollamaUrl) {
  const tags = await fetch(`${ollamaUrl}/api/tags`).then((r) => r.json());
  const models = await Promise.all(
    tags.models.map(async (m) => {
      const s = await fetch(`${ollamaUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.name }),
      })
        .then((x) => x.json())
        .catch(() => null);
      const caps = Array.isArray(s?.capabilities) ? s.capabilities : [];
      return {
        name: m.name,
        vision: caps.includes('vision'),
        thinking: caps.includes('thinking'),
        parameterSize: s?.details?.parameter_size ?? null,
        // ディスク上のサイズ。VRAM の目安になる（実際の常駐量は計測時に /api/ps で取る）
        bytes: m.size ?? null,
      };
    })
  );
  return models;
}

/** パラメータ数の文字列（"4.4B" / "566.70M"）を数値に均す。小さい順に並べるためだけに使う */
function paramNum(s) {
  if (!s) return Infinity;
  const m = /^([\d.]+)\s*([BM])/i.exec(s);
  if (!m) return Infinity;
  return Number(m[1]) * (m[2].toUpperCase() === 'B' ? 1e9 : 1e6);
}

/** "1 3 5" / "1,3,5" / "1-3" / "all" を番号の配列にする */
function parseSelection(input, max) {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === 'all' || s === 'a') return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set();
  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      for (let i = a; i <= b; i++) if (i >= 1 && i <= max) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n >= 1 && n <= max) out.add(n);
    } else {
      return 'invalid';
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : 'invalid';
}

const gib = (b) => (b == null ? '-' : `${(b / 1024 ** 3).toFixed(1)}GB`);

/**
 * モデル一覧を端末に収まる形で出す。
 *
 * 一覧が端末の高さを超えると**先頭の番号が流れて見えなくなる**（入力する時点で 1〜8 が
 * 画面外にある、という状態になっていた）。行数が足りなければ多段組みにして畳む。
 * `hf.co/...` 系は名前が 50 字を超えるので、幅に合わせて省略する（選ぶのは番号なので支障はない）。
 */
function printModelList(models) {
  const termRows = stdout.rows || 24;
  const termCols = stdout.columns || 100;
  // 見出し・注記・入力行・余白に使う分を引いた残りが一覧に使える行数
  const avail = Math.max(4, termRows - 9);
  const nCols = Math.max(1, Math.ceil(models.length / avail));
  const perCol = Math.ceil(models.length / nCols);
  const usable = Math.max(20, termCols - 2);
  const colWidth = Math.floor((usable - 2 * (nCols - 1)) / nCols);

  // メタ情報は必ず同じ幅にする。thinking の有無で長さが変わると名前の列がずれる
  const meta = (m) =>
    nCols === 1
      ? `${(m.parameterSize ?? '-').padStart(7)}  ${gib(m.bytes).padStart(7)}  ${(m.thinking ? 'thinking' : '').padEnd(8)}`
      : `${(m.parameterSize ?? '-').padStart(6)}${m.thinking ? '*' : ' '}`;

  // セルの実体は "NN " + 名前 + "  " + メタ。この 5 文字分を引かないと colWidth をはみ出し、
  // padEnd が効かなくなって列がずれる
  const room = Math.max(3, colWidth - 5 - meta(models[0]).length);
  // 収まらないときは `hf.co/<org>/` を落として末尾を残す。頭を残すと
  // `hf.co/unslo…` が複数並んで見分けが付かなくなる（区別が付くのは末尾側）
  const names = models.map((m) => {
    if (m.name.length <= room) return m.name;
    const tail = m.name.slice(m.name.lastIndexOf('/') + 1);
    if (tail.length <= room) return `…${tail}`.slice(0, room);
    return `${tail.slice(0, room - 1)}…`;
  });
  // 名前の列は一番長い名前に合わせる（端末幅いっぱいに広げると数値が遠くて読めない）
  const nameW = Math.max(...names.map((n) => n.length));
  const cells = models.map((m, i) => `${String(i + 1).padStart(2)} ${names[i].padEnd(nameW)}  ${meta(m)}`.trimEnd());

  for (let r = 0; r < perCol; r++) {
    const line = [];
    for (let c = 0; c < nCols; c++) {
      const idx = c * perCol + r;
      if (idx < models.length) line.push(cells[idx].padEnd(colWidth));
    }
    console.log(`  ${line.join('  ').trimEnd()}`);
  }
  if (nCols > 1) console.log('\n  * = thinking 対応');
}

/**
 * 質問の入出力。
 *
 * 端末なら readline をそのまま使う。**端末でないときは先に全部読む**。
 * readline は stdin が EOF に達すると閉じるため、パイプで答えを流し込むと
 * 2問目以降が `ERR_USE_AFTER_CLOSE` で落ちる（`--interactive` の検証で踏んだ）。
 */
async function makeAsker() {
  if (stdin.isTTY) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    return { ask: (q) => rl.question(q), close: () => rl.close() };
  }
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  let i = 0;
  return {
    ask: async (q) => {
      const v = lines[i++] ?? '';
      stdout.write(`${q}${v}\n`); // 何に答えたのかログに残す
      return v;
    },
    close: () => {},
  };
}

/**
 * 対話で実行内容を決める。
 * @returns {{models:string[], variants:string[], sample:number}}
 */
export async function pickInteractively(ollamaUrl, variantNames, defaults) {
  const io = await makeAsker();
  const ask = async (q, def) => {
    const a = (await io.ask(def ? `${q} [既定 ${def}]: ` : `${q}: `)).trim();
    return a || String(def ?? '');
  };

  try {
    console.log('\n=== VLM プロンプト回帰チェック / モデル比較 ===\n');
    console.log('  1) モデルを比較する    — どのモデルを使うか決めたいとき');
    console.log('  2) プロンプトを比べる  — プロンプトを改修したとき（従来の回帰チェック）\n');
    const mode = await ask('やること', '1');

    const all = await listModels(ollamaUrl);
    const vision = all.filter((m) => m.vision).sort((a, b) => paramNum(a.parameterSize) - paramNum(b.parameterSize));
    if (!vision.length) {
      console.log('\nvision 対応モデルが Ollama にありません。');
      return null;
    }

    // 一覧を画面の先頭から出す。手前の問答が残っていると、その分だけ一覧が上へ流れる
    if (stdin.isTTY) console.clear();
    // 注記は一覧より前に置く。一覧と入力欄を隣り合わせにしておかないと番号を見ながら打てない
    console.log('\n  ※ vision 宣言があっても安定して使えるとは限らない（実例: gemma4:e4b は成否がばらつく）。そこもこの計測で分かる。');
    console.log('\nOllama にある vision 対応モデル（小さい順）:\n');
    printModelList(vision);
    console.log('');

    const multi = mode !== '2';
    let models;
    for (;;) {
      const hint = multi ? '番号を複数（例: 1 3 5 / 1-3 / all）' : '番号をひとつ';
      const input = await ask(`比較するモデル — ${hint}`, multi ? '1-3' : '1');
      const sel = parseSelection(input, vision.length);
      if (sel && sel !== 'invalid') {
        models = sel.map((n) => vision[n - 1].name);
        if (!multi) models = models.slice(0, 1);
        break;
      }
      console.log('  入力を読めませんでした。番号かカンマ区切り、範囲、all で指定してください。');
    }

    /** プロンプトを一覧から番号で選ばせる */
    const pickFromList = async (def) => {
      console.log('\n比べるプロンプト:\n');
      variantNames.forEach((v, i) => console.log(`  ${String(i + 1).padStart(2)}  ${v}`));
      const input = await ask('\n番号を複数', def);
      const sel = parseSelection(input, variantNames.length);
      return sel && sel !== 'invalid' ? sel.map((n) => variantNames[n - 1]) : null;
    };

    /**
     * DETAILED の粒度。`auto` / `both` のときだけ意味を持つ。
     * **既定値をここに書かない**（未指定なら本番の `TagGranularity::default()` に従う）。
     */
    const askGranularity = async () => {
      console.log('\nDETAILED の粒度は?\n');
      console.log('  1) 本番の既定のまま');
      console.log('  2) atomic       — 分解重視。descriptive タグを出さない');
      console.log('  3) balanced     — 基本語 + descriptive 1〜3個');
      console.log('  4) descriptive  — 基本語 + descriptive 3〜6個');
      const g = await ask('\n選択', '1');
      return { 2: 'atomic', 3: 'balanced', 4: 'descriptive' }[g] ?? null;
    };

    let variants = defaults.variants;
    let granularity = null;
    if (multi) {
      // 本番はモデルごとに LIGHT / DETAILED を選ぶ。何を測りたいのかで揃え方が変わる
      console.log('\nどのプロンプトで比べる?\n');
      console.log('  1) LIGHT で揃える  — モデルの素の実力を同条件で見る');
      console.log('  2) 本番と同じ判定  — 実際に使ったときどうなるか（モデルごとに LIGHT/DETAILED）');
      console.log('  3) LIGHT と DETAILED の両方');
      console.log('  4) 全パターン      — LIGHT + DETAILED の粒度3種。目を付けたモデルを絞り込むとき');
      console.log('  5) 一覧から選ぶ    — 特定のプロンプトで揃える');
      const a = await ask('\n選択', '1');
      if (a === '2' || a === '3') {
        variants = a === '2' ? ['auto'] : ['both'];
        granularity = await askGranularity();
      } else if (a === '4') variants = ['all'];
      else if (a === '5') variants = (await pickFromList('1')) ?? ['light'];
      else variants = ['light'];
    } else {
      variants = (await pickFromList('1')) ?? variants;
    }

    const sample = parseInt(await ask('\n検証する画像の枚数', defaults.sample), 10) || defaults.sample;

    // 一覧では名前を省略していることがあるので、確定前に全名を出す
    console.log(`\n  選んだモデル: ${models.join(', ')}`);

    // auto / both / all は実行時に展開される。**何本流れるのかを名前で見せる。**
    // 「プロンプト 4」とだけ出しても、その4本が何なのかは読み取れない
    const expanded =
      variants.flatMap((v) =>
        v === 'all'
          ? variantNames
          : v === 'both'
          ? ['light', `DETAILED (${granularity ?? '本番の既定'})`]
          : v === 'auto'
          ? [`モデルごとに本番の判定 (DETAILED なら ${granularity ?? '本番の既定'})`]
          : [v]
      ) ?? [];
    console.log(`  プロンプト: ${expanded.join(', ')}`);

    // 何回叩くのかを先に見せる。1回あたり数秒〜数十秒かかるので、規模を知らずに走らせない
    const nPrompts = expanded.length;
    const calls = models.length * nPrompts * (sample + 4);
    console.log(`  モデル ${models.length} × プロンプト ${nPrompts} × 画像 約${sample + 4}枚 = 約 ${calls} 回の呼び出し`);
    const go = await ask('  実行する? (y/n)', 'y');
    if (!/^y/i.test(go)) return null;

    // 同じことをする引数は run.mjs が最後にまとめて出す（対話で選んだ分も含めて全オプション）
    return { models, variants, sample, granularity };
  } finally {
    io.close();
  }
}
