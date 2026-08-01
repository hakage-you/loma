/**
 * VLM プロンプトの取得。
 *
 * 重要: プロンプト本文をこのファイルにコピーしない。必ず
 * `src-tauri/src/llm/mod.rs` から実物を抽出する。コピーを持つと必ず乖離し、
 * 「テストは通るが本番と違うものを測っていた」という最悪の失敗をする。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * `pub const NAME: &str = r#"..."#;` / `const NAME: &str = r#"..."#;` を抽出する。
 *
 * CRLF -> LF の正規化は必須。mod.rs は CRLF で保存されているが、**Rust は文字列リテラル
 * （生文字列リテラルを含む）内の CRLF を LF に正規化する**ため、実行時のプロンプトは LF のみ。
 * ここで正規化しないと、本番と1バイト単位で違うプロンプトを測ることになる。
 */
function extractRawConst(src, name) {
  const re = new RegExp(`(?:pub\\s+)?const\\s+${name}\\s*:\\s*&str\\s*=\\s*r#"`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} を mod.rs から抽出できませんでした`);
  const start = m.index + m[0].length;
  const end = src.indexOf('"#;', start);
  if (end < 0) throw new Error(`const ${name} の終端 ("#;) が見つかりません`);
  return src.slice(start, end).replace(/\r\n/g, '\n');
}

/**
 * `descriptive_rules_section` だけは format! マクロなので生文字列として抽出できない。
 * JS 側にミラーを置き、Rust 側が変わったら気付けるようハッシュで見張る（乖離防止ではなく乖離検知）。
 */
const DESCRIPTIVE_SECTION_FN_SHA256 = 'AUTO';

function mirrorDescriptiveRulesSection(min, max) {
  return (
    `# Rules for "descriptive_tags"\n` +
    `- Output ${min} to ${max} descriptive compound tags. Do NOT stop at the minimum: use as many as the scene genuinely supports, up to the maximum, by covering DIFFERENT aspects of the image (e.g. one for the main subject's state/action, one for a background/environmental element, one for lighting/weather/time of day, one for a secondary object's material/condition). Only fall short of the maximum if the image truly lacks that many distinct describable aspects.\n` +
    `- Each descriptive tag MUST combine a modifier (state, condition, material, weather, time of day, or color) with a subject noun visible in the scene. Examples: "rain_soaked_tree", "sunset_beach", "snow_covered_road".\n` +
    `- These are IN ADDITION to "tags". NEVER omit an atomic tag from "tags" just because it also appears inside a descriptive tag.\n` +
    `- Do NOT put bare nouns here. Every entry must contain a modifier.\n` +
    `- Each tag MUST be an object containing "en" (lowercase snake_case English) and "ja" (a natural Japanese phrase).`
  );
}

/**
 * 動画マルチフレーム解析（`batch.rs` の `analyze_multi_frame_with_ollama`）の条件を抽出する。
 *
 * この経路は `llm/ollama.rs` の本流とは**別実装**で、温度も num_ctx も違い、num_ctx の
 * 拡張リトライも持たない。ここを覆っていなかったために `format:"json"` と `num_predict`
 * の欠陥が本流の修正から取り残された（2026-07-30）。値は必ず batch.rs から抽出する。
 */
export function loadMultiFrameConfig(repoRoot) {
  const src = fs.readFileSync(path.join(repoRoot, 'src-tauri/src/batch.rs'), 'utf8');

  const fn = /async fn analyze_multi_frame_with_ollama[\s\S]*?\n\}/.exec(src)?.[0];
  if (!fn) throw new Error('analyze_multi_frame_with_ollama を batch.rs から抽出できませんでした');

  // format!("{}\n\n<note>", base_prompt) の <note> を取り出す。
  // 通常の文字列リテラルなので \n はエスケープのまま入っている。実行時と同じ形に戻す。
  const noteMatch = /format!\("\{\}((?:[^"\\]|\\.)*)",\s*base_prompt\)/.exec(fn);
  if (!noteMatch) throw new Error('マルチフレームの注記を batch.rs から抽出できませんでした');
  const note = noteMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  const opts = /options:\s*OllamaOptions\s*\{([\s\S]*?)\}/.exec(fn)?.[1] ?? '';
  const numOf = (key) => {
    const m = new RegExp(`${key}:\\s*([\\d.]+)`).exec(opts);
    return m ? Number(m[1]) : null;
  };

  return {
    note,
    temperature: numOf('temperature') ?? 0.1,
    numCtx: numOf('num_ctx') ?? 16384,
    // 本番に num_predict が復活したら計測側でも再現される（無指定なら null）
    numPredict: numOf('num_predict'),
    formatJson: /format:\s*"json"/.test(fn),
  };
}

