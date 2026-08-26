use std::path::{Path, PathBuf};
use async_trait::async_trait;
use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

use super::traits::LlmProvider;
use super::{
    get_vlm_prompt, parse_analysis_result, AnalysisResult, PromptConfig, IMAGE_ENCODE_ERROR,
};

#[derive(Serialize)]
struct InlineData {
    mime_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Part {
    Text { text: String },
    InlineData { inline_data: InlineData },
}

#[derive(Serialize)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Serialize)]
struct GeminiGenerateRequest {
    contents: Vec<Content>,
}

#[derive(Deserialize)]
struct ResponsePart {
    text: Option<String>,
}

#[derive(Deserialize)]
struct ResponseContent {
    parts: Vec<ResponsePart>,
}

#[derive(Deserialize)]
struct Candidate {
    content: ResponseContent,
}

#[derive(Deserialize)]
struct GeminiGenerateResponse {
    candidates: Option<Vec<Candidate>>,
    error: Option<GeminiError>,
}

#[derive(Deserialize)]
struct GeminiError {
    message: String,
    code: Option<i32>,
}

pub struct GeminiProvider {
    client: Client,
    api_key: String,
    model_name: String,
    prompt_config: PromptConfig,
}

impl GeminiProvider {
    pub fn new(api_key: String, model_name: String, prompt_config: PromptConfig) -> Self {
        let model = if model_name.trim().is_empty() {
            "gemini-2.0-flash".to_string()
        } else {
            model_name
        };

        Self {
            client: Client::new(),
            api_key,
            model_name: model,
            prompt_config,
        }
    }

    fn prepare_base64_image(image_path: &Path) -> Result<String> {
        // デコードできないファイルを生バイトのまま送らないこと。送るとAPI側が
        // 400 を返し、ファイル1件の問題がスキャン全体の中断に化ける。
        // 拡張子ではなく中身でデコーダを選ぶ理由は decode_image のコメントを参照。
        let img = crate::image_io::decode_image(image_path)?;
        let rgb_img = img.to_rgb8();
        let mut buffer = std::io::Cursor::new(Vec::new());
        rgb_img
            .write_to(&mut buffer, image::ImageFormat::Jpeg)
            .map_err(|e| anyhow!("{}: {} ({})", IMAGE_ENCODE_ERROR, image_path.display(), e))?;
        Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            buffer.into_inner(),
        ))
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    fn name(&self) -> &str {
        "Google Gemini"
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    async fn analyze_image(&self, image_path: &Path) -> Result<AnalysisResult> {

        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Gemini API Key is missing. Please set your API key in Settings."));
        }

        let base64_img = Self::prepare_base64_image(image_path)?;

        let prompt = get_vlm_prompt("Google Gemini", &self.model_name, &self.prompt_config);
        let req_body = GeminiGenerateRequest {
            contents: vec![Content {
                parts: vec![
                    Part::Text { text: prompt.to_string() },
                    Part::InlineData {
                        inline_data: InlineData {
                            mime_type: "image/jpeg".to_string(),
                            data: base64_img,
                        },
                    },
                ],
            }],
        };

        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.model_name, self.api_key
        );

        let res = self.client
            .post(&endpoint)
            .json(&req_body)
            .send()
            .await?;

        let status = res.status();
        if status.as_u16() == 429 {
            return Err(anyhow!("Gemini API Quota Exceeded (429 Rate Limit)"));
        }

        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Gemini API Error (HTTP {}): {}", status, err_text));
        }

        let gemini_res: GeminiGenerateResponse = res.json().await?;
        if let Some(err) = gemini_res.error {
            return Err(anyhow!(
                "Gemini API Internal Error (code {:?}): {}",
                err.code,
                err.message
            ));
        }

        let raw_text = gemini_res
            .candidates
            .as_ref()
            .and_then(|c| c.first())
            .and_then(|c| c.content.parts.first())
            .and_then(|p| p.text.as_ref())
            .ok_or_else(|| anyhow!("Gemini returned empty response"))?;

        parse_analysis_result(raw_text)
    }

    async fn analyze_multi_frame(&self, frame_paths: &[PathBuf]) -> Result<AnalysisResult> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Gemini API Key is missing. Please set your API key in Settings."));
        }

        let prompt = get_vlm_prompt("Google Gemini", &self.model_name, &self.prompt_config);
        let multi_prompt = format!(
            "{}\n\nNote: Multiple sequential video frames (3 frames: pre, main, post) are provided above. Synthesize them to generate accurate tags and categories.",
            prompt
        );

        let mut parts = vec![Part::Text {
            text: multi_prompt,
        }];

        for path in frame_paths {
            if path.exists() {
                if let Ok(b64) = Self::prepare_base64_image(path) {
                    parts.push(Part::InlineData {
                        inline_data: InlineData {
                            mime_type: "image/jpeg".to_string(),
                            data: b64,
                        },
                    });
                }
            }
        }

        if parts.len() <= 1 {
            return Err(anyhow!("No valid frames found for Gemini multi-frame analysis"));
        }

        let req_body = GeminiGenerateRequest {
            contents: vec![Content { parts }],
        };

        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            self.model_name, self.api_key
        );

        let res = self.client
            .post(&endpoint)
            .json(&req_body)
            .send()
            .await?;

        let status = res.status();
        if status.as_u16() == 429 {
            return Err(anyhow!("Gemini API Quota Exceeded (429 Rate Limit)"));
        }

        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Gemini API Error (HTTP {}): {}", status, err_text));
        }

        let gemini_res: GeminiGenerateResponse = res.json().await?;
        let raw_text = gemini_res
            .candidates
            .as_ref()
            .and_then(|c| c.first())
            .and_then(|c| c.content.parts.first())
            .and_then(|p| p.text.as_ref())
            .ok_or_else(|| anyhow!("Gemini returned empty multi-frame response"))?;

        parse_analysis_result(raw_text)
    }

    async fn check_health(&self) -> Result<()> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Gemini API Key is not set"));
        }
        let endpoint = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}?key={}",
            self.model_name, self.api_key
        );
        let res = self.client.get(&endpoint).send().await?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(anyhow!("Gemini health check failed: HTTP {}", res.status()))
        }
    }
}
