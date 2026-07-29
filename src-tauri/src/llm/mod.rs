pub mod traits;
pub mod ollama;
pub mod gemini;
pub mod openai;
pub mod claude;
pub mod retry;
pub mod factory;

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct TagPair {
    pub en: String,
    pub ja: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct AnalysisResult {
    pub categories: Vec<String>,
    pub tags: Vec<TagPair>,
    /// 修飾語付きの記述的タグ（tag_granularity が atomic の場合や、
    /// LLMがセクション自体を出さなかった場合は空になる）
    #[serde(default)]
    pub descriptive_tags: Vec<TagPair>,
}

/// LLMからの生のテキストレスポンスから JSON 部分を抽出して AnalysisResult にパースする堅牢なヘルパー関数
pub fn parse_analysis_result(raw_response: &str) -> anyhow::Result<AnalysisResult> {
    let clean = raw_response.trim();
    if clean.is_empty() {
        return Err(anyhow::anyhow!("Received empty response content from LLM. Please ensure the selected model supports image/multimodal analysis."));
    }
    
    // ```json ... ``` などのコードブロックのストリップ
    let json_str = if clean.contains("```") {
        let mut extracted = clean;
        for part in clean.split("```") {
            let p = part.trim();
            if let Some(rest) = p.strip_prefix("json") {
                extracted = rest.trim();
                break;
            } else if p.starts_with('{') {
                extracted = p;
                break;
            }
        }
        extracted
    } else {
        clean
    };

    // 最外層の '{' と '}' の抽出
    let start_idx = json_str.find('{').unwrap_or(0);
    let end_idx = json_str.rfind('}').map(|i| i + 1).unwrap_or_else(|| json_str.len());
    
    let trimmed_json = if start_idx < end_idx && end_idx <= json_str.len() {
        &json_str[start_idx..end_idx]
    } else {
        json_str
    };

    let result: AnalysisResult = serde_json::from_str(trimmed_json)
        .map_err(|e| anyhow::anyhow!("Failed to parse AnalysisResult JSON: {}. Content: {}", e, trimmed_json))?;

    Ok(result)
}

/// 高精度・大規模モデル（Gemini, Claude, GPT-4o, llava-34b等）向けの詳細プロンプト定義
pub const VLM_ANALYSIS_PROMPT_DETAILED: &str = r#"You are an expert media archivist. Perform an extremely accurate visual analysis of the provided image and generate metadata.

# Rules for "categories"
- Pick 1 to 3 matching items STRICTLY from the following list:
  ["screenshot", "document", "landscape", "food", "character", "animal", "person", "item_product", "art_illustration", "text_heavy", "tech", "other"]

# Rules for "tags"
- Output 5 to 10 accurate, reusable tags.
- Tag Naming & Granularity:
  - Proper Nouns: Always KEEP specific proper nouns intact (e.g., character names, brand/product names, title names, specific location names like "tokyo").
  - General Objects: For general items, prefer basic-level nouns over compound tags with materials or modifiers (e.g., use "counter" instead of "wooden_counter", or separate them into ["counter", "wood"]).
  - Avoid Ultra-Abstract Terms: DO NOT use over-abstract or generic words like: ["matter", "substance", "object", "thing", "element", "stuff", "entity", "image", "photo", "picture", "background", "file", "media"].
- Focus on: Main subjects, specific objects, proper nouns, text OCR keywords, visual style, and location.
- Each tag MUST be an object containing "en" (singular lowercase English) and "ja" (accurate and natural Japanese translation).

# Output Format
Respond ONLY with a valid JSON object matching this exact structure:
{
  "categories": ["animal", "landscape"],
  "tags": [
    {
      "en": "cat",
      "ja": "猫"
    },
    {
      "en": "cherry_blossom",
      "ja": "桜"
    }
  ]
}"#;

/// 軽量・小型モデル（qwen3-vl:4b等）向けの高速・安定化プロンプト定義
///
/// **`Output 3 to 5 tags.` の行を削らないこと。** これが無いと小型モデルは直前の例示
/// （タグ1個）に引きずられ、実測で**タグ3個未満が82%**（qwen3-vl:4b / n=57 / 2026-07-29）になる。
/// 低情報量の画像では 100% が3個未満で、`"tags": []` すら返る。
/// `en`/`ja` 必須の明示は、本数指示のみの案に対しタグの再現性を上げる
/// （反復間 Jaccard 0.549 対 0.399、生成語彙は15%少ない）。
/// 経緯と実測値: docs/vlm-notes.md / 検証方法: tools/prompt-check/README.md
pub const VLM_ANALYSIS_PROMPT_LIGHT: &str = r#"Analyze this image and return metadata in JSON matching structure:
{"categories": ["animal"], "tags": [{"en": "cat", "ja": "猫"}]}

Output 3 to 5 tags. Each tag MUST have both "en" and "ja".

Categories options: ["screenshot", "document", "landscape", "food", "character", "animal", "person", "item_product", "art_illustration", "text_heavy", "tech", "other"]"#;

/// デフォルトプロンプト（互換性のためのフォールバック）
#[allow(dead_code)]
pub const VLM_ANALYSIS_PROMPT: &str = VLM_ANALYSIS_PROMPT_LIGHT;

/// タグ付与の粒度レベル（DETAILEDプロンプトにのみ適用される）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TagGranularity {
    /// 現行仕様: 分解重視。descriptive_tags セクション自体を出さない
    #[default]
    Atomic,
    /// 基本語5-10個 + 記述的タグ1-3個
    Balanced,
    /// 基本語5-10個 + 記述的タグ3-6個
    Descriptive,
}

