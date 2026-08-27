use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use async_trait::async_trait;
use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::traits::LlmProvider;
use super::{
    get_vlm_prompt_info, parse_analysis_result, AnalysisResult, PromptConfig, IMAGE_ENCODE_ERROR,
};

/// num_ctx 自動拡張の上限。これ以上はVRAM消費が現実的でないため打ち切る。
const NUM_CTX_HARD_CAP: usize = 32768;

#[derive(Serialize)]
struct OllamaGenerateOptions {
    temperature: f32,
    num_ctx: usize,
}

/// Ollama /api/generate のリクエスト。
///
/// **`format: "json"` フィールドを追加してはならない。**
/// thinking 対応モデル（既定の qwen3-vl 系はすべて該当）に指定すると応答が空文字になる。
/// 画像の有無に関わらず再現し、非 thinking モデルでは再現しないため、原因は
/// プロンプトでも画像でもなく thinking 対応の有無である（2026-07-29 実測）。
/// しかも `done_reason` は "length" ではなく "stop"（正常終了）で返るため、
/// `analyze_with_ctx_escalation` の再試行ガードをすり抜けて静かに失敗する。
/// JSON の抽出は `parse_analysis_result` が担うので format 指定は不要。
/// 検証方法: tools/prompt-check/README.md
#[derive(Serialize)]
struct OllamaGenerateRequest {
    model: String,
    prompt: String,
    images: Vec<String>,
    stream: bool,
    options: OllamaGenerateOptions,
}

/// Ollama /api/generate のレスポンス。
/// `response` 以外の統計値は、コンテキスト枯渇（done_reason = "length"）などの
/// 失敗原因を切り分けるための診断情報として取得している。
#[derive(Deserialize)]
struct OllamaGenerateResponse {
    response: String,
    /// thinking 対応モデル（qwen3-vl 等）では推論部分がこちらに分離して返る
    #[serde(default)]
    thinking: Option<String>,
    /// "stop" = 正常終了, "length" = コンテキスト長/生成上限に到達して打ち切り
    #[serde(default)]
    done_reason: Option<String>,
    /// プロンプト（画像トークンを含む）の消費トークン数
    #[serde(default)]
    prompt_eval_count: Option<u32>,
    /// 生成（thinking を含む）の消費トークン数
    #[serde(default)]
    eval_count: Option<u32>,
    #[serde(default)]
    total_duration: Option<u64>,
}

impl OllamaGenerateResponse {
    /// コンテキスト枯渇（生成が最後まで到達しなかった）かどうか
    fn is_truncated(&self) -> bool {
        self.done_reason.as_deref() == Some("length")
    }

    /// 診断用の1行サマリ
    fn diagnostics(&self, num_ctx: usize) -> String {
        format!(
            "done_reason={} num_ctx={} prompt_eval={} eval={} total={} thinking_chars={} response_chars={} elapsed={:.1}s",
            self.done_reason.as_deref().unwrap_or("?"),
            num_ctx,
            self.prompt_eval_count.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
            self.eval_count.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
            match (self.prompt_eval_count, self.eval_count) {
                (Some(p), Some(e)) => (p + e).to_string(),
                _ => "?".into(),
            },
            self.thinking.as_deref().map(|t| t.len()).unwrap_or(0),
            self.response.len(),
            self.total_duration.unwrap_or(0) as f64 / 1_000_000_000.0,
        )
    }
}

pub struct OllamaProvider {
    client: Client,
    base_url: String,
    model_name: String,
    prompt_config: PromptConfig,
    /// ユーザー設定の num_ctx。0 の場合はプロンプト種別・粒度から自動決定する。
    configured_num_ctx: usize,
    /// 画像の長辺をこのピクセル数まで縮小してから送信する。0 で縮小なし。
    max_image_edge: u32,
    /// 枯渇を検知して拡張した num_ctx を、同一プロバイダー（＝同一バッチスキャン）内で
    /// 以降の画像にも引き継ぐための学習値。0 は未学習。
    ///
    /// 1枚目で枯渇したなら同じ設定の2枚目以降も枯渇する可能性が高く、
    /// 都度やり直すと1回あたり2分前後を無駄にするため、拡張後の値を下限として保持する。
    learned_num_ctx: AtomicUsize,
}

