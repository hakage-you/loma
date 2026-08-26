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
struct ImageUrlDetail {
    url: String,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum MessageContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image_url")]
    ImageUrl { image_url: ImageUrlDetail },
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: Vec<MessageContent>,
}

#[derive(Serialize)]
struct OpenAiChatRequest {
    model: String,
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<Choice>,
}

pub struct OpenAiProvider {
    client: Client,
    api_key: String,
    base_url: String,
    model_name: String,
    prompt_config: PromptConfig,
}

impl OpenAiProvider {
    pub fn new(api_key: String, base_url: String, model_name: String, prompt_config: PromptConfig) -> Self {
        let url = if base_url.trim().is_empty() {
            "https://api.openai.com/v1".to_string()
        } else {
            base_url
        };
        let model = if model_name.trim().is_empty() {
            "gpt-4o-mini".to_string()
        } else {
            model_name
        };
        Self {
            client: Client::new(),
            api_key,
            base_url: url,
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
impl LlmProvider for OpenAiProvider {
    fn name(&self) -> &str {
        "OpenAI"
    }

    fn model_name(&self) -> &str {
        &self.model_name
    }

    async fn analyze_image(&self, image_path: &Path) -> Result<AnalysisResult> {

        if self.api_key.trim().is_empty() {
            return Err(anyhow!("OpenAI API Key is missing. Please set your API key in Settings."));
        }

        let base64_img = Self::prepare_base64_image(image_path)?;
        let data_url = format!("data:image/jpeg;base64,{}", base64_img);

        let prompt = get_vlm_prompt("OpenAI", &self.model_name, &self.prompt_config);
        let req_body = OpenAiChatRequest {
            model: self.model_name.clone(),
            messages: vec![Message {
                role: "user".to_string(),
                content: vec![
                    MessageContent::Text { text: prompt.to_string() },
                    MessageContent::ImageUrl { image_url: ImageUrlDetail { url: data_url } },
                ],
            }],
        };

        let endpoint = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let res = self.client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&req_body)
            .send()
            .await?;

        let status = res.status();
        if status.as_u16() == 429 {
            return Err(anyhow!("OpenAI API Quota Exceeded (429 Rate Limit)"));
        }
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("OpenAI API Error (HTTP {}): {}", status, err_text));
        }

        let chat_res: OpenAiChatResponse = res.json().await?;
        let raw_text = chat_res
            .choices
            .first()
            .and_then(|c| c.message.content.as_ref())
            .ok_or_else(|| anyhow!("OpenAI returned empty response"))?;

        parse_analysis_result(raw_text)
    }

    async fn analyze_multi_frame(&self, frame_paths: &[PathBuf]) -> Result<AnalysisResult> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("OpenAI API Key is missing. Please set your API key in Settings."));
        }

        let prompt = get_vlm_prompt("OpenAI", &self.model_name, &self.prompt_config);
        let multi_prompt = format!(
            "{}\n\nNote: Multiple sequential video frames (3 frames: pre, main, post) are provided above. Synthesize them to generate accurate tags and categories.",
            prompt
        );
        let mut contents = vec![MessageContent::Text {
            text: multi_prompt,
        }];

        for path in frame_paths {
            if path.exists() {
                if let Ok(b64) = Self::prepare_base64_image(path) {
                    let data_url = format!("data:image/jpeg;base64,{}", b64);
                    contents.push(MessageContent::ImageUrl { image_url: ImageUrlDetail { url: data_url } });
                }
            }
        }

        if contents.len() <= 1 {
            return Err(anyhow!("No valid frames found for OpenAI multi-frame analysis"));
        }

        let req_body = OpenAiChatRequest {
            model: self.model_name.clone(),
            messages: vec![Message {
                role: "user".to_string(),
                content: contents,
            }],
        };

        let endpoint = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let res = self.client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&req_body)
            .send()
            .await?;

        let status = res.status();
        if status.as_u16() == 429 {
            return Err(anyhow!("OpenAI API Quota Exceeded (429 Rate Limit)"));
        }
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(anyhow!("OpenAI API Error (HTTP {}): {}", status, err_text));
        }

        let chat_res: OpenAiChatResponse = res.json().await?;
        let raw_text = chat_res
            .choices
            .first()
            .and_then(|c| c.message.content.as_ref())
            .ok_or_else(|| anyhow!("OpenAI returned empty multi-frame response"))?;

        parse_analysis_result(raw_text)
    }

    async fn check_health(&self) -> Result<()> {
        if self.api_key.trim().is_empty() {
            return Err(anyhow!("OpenAI API Key is not set"));
        }
        let endpoint = format!("{}/models", self.base_url.trim_end_matches('/'));
        let res = self.client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(anyhow!("OpenAI health check failed: HTTP {}", res.status()))
        }
    }
}