/**
 * 本番がどのモデルにどのプロンプトを与えるかを、**本番のコードそのものに聞く**。
 *
 * `mod.rs` の `#[ignore]` テスト `resolve_prompt_selection` を呼び、
 * `get_vlm_prompt_info` の判定結果を受け取る。
 *
 * **判定を JS に書き写さない。** しきい値もキーワードも名前の解析も、写せば必ず乖離し、
 * 「本番と違うものを測っていた」に行き着く（`tools/embedding-check` が計測ロジックを
 * Rust テスト経由で回しているのと同じ理由）。
 *
 * 乖離が怖いので**フォールバックも用意しない**。cargo が無ければ失敗させる。
 * 静かに近似値へ落ちる方が、動かないより悪い。
 */
export function resolvePromptVariants(repoRoot, models, { forceDetailed = false, granularity = null } = {}) {
  // 本文も一緒に返させる。抽出側（とくに descriptive_rules_section のミラー）が
  // 本番と一致しているかは、本文を突き合わせないと分からない
  const env = { ...process.env, LOMA_PROMPT_MODELS: models.join(','), LOMA_PROMPT_DUMP: 'true' };
  if (forceDetailed) env.LOMA_PROMPT_FORCE_DETAILED = 'true';
  if (granularity) env.LOMA_PROMPT_GRANULARITY = granularity;

  const r = spawnSync('cargo', ['test', '--release', 'resolve_prompt_selection', '--', '--ignored', '--nocapture'], {
    cwd: path.join(repoRoot, 'src-tauri'),
    env,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
  });
  if (r.error) {
    throw new Error(
      `cargo を起動できませんでした (${r.error.message})。\n` +
        '本番の判定を使うため Rust のツールチェインが要る。'
    );
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => /error|panicked|failed/i.test(l)).slice(0, 10).join('\n'));
    throw new Error(`cargo test resolve_prompt_selection が失敗しました (exit ${r.status})`);
  }

  const lines = out.split(/\r?\n/);
  const map = new Map();
  const bodies = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^LOMA_PROMPT_SELECTION\t(.*)\t([^\t]*)\t([^\t]*)\t(\d+)\s*$/.exec(lines[i]);
    if (m) {
      map.set(m[1], { variant: m[2], paramSize: m[3] === 'null' ? null : Number(m[3]), promptChars: Number(m[4]) });
      continue;
    }
    const b = /^LOMA_PROMPT_BODY_BEGIN (.+)$/.exec(lines[i]);
    if (b) {
      const buf = [];
      while (++i < lines.length && lines[i] !== 'LOMA_PROMPT_BODY_END') buf.push(lines[i]);
      bodies.set(b[1].trim(), buf.join('\n'));
    }
  }
  const missing = models.filter((m) => !map.has(m));
  if (missing.length) {
    throw new Error(
      `判定結果を取得できませんでした: ${missing.join(', ')}\n` +
        'mod.rs の resolve_prompt_selection が出力形式を変えた可能性がある。'
    );
  }
  return { byModel: map, bodies };
}

export function loadRustPrompts(repoRoot) {
  const modPath = path.join(repoRoot, 'src-tauri/src/llm/mod.rs');
  const src = fs.readFileSync(modPath, 'utf8');

  const LIGHT = extractRawConst(src, 'VLM_ANALYSIS_PROMPT_LIGHT');
  const DETAILED = extractRawConst(src, 'VLM_ANALYSIS_PROMPT_DETAILED');
  const JSON_WITH_DESC = extractRawConst(src, 'JSON_EXAMPLE_WITH_DESCRIPTIVE');

  // build_detailed_with_descriptive (mod.rs) と同じ組み立て
  const MARKER = '\n\n# Output Format\n';
  const buildDetailedWithDescriptive = (min, max) => {
    const idx = DETAILED.indexOf(MARKER);
    if (idx < 0) throw new Error('DETAILED プロンプトに Output Format マーカーがありません');
    const rules = DETAILED.slice(0, idx);
    return `${rules}\n\n${mirrorDescriptiveRulesSection(min, max)}\n\n# Output Format\n${JSON_WITH_DESC}`;
  };

  // descriptive_rules_section のドリフト検知
  const fnMatch = /fn descriptive_rules_section[\s\S]*?\n\}/.exec(src);
  const fnHash = fnMatch ? crypto.createHash('sha256').update(fnMatch[0]).digest('hex') : null;

  // num_ctx も recommended_num_ctx() から抽出する（ここも定数をコピーしない）
  const ctxFn = /pub fn recommended_num_ctx[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
  const num = (re, fallback) => {
    const m = re.exec(ctxFn);
    return m ? parseInt(m[1], 10) : fallback;
  };
  const numCtx = {
    light: num(/VlmPromptType::Light\s*=>\s*(\d+)/, 8192),
    atomic: num(/TagGranularity::Atomic\s*=>\s*(\d+)/, 12288),
    balanced: num(/TagGranularity::Balanced\s*=>\s*(\d+)/, 16384),
    descriptive: num(/TagGranularity::Descriptive\s*=>\s*(\d+)/, 16384),
  };

  return {
    LIGHT,
    DETAILED_ATOMIC: DETAILED,
    DETAILED_BALANCED: buildDetailedWithDescriptive(1, 3),
    DETAILED_DESCRIPTIVE: buildDetailedWithDescriptive(3, 6),
    numCtx,
    _descriptiveFnHash: fnHash,
  };
}