impl TagGranularity {
    pub fn from_setting(value: &str) -> Self {
        match value {
            "balanced" => TagGranularity::Balanced,
            "descriptive" => TagGranularity::Descriptive,
            _ => TagGranularity::Atomic,
        }
    }

    pub fn as_setting_str(&self) -> &'static str {
        match self {
            TagGranularity::Atomic => "atomic",
            TagGranularity::Balanced => "balanced",
            TagGranularity::Descriptive => "descriptive",
        }
    }
}

/// 解析プロンプトの構築に必要な設定値
#[derive(Debug, Clone, Copy, Default)]
pub struct PromptConfig {
    pub granularity: TagGranularity,
    /// ONの場合、モデル規模判定を無視して常にDETAILEDプロンプトを使用する
    pub force_detailed: bool,
}

// DETAILEDプロンプトの本文セクションと出力形式セクションの境界マーカー。
// build_detailed_with_descriptive はこのマーカーで分割し、
// 中間に "# Rules for descriptive_tags" セクションを挿入する。
const DETAILED_OUTPUT_FORMAT_MARKER: &str = "\n\n# Output Format\n";

fn descriptive_rules_section(min: u32, max: u32) -> String {
    format!(
        "# Rules for \"descriptive_tags\"\n\
- Output {min} to {max} descriptive compound tags. Do NOT stop at the minimum: use as many as the scene genuinely supports, up to the maximum, by covering DIFFERENT aspects of the image (e.g. one for the main subject's state/action, one for a background/environmental element, one for lighting/weather/time of day, one for a secondary object's material/condition). Only fall short of the maximum if the image truly lacks that many distinct describable aspects.\n\
- Each descriptive tag MUST combine a modifier (state, condition, material, weather, time of day, or color) with a subject noun visible in the scene. Examples: \"rain_soaked_tree\", \"sunset_beach\", \"snow_covered_road\".\n\
- These are IN ADDITION to \"tags\". NEVER omit an atomic tag from \"tags\" just because it also appears inside a descriptive tag.\n\
- Do NOT put bare nouns here. Every entry must contain a modifier.\n\
- Each tag MUST be an object containing \"en\" (lowercase snake_case English) and \"ja\" (a natural Japanese phrase)."
    )
}

const JSON_EXAMPLE_WITH_DESCRIPTIVE: &str = r#"Respond ONLY with a valid JSON object matching this exact structure:
{
  "categories": ["animal", "landscape"],
  "tags": [
    {
      "en": "cat",
      "ja": "猫"
    },
    {
      "en": "cherry_blossom",
      "ja": "桜"
    }
  ],
  "descriptive_tags": [
    {
      "en": "rain_soaked_tree",
      "ja": "雨に濡れた木"
    }
  ]
}"#;

