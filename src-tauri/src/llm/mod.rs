pub mod traits;
pub mod ollama;
/// タグ整理のテキスト生成専用。画像経路（`ollama`）とは要る歯止めが違う
pub mod ollama_text;
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

/// 画像として開けなかったファイルのエラー文言。
pub const NOT_AN_IMAGE_ERROR: &str = "Not a decodable image";

/// JPEG への再エンコードに失敗した場合のエラー文言。
pub const IMAGE_ENCODE_ERROR: &str = "Image encoding failed";

/// 動画からサムネイル用フレームを取り出せなかった場合のエラー文言。
pub const NO_VIDEO_FRAME_ERROR: &str = "No thumbnail frame generated";

/// 失敗の種別コード。`media.analysis_error_kind` に保存し、失敗一覧の
/// グループ化に使う。**DBに残る値なので、既存のコードは改名しないこと。**
///
/// ここに列挙されていない失敗は必ず `UNKNOWN` に落ちる。種別を事前に
/// 数え上げきる前提は置かない。未知は UI 側でエラー文面ごとに束ねる。
pub mod error_kind {
    pub const NOT_DECODABLE: &str = "not_decodable";
    pub const ENCODE_FAILED: &str = "encode_failed";
    pub const IMAGE_REJECTED: &str = "image_rejected";
    pub const NO_VIDEO_FRAME: &str = "no_video_frame";
    pub const CONTEXT_EXHAUSTED: &str = "context_exhausted";
    pub const RATE_LIMIT: &str = "rate_limit";
    pub const SERVER_UNAVAILABLE: &str = "server_unavailable";
    pub const UNKNOWN: &str = "unknown";
}

/// クォータ超過・レート制限か。
pub fn is_rate_limit(err_msg: &str) -> bool {
    err_msg.contains("429")
        || err_msg.contains("Quota Exceeded")
        || err_msg.contains("Rate Limit")
        || err_msg.contains("RESOURCE_EXHAUSTED")
}

/// コンテキスト枯渇はリトライしても同じ結果になるため、一時障害として扱わない。
/// （OllamaProvider 側で num_ctx を拡張して再試行済み）
pub fn is_context_exhausted(err_msg: &str) -> bool {
    err_msg.contains("Ollama context exhausted")
}

/// サーバー側の一時障害か。
pub fn is_transient_server_error(err_msg: &str) -> bool {
    err_msg.contains("503")
        || err_msg.contains("500")
        || err_msg.contains("502")
        || err_msg.contains("504")
        || err_msg.contains("Service Unavailable")
        || err_msg.contains("UNAVAILABLE")
        || err_msg.contains("Internal Error")
        || err_msg.contains("high demand")
        || err_msg.contains("overloaded")
        || err_msg.contains("Overloaded")
        || err_msg.contains("empty response")
        || err_msg.contains("Failed to parse AnalysisResult JSON")
}

/// エラー文言から種別コードを求める。判定は文字列一致に頼るので、
/// 対象の文言は必ず上の定数から組み立てること。
pub fn classify_error(err_msg: &str) -> &'static str {
    // ファイル個別の問題を先に見る。サーバー側の判定は数字の部分一致
    // （"500" 等）を含むため、後に置かないと巻き込む
    if err_msg.contains(NOT_AN_IMAGE_ERROR) {
        error_kind::NOT_DECODABLE
    } else if err_msg.contains(IMAGE_ENCODE_ERROR) {
        error_kind::ENCODE_FAILED
    } else if err_msg.contains("Failed to load image or audio file") {
        // Ollama が受け取った画像ペイロードを解釈できなかったときの応答
        error_kind::IMAGE_REJECTED
    } else if err_msg.contains(NO_VIDEO_FRAME_ERROR) {
        error_kind::NO_VIDEO_FRAME
    } else if is_context_exhausted(err_msg) {
        error_kind::CONTEXT_EXHAUSTED
    } else if is_rate_limit(err_msg) {
        error_kind::RATE_LIMIT
    } else if is_transient_server_error(err_msg) {
        error_kind::SERVER_UNAVAILABLE
    } else {
        error_kind::UNKNOWN
    }
}