impl OllamaProvider {
    pub fn new(
        base_url: String,
        model_name: String,
        prompt_config: PromptConfig,
        configured_num_ctx: usize,
        max_image_edge: u32,
    ) -> Self {
        Self {
            client: Client::new(),
            base_url,
            model_name,
            prompt_config,
            configured_num_ctx,
            max_image_edge,
            learned_num_ctx: AtomicUsize::new(0),
        }
    }

    /// このリクエストで使用する num_ctx の初期値を決定する。
    ///
    /// qwen3-vl 系のような thinking 対応モデルは、粒度Lv2/Lv3の指示が増えるほど
    /// 推論トークンが伸びる。画像トークン（12MP写真で約4000トークン）と合わせて
    /// 8192 を超えると生成が done_reason="length" で打ち切られ、
    /// `response` が空のまま返ってくるため、粒度に応じた余裕を初期値として確保する。
    fn base_num_ctx(&self) -> usize {
        let configured = if self.configured_num_ctx > 0 {
            self.configured_num_ctx
        } else {
            let (prompt_type, _) =
                get_vlm_prompt_info("Ollama", &self.model_name, &self.prompt_config);
            super::recommended_num_ctx(prompt_type, self.prompt_config.granularity)
        };
        // 同一スキャン中に枯渇を経験していれば、その拡張値を下限として引き継ぐ
        configured.max(self.learned_num_ctx.load(Ordering::Relaxed))
    }

    /// 枯渇により拡張した num_ctx を、以降の画像へ引き継ぐために記録する
    fn remember_expanded_num_ctx(&self, num_ctx: usize) {
        self.learned_num_ctx.fetch_max(num_ctx, Ordering::Relaxed);
    }

    /// 画像のデコード・縮小・JPEG エンコードは数百ms〜秒単位の CPU 処理のため、
    /// 非同期ランタイムのワーカースレッドを占有しないようブロッキングプールへ逃がす。
    /// （占有すると `tokio::select!` によるキャンセル検知や他のコマンドまで待たされる）
    async fn prepare_base64_image_async(&self, image_path: &Path) -> Result<String> {
        let path = image_path.to_path_buf();
        let max_edge = self.max_image_edge;
        tokio::task::spawn_blocking(move || prepare_base64_image(&path, max_edge))
            .await
            .map_err(|e| anyhow!("Image encoding task failed: {}", e))?
    }
}

/// 画像を（必要なら縮小して）JPEG base64 化する。CPU バウンドな同期処理。
fn prepare_base64_image(image_path: &Path, max_image_edge: u32) -> Result<String> {
    // デコードできないファイルを生バイトのまま送らないこと。送ると Ollama が
    // 400 Bad Request を返し、ファイル1件の問題がスキャン全体の中断に化ける。
    // 拡張子ではなく中身でデコーダを選ぶ理由は decode_image のコメントを参照。
    let img = crate::image_io::decode_image(image_path)?;

    // 長辺を max_image_edge まで縮小してから送る。
    // 12MP のスマホ写真をそのまま送ると画像だけで約4000トークンを消費し、
    // 生成に使えるコンテキストを圧迫するため。
    //
    // **縮小と RGB 化は image_io に集約している。** 計測ツールが同じ関数を呼んで
    // 同じバイト列を作れるようにするため（別実装で測ると本番と違うものを測ることになる）。
    let (w, h) = (img.width(), img.height());
    let jpeg = crate::image_io::encode_jpeg_for_vlm(
        &img,
        max_image_edge,
        // 透過画像は市松で埋める。合成しないと透明画素の下の RGB（多くは黒）が
        // そのまま出て、VLM が「黒背景」に相当するタグを付ける。
        // 見える透過が無い画像には何もしない（`composite_over` が素通しする）
        crate::image_io::Background::Checker,
    )
    .map_err(|e| anyhow!("{}: {} ({})", IMAGE_ENCODE_ERROR, image_path.display(), e))?;
    if max_image_edge > 0 && w.max(h) > max_image_edge {
        crate::logger::log_debug(&format!(
            "[Ollama Debug] Downscaled image {}x{} (max edge {})",
            w, h, max_image_edge
        ));
    }
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        jpeg,
    ))
}