/// Lv2/Lv3用: DETAILEDプロンプトのルール部分はそのまま維持しつつ、
/// "# Output Format" の直前に descriptive_tags セクションを挿入し、
/// JSON出力例も descriptive_tags を含む形に差し替える
fn build_detailed_with_descriptive(min: u32, max: u32) -> String {
    let (rules_part, _) = VLM_ANALYSIS_PROMPT_DETAILED
        .split_once(DETAILED_OUTPUT_FORMAT_MARKER)
        .expect("VLM_ANALYSIS_PROMPT_DETAILED must contain the Output Format marker");

    format!(
        "{rules}\n\n{descriptive}\n\n# Output Format\n{json}",
        rules = rules_part,
        descriptive = descriptive_rules_section(min, max),
        json = JSON_EXAMPLE_WITH_DESCRIPTIVE
    )
}

/// 粒度レベルに応じたDETAILEDプロンプト本文を構築する。
/// Atomic の場合は現行の VLM_ANALYSIS_PROMPT_DETAILED と完全一致する。
pub fn build_detailed_prompt(granularity: TagGranularity) -> String {
    match granularity {
        TagGranularity::Atomic => VLM_ANALYSIS_PROMPT_DETAILED.to_string(),
        TagGranularity::Balanced => build_detailed_with_descriptive(1, 3),
        TagGranularity::Descriptive => build_detailed_with_descriptive(3, 6),
    }
}