/// その種別が「再試行しても直らない」ものか。
/// `UNKNOWN` はここでは false を返す。未知を恒久失敗と決めつけず、
/// 連続失敗回数で降格させる（判定は UI 側）。
pub fn is_permanent_kind(kind: &str) -> bool {
    kind == error_kind::NOT_DECODABLE
        || kind == error_kind::ENCODE_FAILED
        || kind == error_kind::IMAGE_REJECTED
        || kind == error_kind::NO_VIDEO_FRAME
        || kind == error_kind::CONTEXT_EXHAUSTED
}

/// 未知のエラーを「要確認」に降格させる連続失敗回数。
/// 1回目は一時障害の可能性を残し、同じエラーで再度失敗したら降格させる。
pub const UNKNOWN_FAILURE_ATTENTION_THRESHOLD: i64 = 2;

/// 再試行しても直らない見込みで、ユーザーの判断を要するか。
///
/// この判定はフロントに複製しない。閾値も恒久種別の一覧もここだけに置き、
/// 結果だけを `MediaItem.needs_attention` として返す。
pub fn needs_attention(kind: &str, consecutive_failures: i64) -> bool {
    is_permanent_kind(kind)
        || (kind == error_kind::UNKNOWN
            && consecutive_failures >= UNKNOWN_FAILURE_ATTENTION_THRESHOLD)
}

