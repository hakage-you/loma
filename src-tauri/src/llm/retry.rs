use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use async_trait::async_trait;
use anyhow::{anyhow, Result};
use tokio::time::sleep;
use tauri::{AppHandle, Emitter};

use super::traits::LlmProvider;
use super::AnalysisResult;
use crate::batch::ProgressPayload;

#[derive(Clone)]
pub struct RetryContext {
    pub app_handle: AppHandle,
    pub cancel_flag: Arc<AtomicBool>,
    pub total: usize,
    pub current: usize,
    pub current_file: String,
    pub error_count: usize,
}

pub struct RetryingLlmProvider {
    inner: Arc<dyn LlmProvider>,
    max_attempts: u32,
    _base_delay_sec: u64,
    context: Arc<Mutex<Option<RetryContext>>>,
}

impl RetryingLlmProvider {
    pub fn new(inner: Arc<dyn LlmProvider>, max_attempts: u32, base_delay_sec: u64) -> Self {
        Self {
            inner,
            max_attempts: max_attempts.max(1),
            _base_delay_sec: base_delay_sec,
            context: Arc::new(Mutex::new(None)),
        }
    }

    fn is_rate_limit(err_msg: &str) -> bool {
        super::is_rate_limit(err_msg)
    }

    /// コンテキスト枯渇はリトライしても同じ結果になるため、一時障害として扱わない。
    /// （OllamaProvider 側で num_ctx を拡張して再試行済み）
    fn is_context_exhausted(err_msg: &str) -> bool {
        super::is_context_exhausted(err_msg)
    }

    fn is_transient_server_error(err_msg: &str) -> bool {
        super::is_transient_server_error(err_msg)
    }

    /// クォータ復旧待ち時間を大きく確保するバックオフ秒数の計算 (429 Rate Limit 用)
    fn calculate_long_backoff_sec(&self, attempt: u32) -> u64 {
        let base_wait = match attempt {
            1 => 60,       // 1分
            2 => 300,      // 5分
            3 => 1800,     // 30分
            _ => 3600,     // 60分
        };
        let jitter = (attempt as u64 * 3) % 6;
        base_wait + jitter
    }

    /// サーバー一時障害・過負荷用の短周期指数バックオフ秒数計算 (503 / 500 等用)
    fn calculate_short_backoff_sec(&self, attempt: u32) -> u64 {
        let base_wait = match attempt {
            1 => 3,   // 3秒
            2 => 6,   // 6秒
            3 => 12,  // 12秒
            4 => 24,  // 24秒
            _ => 30,  // 30秒
        };
        let jitter = (attempt as u64 * 2) % 3;
        base_wait + jitter
    }

    fn format_duration_desc(seconds: u64) -> String {
        if seconds >= 3600 {
            format!("{} hour(s) ({}s)", seconds / 3600, seconds)
        } else if seconds >= 60 {
            format!("{} minute(s) ({}s)", seconds / 60, seconds)
        } else {
            format!("{} seconds", seconds)
        }
    }