/// モデル名からパラメータ数（~B）を数値 (f32) として抽出する堅牢なパース関数
/// 例: "qwen3-vl:4b" -> Some(4.0)
/// 例: "llama3.2-vision:11b" -> Some(11.0)
/// 例: "my-custom-model:12b" -> Some(12.0)
/// 例: "llava:34b" -> Some(34.0)
pub fn parse_model_parameter_size(model_name: &str) -> Option<f32> {
    let lower = model_name.to_lowercase();
    let bytes = lower.as_bytes();
    
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'b' {
            let mut start = i;
            while start > 0 {
                let prev = bytes[start - 1];
                if prev.is_ascii_digit() || prev == b'.' {
                    start -= 1;
                } else {
                    break;
                }
            }
            if start < i {
                if let Ok(val) = lower[start..i].parse::<f32>() {
                    if val > 0.0 && val < 500.0 {
                        return Some(val);
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VlmPromptType {
    Detailed,
    Light,
}

impl VlmPromptType {
    pub fn name(&self) -> &'static str {
        match self {
            VlmPromptType::Detailed => "DETAILED (High-Precision)",
            VlmPromptType::Light => "LIGHT (Fast/Stable)",
        }
    }
}

/// プロバイダー名とモデル名、および解析プロンプト設定に応じた
/// プロンプトタイプとプロンプト本文を返す関数
pub fn get_vlm_prompt_info(provider_name: &str, model_name: &str, config: &PromptConfig) -> (VlmPromptType, String) {
    let provider_lower = provider_name.to_lowercase();
    let model_lower = model_name.to_lowercase();

    // 0. 高精度プロンプトの強制適用が有効な場合は、モデル規模判定を無視する
    if config.force_detailed {
        return (VlmPromptType::Detailed, build_detailed_prompt(config.granularity));
    }

    // 1. クラウドプロバイダー (Gemini, OpenAI, Claude) は常に高精度詳細プロンプトを使用
    if provider_lower.contains("gemini")
        || provider_lower.contains("google")
        || provider_lower.contains("openai")
        || provider_lower.contains("gpt")
        || provider_lower.contains("claude")
        || provider_lower.contains("anthropic")
    {
        return (VlmPromptType::Detailed, build_detailed_prompt(config.granularity));
    }

    // 2. Ollamaモデルの数値パラメータ解析: 10B（100億パラメータ）以上は高精度詳細プロンプト
    if let Some(param_size) = parse_model_parameter_size(model_name) {
        if param_size >= 10.0 {
            return (VlmPromptType::Detailed, build_detailed_prompt(config.granularity));
        } else {
            return (VlmPromptType::Light, VLM_ANALYSIS_PROMPT_LIGHT.to_string());
        }
    }

    // 3. パース失敗時のキーワードフォールバック（例: 4b/11b などの数字がモデル名に含まれない場合）
    if model_lower.contains("large") || model_lower.contains("giant") || model_lower.contains("pro") {
        (VlmPromptType::Detailed, build_detailed_prompt(config.granularity))
    } else {
        // パラメータ数不明のモデルは、破綻を防ぎ安定動作させるため LIGHT に安全フォールバック
        (VlmPromptType::Light, VLM_ANALYSIS_PROMPT_LIGHT.to_string())
    }
}

/// プロンプト本文のみを返す便利関数
#[allow(dead_code)]
pub fn get_vlm_prompt(provider_name: &str, model_name: &str, config: &PromptConfig) -> String {
    get_vlm_prompt_info(provider_name, model_name, config).1
}

/// プロンプト種別と粒度から、Ollama へ渡す num_ctx の推奨初期値を返す。
///
/// 背景: qwen3-vl 系のような thinking 対応モデルは、応答本文を出す前に
/// 推論トークンを大量に消費する。12MP 写真は画像だけで約4,000トークンを占めるため、
/// 従来の固定値 8192 では粒度Lv2/Lv3で生成が途中で打ち切られ
/// （done_reason="length"）、本文が空のまま返っていた。
///
/// 実測値（qwen3-vl:30b / 12MP写真 / num_ctx=8192）:
///   Lv1(atomic)      : prompt 4,408 + 生成 2,193 = 6,601 → 成功
///   Lv3(descriptive) : prompt 4,674 + 生成 3,518〜5,413 → 打ち切り
pub fn recommended_num_ctx(prompt_type: VlmPromptType, granularity: TagGranularity) -> usize {
    match prompt_type {
        // 軽量モデル向けLIGHTプロンプトは出力も推論も短いため従来値で足りる
        VlmPromptType::Light => 8192,
        VlmPromptType::Detailed => match granularity {
            TagGranularity::Atomic => 12288,
            TagGranularity::Balanced => 16384,
            TagGranularity::Descriptive => 16384,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(granularity: TagGranularity, force_detailed: bool) -> PromptConfig {
        PromptConfig { granularity, force_detailed }
    }

    #[test]
    fn atomic_prompt_matches_legacy_detailed_prompt_verbatim() {
        // Lv1(atomic) は既存ユーザーへの後方互換のため、
        // 従来の VLM_ANALYSIS_PROMPT_DETAILED と一文字違わず一致しなければならない
        assert_eq!(build_detailed_prompt(TagGranularity::Atomic), VLM_ANALYSIS_PROMPT_DETAILED);
    }

    #[test]
    fn atomic_prompt_has_no_descriptive_tags_section() {
        let prompt = build_detailed_prompt(TagGranularity::Atomic);
        assert!(!prompt.contains("descriptive_tags"));
    }

    #[test]
    fn balanced_prompt_specifies_1_to_3_descriptive_tags() {
        let prompt = build_detailed_prompt(TagGranularity::Balanced);
        assert!(prompt.contains("Output 1 to 3 descriptive compound tags"));
        assert!(prompt.contains("\"descriptive_tags\""));
        // 基本語タグのルール文言はレベルに関わらず維持される
        assert!(prompt.contains("Output 5 to 10 accurate, reusable tags"));
    }

    #[test]
    fn descriptive_prompt_specifies_3_to_6_descriptive_tags() {
        let prompt = build_detailed_prompt(TagGranularity::Descriptive);
        assert!(prompt.contains("Output 3 to 6 descriptive compound tags"));
        assert!(prompt.contains("Output 5 to 10 accurate, reusable tags"));
    }

    #[test]
    fn force_detailed_overrides_small_model_to_detailed() {
        let cfg = config(TagGranularity::Balanced, true);
        let (kind, prompt) = get_vlm_prompt_info("Ollama", "qwen3-vl:4b", &cfg);
        assert_eq!(kind, VlmPromptType::Detailed);
        assert!(prompt.contains("descriptive_tags"));
    }

    #[test]
    fn small_model_without_force_detailed_stays_light_and_ignores_granularity() {
        let cfg = config(TagGranularity::Descriptive, false);
        let (kind, prompt) = get_vlm_prompt_info("Ollama", "qwen3-vl:4b", &cfg);
        assert_eq!(kind, VlmPromptType::Light);
        assert_eq!(prompt, VLM_ANALYSIS_PROMPT_LIGHT);
    }

    #[test]
    fn light_prompt_instructs_tag_count_and_bilingual_pairs() {
        // この指示が無いと小型モデルは例示のタグ1個に引きずられ、
        // 実測でタグ3個未満が82%になる（qwen3-vl:4b / n=57 / 2026-07-29）。
        // 概念スペクトラム検索は basic タグ3個以上を参加条件にしているため、
        // ここが欠けると解析済みメディアが大量に対象外へ落ちる。
        // 経緯: docs/vlm-notes.md
        assert!(VLM_ANALYSIS_PROMPT_LIGHT.contains("Output 3 to 5 tags."));
        assert!(VLM_ANALYSIS_PROMPT_LIGHT.contains(r#"MUST have both "en" and "ja""#));
    }

    #[test]
    fn cloud_provider_always_uses_detailed_prompt() {
        let cfg = config(TagGranularity::Atomic, false);
        let (kind, _) = get_vlm_prompt_info("Google Gemini", "gemini-2.0-flash", &cfg);
        assert_eq!(kind, VlmPromptType::Detailed);
    }

    #[test]
    fn analysis_result_parses_without_descriptive_tags_field() {
        // 旧形式のJSON（LLMがdescriptive_tagsを返さない場合）でもパースでき、空配列になる
        let json = r#"{"categories":["animal"],"tags":[{"en":"cat","ja":"猫"}]}"#;
        let result: AnalysisResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.categories, vec!["animal".to_string()]);
        assert_eq!(result.tags.len(), 1);
        assert!(result.descriptive_tags.is_empty());
    }

    #[test]
    fn analysis_result_parses_with_descriptive_tags_field() {
        let json = r#"{
            "categories": ["landscape"],
            "tags": [{"en":"tree","ja":"木"}],
            "descriptive_tags": [{"en":"rain_soaked_tree","ja":"雨に濡れた木"}]
        }"#;
        let result: AnalysisResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.descriptive_tags.len(), 1);
        assert_eq!(result.descriptive_tags[0].en, "rain_soaked_tree");
    }

    #[test]
    fn tag_granularity_setting_roundtrip() {
        assert_eq!(TagGranularity::from_setting("atomic"), TagGranularity::Atomic);
        assert_eq!(TagGranularity::from_setting("balanced"), TagGranularity::Balanced);
        assert_eq!(TagGranularity::from_setting("descriptive"), TagGranularity::Descriptive);
        // 不明な値は安全に atomic へフォールバックする
        assert_eq!(TagGranularity::from_setting("bogus"), TagGranularity::Atomic);

        for g in [TagGranularity::Atomic, TagGranularity::Balanced, TagGranularity::Descriptive] {
            assert_eq!(TagGranularity::from_setting(g.as_setting_str()), g);
        }
    }

    #[test]
    fn detailed_prompt_gets_more_context_than_light_prompt() {
        // LIGHT は軽量モデル向けで出力も短いため従来値のままでよい
        assert_eq!(recommended_num_ctx(VlmPromptType::Light, TagGranularity::Descriptive), 8192);
        // DETAILED は thinking 対応モデルの推論トークンを吸収できるだけの余裕が必要
        assert!(recommended_num_ctx(VlmPromptType::Detailed, TagGranularity::Atomic) > 8192);
    }

    #[test]
    fn higher_granularity_never_gets_less_context() {
        // 粒度を上げるほど推論・出力が伸びるため、確保する num_ctx が減ってはならない
        let atomic = recommended_num_ctx(VlmPromptType::Detailed, TagGranularity::Atomic);
        let balanced = recommended_num_ctx(VlmPromptType::Detailed, TagGranularity::Balanced);
        let descriptive = recommended_num_ctx(VlmPromptType::Detailed, TagGranularity::Descriptive);
        assert!(balanced >= atomic);
        assert!(descriptive >= balanced);
    }

    #[test]
    fn descriptive_context_covers_observed_worst_case_usage() {
        // 実測ワーストケース (qwen3-vl:30b / 粒度Lv3):
        //   縮小前の12MP写真 = プロンプト 4,674 トークン
        //   生成(thinking込み) = 6,249 トークン
        // Lv3 の推奨値はこれを収容できなければ done_reason="length" で本文が空になる。
        const OBSERVED_WORST_CASE_TOKENS: usize = 4_674 + 6_249;
        assert!(
            recommended_num_ctx(VlmPromptType::Detailed, TagGranularity::Descriptive)
                >= OBSERVED_WORST_CASE_TOKENS
        );
    }

    #[test]
    fn parse_model_parameter_size_extracts_billions() {
        assert_eq!(parse_model_parameter_size("qwen3-vl:4b"), Some(4.0));
        assert_eq!(parse_model_parameter_size("llama3.2-vision:11b"), Some(11.0));
        assert_eq!(parse_model_parameter_size("llava:34b"), Some(34.0));
        assert_eq!(parse_model_parameter_size("my-custom-model:12b"), Some(12.0));
        assert_eq!(parse_model_parameter_size("no-size-here"), None);
    }
}