impl OllamaProvider {
    /// 1回分の /api/generate 呼び出し。レスポンスは統計情報付きで返す。
    async fn call_generate(
        &self,
        prompt: &str,
        images: Vec<String>,
        num_ctx: usize,
    ) -> Result<OllamaGenerateResponse> {
        let req_body = OllamaGenerateRequest {
            model: self.model_name.clone(),
            prompt: prompt.to_string(),
            images,
            stream: false,
            options: OllamaGenerateOptions {
                temperature: 0.2,
                num_ctx,
            },
        };

        let endpoint = format!("{}/api/generate", self.base_url.trim_end_matches('/'));
        let res = self.client.post(&endpoint).json(&req_body).send().await?;

        if !res.status().is_success() {
            let status = res.status();
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Ollama API Error ({}): {}", status, err_text));
        }

        Ok(res.json().await?)
    }

    /// コンテキスト枯渇時に num_ctx を倍増させながら解析を試行する共通ルーチン。
    ///
    /// thinking 対応モデルの推論長は同じ画像・同じプロンプトでも大きくばらつくため
    /// （実測: 粒度Lv3で 3,500〜5,400 トークン）、固定 num_ctx では成功と
    /// 打ち切りが確率的に入れ替わる。ここで枯渇を検知して拡張・再試行することで、
    /// 上位のリトライ層に到達する前に確定的に解消する。
    async fn analyze_with_ctx_escalation(
        &self,
        prompt: &str,
        images: Vec<String>,
        label: &str,
    ) -> Result<AnalysisResult> {
        // 画像1枚あたり数千トークンを消費するため、複数フレーム時は初期値を引き上げる
        let frame_multiplier = images.len().max(1).min(3);
        let mut num_ctx = (self.base_num_ctx() * frame_multiplier).min(NUM_CTX_HARD_CAP);

        loop {
            let gen_res = self.call_generate(prompt, images.clone(), num_ctx).await?;
            let last_diag = gen_res.diagnostics(num_ctx);
            crate::logger::log_debug(&format!("[Ollama Debug] {} {}", label, last_diag));

            // コンテキスト枯渇で response が空 → num_ctx を拡張して再試行
            if gen_res.is_truncated() && gen_res.response.trim().is_empty() {
                let next_ctx = (num_ctx * 2).min(NUM_CTX_HARD_CAP);
                if next_ctx > num_ctx {
                    crate::logger::log_info(&format!(
                        "[Ollama Context Expansion] {} Generation truncated before any answer was produced \
                         (model consumed the whole context with reasoning). Expanding num_ctx {} -> {} and retrying. [{}]",
                        label, num_ctx, next_ctx, last_diag
                    ));
                    num_ctx = next_ctx;
                    // フレーム数による嵩上げ分を戻し、1枚あたりの基準値として引き継ぐ
                    self.remember_expanded_num_ctx(next_ctx / frame_multiplier);
                    continue;
                }
                return Err(anyhow!(
                    "Ollama context exhausted: the model '{}' used the entire {}-token context for reasoning \
                     without emitting an answer (done_reason=length). Lower the tag granularity, reduce \
                     'ollama_max_image_edge', or use a non-thinking model. [{}]",
                    self.model_name, num_ctx, last_diag
                ));
            }

            if gen_res.response.trim().is_empty() {
                return Err(anyhow!(
                    "Ollama returned an empty response. Make sure the selected model ('{}') supports vision input (e.g., llava, llama3.2-vision). [{}]",
                    self.model_name, last_diag
                ));
            }

            // 途中で打ち切られた JSON はパースに失敗するため、拡張して再試行する価値がある
            match parse_analysis_result(&gen_res.response) {
                Ok(result) => return Ok(result),
                Err(parse_err) => {
                    crate::logger::log_error(&format!(
                        "[Ollama Parse Failure] {} {} | raw response: {}",
                        label,
                        last_diag,
                        truncate_for_log(&gen_res.response)
                    ));
                    if let Some(thinking) = gen_res.thinking.as_deref() {
                        crate::logger::log_debug(&format!(
                            "[Ollama Debug] {} thinking tail: {}",
                            label,
                            tail_for_log(thinking)
                        ));
                    }

                    let next_ctx = (num_ctx * 2).min(NUM_CTX_HARD_CAP);
                    if gen_res.is_truncated() && next_ctx > num_ctx {
                        crate::logger::log_info(&format!(
                            "[Ollama Context Expansion] {} Response was cut off mid-JSON. Expanding num_ctx {} -> {} and retrying.",
                            label, num_ctx, next_ctx
                        ));
                        num_ctx = next_ctx;
                        self.remember_expanded_num_ctx(next_ctx / frame_multiplier);
                        continue;
                    }
                    return Err(parse_err);
                }
            }
        }
    }
}

