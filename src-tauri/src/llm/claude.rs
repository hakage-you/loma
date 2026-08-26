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
struct ImageSource {
    #[serde(rename = "type")]
    source_type: String,
    media_type: String,
    data: String,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum ClaudeContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { source: ImageSource },
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: Vec<ClaudeContent>,
}

#[derive(Serialize)]
struct ClaudeMessagesRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct ResponseContent {
    text: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeMessagesResponse {
    content: Vec<ResponseContent>,
}

pub struct ClaudeProvider {
    client: Client,
    api_key: String,
    model_name: String,
    prompt_config: PromptConfig,
}

impl ClaudeProvider {
    pub fn new(api_key: String, model_name: String, prompt_config: PromptConfig) -> Self {
        let model = if model_name.trim().is_empty() {
            "claude-3-5-sonnet-20241022".to_string()
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
impl LlmProvider for ClaudeProvider {
    fn name(&self) -> &str {
        "Anthropic Claude"
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    async fn analyze_image(&self, image_path: &Path) -> Result<AnalysisResult> {

        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Claude API Key is missing. Please set your API key in Settings."));
        }

        let base64_img = Self::prepare_base64_image(image_path)?;

        let prompt = get_vlm_prompt("Claude", &self.model_name, &self.prompt_config);
        let req_body = ClaudeMessagesRequest {
            model: self.model_name.clone(),
            max_tokens: 2048,
            messages: vec![Message {
                role: "user".to_string(),
                content: vec![
                    ClaudeContent::Text { text: prompt.to_string() },
                    ClaudeContent::Image {
                        source: ImageSource {
                            source_type: "base64".to_string(),
                            media_type: "image/jpeg".to_string(),
                            data: base64_img,
                        },
                    },
                ],
            }],
        };

        let endpoint = "https://api.anthropic.com/v1/messages";
        let res = self.client
            .post(endpoint)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&req_body)
            .send()
            .await?;

        let status = res.status();
        if status.as_u16() == 429 {
            return Err(anyhow!("Claude API Quota Exceeded (429 Rate Limit)"));
        }
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Claude API Error (HTTP {}): {}", status, err_text));
        }

        let claude_res: ClaudeMessagesResponse = res.json().await?;
        let raw_text = claude_res
            .content
            .first()
            .and_then(|c| c.text.as_ref())
            .ok_or_else(|| anyhow!("Claude returned empty response"))?;

        parse_analysis_result(raw_text)
    }

    async fn analyze_multi_frame(&self, frame_paths: &[PathBuf]) -> Result<AnalysisResult> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Claude API Key is missing. Please set your API key in Settings."));
        }

        let mut contents = Vec::new();
        for path in frame_paths {
            if path.exists() {
                if let Ok(b64) = Self::prepare_base64_image(path) {
                    contents.push(ClaudeContent::Image {
                        source: ImageSource {
                            source_type: "base64".to_string(),
                            media_type: "image/jpeg".to_string(),
                            data: b64,
                        },
                    });
                }
            }
        }

        if contents.is_empty() {
            return Err(anyhow!("No valid frames found for Claude multi-frame analysis"));
        }

        let prompt = get_vlm_prompt("Claude", &self.model_name, &self.prompt_config);
        let multi_prompt = format!(
            "{}\n\nNote: Multiple sequential video frames (3 frames: pre, main, post) are provided above. Synthesize them to generate accurate tags and categories.",
            prompt
        );

        contents.push(ClaudeContent::Text {
            text: multi_prompt,
        });

        let req_body = ClaudeMessagesRequest {
            model: self.model_name.clone(),
            max_tokens: 1024,
            messages: vec![Message {
                role: "user".to_string(),
                content: contents,
            }],
        };

        let endpoint = "https://api.anthropic.com/v1/messages";
        let res = self.client
            .post(endpoint)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&req_body)
            .send()
            .await?;

        let status = res.status();
        if status.as_u16() == 429 {
            return Err(anyhow!("Claude API Quota Exceeded (429 Rate Limit)"));
        }
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("Claude API Error (HTTP {}): {}", status, err_text));
        }

        let claude_res: ClaudeMessagesResponse = res.json().await?;
        let raw_text = claude_res
            .content
            .first()
            .and_then(|c| c.text.as_ref())
            .ok_or_else(|| anyhow!("Claude returned empty multi-frame response"))?;

        parse_analysis_result(raw_text)
    }

    async fn check_health(&self) -> Result<()> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("Claude API Key is not set"));
        }
        // AnthropicAPIには明示的な /health エンドポイントがないため無効なモデルへのリクエストステータスやキーの存在でチェック
        Ok(())
    }
}
