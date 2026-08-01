#!/usr/bin/env node
/**
 * VLM プロンプト回帰チェック / モデル比較
 *
 * プロンプトを改修したら必ず回す。改修前後の両方を同じ画像で流し、
 * **タグ本数 / パース失敗率 / 空文字応答率** を別軸で比較する。
 *
 * `--models a,b` と複数指定するとモデル横断の比較になる。この場合は
 * **タグの質 / 速度 / VRAM / 安定性**の4軸で見る。速度と VRAM を正しく測るため、
 * モデルは1つずつ載せて降ろし、ロードの1回は計測から外す。
 *
 * 本番 (src-tauri/src/llm/ollama.rs, mod.rs) と同じ条件を再現する:
 *   - POST /api/generate, temperature 0.2, num_ctx は recommended_num_ctx 相当
 *   - done_reason="length" かつ response 空 のとき num_ctx を倍増して再試行（上限 32768）
 *   - パース判定は parse_analysis_result と同じ抽出手順 + AnalysisResult と同じ必須フィールド検証
 *
 * 使い方は README.md を参照。
 */

import fs from 'node:fs';
import path from 'node:path';
import { stdin } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allPrompts, loadMultiFrameConfig, resolvePromptVariants } from './prompts.mjs';
import { collectImages } from './images.mjs';
import { pickInteractively } from './pick.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const NUM_CTX_HARD_CAP = 32768;

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const OLLAMA_URL = arg('url', 'http://localhost:11434');
// --models にカンマ区切りで並べるとモデル横断比較になる（embedding-check と同じ呼び方）。
// --model は単数の別名。従来の書き方をそのまま残す。
let MODELS = arg('models', arg('model', 'qwen3-vl:4b'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let MULTI_MODEL = MODELS.length > 1;
// モデルを指定せず、端末から起動されたときは対話で選ばせる。
// このツールはオプションが多く、引数を覚えていないと使えない状態だったため。
const INTERACTIVE =
  has('interactive') ||
  (!has('no-interactive') && !argv.includes('--models') && !argv.includes('--model') && Boolean(stdin.isTTY));
// モデル横断時に、同じ画像に対する各モデルのタグを横並びで出す枚数（0 で無効）。
// タグ本数では質を測れないため、最後は目視で決める必要がある。
const SIDE_BY_SIDE = parseInt(arg('side-by-side', '3'), 10);
const REPEAT = parseInt(arg('repeat', '1'), 10);
let VARIANTS = arg('variants', 'light').split(',').map((s) => s.trim());
// auto / both が使う DETAILED の粒度。未指定なら本番の既定に従う（既定値をここに書かない）
const GRANULARITIES = ['atomic', 'balanced', 'descriptive'];
let GRANULARITY = arg('granularity', null);
const FORMAT_MODE = arg('format-json', 'off'); // off | on | both
const LIMIT = parseInt(arg('limit', '0'), 10);
let SAMPLE = parseInt(arg('sample', '5'), 10); // test_assets/100files から拾う枚数
// 1 なら llm/ollama.rs の単画像経路、2 以上なら batch.rs の動画マルチフレーム経路を再現する
const FRAMES = parseInt(arg('frames', '1'), 10);
// batch.rs の値を上書きして num_predict の影響を測るためのもの（回帰の再現用）
const NUM_PREDICT_OVERRIDE = arg('num-predict', null);

if (has('help')) {
  console.log(fs.readFileSync(path.join(HERE, 'README.md'), 'utf8'));
  process.exit(0);
}

// ---------------------------------------------------------------- パース (本番と同一ロジック)

/** mod.rs parse_analysis_result と同じ抽出手順 */
function extractJsonText(rawResponse) {
  const clean = (rawResponse ?? '').trim();
  if (!clean) return { ok: false, reason: 'empty_response' };

  let jsonStr = clean;
  if (clean.includes('```')) {
    for (const part of clean.split('```')) {
      const p = part.trim();
      if (p.startsWith('json')) {
        jsonStr = p.slice(4).trim();
        break;
      } else if (p.startsWith('{')) {
        jsonStr = p;
        break;
      }
    }
  }
  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  const trimmed = start >= 0 && end >= 0 ? jsonStr.slice(start, end + 1) : jsonStr;
  return { ok: true, text: trimmed };
}

/** AnalysisResult と同じ必須フィールド検証 */
function parseAnalysisResult(rawResponse) {
  const ex = extractJsonText(rawResponse);
  if (!ex.ok) return { ok: false, reason: ex.reason };

  let obj;
  try {
    obj = JSON.parse(ex.text);
  } catch (e) {
    return { ok: false, reason: 'json_syntax_error', detail: String(e.message).slice(0, 120) };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not_an_object' };
  if (!Array.isArray(obj.categories)) return { ok: false, reason: 'missing_categories' };
  if (!obj.categories.every((c) => typeof c === 'string')) return { ok: false, reason: 'categories_not_strings' };
  if (!Array.isArray(obj.tags)) return { ok: false, reason: 'missing_tags' };
  for (const t of obj.tags) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return { ok: false, reason: 'tag_not_object' };
    if (typeof t.en !== 'string' || typeof t.ja !== 'string') return { ok: false, reason: 'tag_missing_en_or_ja' };
  }
  const desc = Array.isArray(obj.descriptive_tags) ? obj.descriptive_tags : [];
  return { ok: true, categories: obj.categories, tags: obj.tags, descriptiveTags: desc };
}

// ---------------------------------------------------------------- Ollama

async function callGenerate(model, prompt, imagesB64, numCtx, useFormatJson, extra = {}) {
  const body = {
    model,
    prompt,
    images: imagesB64,
    stream: false,
    options: { temperature: extra.temperature ?? 0.2, num_ctx: numCtx },
  };
  // num_predict は既定で付けない。thinking の消費分も同じ枠から引かれるため、
  // 上限を切ると答えを書く前に打ち切られる（batch.rs のコメント参照）。
  // 回帰を再現したいときだけ --num-predict で明示する。
  if (extra.numPredict != null) body.options.num_predict = extra.numPredict;
  // format:"json" は過去に空文字応答を起こした経緯があるため既定 off。
  // プロンプト次第で有効になりうるので、条件として切り替えて実測する。
  if (useFormatJson) body.format = 'json';

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama API Error (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * 本番の analyze_with_ctx_escalation と同じ num_ctx 拡張リトライ。
 *
 * **マルチフレーム経路（batch.rs）はこの拡張を持たない。** 忠実に測るため、
 * frames > 1 のときは 1 回だけ呼んで返す（本番に無い救済を効かせると欠陥が隠れる）。
 */
async function analyzeWithEscalation(model, prompt, imagesB64, baseNumCtx, useFormatJson, extra = {}) {
  let numCtx = baseNumCtx;
  let escalations = 0;
  for (;;) {
    const resp = await callGenerate(model, prompt, imagesB64, numCtx, useFormatJson, extra);
    if (extra.noEscalation) return { resp, numCtx, escalations, exhausted: false };
    if (resp.done_reason === 'length' && !(resp.response ?? '').trim()) {
      const next = Math.min(numCtx * 2, NUM_CTX_HARD_CAP);
      if (next > numCtx) {
        numCtx = next;
        escalations++;
        continue;
      }
      return { resp, numCtx, escalations, exhausted: true };
    }
    return { resp, numCtx, escalations, exhausted: false };
  }
}

// ---------------------------------------------------------------- モデルの制御（横断比較用）

/**
 * モデルを VRAM から降ろす。
 *
 * 複数モデルを続けて測るとき、前のモデルが常駐したままだと `/api/ps` の VRAM が混ざり、
 * 空きVRAM次第で後のモデルの速度も変わる。**1モデルずつ載せて降ろす**のが計測の前提。
 */
async function unloadModel(model) {
  try {
    await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch {
    // 降ろせなくても計測は続行できる。VRAM の値が混ざる可能性があるだけ。
  }
}

/**
 * いま常駐しているモデルの VRAM 使用量。降ろした直後・載せる前に呼んでも意味は無い。
 *
 * `others` には**自分以外に常駐しているモデル**が入る。ここが空でないと VRAM も速度も
 * その分を差し引いて読む必要がある（他アプリが Ollama を使っている場合など）。
 * 勝手に降ろすとユーザーの実行中の処理を巻き添えにするので、警告するだけにとどめる。
 */
async function residentSize(model) {
  const ps = await fetch(`${OLLAMA_URL}/api/ps`).then((r) => r.json()).catch(() => null);
  const list = ps?.models ?? [];
  const hit = list.find((m) => m.name === model || m.model === model);
  return {
    sizeVram: hit?.size_vram ?? null,
    sizeTotal: hit?.size ?? null,
    others: list.filter((m) => m !== hit).map((m) => m.name),
  };
}

/**
 * `/api/show` からモデルの素性を取る。
 *
 * `capabilities` に `"thinking"` が含まれるかは特に重要で、`format:"json"` が使えるか否かが
 * ここで決まる（README「format:"json" について」）。パラメータ数と量子化は速度・VRAM の読み方に効く。
 */
async function modelProfile(model) {
  const r = await fetch(`${OLLAMA_URL}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  })
    .then((x) => x.json())
    .catch(() => null);
  const caps = Array.isArray(r?.capabilities) ? r.capabilities : [];
  return {
    capabilities: caps,
    thinking: caps.includes('thinking'),
    parameterSize: r?.details?.parameter_size ?? null,
    quantization: r?.details?.quantization_level ?? null,
  };
}

// ---------------------------------------------------------------- 実行

/**
 * いま実行している内容を、そのまま貼れる1行に戻す。
 *
 * 対話で選んだときは何を選んだのかが引数として残らない。**既定値も省かず全部書く**ので、
 * これを控えておけば同じ計測を再現できるし、結果がどの条件のものかも後から分かる。
 */
function equivalentCommand() {
  const parts = [
    'node tools/prompt-check/run.mjs',
    `--models "${MODELS.join(',')}"`,
    `--variants ${VARIANTS.join(',')}`,
    `--sample ${SAMPLE}`,
    `--repeat ${REPEAT}`,
    `--format-json ${FORMAT_MODE}`,
    `--frames ${FRAMES}`,
    `--limit ${LIMIT}`,
    `--side-by-side ${SIDE_BY_SIDE}`,
    `--url ${OLLAMA_URL}`,
  ];
  if (GRANULARITY) parts.push(`--granularity ${GRANULARITY}`);
  if (NUM_PREDICT_OVERRIDE != null) parts.push(`--num-predict ${NUM_PREDICT_OVERRIDE}`);
  if (has('embed')) parts.push('--embed');
  if (has('no-html')) parts.push('--no-html');
  return parts.join(' ');
}

const pct = (n, d) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}%`);
const ns2s = (n) => (n == null ? null : n / 1e9);
/** 生成トークン数の中央値。速度が強く相関する実測値（`thinking` が 0 でも多いモデルがある） */
const medianEvalCount = (rows) => {
  const v = rows.map((r) => r.evalCount).filter((n) => n != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const gib = (b) => (b == null ? '-' : `${(b / 1024 ** 3).toFixed(1)}GB`);

async function main() {
  const prompts = allPrompts(REPO_ROOT);
  const formatModes = FORMAT_MODE === 'both' ? [false, true] : FORMAT_MODE === 'on' ? [true] : [false];

  const allVariantNames = Object.keys(prompts).filter((k) => k !== '_meta');
  // auto / both / all は実在の variant ではなく、実行時に展開される指定
  const META_VARIANTS = ['auto', 'both', 'all'];
  const unknown = VARIANTS.filter((v) => !META_VARIANTS.includes(v) && !prompts[v]);
  if (unknown.length) {
    console.error(`未知の variant: ${unknown.join(', ')}`);
    console.error(`利用可能: ${allVariantNames.join(', ')}, ${META_VARIANTS.join(', ')}`);
    process.exit(1);
  }
  // 不正な粒度は既定に落とさず止める。黙って別の条件を測るのが一番まずい
  if (GRANULARITY && !GRANULARITIES.includes(GRANULARITY)) {
    console.error(`未知の粒度: ${GRANULARITY}\n利用可能: ${GRANULARITIES.join(', ')}（未指定なら本番の既定）`);
    process.exit(1);
  }

  const tagsRes = await fetch(`${OLLAMA_URL}/api/tags`).then((r) => r.json()).catch(() => null);
  if (!tagsRes) {
    console.error(`Ollama (${OLLAMA_URL}) に接続できません。起動しているか確認してください。`);
    process.exit(1);
  }
  const names = tagsRes.models.map((m) => m.name);

  if (INTERACTIVE) {
    const picked = await pickInteractively(
      OLLAMA_URL,
      Object.keys(prompts).filter((k) => k !== '_meta'),
      { variants: VARIANTS, sample: SAMPLE }
    );
    if (!picked) {
      console.log('\n中止しました。');
      return;
    }
    MODELS = picked.models;
    MULTI_MODEL = MODELS.length > 1;
    VARIANTS = picked.variants;
    SAMPLE = picked.sample;
    GRANULARITY = picked.granularity ?? GRANULARITY;
  }

  // 1つでも欠けていたら走り出す前に止める。長時間回したあとで気付くと計測をやり直すことになる。
  const missing = MODELS.filter((m) => !names.includes(m));
  if (missing.length) {
    console.error(`モデルが Ollama にありません: ${missing.join(', ')}\n利用可能: ${names.join(', ')}`);
    process.exit(1);
  }
  const profiles = Object.fromEntries(
    await Promise.all(MODELS.map(async (m) => [m, await modelProfile(m)]))
  );

  const generatedDir = path.join(HERE, 'generated-images');
  let images = collectImages(REPO_ROOT, generatedDir, SAMPLE);
  if (LIMIT > 0) images = images.slice(0, LIMIT);
  if (!images.length) {
    console.error('検証対象の画像がありません。test_assets/ に画像を置いてください。');
    process.exit(1);
  }

  // frames > 1 は動画マルチフレーム経路（batch.rs）の再現。連続する画像をひと組にして送る。
  const multiFrame = FRAMES > 1 ? loadMultiFrameConfig(REPO_ROOT) : null;
  const units = [];
  for (let i = 0; i + FRAMES <= images.length; i += FRAMES) {
    const set = images.slice(i, i + FRAMES);
    units.push({
      images: set,
      name: set.map((s) => s.name).join('+').slice(0, 26),
      group: set[0].group,
      // HTML レポートから画像を参照するため、リポジトリ相対で持たせる（生成画像も test_assets も配下）
      paths: set.map((s) => path.relative(REPO_ROOT, s.path).replace(/\\/g, '/')),
    });
  }
  if (!units.length) {
    console.error(`画像が ${images.length} 枚しかなく、frames=${FRAMES} の組を作れません。--sample を増やしてください。`);
    process.exit(1);
  }

  // auto / both はモデルごとに違う variant になる。判定は本番の Rust に聞いて確定させる
  const needAuto = VARIANTS.includes('auto');
  const needBoth = VARIANTS.includes('both');
  if (needAuto || needBoth) console.log('\n本番の判定を取得中 (cargo test resolve_prompt_selection) ...');
  const auto = needAuto ? resolvePromptVariants(REPO_ROOT, MODELS, { granularity: GRANULARITY }) : null;
  const both = needBoth
    ? resolvePromptVariants(REPO_ROOT, MODELS, { forceDetailed: true, granularity: GRANULARITY })
    : null;
  const selection =
    needAuto || needBoth
      ? {
          source: 'cargo test --release resolve_prompt_selection -- --ignored',
          byModel: Object.fromEntries(MODELS.map((m) => [m, (auto ?? both).byModel.get(m)])),
        }
      : null;

  const planned = new Map(
    MODELS.map((m) => {
      const out = [];
      for (const v of VARIANTS) {
        if (v === 'auto') out.push(auto.byModel.get(m).variant);
        else if (v === 'both') out.push('light', both.byModel.get(m).variant);
        else if (v === 'all') out.push(...allVariantNames);
        else out.push(v);
      }
      return [m, [...new Set(out)]];
    })
  );

  // 本番が返した本文と、prompts.mjs が抽出した本文を1文字ずつ突き合わせる。
  // ズレていれば抽出側（とくに descriptive_rules_section のミラー）が本番と乖離している
  for (const src of [auto, both]) {
    for (const [variant, body] of src?.bodies ?? []) {
      const local = prompts[variant]?.prompt;
      if (local == null || local === body) continue;
      let at = 0;
      while (at < local.length && at < body.length && local[at] === body[at]) at++;
      console.log(
        `  [警告] ${variant} のプロンプトが本番と一致しません（${at} 文字目から / 本番 ${body.length} 文字 / 抽出 ${local.length} 文字）\n` +
          `         本番: ${JSON.stringify(body.slice(at, at + 60))}\n` +
          `         抽出: ${JSON.stringify(local.slice(at, at + 60))}\n` +
          '         prompts.mjs の抽出を直すこと。このまま測ると本番と違うものを測ることになる。'
      );
    }
  }

  const cells = [...planned.values()].reduce((s, v) => s + v.length, 0) * formatModes.length * units.length * REPEAT;
  console.log(`\n=== VLM ${MULTI_MODEL ? 'モデル比較' : 'プロンプト回帰チェック'} ===`);
  for (const m of MODELS) {
    const pf = profiles[m];
    const spec = [pf.parameterSize, pf.quantization].filter(Boolean).join(' ');
    console.log(`model     : ${m}${spec ? ` (${spec})` : ''}${pf.thinking ? ' [thinking]' : ''}`);
  }
  console.log(`variants  : ${VARIANTS.join(', ')}`);
  if (selection) {
    // 本番のコードが返した判定をそのまま見せる。何を測っているのか隠さない
    console.log(`  本番の判定 (mod.rs get_vlm_prompt_info を cargo test 経由で実行):`);
    for (const m of MODELS) {
      const size = selection.byModel[m]?.paramSize;
      console.log(`    ${m} (${size == null ? '名前から読めず' : `${size}B`}) -> ${planned.get(m).join(', ')}`);
    }
  }
  console.log(`format    : ${formatModes.map((f) => (f ? 'json' : 'none')).join(', ')}`);
  console.log(`images    : ${images.length} 枚 (sparse ${images.filter((i) => i.group === 'sparse').length} 枚を含む)`);
  console.log(`repeat    : ${REPEAT}`);
  if (multiFrame) {
    console.log(`frames    : ${FRAMES} 枚/回 -> ${units.length} 組（batch.rs 経路: temperature ${multiFrame.temperature}, num_ctx ${multiFrame.numCtx}, num_ctx 拡張なし）`);
    console.log(`num_predict: ${NUM_PREDICT_OVERRIDE ?? multiFrame.numPredict ?? '無指定'}`);
  }
  // ウォームアップはモデルごとに1回。計測には入れないが実行時間には乗る
  console.log(`calls     : ${cells} (+ ウォームアップ ${MODELS.length})\n`);

  const b64 = new Map();
  const results = [];
  const modelStats = {};

  const loadB64 = (unit) => {
    for (const one of unit.images) {
      if (!b64.has(one.path)) b64.set(one.path, fs.readFileSync(one.path).toString('base64'));
    }
    return unit.images.map((one) => b64.get(one.path));
  };

  // モデルは1つずつ載せて降ろす。並べて常駐させると VRAM も速度も互いに影響し合う。
  for (const model of MODELS) {
    const first = prompts[planned.get(model)[0]];
    const warmPrompt = multiFrame ? first.prompt + multiFrame.note : first.prompt;
    const warmCtx = multiFrame ? multiFrame.numCtx : first.numCtx;

    // ウォームアップ。**この1回を計測に混ぜない。** 初回呼び出しにはモデルのロード時間が
    // 乗るため、混ぜるとモデルが大きいほど不当に遅く見える。ロード時間は別軸として記録する。
    let loadMs = null;
    try {
      const t0 = Date.now();
      const warm = await callGenerate(model, warmPrompt, loadB64(units[0]), warmCtx, false, {
        temperature: multiFrame ? multiFrame.temperature : undefined,
      });
      loadMs = ns2s(warm.load_duration) != null ? ns2s(warm.load_duration) * 1000 : Date.now() - t0;
    } catch (e) {
      console.error(`  [警告] ${model} のウォームアップに失敗: ${String(e.message).slice(0, 120)}`);
    }
    const size = await residentSize(model);
    modelStats[model] = { ...profiles[model], loadMs, ...size };
    if (size.others.length) {
      console.log(
        `  [警告] 他のモデルが常駐しています: ${size.others.join(', ')}\n` +
          `         VRAM と速度がその分の影響を受けます。厳密に測るなら他の利用を止めてから回してください。`
      );
    }
    if (MULTI_MODEL) {
      console.log(
        `### ${model}  VRAM ${gib(size.sizeVram)}${
          size.sizeTotal && size.sizeVram !== size.sizeTotal ? ` / 常駐計 ${gib(size.sizeTotal)}` : ''
        }  ロード ${loadMs == null ? '-' : (loadMs / 1000).toFixed(1)}s\n`
      );
    }

    for (const variant of planned.get(model)) {
      const p = prompts[variant];
      const label = multiFrame ? `${p.label} + マルチフレーム注記` : p.label;
      const prompt = multiFrame ? p.prompt + multiFrame.note : p.prompt;
      const numCtx = multiFrame ? multiFrame.numCtx : p.numCtx;
      const extra = multiFrame
        ? {
            temperature: multiFrame.temperature,
            numPredict: NUM_PREDICT_OVERRIDE != null ? Number(NUM_PREDICT_OVERRIDE) : multiFrame.numPredict,
            noEscalation: true,
          }
        : {};
      for (const useFormatJson of formatModes) {
        const condId = `${MULTI_MODEL ? `${model} ` : ''}${variant}${useFormatJson ? '+fmt' : ''}${
          multiFrame ? `+f${FRAMES}` : ''
        }`;
        console.log(`--- ${condId}: ${label}${useFormatJson ? ' [format:"json"]' : ''} (num_ctx ${numCtx}) ---`);

        for (const img of units) {
          const imagesB64 = loadB64(img);
          for (let rep = 0; rep < REPEAT; rep++) {
            const t0 = Date.now();
            const row = {
              model, variant, formatJson: useFormatJson, cond: condId,
              image: img.name, group: img.group, rep,
              elapsedMs: 0, parseOk: false, failReason: null,
              tagCount: 0, descCount: 0, categoryCount: 0, tags: [], descriptiveTags: [],
              numCtx, escalations: 0, doneReason: null, thinkingChars: 0, rawSample: null,
              // Ollama 自身の計測値。壁時計と違いロード・プロンプト評価・生成を分離できる
              loadMs: null, promptEvalCount: null, promptEvalMs: null, evalCount: null, evalMs: null,
            };
            try {
              const r = await analyzeWithEscalation(model, prompt, imagesB64, numCtx, useFormatJson, extra);
              row.elapsedMs = Date.now() - t0;
              row.numCtx = r.numCtx;
              row.escalations = r.escalations;
              row.doneReason = r.resp.done_reason ?? null;
              row.thinkingChars = (r.resp.thinking ?? '').length;
              row.loadMs = ns2s(r.resp.load_duration) * 1000 || 0;
              row.promptEvalCount = r.resp.prompt_eval_count ?? null;
              row.promptEvalMs = ns2s(r.resp.prompt_eval_duration) * 1000 || null;
              row.evalCount = r.resp.eval_count ?? null;
              row.evalMs = ns2s(r.resp.eval_duration) * 1000 || null;

              if (r.exhausted) {
                row.failReason = 'context_exhausted';
              } else {
                const p = parseAnalysisResult(r.resp.response);
                if (p.ok) {
                  Object.assign(row, {
                    parseOk: true,
                    tagCount: p.tags.length,
                    descCount: p.descriptiveTags.length,
                    categoryCount: p.categories.length,
                    tags: p.tags.map((t) => `${t.en}/${t.ja}`),
                    descriptiveTags: p.descriptiveTags.map((t) => `${t.en}/${t.ja}`),
                  });
                } else {
                  row.failReason = p.reason;
                  row.rawSample = (r.resp.response ?? '').trim().slice(0, 300);
                }
              }
            } catch (e) {
              row.elapsedMs = Date.now() - t0;
              row.failReason = 'request_error';
              row.rawSample = String(e.message).slice(0, 200);
            }

            results.push(row);
            const status = row.parseOk
              ? `OK  tags=${String(row.tagCount).padStart(2)}${row.descCount ? `+desc${row.descCount}` : ''}`
              : `NG  ${row.failReason}`;
            console.log(
              `  ${img.name.padEnd(26)} ${String((row.elapsedMs / 1000).toFixed(1)).padStart(6)}s  ${status}` +
                (row.escalations ? `  (num_ctx x${row.escalations} -> ${row.numCtx})` : '')
            );
          }
        }
        console.log('');
      }
    }

    // 次のモデルの計測を汚さないよう必ず降ろす（最後のモデルも VRAM を返す）
    if (MULTI_MODEL) await unloadModel(model);
  }

  // ------------------------------------------------------------ 集計

  console.log('\n================ 集計 ================\n');
  const conds = [...new Set(results.map((r) => r.cond))];
  const header = ['条件', '試行', 'パース失敗', '空文字応答', 'タグ<3', 'タグ数 中央値', 'min/max', '平均秒'];
  const rows = conds.map((c) => {
    const rs = results.filter((r) => r.cond === c);
    const ok = rs.filter((r) => r.parseOk);
    const empty = rs.filter((r) => r.failReason === 'empty_response');
    const under3 = ok.filter((r) => r.tagCount < 3);
    const counts = ok.map((r) => r.tagCount).sort((a, b) => a - b);
    return [
      c,
      String(rs.length),
      `${rs.length - ok.length} (${pct(rs.length - ok.length, rs.length)})`,
      `${empty.length} (${pct(empty.length, rs.length)})`,
      `${under3.length} (${pct(under3.length, ok.length)})`,
      counts.length ? String(counts[Math.floor(counts.length / 2)]) : '-',
      counts.length ? `${counts[0]}/${counts[counts.length - 1]}` : '-',
      (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1),
    ];
  });
  const printTable = (hd, rs) => {
    const w = hd.map((h, i) => Math.max(h.length, ...rs.map((r) => r[i].length)));
    const line = (cs) => cs.map((c, i) => c.padEnd(w[i])).join('  ');
    console.log(line(hd));
    console.log(w.map((x) => '-'.repeat(x)).join('  '));
    rs.forEach((r) => console.log(line(r)));
  };
  printTable(header, rows);

  // ------------------------------------------------------------ モデル別（横断比較のときだけ）

  if (MULTI_MODEL) {
    console.log('\n--- モデル別 ---\n');
    const mh = ['モデル', 'パラメータ', 'VRAM', 'ロード秒', '生成トークン', '生成tok/s', 'パース失敗', '空文字応答', 'タグ数 中央値', '平均秒'];
    const mrows = MODELS.map((m) => {
      const rs = results.filter((r) => r.model === m);
      const ok = rs.filter((r) => r.parseOk);
      const empty = rs.filter((r) => r.failReason === 'empty_response');
      const counts = ok.map((r) => r.tagCount).sort((a, b) => a - b);
      // 壁時計ではなく Ollama の eval_duration で出す。ロード時間もプロンプト評価も混ざらない
      const evalRows = rs.filter((r) => r.evalCount && r.evalMs);
      const toks = evalRows.reduce((s, r) => s + r.evalCount, 0);
      const ms = evalRows.reduce((s, r) => s + r.evalMs, 0);
      const st = modelStats[m] ?? {};
      return [
        m,
        st.parameterSize ?? '-',
        gib(st.sizeVram),
        st.loadMs == null ? '-' : (st.loadMs / 1000).toFixed(1),
        String(medianEvalCount(ok) ?? '-'),
        ms ? (toks / (ms / 1000)).toFixed(1) : '-',
        `${rs.length - ok.length} (${pct(rs.length - ok.length, rs.length)})`,
        `${empty.length} (${pct(empty.length, rs.length)})`,
        counts.length ? String(counts[Math.floor(counts.length / 2)]) : '-',
        (rs.reduce((s, r) => s + r.elapsedMs, 0) / rs.length / 1000).toFixed(1),
      ];
    });
    printTable(mh, mrows);

    // 生成トークン数は実測値そのもの。**なぜ増えるのかは別の話**なので、ここでは断定しない。
    // 分かっているのは「同じタグ数でも桁が違う」ことと「速度がこれに強く相関する」ことまで。
    const floors = MODELS.map((m) => medianEvalCount(results.filter((r) => r.model === m && r.parseOk))).filter(
      (v) => v != null
    );
    console.log('\n  平均秒はロード後の壁時計（ウォームアップの1回は含まない）。');
    console.log('  VRAM は各モデルを単独で常駐させたときの値。');
    if (floors.length > 1) {
      console.log(
        `  生成トークンはこの計測での最小が ${Math.min(...floors)}。同じタグ数でも桁が違い、速度はここに強く相関する。` +
          '\n  ただし**増える理由は未確認**（生成の中身か、トークナイザ効率かを区別できていない）。'
      );
    }
    console.log('  **タグの質はこの表では決まらない。** 下の横並びを必ず目視すること。');
  }

  console.log('\n--- 画像グループ別 タグ<3 率 ---');
  const groups = [...new Set(results.map((r) => r.group))];
  // モデル名が入ると条件名が長くなるので、固定幅ではなく実際の見出し長から決める
  printTable(
    ['group', ...conds],
    groups.map((g) => [
      g,
      ...conds.map((c) => {
        const ok = results.filter((r) => r.group === g && r.cond === c && r.parseOk);
        const u = ok.filter((r) => r.tagCount < 3);
        return `${u.length}/${ok.length} ${pct(u.length, ok.length)}`;
      }),
    ])
  );

  const fails = results.filter((r) => !r.parseOk);
  if (fails.length) {
    console.log('\n--- 失敗の内訳 ---');
    const by = {};
    for (const f of fails) by[`${f.cond} / ${f.failReason}`] = (by[`${f.cond} / ${f.failReason}`] || 0) + 1;
    Object.entries(by).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}件`));
    console.log('\n  代表的な生レスポンス:');
    fails.filter((f) => f.rawSample).slice(0, 3)
      .forEach((f) => console.log(`  [${f.cond} ${f.image}] ${JSON.stringify(f.rawSample).slice(0, 250)}`));
  }

  // ------------------------------------------------------------ 横並び（目視用）

  // タグ本数・失敗率はモデルの「安定性」しか語らない。**どちらのタグが使えるかは目で見るしかない。**
  // 同じ画像に対する各モデルの出力を並べる。条件は最初の variant / format に固定する
  // （条件を混ぜて並べると、モデルの差なのか条件の差なのか読めなくなる）。
  if (MULTI_MODEL && SIDE_BY_SIDE > 0) {
    const baseFormat = formatModes[0];
    // auto ではモデルごとに variant が違う。各モデルの1つ目を使う
    const baseOf = (m) => planned.get(m)[0];
    const shown = [...new Set(MODELS.map(baseOf))].join(' / ');
    console.log(`\n--- 同一画像に対するタグの横並び（${shown}${baseFormat ? ' + format:"json"' : ''} / rep 0） ---`);
    for (const img of units.slice(0, SIDE_BY_SIDE)) {
      console.log(`\n[${img.name}] (${img.group})`);
      for (const m of MODELS) {
        const r = results.find(
          (x) => x.model === m && x.image === img.name && x.variant === baseOf(m) &&
                 x.formatJson === baseFormat && x.rep === 0
        );
        const tag = MODELS.some((o) => baseOf(o) !== baseOf(m)) ? `${m} [${baseOf(m)}]` : m;
        if (!r) {
          console.log(`  ${tag.padEnd(22)} -`);
        } else if (!r.parseOk) {
          console.log(`  ${tag.padEnd(22)} NG ${r.failReason}`);
        } else {
          console.log(`  ${tag.padEnd(22)} ${r.tags.join(', ')}`);
          if (r.descriptiveTags.length) console.log(`  ${' '.repeat(22)} desc: ${r.descriptiveTags.join(', ')}`);
        }
      }
    }
    if (units.length > SIDE_BY_SIDE) {
      console.log(`\n  （${units.length} 組中 ${SIDE_BY_SIDE} 組のみ表示。--side-by-side で増やせる。全件は results/ の JSON にある）`);
    }
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stem = MULTI_MODEL ? `compare-${MODELS.length}models` : MODELS[0].replace(/[:\\/]/g, '_');
  const out = path.join(outDir, `${stem}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({
    model: MODELS[0], models: MODELS, modelStats, variants: VARIANTS, formatModes, repeat: REPEAT,
    variantsByModel: Object.fromEntries(planned), promptSelection: selection,
    command: equivalentCommand(),
    frames: FRAMES, multiFrame, numPredictOverride: NUM_PREDICT_OVERRIDE,
    units: units.map((u) => ({ name: u.name, group: u.group, paths: u.paths })),
    promptMeta: prompts._meta, ranAt: new Date().toISOString(), results,
  }, null, 2));
  console.log(`\n生データ: ${path.relative(REPO_ROOT, out)}`);

  // コンソールは計測しながら眺めるためのもので、後から人が判断する形にはなっていない。
  // 既定で HTML も出す（計測はやり直さないので、見せ方だけ変えたいときは report.mjs を単体で回す）
  if (!has('no-html')) {
    const { buildReport } = await import('./report.mjs');
    const htmlPath = buildReport(out, { embed: has('embed') });
    console.log(`レポート: ${path.relative(REPO_ROOT, htmlPath)}`);
    console.log(`  ${pathToFileURL(htmlPath).href}`);
  }

  // 対話で選んだ内容も含めて、この実行を再現する1行を最後に出す
  console.log(`\nこの実行を再現するコマンド:\n  ${equivalentCommand()}\n`);
}

main().catch((e) => {
  console.error('\n[FATAL]', e);
  process.exit(1);
});