/**
 * 検証したい改修候補。ここは「まだ Rust に入れていない案」を置く場所。
 * 採用が決まって Rust に取り込んだら、対応するエントリはここから消す
 * （残すと本物と候補の二重管理になる）。
 */
export function candidateVariants(rust) {
  /** LIGHT の Categories options 行の直前に1行差し込む。改修案を試すときの定石。 */
  // eslint-disable-next-line no-unused-vars
  const insertBeforeCategories = (base, extraLine) => {
    const anchor = '\n\nCategories options:';
    const i = base.indexOf(anchor);
    if (i < 0) throw new Error('LIGHT プロンプトに Categories options アンカーがありません');
    return base.slice(0, i) + `\n\n${extraLine}` + base.slice(i);
  };

  // Phase 0 (2026-07-29) の LIGHT_COUNT / LIGHT_COUNT_SCHEMA は検証を終えて
  // mod.rs に取り込んだため削除した（残すと本物と候補の二重管理になる）。
  // 実測結果は docs/vlm-notes.md を参照。

  /**
   * 「モデルサイズが大きいほど複雑な指示に従える」という仮説を検証するための候補。
   * 通常のタグ付けでは 8B と 12B〜30B で差が出なかった（2026-07-31 実測、タグ数中央値が
   * ほぼ同じ）。もし複雑な制約下でも差が出ないなら、より大きいモデルを勧める理由が消える。
   *
   * DETAILED atomic に3つの制約を足すだけで、本体の抽出ロジックは変えない:
   *   - 件数の厳守（5-10 本の幅ではなく、ちょうど6本）
   *   - 同一概念の重複禁止（"cat" / "orange_cat" / "sleeping_cat" のような言い換えの乱立）
   *   - スキーマに無い追加指示への追従（"lighting_" で始まるタグを1本含める）
   *
   * 採否を決める実験ではなく検証用なので、採用されても mod.rs には取り込まない
   * （通常運用のプロンプトを複雑にする話ではないため）。
   */
  const MARKER = '\n\n# Output Format\n';
  const idx = rust.DETAILED_ATOMIC.indexOf(MARKER);
  if (idx < 0) return {};
  const rules = rust.DETAILED_ATOMIC.slice(0, idx);
  const extra = [
    '# Additional strict constraints',
    '- Output EXACTLY 6 tags in "tags". Not 5, not 7 — exactly 6, no matter how many distinct things you notice.',
    '- Do NOT include multiple tags describing the same concept from different angles ' +
      '(e.g. do not use both "cat" and "orange_cat" and "sleeping_cat" for one cat — merge into the single most useful tag).',
    '- Exactly ONE of the 6 tags MUST have "en" starting with "lighting_" describing the lighting condition ' +
      '(e.g. "lighting_bright", "lighting_dim", "lighting_natural", "lighting_artificial"). This is mandatory in every response.',
  ].join('\n');

  return {
    CONSTRAINED: {
      prompt: `${rules}\n\n${extra}${MARKER}${rust.DETAILED_ATOMIC.slice(idx + MARKER.length)}`,
      numCtx: rust.numCtx.atomic,
    },
  };
}

export function allPrompts(repoRoot) {
  const rust = loadRustPrompts(repoRoot);
  const cand = candidateVariants(rust);
  const c = rust.numCtx;
  return {
    // Rust の実物
    light: { prompt: rust.LIGHT, label: 'LIGHT (現行 / mod.rs 実物)', numCtx: c.light },
    detailed_atomic: { prompt: rust.DETAILED_ATOMIC, label: 'DETAILED atomic (現行 / mod.rs 実物)', numCtx: c.atomic },
    detailed_balanced: { prompt: rust.DETAILED_BALANCED, label: 'DETAILED balanced', numCtx: c.balanced },
    detailed_descriptive: { prompt: rust.DETAILED_DESCRIPTIVE, label: 'DETAILED descriptive', numCtx: c.descriptive },
    // 検証中の候補（candidateVariants に追加すると自動でここに並ぶ）。
    // 候補は素の文字列でも { prompt, numCtx } でもよい（後者は DETAILED 相当の長さを想定するとき用）
    ...Object.fromEntries(
      Object.entries(cand).map(([k, v]) => {
        const entry = typeof v === 'string' ? { prompt: v, numCtx: c.light } : { prompt: v.prompt, numCtx: v.numCtx ?? c.light };
        return [k.toLowerCase(), { prompt: entry.prompt, label: `候補: ${k}`, numCtx: entry.numCtx }];
      })
    ),
    _meta: { descriptiveFnHash: rust._descriptiveFnHash, numCtx: c },
  };
}