/// ログ肥大化を避けるため、生レスポンスは先頭部分のみ記録する
fn truncate_for_log(s: &str) -> String {
    const LIMIT: usize = 1500;
    let trimmed = s.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.replace('\n', "\\n");
    }
    let head: String = trimmed.chars().take(LIMIT).collect();
    format!("{}...<truncated, {} chars total>", head.replace('\n', "\\n"), trimmed.chars().count())
}

/// thinking は末尾（打ち切られた箇所）が原因究明に有用なため末尾を記録する
fn tail_for_log(s: &str) -> String {
    const LIMIT: usize = 600;
    let count = s.chars().count();
    if count <= LIMIT {
        return s.replace('\n', "\\n");
    }
    let tail: String = s.chars().skip(count - LIMIT).collect();
    format!("<...{} chars omitted>{}", count - LIMIT, tail.replace('\n', "\\n"))
}

#[async_trait]
impl LlmProvider for OllamaProvider {
    fn name(&self) -> &str {
        "Ollama"
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    async fn analyze_image(&self, image_path: &Path) -> Result<AnalysisResult> {
        let base64_img = self.prepare_base64_image_async(image_path).await?;

        let (prompt_type, prompt) =
            get_vlm_prompt_info("Ollama", &self.model_name, &self.prompt_config);
        crate::logger::log_debug(&format!(
            "[Ollama Debug] Request: model='{}' file='{}' prompt_style={} granularity={} prompt_chars={} base_num_ctx={} image_b64_bytes={}",
            self.model_name,
            image_path.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
            prompt_type.name(),
            self.prompt_config.granularity.as_setting_str(),
            prompt.len(),
            self.base_num_ctx(),
            base64_img.len(),
        ));

        self.analyze_with_ctx_escalation(&prompt, vec![base64_img], "[single]")
            .await
    }

    async fn analyze_multi_frame(&self, frame_paths: &[PathBuf]) -> Result<AnalysisResult> {
        let mut base64_images = Vec::new();
        for path in frame_paths {
            if path.exists() {
                if let Ok(b64) = self.prepare_base64_image_async(path).await {
                    base64_images.push(b64);
                }
            }
        }

        if base64_images.is_empty() {
            return Err(anyhow!("No valid frames found for analysis"));
        }

        let (_, prompt) = get_vlm_prompt_info("Ollama", &self.model_name, &self.prompt_config);
        let multi_prompt = format!(
            "{}\n\nNote: Multiple sequential video frames (3 frames: pre, main, post) are provided above. Synthesize them to generate accurate tags and categories.",
            prompt
        );

        crate::logger::log_debug(&format!(
            "[Ollama Debug] Multi-frame request: model='{}' frames={} granularity={} base_num_ctx={}",
            self.model_name,
            base64_images.len(),
            self.prompt_config.granularity.as_setting_str(),
            self.base_num_ctx(),
        ));

        self.analyze_with_ctx_escalation(&multi_prompt, base64_images, "[multi-frame]")
            .await
    }

    async fn check_health(&self) -> Result<()> {
        let endpoint = format!("{}/api/tags", self.base_url.trim_end_matches('/'));
        let res = self.client.get(&endpoint).send().await?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(anyhow!("Ollama server health check failed with status: {}", res.status()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::TagGranularity;

    /// **本番の送信経路そのもの**で透過画像を解析し、タグを目で見るための計測用テスト。
    ///
    /// `tools/prompt-check` は合成済みのファイルを送るので、`prepare_base64_image` が
    /// 実際に市松で埋めているか・`drop_fill_artifact_tags` が効いているかは通らない。
    /// ここは `OllamaProvider::analyze_image` を直接叩くので、本番と同じ経路を通る。
    ///
    /// ```bash
    /// LOMA_VERIFY_IMAGES=<パス一覧のファイル> LOMA_VERIFY_MODEL=qwen3-vl:8b-instruct     ///   cargo test --release verify_transparent_pipeline -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore]
    async fn verify_transparent_pipeline() {
        let list_path = std::env::var("LOMA_VERIFY_IMAGES")
            .expect("LOMA_VERIFY_IMAGES にパス一覧のファイルを指定してください");
        let model = std::env::var("LOMA_VERIFY_MODEL")
            .unwrap_or_else(|_| "qwen3-vl:8b-instruct".to_string());
        let max_edge: u32 = std::env::var("LOMA_MAX_EDGE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1280);
        let want: usize = std::env::var("LOMA_VERIFY_COUNT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8);

        // 実利用の設定に合わせる（force_detailed = true / granularity = descriptive）
        let provider = OllamaProvider::new(
            "http://localhost:11434".to_string(),
            model.clone(),
            PromptConfig {
                granularity: TagGranularity::Descriptive,
                force_detailed: true,
            },
            0,
            max_edge,
        );

        let list = std::fs::read_to_string(&list_path).unwrap();
        let mut done = 0usize;
        let mut with_dark = 0usize;
        let mut with_checker = 0usize;
        for line in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if done >= want {
                break;
            }
            let path = std::path::Path::new(line);
            if !crate::image_io::file_has_visible_transparency(path) {
                continue;
            }
            match provider.analyze_image(path).await {
                Ok(mut result) => {
                    result.drop_fill_artifact_tags();
                    let names: Vec<String> = result
                        .tags
                        .iter()
                        .chain(result.descriptive_tags.iter())
                        .map(|t| t.en.to_lowercase())
                        .collect();
                    let dark = names.iter().any(|n| {
                        n.contains("black_background")
                            || n.contains("dark_background")
                            || n.contains("black_backdrop")
                    });
                    let checker = names.iter().any(|n| n.contains("checker"));
                    if dark {
                        with_dark += 1;
                    }
                    if checker {
                        with_checker += 1;
                    }
                    println!(
                        "{} tags={} desc={} {}{}
    {}",
                        path.file_name().unwrap_or_default().to_string_lossy(),
                        result.tags.len(),
                        result.descriptive_tags.len(),
                        if dark { "[黒背景タグあり] " } else { "" },
                        if checker { "[市松タグ残り] " } else { "" },
                        names.join(", ")
                    );
                }
                Err(e) => println!("{}  失敗: {}", path.display(), e),
            }
            done += 1;
        }
        println!("
{done} 件 / 黒背景タグ {with_dark} 件 / 市松タグの残り {with_checker} 件");
        assert_eq!(with_checker, 0, "市松のタグが除去できていない");
    }

    fn provider_with(granularity: TagGranularity, num_ctx: usize, max_edge: u32) -> OllamaProvider {
        OllamaProvider::new(
            "http://localhost:11434".to_string(),
            "qwen3-vl:30b".to_string(),
            PromptConfig { granularity, force_detailed: true },
            num_ctx,
            max_edge,
        )
    }

    #[test]
    fn base_num_ctx_prefers_explicit_user_setting() {
        let p = provider_with(TagGranularity::Descriptive, 4096, 1536);
        assert_eq!(p.base_num_ctx(), 4096);
    }

    #[test]
    fn base_num_ctx_auto_scales_with_granularity() {
        // 0 = 自動。粒度Lv3は推論トークンが伸びるため、従来の固定値8192より大きい必要がある
        let lv3 = provider_with(TagGranularity::Descriptive, 0, 1536).base_num_ctx();
        let lv1 = provider_with(TagGranularity::Atomic, 0, 1536).base_num_ctx();
        assert!(lv3 > 8192, "Lv3 num_ctx should exceed the legacy 8192 default, got {}", lv3);
        assert!(lv3 >= lv1);
    }

    #[test]
    fn expanded_num_ctx_carries_over_to_later_images() {
        // 1枚目で枯渇→拡張したら、同一スキャン内の以降の画像も拡張後の値から始める
        let p = provider_with(TagGranularity::Descriptive, 0, 1536);
        let initial = p.base_num_ctx();
        p.remember_expanded_num_ctx(initial * 2);
        assert_eq!(p.base_num_ctx(), initial * 2);
    }

    #[test]
    fn learned_num_ctx_never_regresses() {
        let p = provider_with(TagGranularity::Descriptive, 0, 1536);
        let initial = p.base_num_ctx();
        p.remember_expanded_num_ctx(initial * 2);
        // より小さい値を記録しても下がらない
        p.remember_expanded_num_ctx(initial);
        assert_eq!(p.base_num_ctx(), initial * 2);
    }

    #[test]
    fn downscaling_preserves_aspect_ratio() {
        // image クレートの resize は指定枠に収まるよう縦横比を保つ（resize_exact とは異なる）
        let src = image::DynamicImage::new_rgb8(3072, 4096);
        let out = src.resize(1536, 1536, image::imageops::FilterType::Triangle);
        assert_eq!((out.width(), out.height()), (1152, 1536));
        let src_ratio = 3072.0_f64 / 4096.0;
        let out_ratio = out.width() as f64 / out.height() as f64;
        assert!((src_ratio - out_ratio).abs() < 0.01);
    }

    #[test]
    fn downscaling_caps_the_longest_edge_for_landscape_too() {
        let src = image::DynamicImage::new_rgb8(4096, 3072);
        let out = src.resize(1536, 1536, image::imageops::FilterType::Triangle);
        assert_eq!((out.width(), out.height()), (1536, 1152));
    }

    #[test]
    fn truncate_for_log_caps_long_responses() {
        let long = "a".repeat(5000);
        let out = truncate_for_log(&long);
        assert!(out.contains("truncated"));
        assert!(out.chars().count() < 1700);
    }

    #[test]
    fn tail_for_log_keeps_the_end_where_truncation_happens() {
        let s = format!("{}NEEDLE", "x".repeat(5000));
        let out = tail_for_log(&s);
        assert!(out.ends_with("NEEDLE"));
        assert!(out.contains("chars omitted"));
    }

    /// 実機のOllamaに対する結合テスト。既定では無視される。
    /// 実行例:
    ///   set LOMA_TEST_IMAGE=D:\path\to\photo.jpg
    ///   cargo test live_ollama_descriptive_analysis -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires a running Ollama with qwen3-vl:30b"]
    async fn live_ollama_descriptive_analysis_succeeds_at_lv3() {
        let image = std::env::var("LOMA_TEST_IMAGE")
            .expect("set LOMA_TEST_IMAGE to an image path");
        crate::logger::set_llm_debug_enabled(true);

        let provider = provider_with(TagGranularity::Descriptive, 0, 1536);
        let result = provider
            .analyze_image(Path::new(&image))
            .await
            .expect("Lv3 analysis should succeed without exhausting the context");

        println!(
            "categories={:?} tags={} descriptive_tags={}",
            result.categories,
            result.tags.len(),
            result.descriptive_tags.len()
        );
        assert!(!result.tags.is_empty());
        assert!(
            !result.descriptive_tags.is_empty(),
            "Lv3 must produce descriptive tags"
        );
    }
}