/// そのファイル固有の入力エラーか（＝別のファイルなら成功しうるか）を判定する。
/// サーバー障害と区別し、スキャン全体を打ち切る連続エラー数に数えないために使う。
pub fn is_media_input_error(err_msg: &str) -> bool {
    let kind = classify_error(err_msg);
    kind == error_kind::NOT_DECODABLE
        || kind == error_kind::ENCODE_FAILED
        || kind == error_kind::IMAGE_REJECTED
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

    /// ファイル1件の入力エラーと、サーバー側の障害を取り違えないこと。
    /// 取り違えると前者で連続エラー打ち切りが働き、スキャンが先に進まない。
    #[test]
    fn per_file_input_errors_are_distinguished_from_server_failures() {
        let not_an_image = format!("{}: D:/pic/._a.png (invalid PNG signature)", NOT_AN_IMAGE_ERROR);
        assert!(is_media_input_error(&not_an_image));
        assert!(is_media_input_error(&format!("{}: D:/pic/a.png (io)", IMAGE_ENCODE_ERROR)));
        assert!(is_media_input_error(
            r#"Ollama API Error (400 Bad Request): {"error":{"message":"Failed to load image or audio file"}}"#
        ));

        // サーバー障害・モデル未取得は打ち切りの対象のまま
        assert!(!is_media_input_error("Ollama API Error (503 Service Unavailable): "));
        assert!(!is_media_input_error("Ollama API Error (404 Not Found): model 'x' not found"));
        assert!(!is_media_input_error("error sending request for url (http://localhost:11434/api/generate)"));
    }

    /// 種別コードは DB に保存され、失敗一覧のグループ化キーになる。
    /// ファイル個別の判定はサーバー側の判定より先に効くこと（後者は "500" の
    /// ような数字の部分一致を含むので、順序を崩すと巻き込む）。
    #[test]
    fn each_error_lands_on_its_kind() {
        let cases: &[(&str, &str)] = &[
            (
                "Not a decodable image: D:/pic/a.png (Format error decoding Png: Invalid PNG signature.)",
                error_kind::NOT_DECODABLE,
            ),
            ("Image encoding failed: D:/pic/a.png (io)", error_kind::ENCODE_FAILED),
            (
                r#"Ollama API Error (400 Bad Request): {"error":{"message":"Failed to load image or audio file"}}"#,
                error_kind::IMAGE_REJECTED,
            ),
            ("No thumbnail frame generated", error_kind::NO_VIDEO_FRAME),
            ("Ollama context exhausted at num_ctx=32768", error_kind::CONTEXT_EXHAUSTED),
            ("Gemini API Error (429): Quota Exceeded", error_kind::RATE_LIMIT),
            ("Ollama API Error (503 Service Unavailable): ", error_kind::SERVER_UNAVAILABLE),
            ("Failed to parse AnalysisResult JSON", error_kind::SERVER_UNAVAILABLE),
        ];
        for (msg, expected) in cases {
            assert_eq!(classify_error(msg), *expected, "分類が違う: {msg}");
        }

        // 知らないエラーは必ず UNKNOWN に落ちる。種別を数え上げきる前提は置かない
        assert_eq!(
            classify_error("Ollama API Error (404 Not Found): model 'x' not found"),
            error_kind::UNKNOWN
        );
        assert_eq!(classify_error("something nobody has seen yet"), error_kind::UNKNOWN);
    }

    /// 未知のエラーを恒久失敗と決めつけないこと。決めつけると、Ollama 側の
    /// 新しい一時エラーが「直らないもの」として再試行対象から消える。
    #[test]
    fn unknown_errors_are_demoted_only_after_repeating() {
        assert!(!needs_attention(error_kind::UNKNOWN, 1), "1回目で降格している");
        assert!(needs_attention(error_kind::UNKNOWN, 2), "2回目で降格していない");
        assert!(needs_attention(error_kind::UNKNOWN, 7));

        // 恒久種別は初回から要確認
        assert!(needs_attention(error_kind::NOT_DECODABLE, 1));
        assert!(needs_attention(error_kind::NO_VIDEO_FRAME, 1));

        // 一時障害は何回続いても要確認にしない。Ollama を起動し直せば直る
        assert!(!needs_attention(error_kind::SERVER_UNAVAILABLE, 9));
        assert!(!needs_attention(error_kind::RATE_LIMIT, 9));
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
    /// 計測ツール（`tools/prompt-check`）が**本番の判定そのもの**を使うための出力。
    ///
    /// ```bash
    ///   LOMA_PROMPT_MODELS=qwen3-vl:4b,gemma4:12b \
    ///     cargo test --release resolve_prompt_selection -- --ignored --nocapture
    /// ```
    ///
    /// JS 側に判定を書き写すと必ず乖離するため、**ミラーを持たせずここを呼ばせる**。
    /// 本番の Ollama 経路（`llm/ollama.rs`）は生のモデル名をそのまま渡すので、ここでもそうする。
    ///
    /// 出力は 1 行 1 モデルの TSV。cargo のノイズと混ざらないよう接頭辞を付ける:
    ///   `LOMA_PROMPT_SELECTION\t<model>\t<variant>\t<parsed_size|null>\t<prompt_chars>`
    #[test]
    #[ignore]
    fn resolve_prompt_selection() {
        let Ok(models) = std::env::var("LOMA_PROMPT_MODELS") else {
            eprintln!("LOMA_PROMPT_MODELS が未設定のためスキップ");
            return;
        };
        let provider = std::env::var("LOMA_PROMPT_PROVIDER").unwrap_or_else(|_| "Ollama".to_string());
        let force_detailed = matches!(std::env::var("LOMA_PROMPT_FORCE_DETAILED").as_deref(), Ok("true"));
        let granularity = match std::env::var("LOMA_PROMPT_GRANULARITY").unwrap_or_default().as_str() {
            "atomic" => TagGranularity::Atomic,
            "balanced" => TagGranularity::Balanced,
            "descriptive" => TagGranularity::Descriptive,
            // 未指定なら本番の既定値に従う（ここに既定を書かない）
            _ => TagGranularity::default(),
        };
        let gran_name = match granularity {
            TagGranularity::Atomic => "atomic",
            TagGranularity::Balanced => "balanced",
            TagGranularity::Descriptive => "descriptive",
        };
        let cfg = PromptConfig { granularity, force_detailed };

        let mut seen: Vec<(String, String)> = Vec::new();
        for model in models.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let (kind, prompt) = get_vlm_prompt_info(&provider, model, &cfg);
            let variant = match kind {
                VlmPromptType::Light => "light".to_string(),
                VlmPromptType::Detailed => format!("detailed_{}", gran_name),
            };
            let size = parse_model_parameter_size(model)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "null".to_string());
            println!(
                "LOMA_PROMPT_SELECTION\t{}\t{}\t{}\t{}",
                model,
                variant,
                size,
                prompt.chars().count()
            );
            if !seen.iter().any(|(v, _): &(String, String)| v == &variant) {
                seen.push((variant, prompt));
            }
        }

        // 文字数だけでは balanced と descriptive を区別できない（差は数字1文字ずつで長さが同じ）。
        // 抽出側が本番と一致しているかを確かめるには本文そのものを渡すしかない。
        if matches!(std::env::var("LOMA_PROMPT_DUMP").as_deref(), Ok("true")) {
            for (variant, prompt) in &seen {
                println!("LOMA_PROMPT_BODY_BEGIN {}", variant);
                println!("{}", prompt);
                println!("LOMA_PROMPT_BODY_END");
            }
        }
    }
}