    /// 1秒ごとのスリープ・リアルタイムカウントダウン・即時キャンセルチェック
    async fn sleep_and_emit_countdown(
        &self,
        wait_sec: u64,
        reason_label: &str,
        attempt: u32,
        max_att: u32,
    ) -> Result<()> {
        for remaining in (1..=wait_sec).rev() {
            // 1. キャンセルフラグの即時チェック
            if let Ok(lock) = self.context.lock() {
                if let Some(ref ctx) = *lock {
                    if ctx.cancel_flag.load(Ordering::Relaxed) {
                        crate::logger::log_info(&format!(
                            "[Scan Cancelled] Cancelled during the '{}' wait (attempt {}/{}, {}s of the backoff remaining).",
                            reason_label, attempt, max_att, remaining
                        ));
                        return Err(anyhow!("Scan cancelled during API retry wait"));
                    }
                }
            }

            // 2. UIおよびログへの1秒ごとの進捗更新
            let duration_desc = Self::format_duration_desc(remaining);
            let status_msg = format!(
                "[{}] Waiting for API recovery (Attempt {}/{}): {} remaining...",
                reason_label, attempt, max_att, duration_desc
            );

            if let Ok(lock) = self.context.lock() {
                if let Some(ref ctx) = *lock {
                    let _ = ctx.app_handle.emit(
                        "batch_progress",
                        ProgressPayload {
                            total: ctx.total,
                            current: ctx.current,
                            current_file: ctx.current_file.clone(),
                            status: status_msg.clone(),
                            error_count: ctx.error_count,
                            is_paused: false,
                        },
                    );
                }
            }

            // 1秒をまとめて待つとキャンセル検知が最大1秒遅れるため、100ms 刻みで待機する
            for _ in 0..10 {
                if let Ok(lock) = self.context.lock() {
                    if let Some(ref ctx) = *lock {
                        if ctx.cancel_flag.load(Ordering::Relaxed) {
                            crate::logger::log_info(&format!(
                                "[Scan Cancelled] Cancelled during the '{}' wait (attempt {}/{}, {}s of the backoff remaining).",
                                reason_label, attempt, max_att, remaining
                            ));
                            return Err(anyhow!("Scan cancelled during API retry wait"));
                        }
                    }
                }
                sleep(Duration::from_millis(100)).await;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl LlmProvider for RetryingLlmProvider {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn model_name(&self) -> &str {
        self.inner.model_name()
    }

    fn status_message(&self, is_first: bool) -> String {
        self.inner.status_message(is_first)
    }

    fn update_progress_context(
        &self,
        app_handle: &AppHandle,
        cancel_flag: &Arc<AtomicBool>,
        total: usize,
        current: usize,
        current_file: &str,
        error_count: usize,
    ) {
        if let Ok(mut lock) = self.context.lock() {
            *lock = Some(RetryContext {
                app_handle: app_handle.clone(),
                cancel_flag: cancel_flag.clone(),
                total,
                current,
                current_file: current_file.to_string(),
                error_count,
            });
        }
    }

    async fn analyze_image(&self, image_path: &Path) -> Result<AnalysisResult> {
        let mut attempt = 0;
        let transient_max_attempts = 5;
        loop {
            attempt += 1;
            match self.inner.analyze_image(image_path).await {
                Ok(res) => return Ok(res),
                Err(err) => {
                    let err_msg = err.to_string();

                    if Self::is_context_exhausted(&err_msg) {
                        // 同一条件での再試行は無意味なため、即座に失敗として扱う
                        crate::logger::log_error(&format!(
                            "[Retry Aborted] Context exhausted - retrying would not help: {}",
                            err_msg
                        ));
                        return Err(err);
                    }

                    if Self::is_rate_limit(&err_msg) && attempt < self.max_attempts {
                        let wait_time = self.calculate_long_backoff_sec(attempt);
                        let duration_desc = Self::format_duration_desc(wait_time);
                        let log_msg = format!(
                            "[API Quota Recovery] Rate/Quota limit hit (Attempt {}/{}). Pausing for {} to allow API quota to recover...",
                            attempt, self.max_attempts, duration_desc
                        );
                        crate::logger::log_info(&log_msg);
                        eprintln!("{}", log_msg);
                        
                        self.sleep_and_emit_countdown(wait_time, "Quota Limit Recovery", attempt, self.max_attempts).await?;
                    } else if Self::is_transient_server_error(&err_msg) && attempt < transient_max_attempts {
                        let is_ollama = self.inner.name().to_lowercase().contains("ollama");
                        let wait_time = if is_ollama { 0 } else { self.calculate_short_backoff_sec(attempt) };

                        if wait_time > 0 {
                            let duration_desc = Self::format_duration_desc(wait_time);
                            let log_msg = format!(
                                "[API Transient Error Recovery] Model or server temporarily unresponsive (Attempt {}/{}). Retrying in {}... Cause: {}",
                                attempt, transient_max_attempts, duration_desc, err_msg
                            );
                            crate::logger::log_info(&log_msg);
                            eprintln!("{}", log_msg);
                            self.sleep_and_emit_countdown(wait_time, "API Retry Wait", attempt, transient_max_attempts).await?;
                        } else {
                            // 原因究明のため、リトライを誘発した実際のエラー内容を必ず残す
                            let log_msg = format!(
                                "[Ollama Instant Retry] Model temporarily unresponsive (Attempt {}/{}). Retrying immediately... Cause: {}",
                                attempt, transient_max_attempts, err_msg
                            );
                            crate::logger::log_info(&log_msg);
                        }
                    } else {
                        return Err(err);
                    }
                }
            }
        }
    }

    async fn analyze_multi_frame(&self, frame_paths: &[PathBuf]) -> Result<AnalysisResult> {
        let mut attempt = 0;
        let transient_max_attempts = 5;
        loop {
            attempt += 1;
            match self.inner.analyze_multi_frame(frame_paths).await {
                Ok(res) => return Ok(res),
                Err(err) => {
                    let err_msg = err.to_string();

                    if Self::is_context_exhausted(&err_msg) {
                        // 同一条件での再試行は無意味なため、即座に失敗として扱う
                        crate::logger::log_error(&format!(
                            "[Retry Aborted] Context exhausted - retrying would not help: {}",
                            err_msg
                        ));
                        return Err(err);
                    }

                    if Self::is_rate_limit(&err_msg) && attempt < self.max_attempts {
                        let wait_time = self.calculate_long_backoff_sec(attempt);
                        let duration_desc = Self::format_duration_desc(wait_time);
                        let log_msg = format!(
                            "[API Quota Recovery] Multi-frame Rate/Quota limit hit (Attempt {}/{}). Pausing for {} to allow API quota to recover...",
                            attempt, self.max_attempts, duration_desc
                        );
                        crate::logger::log_info(&log_msg);
                        eprintln!("{}", log_msg);

                        self.sleep_and_emit_countdown(wait_time, "Quota Limit Recovery", attempt, self.max_attempts).await?;
                    } else if Self::is_transient_server_error(&err_msg) && attempt < transient_max_attempts {
                        let is_ollama = self.inner.name().to_lowercase().contains("ollama");
                        let wait_time = if is_ollama { 0 } else { self.calculate_short_backoff_sec(attempt) };

                        if wait_time > 0 {
                            let duration_desc = Self::format_duration_desc(wait_time);
                            let log_msg = format!(
                                "[API Transient Error Recovery] Multi-frame Model or server temporarily unresponsive (Attempt {}/{}). Retrying in {}... Cause: {}",
                                attempt, transient_max_attempts, duration_desc, err_msg
                            );
                            crate::logger::log_info(&log_msg);
                            eprintln!("{}", log_msg);
                            self.sleep_and_emit_countdown(wait_time, "API Retry Wait", attempt, transient_max_attempts).await?;
                        } else {
                            let log_msg = format!(
                                "[Ollama Instant Retry] Multi-frame Model temporarily unresponsive (Attempt {}/{}). Retrying immediately... Cause: {}",
                                attempt, transient_max_attempts, err_msg
                            );
                            crate::logger::log_info(&log_msg);
                        }
                    } else {
                        return Err(err);
                    }
                }
            }
        }
    }

    async fn check_health(&self) -> Result<()> {
        self.inner.check_health().await
    }
}
