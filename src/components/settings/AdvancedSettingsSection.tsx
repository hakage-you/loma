import React from 'react';
import { ChevronDown, Server, SlidersHorizontal, Trash2 } from 'lucide-react';
import { RecommendedModel } from '../../constants/recommendedModels';
import { useTranslation } from '../../contexts/I18nContext';
import { EmbeddingSettings } from '../../hooks/useEmbeddingSettings';
import { TooltipHelp } from '../TooltipHelp';
import { SpectrumSettingsSection } from './SpectrumSettingsSection';

interface Props {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;

  provider: string;
  setProvider: (v: string) => void;
  ollamaUrl: string;
  setOllamaUrl: (v: string) => void;
  forceDetailedPrompt: boolean;
  setForceDetailedPrompt: (v: boolean) => void;
  ffmpegNoticeEnabled: boolean;
  setFfmpegNoticeEnabled: (v: boolean) => void;
  llmDebugLogging: boolean;
  setLlmDebugLogging: (v: boolean) => void;
  ollamaNumCtx: string;
  setOllamaNumCtx: (v: string) => void;
  ollamaMaxImageEdge: string;
  setOllamaMaxImageEdge: (v: string) => void;

  /** VRAM の手動解放。渡されないときはボタンを出さない */
  onUnloadModel?: () => void;
  onManualUnload: () => void;
  unloadedStatus: boolean;

  emb: EmbeddingSettings;
  availableModels: string[];
  onSelectPreset: (item: RecommendedModel, targetType: 'vlm' | 'text' | 'embedding') => void;
}

/**
 * 詳細設定のアコーディオン。
 *
 * **基本設定（言語・モデル選択・タグ粒度）以外はすべてここに入る。**
 * 既定では畳んであり、普段触らないものを表に出さないための区画。
 */
