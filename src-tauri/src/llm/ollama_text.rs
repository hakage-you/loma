//! タグ整理のテキスト生成に使う Ollama クライアント。
//!
//! **画像経路（`ollama.rs`）とは別に持つ。** あちらは `analyze_image` の trait 実装で
//! 画像の縮小や num_ctx の学習を抱えており、タグ整理には要らないものが多い。
//! 逆にこちらには**あちらに無い歯止め**が要る（下記）。
//!
//! パラメータは実測で決めた値。詳細は
//! `_plan/20260805_tag_organize_rebuild_implementation_plan.md` §2。

use serde::Deserialize;
use std::time::{Duration, Instant};

/// 生成長は Ollama 側で止められないので、**時間で打ち切るしかない**。
///
/// - `num_ctx` は上限にならない。文脈が埋まるとシフトして生成が続く
///   （`num_ctx 8192` に対して `eval_count 19,512` の実測がある）
/// - `num_predict` は thinking が同じ枠を消費するため、答えを書く前に打ち切られる
///
/// 実測では1チャンク 30秒〜16分と振れ、16分の回も最終的に結果を返した。
pub const DEFAULT_TIMEOUT_SECS: u64 = 900;

/// 実測で決めた既定値。`_plan/...` §2 の表と対応する。
pub const DEFAULT_TEMPERATURE: f32 = 0.1;
pub const DEFAULT_NUM_CTX: usize = 32768;

#[derive(Debug, Clone)]
pub struct TextGenOptions {
    pub temperature: f32,
    pub num_ctx: usize,
    /// `None` はモデル既定。**タグ整理では両段とも `Some(false)`。**
    ///
    /// 出力の形が決まっている抽出タスクでは thinking が害になる（2026-08-07 実測）:
    ///
    /// - 段1（タグ名の列挙）: 切ると6〜15倍速い
    /// - 段2（カテゴリへの割り当て）: 切ると **回収率 54% → 90%**、30倍速い
    ///
    /// 段2は以前「切ると悪化する」と記録していたが、正解セットを固定して
    /// 測り直したら逆だった。詳細は `tag_organize.rs` の段2の呼び出し箇所。
    pub think: Option<bool>,
    pub timeout_secs: u64,
}

impl Default for TextGenOptions {
    fn default() -> Self {
        Self {
            temperature: DEFAULT_TEMPERATURE,
            num_ctx: DEFAULT_NUM_CTX,
            think: None,
            timeout_secs: DEFAULT_TIMEOUT_SECS,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct TextGenResponse {
    #[serde(default)]
    pub response: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub done_reason: Option<String>,
    #[serde(default)]
    pub prompt_eval_count: Option<u32>,
    #[serde(default)]
    pub eval_count: Option<u32>,
}

impl TextGenResponse {
    /// **「答えの途中で切れた」と「答えを出さずに発散した」は別物。**
    ///
    /// どちらも `done_reason == "length"` で返るが、診断も対策も違う。
    /// 実測: n=200 で `eval_count = 327,680`（`num_ctx` のちょうど10倍）を吐き、
    /// 応答は空だった。**プロンプトを短くしても直らない。この規模がモデルの限界という意味。**
    pub fn diverged(&self, num_ctx: usize) -> bool {
        self.done_reason.as_deref() == Some("length")
            && self.eval_count.unwrap_or(0) as usize >= num_ctx * 2
            && self.response.trim().is_empty()
    }

    /// 答えの途中で切れた（発散ではない）
    pub fn truncated(&self, num_ctx: usize) -> bool {
        self.done_reason.as_deref() == Some("length") && !self.diverged(num_ctx)
    }

    pub fn diagnostics(&self, num_ctx: usize, elapsed: Duration) -> String {
        format!(
            "done_reason={} num_ctx={} prompt_eval={} eval={} thinking_chars={} response_chars={} elapsed={:.1}s",
            self.done_reason.as_deref().unwrap_or("?"),
            num_ctx,
            self.prompt_eval_count.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
            self.eval_count.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
            self.thinking.as_deref().map(|t| t.len()).unwrap_or(0),
            self.response.len(),
            elapsed.as_secs_f64(),
        )
    }
}

#[derive(Debug)]
pub enum TextGenError {
    /// 時間切れ。**モデルの故障ではなく「この規模では終わらない」という測定値。**
    /// 呼び出し側は条件を変えて（thinking を切って）やり直す。
    Timeout { secs: u64 },
    /// Ollama 側の障害。`llama-server` が落ちる既知の issue を含む。
    /// **モデルの失敗と混ぜないこと。** 起きると全チャンクが一様に失敗し、
    /// 「モデルが処理できなかった」ように見える。復旧は Ollama の再起動。
    Environment(String),
    Http(String),
    Parse(String),
}

impl std::fmt::Display for TextGenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout { secs } => write!(f, "generation_timeout: {}秒を超えても応答がない", secs),
            Self::Environment(m) => write!(f, "environment_failure: {}", m),
            Self::Http(m) => write!(f, "http_error: {}", m),
            Self::Parse(m) => write!(f, "parse_error: {}", m),
        }
    }
}

/// モデルの失敗ではなく環境の障害かを判定する。
///
/// Ollama の `llama-server` は最新版で落ちることがある（既知 issue）。
/// これが起きると全モデル・全サイズが一様に失敗するので、計測結果と混ぜてはいけない。
pub fn is_environment_failure(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("llama-server process has terminated")
        || m.contains("0xc0000005")
        || m.contains("connection refused")
        || m.contains("socket hang up")
        || m.contains("connection reset")
        || m.contains("os error 10061") // Windows: 接続を拒否された
}

/// Ollama にテキスト生成を投げる。
///
/// **`format: "json"` は指定しない。** thinking 対応モデルに指定すると応答が `{}` に縮退し、
/// しかも `done_reason` は `"stop"`（正常終了）で返るためエラーにもならず静かに壊れる
/// （2026-07-29 実測）。JSON の抽出は呼び出し側が行う。
pub async fn generate(
    base_url: &str,
    model: &str,
    prompt: &str,
    opts: &TextGenOptions,
) -> Result<(TextGenResponse, Duration), TextGenError> {
    let mut options = serde_json::json!({
        "temperature": opts.temperature,
        "num_ctx": opts.num_ctx,
    });
    // num_predict は入れない（thinking が同じ枠を消費して答えを書く前に尽きる）
    let mut body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "options": options.take(),
    });
    if let Some(think) = opts.think {
        body["think"] = serde_json::Value::Bool(think);
    }

    // 送信内容の記録。**デバッグ設定が有効なときだけ。**
    // 「計測ツールでは動くのに本番で動かない」を切り分けるのに要る
    // （実測でプロンプトがバイト単位で同一だと確認できたのはこれ）。
    // プロンプトは長いので長さだけ出す。
    // `LOMA_DUMP_REQUEST=1` はテストから使う（設定DBを持たないため）
    if crate::logger::is_llm_debug_enabled() || std::env::var("LOMA_DUMP_REQUEST").is_ok() {
        let mut shown = body.clone();
        shown["prompt"] = serde_json::Value::String(format!("<{} bytes>", prompt.len()));
        crate::logger::log_debug(&format!("[ollama-text] request {}", shown));
        if std::env::var("LOMA_DUMP_REQUEST").is_ok() {
            eprintln!("LOMA_REQUEST {}", shown);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(opts.timeout_secs))
        .build()
        .map_err(|e| TextGenError::Http(e.to_string()))?;

    let started = Instant::now();
    let res = client
        .post(format!("{}/api/generate", base_url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                TextGenError::Timeout { secs: opts.timeout_secs }
            } else if is_environment_failure(&e.to_string()) {
                TextGenError::Environment(e.to_string())
            } else {
                TextGenError::Http(e.to_string())
            }
        })?;

    let status = res.status();
    let text = res.text().await.map_err(|e| TextGenError::Http(e.to_string()))?;
    if !status.is_success() {
        // Ollama は llama-server の異常終了を 500 の本文で返す
        return Err(if is_environment_failure(&text) {
            TextGenError::Environment(text.chars().take(300).collect())
        } else {
            TextGenError::Http(format!("{}: {}", status, text.chars().take(300).collect::<String>()))
        });
    }

    let parsed: TextGenResponse =
        serde_json::from_str(&text).map_err(|e| TextGenError::Parse(e.to_string()))?;
    Ok((parsed, started.elapsed()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_failure_is_separated_from_model_failure() {
        assert!(is_environment_failure(
            "llama-server process has terminated: exit status 0xc0000005"
        ));
        assert!(is_environment_failure("socket hang up"));
        assert!(is_environment_failure("tcp connect error: Connection refused"));
        // モデル側の応答内容は環境障害ではない
        assert!(!is_environment_failure("invalid json in response"));
        assert!(!is_environment_failure("model produced no groups"));
    }

    #[test]
    fn diverged_needs_all_three_signals() {
        let big = DEFAULT_NUM_CTX;
        // 発散: length + 大量生成 + 空応答
        let d = TextGenResponse {
            done_reason: Some("length".into()),
            eval_count: Some((big * 10) as u32),
            response: String::new(),
            ..Default::default()
        };
        assert!(d.diverged(big));
        assert!(!d.truncated(big));

        // 途中で切れた: length だが答えは出ている
        let t = TextGenResponse {
            done_reason: Some("length".into()),
            eval_count: Some((big * 10) as u32),
            response: "{\"target\":\"a\",\"members\":[\"b\"]}".into(),
            ..Default::default()
        };
        assert!(!t.diverged(big));
        assert!(t.truncated(big));

        // 正常終了はどちらでもない
        let ok = TextGenResponse {
            done_reason: Some("stop".into()),
            eval_count: Some(4142),
            response: "ok".into(),
            ..Default::default()
        };
        assert!(!ok.diverged(big));
        assert!(!ok.truncated(big));
    }
}