export const AdvancedSettingsSection: React.FC<Props> = ({
  open,
  setOpen,
  provider,
  setProvider,
  ollamaUrl,
  setOllamaUrl,
  forceDetailedPrompt,
  setForceDetailedPrompt,
  ffmpegNoticeEnabled,
  setFfmpegNoticeEnabled,
  llmDebugLogging,
  setLlmDebugLogging,
  ollamaNumCtx,
  setOllamaNumCtx,
  ollamaMaxImageEdge,
  setOllamaMaxImageEdge,
  onUnloadModel,
  onManualUnload,
  unloadedStatus,
  emb,
  availableModels,
  onSelectPreset,
}) => {
  const { t } = useTranslation();

  return (
          <div className="bg-slate-900/50 rounded-xl border border-white/5 overflow-hidden">
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition cursor-pointer"
    >
      <span className="flex items-center gap-1.5 text-xs font-bold text-indigo-300 uppercase tracking-wider">
        <SlidersHorizontal className="w-3.5 h-3.5" />
        {t('settings.label_advanced_section', '詳細設定')}
      </span>
      <ChevronDown
        className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </button>

    {open && (
      <div className="px-4 pb-4 space-y-4 border-t border-white/5 pt-4">
        {/* LLM Provider Selection */}
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Server className="w-3.5 h-3.5 text-indigo-400" />
            <label className="text-xs font-semibold text-slate-300">
              {t('settings.label_provider_label', 'LLMプロバイダー選択')}
            </label>
            <TooltipHelp text={t('settings.provider_help', 'メディアの解析やタグ生成に使用するAIエンジンを選択します。Ollamaがローカル動作の標準プロバイダーです。')} />
          </div>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50"
          >
            <option value="ollama">Ollama</option>
            <option value="gemini">Google Gemini API [Unsupported]</option>
            <option value="openai">OpenAI API [Unsupported]</option>
            <option value="claude">Anthropic Claude API [Unsupported]</option>
          </select>
        </div>

        {/* Ollama Endpoint URL */}
        {provider === 'ollama' && (
          <div className="pt-3 border-t border-white/5">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Server className="w-3.5 h-3.5 text-indigo-400" />
              <label className="text-xs font-semibold text-slate-300">
                {t('settings.label_ollama_url', 'Ollama API エンドポイント URL')}
              </label>
              <TooltipHelp text={t('settings.ollama_url_help', 'ローカルまたはリモートで稼働中のOllamaサーバーの接続URLです（デフォルト: http://localhost:11434）。')} />
            </div>
            <input
              type="text"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              placeholder="http://localhost:11434"
              className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
            />
          </div>
        )}

        {/* Force Detailed Prompt Mode (applies to cloud providers too) */}
        <div className="flex items-center justify-between pt-3 border-t border-white/5">
          <label className="text-xs font-semibold text-slate-300 cursor-pointer select-none flex items-center gap-2">
            <input
              type="checkbox"
              checked={forceDetailedPrompt}
              onChange={(e) => setForceDetailedPrompt(e.target.checked)}
              className="rounded border-white/10 bg-slate-950 text-indigo-600 focus:ring-0 cursor-pointer"
            />
            <span>{t('settings.label_force_detailed_mode', '高精度プロンプトモード (DETAILED) を強制適用する')}</span>
          </label>
          <TooltipHelp align="right" text={t('settings.force_detailed_help', '軽量モデル（8B未満など）で高精度モードを強制すると、モデルが高度な文脈指示や構造化JSONを解釈できず解析エラーの原因となる場合があります。OFF推奨（判定失敗時に自動で軽量モードへフォールバックします）。')} />
        </div>

        {/* FFmpeg Notice Toggle */}
        <div className="flex items-center justify-between pt-3 border-t border-white/5">
          <label className="text-xs font-semibold text-slate-300 cursor-pointer select-none flex items-center gap-2">
            <input
              type="checkbox"
              checked={ffmpegNoticeEnabled}
              onChange={(e) => setFfmpegNoticeEnabled(e.target.checked)}
              className="rounded border-white/10 bg-slate-950 text-indigo-600 focus:ring-0 cursor-pointer"
            />
            <span>{t('settings.label_ffmpeg_notice', 'FFmpeg未インストール時のアナウンス通知を表示')}</span>
          </label>
          <TooltipHelp align="right" text={t('settings.ffmpeg_notice_help', '動画解析に必要なFFmpegが見つからない場合のアナウンス通知アイコンの表示を切り替えます。')} />
        </div>

        {/* Ollama Diagnostics & Tuning */}
        {provider === 'ollama' && (
          <div className="pt-3 border-t border-white/5 space-y-3">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide">
              {t('settings.label_ollama_advanced', 'Ollama 詳細・診断')}
            </h4>

            {/* 縦並び: コンテキスト長 → 最大長辺 */}
            <div className="flex flex-col gap-3">
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.label_ollama_num_ctx', 'コンテキスト長 (num_ctx)')}
                  </label>
                  <TooltipHelp text={t('settings.ollama_num_ctx_help', '0で自動（タグ粒度に応じて8192〜16384を選択）。qwen3-vl等の思考モデルは応答本文の前に大量の推論トークンを消費するため、コンテキストが不足すると生成が途中で打ち切られ空応答となりリトライが多発します。不足時は自動的に2倍へ拡張されます。')} />
                </div>
                <input
                  type="number"
                  min={0}
                  step={1024}
                  value={ollamaNumCtx}
                  onChange={(e) => setOllamaNumCtx(e.target.value)}
                  placeholder={t('settings.label_placeholder_auto', '0 (auto)')}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
                />
              </div>

              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.label_ollama_max_image_edge', '送信画像の最大長辺 (px)')}
                  </label>
                  <TooltipHelp text={t('settings.ollama_max_image_edge_help', '解析前に画像をこのサイズまで縮小して送信します（0で無効）。縦横比は保たれます。12MPの写真は画像だけで約4000トークンを消費するため、縮小するとコンテキストに余裕が生まれ解析も高速化します。文字認識精度を優先する場合は大きめの値に設定してください。')} />
                </div>
                <input
                  type="number"
                  min={0}
                  step={256}
                  value={ollamaMaxImageEdge}
                  onChange={(e) => setOllamaMaxImageEdge(e.target.value)}
                  placeholder="1536"
                  className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-slate-300 cursor-pointer select-none flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={llmDebugLogging}
                  onChange={(e) => setLlmDebugLogging(e.target.checked)}
                  className="rounded border-white/10 bg-slate-950 text-indigo-600 focus:ring-0 cursor-pointer"
                />
                <span>{t('settings.label_llm_debug_logging', 'LLM診断ログを出力する（開発用）')}</span>
              </label>
              <TooltipHelp align="right" text={t('settings.llm_debug_logging_help', 'リクエストごとにプロンプト種別・num_ctx・トークン消費量・終了理由(done_reason)を、解析失敗時には生レスポンスをログへ記録します。リトライの原因調査に使用します。ログ量が増えるため通常はOFFにしてください。')} />
            </div>
          </div>
        )}

        {/* Manual VRAM Unload for Ollama */}
        {provider === 'ollama' && onUnloadModel && (
          <div className="pt-3 border-t border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-300 font-medium">{t('settings.label_manual_unload', 'Free VRAM manually')}</span>
              <TooltipHelp text={t('settings.unload_vram_help', 'Ollamaでロード中のモデルをVRAMから即座にメモリ解放（アンロード）します。WebUIや他のアプリケーション等で同一モデルを使用中の場合でも、VRAMからアンロードされます。')} />
            </div>
            <button
              onClick={onManualUnload}
              className="flex items-center gap-1.5 px-3 py-1 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-semibold transition cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              {unloadedStatus ? t('settings.label_unloaded', 'Freed') : t('settings.label_unload', 'Free VRAM')}
            </button>
          </div>
        )}
        <SpectrumSettingsSection
          emb={emb}
          availableModels={availableModels}
          onSelectPreset={onSelectPreset}
        />
      </div>
    )}
          </div>
  );
};
