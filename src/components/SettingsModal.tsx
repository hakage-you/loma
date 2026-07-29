import React, { useState, useEffect } from 'react';
import { Settings, RefreshCw, Check, X, Server, Cpu, FileText, Trash2, AlertTriangle, ShieldAlert, Download, Sparkles, Loader2, HelpCircle, HardDrive, Layers, FlaskConical, Info, SlidersHorizontal, ChevronDown, Radar } from 'lucide-react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  RECOMMENDED_VLM_MODELS,
  RECOMMENDED_TEXT_MODELS,
  RECOMMENDED_EMBEDDING_MODELS,
  RecommendedModel,
} from '../constants/recommendedModels';
import {
  OllamaPullProgressPayload,
  TagGranularity,
  GranularityComparisonItem,
  EmbeddingStatus,
  EmbeddingProgressPayload,
  EmbeddingDiagnostics,
} from '../types';
import { useTranslation } from '../contexts/I18nContext';

interface SettingsModalProps {
  open: boolean;
  settings: Record<string, string>;
  availableModels: string[];
  onClose: () => void;
  onUpdateSetting: (key: string, value: string) => Promise<void>;
  onFetchModels: () => Promise<void>;
  onUnloadModel?: () => Promise<void>;
}

// Hover-activated instant tooltip component (with smart positioning)
const TooltipHelp: React.FC<{ text: string; align?: 'left' | 'right' | 'center' }> = ({ text, align = 'left' }) => {
  const containerClasses =
    align === 'right'
      ? 'right-0 bottom-full mb-2'
      : align === 'center'
      ? 'left-1/2 -translate-x-1/2 bottom-full mb-2'
      : 'left-0 bottom-full mb-2';

  const arrowClasses =
    align === 'right'
      ? 'right-2'
      : align === 'center'
      ? 'left-1/2 -translate-x-1/2'
      : 'left-2';

  return (
    <div className="relative group inline-flex items-center">
      <HelpCircle className="w-3.5 h-3.5 text-slate-400 hover:text-indigo-300 transition cursor-help shrink-0" />
      <div className={`absolute ${containerClasses} hidden group-hover:block z-50 w-64 p-2.5 bg-slate-900 border border-indigo-500/50 rounded-xl text-[11px] text-slate-200 shadow-2xl backdrop-blur-md pointer-events-none leading-relaxed animate-in fade-in zoom-in-95 duration-150`}>
        {text}
        <div className={`absolute top-full ${arrowClasses} border-4 border-transparent border-t-slate-900`} />
      </div>
    </div>
  );
};

// Flexible installed model matching helper (checks model family/base)
const isModelInstalled = (recommendedName: string, availableList: string[]): boolean => {
  if (!availableList || availableList.length === 0) return false;
  const target = recommendedName.toLowerCase().trim();
  const targetBase = target.split(':')[0];

  return availableList.some((installed) => {
    const inst = installed.toLowerCase().trim();
    const instBase = inst.split(':')[0];

    if (inst === target) return true;
    if (inst.startsWith(target) || target.startsWith(inst)) return true;
    if (instBase === targetBase) return true;
    return false;
  });
};

// Precise selected model matching helper (strictly checks size tag e.g. 30b vs 8b vs 4b)
const isModelSelected = (recommendedName: string, selectedModel: string): boolean => {
  if (!selectedModel) return false;
  const rec = recommendedName.toLowerCase().trim();
  const sel = selectedModel.toLowerCase().trim();
  if (rec === sel) return true;

  const recParts = rec.split(':');
  const selParts = sel.split(':');

  const recBase = recParts[0];
  const selBase = selParts[0];
  const recTag = recParts[1] || '';
  const selTag = selParts[1] || '';

  if (recBase === selBase) {
    if (recTag && selTag) {
      return recTag === selTag || selTag.startsWith(recTag) || recTag.startsWith(selTag);
    }
    return !recTag && !selTag;
  }
  return false;
};

// タグ付与粒度レベルの定義（基本語タグは常に5〜10個で固定、記述的タグのみレベルで変動する）
const GRANULARITY_LEVELS: { value: TagGranularity; labelKey: string; labelDefault: string; descriptiveRange: string }[] = [
  { value: 'atomic', labelKey: 'settings.granularity_atomic', labelDefault: 'Lv1: 分解重視（現行）', descriptiveRange: '基本語タグ 5〜10個 / 記述的タグなし' },
  { value: 'balanced', labelKey: 'settings.granularity_balanced', labelDefault: 'Lv2: バランス', descriptiveRange: '基本語タグ 5〜10個 + 記述的タグ 1〜3個' },
  { value: 'descriptive', labelKey: 'settings.granularity_descriptive', labelDefault: 'Lv3: 記述重視', descriptiveRange: '基本語タグ 5〜10個 + 記述的タグ 3〜6個' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  availableModels,
  onClose,
  onUpdateSetting,
  onFetchModels,
  onUnloadModel,
}) => {
  const { t } = useTranslation();
  const [provider, setProvider] = useState(settings.llm_provider || 'ollama');

  // Ollama
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollama_url || 'http://localhost:11434');
  const [selectedVlmModel, setSelectedVlmModel] = useState(settings.ollama_model || 'qwen3-vl:30b');
  const [selectedTextModel, setSelectedTextModel] = useState(settings.ollama_text_model || 'qwen3:14b');
  // 0 = タグ粒度から自動決定
  const [ollamaNumCtx, setOllamaNumCtx] = useState(settings.ollama_num_ctx ?? '0');
  const [ollamaMaxImageEdge, setOllamaMaxImageEdge] = useState(settings.ollama_max_image_edge ?? '1536');
  const [llmDebugLogging, setLlmDebugLogging] = useState<boolean>(settings.llm_debug_logging === 'true');

  // 解析プロンプト設定（プロバイダ非依存の共通設定）
  const [forceDetailedPrompt, setForceDetailedPrompt] = useState<boolean>(settings.force_detailed_prompt === 'true');
  const [tagGranularity, setTagGranularity] = useState<TagGranularity>((settings.tag_granularity as TagGranularity) || 'atomic');
  const [effectivePromptType, setEffectivePromptType] = useState<'DETAILED' | 'LIGHT' | null>(null);

  // 粒度比較（検証用）
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [compareResults, setCompareResults] = useState<GranularityComparisonItem[]>([]);
  const [compareProgress, setCompareProgress] = useState<Record<TagGranularity, 'pending' | 'running' | 'done'>>({
    atomic: 'pending',
    balanced: 'pending',
    descriptive: 'pending',
  });
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareImagePath, setCompareImagePath] = useState<string | null>(null);
  const [compareImageEnlarged, setCompareImageEnlarged] = useState(false);

  // 概念スペクトラム検索（タグ埋め込み）
  const [embeddingModel, setEmbeddingModel] = useState(settings.spectrum_embedding_model || 'bge-m3');
  const [spectrumIncludeDescriptive, setSpectrumIncludeDescriptive] = useState<boolean>(
    settings.spectrum_include_descriptive === 'true',
  );
  const [spectrumCentering, setSpectrumCentering] = useState<boolean>(settings.spectrum_centering !== 'false');
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus | null>(null);
  const [embeddingProgress, setEmbeddingProgress] = useState<EmbeddingProgressPayload | null>(null);
  const [isGeneratingEmbeddings, setIsGeneratingEmbeddings] = useState(false);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<EmbeddingDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);

  const refreshEmbeddingStatus = async () => {
    try {
      setEmbeddingStatus(await invoke<EmbeddingStatus>('get_embedding_status'));
    } catch (e) {
      setEmbeddingError(String(e));
    }
  };

  // System VRAM
  const [vramGb, setVramGb] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      onFetchModels().catch(() => {});
      invoke<number>('get_system_vram_gb')
        .then((gb: number) => setVramGb(gb))
        .catch(() => setVramGb(0.0));
      refreshEmbeddingStatus();
    }
  }, [open]);

  // Ollama Model Download State
  const [confirmDownloadModal, setConfirmDownloadModal] = useState<{
    model: RecommendedModel;
    targetType: 'vlm' | 'text' | 'embedding';
  } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<OllamaPullProgressPayload | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);

  // Gemini
  const [geminiModel, setGeminiModel] = useState(settings.gemini_model || 'gemini-2.0-flash');
  const [geminiTextModel, setGeminiTextModel] = useState(settings.gemini_text_model || 'gemini-3.5-flash-lite');
  const [geminiApiKey, setGeminiApiKey] = useState('');

  // OpenAI
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState(settings.openai_base_url || 'https://api.openai.com/v1');
  const [openaiModel, setOpenaiModel] = useState(settings.openai_model || 'gpt-4o-mini');
  const [openaiApiKey, setOpenaiApiKey] = useState('');

  // Claude
  const [claudeModel, setClaudeModel] = useState(settings.claude_model || 'claude-3-5-sonnet-20241022');
  const [claudeTextModel, setClaudeTextModel] = useState(settings.claude_text_model || 'claude-3-5-haiku-20241022');
  const [claudeApiKey, setClaudeApiKey] = useState('');

  // External LLM Settings
  const [extMaxBatchItems, setExtMaxBatchItems] = useState(settings.ext_llm_max_batch_items || '50');
  const [extRetryEnabled, setExtRetryEnabled] = useState(settings.ext_llm_retry_enabled !== 'false');
  const [extRetryAttempts, setExtRetryAttempts] = useState(settings.ext_llm_retry_max_attempts || '3');

  // General Settings
  const [uiLanguage, setUiLanguage] = useState<'ja' | 'en'>((settings.ui_language as any) || 'ja');
  const [ffmpegNoticeEnabled, setFfmpegNoticeEnabled] = useState<boolean>(settings.ffmpeg_notice_enabled !== 'false');

  const [loadingModels, setLoadingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedStatus, setSavedStatus] = useState(false);
  const [unloadedStatus, setUnloadedStatus] = useState(false);
  // 基本設定（言語・モデル選択・タグ粒度）以外をまとめる詳細設定アコーディオンの開閉
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    if (settings.llm_provider) setProvider(settings.llm_provider);
    if (settings.ollama_url) setOllamaUrl(settings.ollama_url);
    if (settings.ollama_model) setSelectedVlmModel(settings.ollama_model);
    if (settings.ollama_text_model) setSelectedTextModel(settings.ollama_text_model);
    if (settings.ollama_num_ctx !== undefined) setOllamaNumCtx(settings.ollama_num_ctx);
    if (settings.ollama_max_image_edge !== undefined) setOllamaMaxImageEdge(settings.ollama_max_image_edge);
    if (settings.llm_debug_logging !== undefined) setLlmDebugLogging(settings.llm_debug_logging === 'true');
    if (settings.force_detailed_prompt !== undefined) setForceDetailedPrompt(settings.force_detailed_prompt === 'true');
    if (settings.tag_granularity) setTagGranularity(settings.tag_granularity as TagGranularity);

    if (settings.spectrum_embedding_model) setEmbeddingModel(settings.spectrum_embedding_model);
    if (settings.spectrum_include_descriptive !== undefined)
      setSpectrumIncludeDescriptive(settings.spectrum_include_descriptive === 'true');
    if (settings.spectrum_centering !== undefined) setSpectrumCentering(settings.spectrum_centering !== 'false');

    if (settings.gemini_model) setGeminiModel(settings.gemini_model);
    if (settings.gemini_text_model) setGeminiTextModel(settings.gemini_text_model);

    if (settings.openai_base_url) setOpenaiBaseUrl(settings.openai_base_url);
    if (settings.openai_model) setOpenaiModel(settings.openai_model);

    if (settings.claude_model) setClaudeModel(settings.claude_model);
    if (settings.claude_text_model) setClaudeTextModel(settings.claude_text_model);

    if (settings.ext_llm_max_batch_items) setExtMaxBatchItems(settings.ext_llm_max_batch_items);
    if (settings.ext_llm_retry_enabled !== undefined) setExtRetryEnabled(settings.ext_llm_retry_enabled === 'true');
    if (settings.ext_llm_retry_max_attempts) setExtRetryAttempts(settings.ext_llm_retry_max_attempts);
    if (settings.ui_language) setUiLanguage(settings.ui_language as any);
    if (settings.ffmpeg_notice_enabled !== undefined) setFfmpegNoticeEnabled(settings.ffmpeg_notice_enabled !== 'false');

    // Fetch API keys from Windows Credential Store
    invoke<string>('get_provider_api_key', { provider: 'gemini' })
      .then((key) => setGeminiApiKey(key || ''))
      .catch(() => { });
    invoke<string>('get_provider_api_key', { provider: 'openai' })
      .then((key) => setOpenaiApiKey(key || ''))
      .catch(() => { });
    invoke<string>('get_provider_api_key', { provider: 'claude' })
      .then((key) => setClaudeApiKey(key || ''))
      .catch(() => { });
  }, [settings, open]);

  // 現在選択中のプロバイダー・モデル・強制フラグから、実際に使用されるプロンプト種別を都度問い合わせる。
  // 未保存の選択状態（モデルのドロップダウンを変えた直後など）も正しく反映するため、
  // 保存済み設定ではなくローカルstateを渡す。
  useEffect(() => {
    if (!open) return;
    const modelForProvider =
      provider === 'gemini' ? geminiModel :
      provider === 'openai' ? openaiModel :
      provider === 'claude' ? claudeModel :
      selectedVlmModel;

    invoke<string>('get_effective_prompt_type', {
      provider,
      model: modelForProvider,
      forceDetailed: forceDetailedPrompt,
    })
      .then((result) => setEffectivePromptType(result as 'DETAILED' | 'LIGHT'))
      .catch(() => setEffectivePromptType(null));
  }, [open, provider, selectedVlmModel, geminiModel, openaiModel, claudeModel, forceDetailedPrompt]);

  if (!open) return null;

  const isGranularityDisabled = effectivePromptType === 'LIGHT';
  const hasGranularityChanged = tagGranularity !== ((settings.tag_granularity as TagGranularity) || 'atomic');

  const handleTryGranularity = async () => {
    let unlisten: (() => void) | null = null;
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (!selected || typeof selected !== 'string') return;

      setCompareModalOpen(true);
      setCompareError(null);
      setCompareResults([]);
      setCompareImagePath(selected);
      setCompareProgress({ atomic: 'pending', balanced: 'pending', descriptive: 'pending' });

      // レベルごとの完了をモーダル内に逐次反映するため、全件完了を待たずイベントを購読する
      unlisten = await listen<{ status: 'running' | 'done'; item: GranularityComparisonItem | null; granularity: TagGranularity }>(
        'granularity_comparison_progress',
        (event) => {
          const { status, item, granularity } = event.payload;
          setCompareProgress((prev) => ({ ...prev, [granularity]: status }));
          if (status === 'done' && item) {
            setCompareResults((prev) => [...prev.filter((r) => r.granularity !== granularity), item]);
          }
        }
      );

      // イベントは逐次表示用の補助。最終的な整合性は戻り値で確定させる
      // (モック環境などイベントが発火しない場合でも結果が表示されるようにするため)
      const results = await invoke<GranularityComparisonItem[]>('compare_granularity_levels', { imagePath: selected });
      setCompareResults(results);
      setCompareProgress({ atomic: 'done', balanced: 'done', descriptive: 'done' });
    } catch (e: any) {
      setCompareError(String(e?.message || e));
    } finally {
      if (unlisten) unlisten();
    }
  };

  const handleRefreshModels = async () => {
    setLoadingModels(true);
    await onFetchModels();
    setLoadingModels(false);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onUpdateSetting('llm_provider', provider);
      await onUpdateSetting('ollama_url', ollamaUrl);
      await onUpdateSetting('ollama_model', selectedVlmModel);
      await onUpdateSetting('ollama_text_model', selectedTextModel);
      // 空欄・不正値は自動(0) / 既定値(1536) にフォールバックさせる
      await onUpdateSetting('ollama_num_ctx', String(Math.max(0, parseInt(ollamaNumCtx, 10) || 0)));
      await onUpdateSetting(
        'ollama_max_image_edge',
        String(Math.max(0, Number.isFinite(parseInt(ollamaMaxImageEdge, 10)) ? parseInt(ollamaMaxImageEdge, 10) : 1536)),
      );
      await onUpdateSetting('llm_debug_logging', llmDebugLogging ? 'true' : 'false');
      await onUpdateSetting('force_detailed_prompt', forceDetailedPrompt ? 'true' : 'false');
      await onUpdateSetting('tag_granularity', tagGranularity);

      await onUpdateSetting('gemini_model', geminiModel);
      await onUpdateSetting('gemini_text_model', geminiTextModel);

      await onUpdateSetting('openai_base_url', openaiBaseUrl);
      await onUpdateSetting('openai_model', openaiModel);

      await onUpdateSetting('claude_model', claudeModel);
      await onUpdateSetting('claude_text_model', claudeTextModel);

      await onUpdateSetting('ext_llm_max_batch_items', extMaxBatchItems);
      await onUpdateSetting('ext_llm_retry_enabled', extRetryEnabled ? 'true' : 'false');
      await onUpdateSetting('ext_llm_retry_max_attempts', extRetryAttempts);
      await onUpdateSetting('ui_language', uiLanguage);
      await onUpdateSetting('ffmpeg_notice_enabled', ffmpegNoticeEnabled ? 'true' : 'false');

      await onUpdateSetting('spectrum_embedding_model', embeddingModel);
      await onUpdateSetting('spectrum_include_descriptive', spectrumIncludeDescriptive ? 'true' : 'false');
      await onUpdateSetting('spectrum_centering', spectrumCentering ? 'true' : 'false');

      // Save API keys to OS Secure Store
      await invoke('save_provider_api_key', { provider: 'gemini', apiKey: geminiApiKey });
      await invoke('save_provider_api_key', { provider: 'openai', apiKey: openaiApiKey });
      await invoke('save_provider_api_key', { provider: 'claude', apiKey: claudeApiKey });

      setSavedStatus(true);
      setTimeout(() => {
        setSavedStatus(false);
        setIsSaving(false);
        onClose();
      }, 700);
    } catch (e) {
      console.error('Failed to save settings:', e);
      setIsSaving(false);
    }
  };

  const handleManualUnload = async () => {
    if (onUnloadModel) {
      await onUnloadModel();
      setUnloadedStatus(true);
      setTimeout(() => setUnloadedStatus(false), 2000);
    }
  };

  const handleSelectPreset = async (item: RecommendedModel, targetType: 'vlm' | 'text' | 'embedding') => {
    const installedModelName = availableModels.find((m) => isModelInstalled(item.name, [m]));
    if (installedModelName) {
      if (targetType === 'vlm') {
        setSelectedVlmModel(installedModelName);
      } else if (targetType === 'text') {
        setSelectedTextModel(installedModelName);
      } else {
        setEmbeddingModel(installedModelName);
      }
    } else {
      setConfirmDownloadModal({ model: item, targetType });
    }
  };

  /**
   * 未ベクトル化タグを一括生成する。
   * スキャン・タグマージと同じグローバルロックを共有するため、実行中は他の処理が弾かれる。
   */
  const handleGenerateEmbeddings = async () => {
    setEmbeddingError(null);
    setIsGeneratingEmbeddings(true);
    setEmbeddingProgress({ total: 0, current: 0, status: 'running' });
    const unlistenPromise = listen<EmbeddingProgressPayload>('embedding_progress', (event) => {
      setEmbeddingProgress(event.payload);
    });
    try {
      await invoke('generate_tag_embeddings');
      await refreshEmbeddingStatus();
    } catch (e) {
      setEmbeddingError(String(e));
    } finally {
      setIsGeneratingEmbeddings(false);
      unlistenPromise.then((unlisten) => unlisten());
    }
  };

  const handleRunDiagnostics = async () => {
    setDiagnosticsLoading(true);
    setEmbeddingError(null);
    try {
      setDiagnostics(await invoke<EmbeddingDiagnostics>('get_embedding_diagnostics'));
    } catch (e) {
      setEmbeddingError(String(e));
      setDiagnostics(null);
    } finally {
      setDiagnosticsLoading(false);
    }
  };

  const handleStartDownload = async () => {
    if (!confirmDownloadModal) return;
    const targetModel = confirmDownloadModal.model;
    const targetType = confirmDownloadModal.targetType;
    setConfirmDownloadModal(null);

    setIsDownloading(true);
    setDownloadProgress({
      model: targetModel.name,
      status: 'ダウンロードを開始しています...',
      completed: 0,
      total: 0,
      percent: 0,
      done: false,
    });

    const unlistenPromise = listen<OllamaPullProgressPayload>('ollama-pull-progress', async (event) => {
      const payload = event.payload;
      setDownloadProgress(payload);
      if (payload.done) {
        setIsDownloading(false);
        if (!payload.error && payload.percent >= 99) {
          await onFetchModels();
          if (targetType === 'vlm') {
            setSelectedVlmModel(targetModel.name);
          } else if (targetType === 'text') {
            setSelectedTextModel(targetModel.name);
          } else {
            setEmbeddingModel(targetModel.name);
          }
        }
      }
    });

    try {
      await invoke('pull_ollama_model', { modelName: targetModel.name });
    } catch (err: any) {
      console.error('Pull model error:', err);
    } finally {
      unlistenPromise.then((unlisten) => unlisten());
    }
  };

  const handleCancelDownload = async () => {
    try {
      await invoke('cancel_ollama_pull');
      setIsDownloading(false);
      setDownloadProgress(null);
    } catch (e) {
      console.error('Cancel pull error:', e);
    }
  };

  // Determine best recommended VLM model based on system VRAM
  const getBestVlmModelName = () => {
    if (!vramGb || vramGb <= 0) return null;
    if (vramGb >= 20.0) return 'qwen3-vl:30b';
    if (vramGb >= 12.0) return 'gemma4:12b';
    if (vramGb >= 6.0) return 'qwen3-vl:8b';
    return 'qwen3-vl:4b';
  };
  const bestVlmName = getBestVlmModelName();

  // Determine best recommended Text model based on system VRAM
  const getBestTextModelName = () => {
    if (!vramGb || vramGb <= 0) return null;
    if (vramGb >= 12.0) return 'qwen3:14b';
    if (vramGb >= 6.0) return 'qwen2.5:7b';
    return 'qwen2.5:3b';
  };
  const bestTextName = getBestTextModelName();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="glass-panel w-full max-w-2xl p-6 rounded-2xl shadow-2xl border border-indigo-500/30 flex flex-col max-h-[90vh] overflow-y-auto select-none">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white">{t('settings.title', '設定')}</h3>
              <p className="text-xs text-slate-400">Configure LLM Provider & Analysis Parameters</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-5 space-y-5">
          {/* General App Settings (Language) */}
          <div className="p-4 bg-slate-900/50 rounded-xl border border-white/5 space-y-3">
            <h4 className="text-xs font-bold text-indigo-300 uppercase tracking-wider">{t('settings.general', '一般設定')}</h4>

            <div className="flex flex-col gap-3.5">
              {/* Language Selection */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-[11px] font-semibold text-slate-300">
                    {t('settings.language', 'UI表示言語')}
                  </label>
                  <TooltipHelp text={t('settings.language_help', 'アプリケーション全体の表示言語（日本語 / English）を切り替えます。')} />
                </div>
                <select
                  value={uiLanguage}
                  onChange={(e) => setUiLanguage(e.target.value as any)}
                  className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="ja">日本語 (Japanese)</option>
                  <option value="en">English (US)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Analysis Prompt Settings (provider-independent common section) */}
          <div className="p-4 bg-slate-900/50 rounded-xl border border-white/5 space-y-3.5">
            <h4 className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" />
              {t('settings.prompt_section', '解析プロンプト設定')}
            </h4>

            {/* Tag Granularity Selection */}
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  {t('settings.tag_granularity', 'タグ粒度')}
                </label>
                <TooltipHelp text={t('settings.tag_granularity_help', 'DETAILEDプロンプト使用時の、タグの分解度合いを設定します。基本語タグは常に5〜10個で維持され、記述的タグ（例:「雨に濡れた木」）が粒度に応じて追加されます。')} />
              </div>

              <select
                value={tagGranularity}
                onChange={(e) => setTagGranularity(e.target.value as TagGranularity)}
                disabled={isGranularityDisabled}
                className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {GRANULARITY_LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {t(level.labelKey, level.labelDefault)}
                  </option>
                ))}
              </select>

              <p className="mt-1.5 text-[10px] text-slate-400">
                {GRANULARITY_LEVELS.find((l) => l.value === tagGranularity)?.descriptiveRange}
              </p>

              {isGranularityDisabled && (
                <div className="mt-2.5 p-2.5 bg-slate-950/60 border border-white/10 rounded-lg text-[11px] text-slate-400 flex items-start gap-1.5">
                  <Info className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />
                  <span>{t('settings.granularity_disabled_light', '現在のモデルは軽量プロンプト(LIGHT)で動作するため、タグ粒度設定は適用されません。下部の「詳細設定」を開き、「高精度プロンプトモード (DETAILED) を強制適用する」を有効にすると使用できます。')}</span>
                </div>
              )}

              <div className="mt-3">
                <button
                  onClick={handleTryGranularity}
                  disabled={isGranularityDisabled}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-white/10 rounded-lg text-[11px] font-semibold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                  {t('settings.granularity_try', '粒度を試す（画像を選択）')}
                </button>
              </div>
            </div>
          </div>

          {/* Privacy Disclaimer Banner for External LLMs */}
          {provider !== 'ollama' && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2 text-amber-300 text-[11px] leading-relaxed">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold text-amber-200">⚠️ 非公式機能 & プライバシー免責事項: </span>
                外部LLMプロバイダー利用時のデータ送信およびプライバシーの取り扱いは**選択したプロバイダーの利用規約に準拠**します。
                Loma 開発者は外部プロバイダーへのデータ送信や第三者サーバーでのデータ取り扱い・保管について**一切の責任を負いません**。
              </div>
            </div>
          )}

          {/* Provider Specific Settings (Ollama) */}
          {provider === 'ollama' && (
            <div className="space-y-4 p-4 bg-slate-900/50 rounded-xl border border-white/5">
              {/* Ollama Not Installed Warning Banner */}
              {availableModels.length === 0 && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-300 text-xs leading-relaxed flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    {t('settings.ollama_not_installed', 'Ollamaがインストールされていないか、サービスが起動していません。ローカルVLM機能を使用するにはOllamaを起動またはインストールしてください。')}
                  </div>
                </div>
              )}

              {/* Download Progress Banner inside Settings */}
              {(isDownloading || downloadProgress) && (
                <div className="p-3.5 bg-slate-900 border border-indigo-500/40 rounded-xl space-y-2.5 animate-in fade-in">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-bold text-white flex items-center gap-1.5">
                      <Loader2 className={`w-3.5 h-3.5 text-indigo-400 ${isDownloading ? 'animate-spin' : ''}`} />
                      ダウンロード中: <span className="font-mono text-indigo-300">{downloadProgress?.model}</span>
                    </span>
                    <span className="font-mono font-bold text-indigo-400">
                      {downloadProgress?.percent.toFixed(1)}%
                    </span>
                  </div>

                  <div className="w-full h-2 bg-slate-950 rounded-full overflow-hidden border border-white/10">
                    <div
                      className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-200"
                      style={{ width: `${Math.max(2, downloadProgress?.percent || 0)}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span className="truncate max-w-[280px]" title={downloadProgress?.status}>
                      {downloadProgress?.status}
                    </span>
                    <span className="font-mono">
                      {downloadProgress?.completed ? (downloadProgress.completed / (1024 * 1024)).toFixed(0) : 0} MB /{' '}
                      {downloadProgress?.total ? (downloadProgress.total / (1024 * 1024)).toFixed(0) : 0} MB
                    </span>
                  </div>

                  {isDownloading && (
                    <div className="flex justify-end pt-1">
                      <button
                        onClick={handleCancelDownload}
                        className="text-xs text-rose-400 hover:text-rose-300 flex items-center gap-1 font-semibold cursor-pointer"
                      >
                        <X className="w-3.5 h-3.5" />
                        ダウンロードをキャンセル
                      </button>
                    </div>
                  )}

                  {downloadProgress?.done && downloadProgress.error && (
                    <div className="p-2 bg-rose-500/10 border border-rose-500/30 rounded-lg text-rose-300 text-xs">
                      ⚠️ {downloadProgress.error}
                    </div>
                  )}

                  {downloadProgress?.done && !downloadProgress.error && (
                    <div className="p-2 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-emerald-300 text-xs flex items-center gap-1.5 font-semibold">
                      <Check className="w-4 h-4 text-emerald-400" />
                      ダウンロードが完了し、モデルとして自動設定されました！
                    </div>
                  )}
                </div>
              )}

              {/* Vision VLM Selection */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                    <label className="text-xs font-semibold text-slate-300">
                      {t('settings.vlm_model', '使用するVLM (視覚言語) モデル')}
                    </label>
                    <TooltipHelp text={t('settings.vlm_model_help', '画像や動画フレームの解釈・説明文の自動作成を行う視覚言語モデル（例: minicpm-v, llama3.2-vision）を選択します。')} />
                  </div>
                  <button
                    onClick={handleRefreshModels}
                    disabled={loadingModels}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} />
                    モデル一覧取得
                  </button>
                </div>
                <select
                  value={selectedVlmModel}
                  onChange={(e) => setSelectedVlmModel(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50"
                >
                  {availableModels.length === 0 ? (
                    <option value={selectedVlmModel}>{selectedVlmModel} (Current)</option>
                  ) : (
                    availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m} {m.includes('qwen3-vl') || m.includes('llava') || m.includes('vision') || m.includes('gemma4') ? '⭐ [Vision VLM]' : ''}
                      </option>
                    ))
                  )}
                </select>

                {/* VLM Recommended Preset Cards */}
                <div className="mt-3 space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      おすすめ VLM プリセット (クリックして選択 / 自動DL)
                    </span>
                    {vramGb !== null && vramGb > 0 && (
                      <span className="text-[10px] text-indigo-300 font-mono flex items-center gap-1">
                        <HardDrive className="w-3 h-3 text-indigo-400" /> 検出VRAM: ~{vramGb.toFixed(1)} GB
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {RECOMMENDED_VLM_MODELS.map((item) => {
                      const isInstalled = isModelInstalled(item.name, availableModels);
                      const isSelected = isModelSelected(item.name, selectedVlmModel);
                      const isBestMatch = bestVlmName !== null && item.name === bestVlmName;

                      const badgeColor =
                        item.badge === 'Lightweight'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : item.badge === 'Standard'
                            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                            : 'bg-purple-500/10 text-purple-400 border-purple-500/20';

                      return (
                        <div
                          key={item.name}
                          onClick={() => handleSelectPreset(item, 'vlm')}
                          className={`p-2.5 rounded-xl border text-left cursor-pointer transition flex flex-col justify-between relative overflow-hidden ${
                            isBestMatch
                              ? 'bg-indigo-950/80 border-indigo-500 shadow-xl shadow-indigo-500/20 hover:border-indigo-500/30 hover:bg-slate-800/50'
                              : isSelected
                              ? 'bg-indigo-950/60 border-indigo-500/60 shadow-lg shadow-indigo-500/10 hover:border-indigo-500/30 hover:bg-slate-800/50'
                              : 'bg-slate-900/80 border-white/5 hover:border-indigo-500/30 hover:bg-slate-800/50'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-1 mb-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${badgeColor}`}>
                                  {item.badgeJa}
                                </span>
                                {isBestMatch && (
                                  <span className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow">
                                    {t('settings.recommended_vram_best', '★ VRAM適合のおすすめ')}
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">{item.size}</span>
                            </div>
                            <div className="text-xs font-bold text-white font-mono mt-0.5">{item.name}</div>
                            <p className="text-[10px] text-slate-400 mt-1 line-clamp-2 leading-tight">
                              {item.description}
                            </p>
                          </div>

                          <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between">
                            {loadingModels ? (
                              <span className="text-[10px] font-medium text-slate-400 flex items-center gap-1">
                                <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" /> 読み込み中...
                              </span>
                            ) : isDownloading && downloadProgress?.model === item.name ? (
                              <span className="text-[10px] font-medium text-amber-400 flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin text-amber-400" /> インストール中...
                              </span>
                            ) : isInstalled ? (
                              <span className="text-[10px] font-medium text-emerald-400 flex items-center gap-1">
                                <Check className="w-3 h-3" /> インストール済
                              </span>
                            ) : (
                              <span className="text-[10px] font-medium text-indigo-400 flex items-center gap-1 hover:text-indigo-300">
                                <Download className="w-3 h-3" /> 要DL
                              </span>
                            )}
                            {isSelected && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-indigo-600 text-white rounded font-bold">
                                選択中
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Text LLM Selection & Presets */}
              <div className="pt-2 border-t border-white/5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <FileText className="w-3.5 h-3.5 text-indigo-400" />
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.text_model', 'テキスト解析・タグ翻訳モデル')}
                  </label>
                  <TooltipHelp text={t('settings.text_model_help', 'VLMが生成した説明文から日本語/英語のタグ構造化やカテゴリ分類を行う言語モデル（例: qwen2.5, llama3.1）を選択します。')} />
                </div>
                <select
                  value={selectedTextModel}
                  onChange={(e) => setSelectedTextModel(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50"
                >
                  {availableModels.length === 0 ? (
                    <option value={selectedTextModel}>{selectedTextModel} (Current)</option>
                  ) : (
                    availableModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))
                  )}
                </select>

                {/* Text LLM Recommended Preset Cards */}
                <div className="mt-2.5 space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      おすすめ Text LLM プリセット (クリックして選択 / 自動DL)
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {RECOMMENDED_TEXT_MODELS.map((item) => {
                      const isInstalled = isModelInstalled(item.name, availableModels);
                      const isSelected = isModelSelected(item.name, selectedTextModel);
                      const isBestMatch = bestTextName !== null && item.name === bestTextName;

                      const badgeColor =
                        item.badge === 'Lightweight'
                          ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                          : item.badge === 'Standard'
                            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                            : 'bg-purple-500/10 text-purple-400 border-purple-500/20';

                      return (
                        <div
                          key={item.name}
                          onClick={() => handleSelectPreset(item, 'text')}
                          className={`p-2.5 rounded-xl border text-left cursor-pointer transition flex flex-col justify-between relative overflow-hidden ${
                            isBestMatch
                              ? 'bg-indigo-950/80 border-indigo-500 shadow-xl shadow-indigo-500/20 hover:border-indigo-500/30 hover:bg-slate-800/50'
                              : isSelected
                              ? 'bg-indigo-950/60 border-indigo-500/60 shadow-lg shadow-indigo-500/10 hover:border-indigo-500/30 hover:bg-slate-800/50'
                              : 'bg-slate-900/80 border-white/5 hover:border-indigo-500/30 hover:bg-slate-800/50'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-1 mb-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${badgeColor}`}>
                                  {item.badgeJa}
                                </span>
                                {isBestMatch && (
                                  <span className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow">
                                    {t('settings.recommended_vram_best', '★ VRAM適合のおすすめ')}
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-slate-400 font-mono shrink-0">{item.size}</span>
                            </div>
                            <div className="text-xs font-bold text-white font-mono mt-0.5">{item.name}</div>
                            <p className="text-[10px] text-slate-400 mt-1 line-clamp-2 leading-tight">
                              {item.description}
                            </p>
                          </div>

                          <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between">
                            {loadingModels ? (
                              <span className="text-[10px] font-medium text-slate-400 flex items-center gap-1">
                                <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" /> 読み込み中...
                              </span>
                            ) : isDownloading && downloadProgress?.model === item.name ? (
                              <span className="text-[10px] font-medium text-amber-400 flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin text-amber-400" /> インストール中...
                              </span>
                            ) : isInstalled ? (
                              <span className="text-[10px] font-medium text-emerald-400 flex items-center gap-1">
                                <Check className="w-3 h-3" /> インストール済
                              </span>
                            ) : (
                              <span className="text-[10px] font-medium text-indigo-400 flex items-center gap-1 hover:text-indigo-300">
                                <Download className="w-3 h-3" /> 要DL
                              </span>
                            )}
                            {isSelected && (
                              <span className="text-[9px] px-1.5 py-0.5 bg-indigo-600 text-white rounded font-bold">
                                選択中
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Advanced Settings Accordion
              基本設定（言語・モデル選択・タグ粒度）以外はすべてここへ格納する */}
          <div className="bg-slate-900/50 rounded-xl border border-white/5 overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/5 transition cursor-pointer"
            >
              <span className="flex items-center gap-1.5 text-xs font-bold text-indigo-300 uppercase tracking-wider">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                {t('settings.advanced_section', '詳細設定')}
              </span>
              <ChevronDown
                className={`w-4 h-4 text-slate-400 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {advancedOpen && (
              <div className="px-4 pb-4 space-y-4 border-t border-white/5 pt-4">
                {/* LLM Provider Selection */}
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Server className="w-3.5 h-3.5 text-indigo-400" />
                    <label className="text-xs font-semibold text-slate-300">
                      {t('settings.provider_label', 'LLMプロバイダー選択')}
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
                        {t('settings.ollama_url', 'Ollama API エンドポイント URL')}
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
                    <span>{t('settings.force_detailed_mode', '高精度プロンプトモード (DETAILED) を強制適用する')}</span>
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
                    <span>{t('settings.ffmpeg_notice', 'FFmpeg未インストール時のアナウンス通知を表示')}</span>
                  </label>
                  <TooltipHelp align="right" text={t('settings.ffmpeg_notice_help', '動画解析に必要なFFmpegが見つからない場合のアナウンス通知アイコンの表示を切り替えます。')} />
                </div>

                {/* Ollama Diagnostics & Tuning */}
                {provider === 'ollama' && (
                  <div className="pt-3 border-t border-white/5 space-y-3">
                    <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                      {t('settings.ollama_advanced', 'Ollama 詳細・診断')}
                    </h4>

                    {/* 縦並び: コンテキスト長 → 最大長辺 */}
                    <div className="flex flex-col gap-3">
                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <label className="text-xs font-semibold text-slate-300">
                            {t('settings.ollama_num_ctx', 'コンテキスト長 (num_ctx)')}
                          </label>
                          <TooltipHelp text={t('settings.ollama_num_ctx_help', '0で自動（タグ粒度に応じて8192〜16384を選択）。qwen3-vl等の思考モデルは応答本文の前に大量の推論トークンを消費するため、コンテキストが不足すると生成が途中で打ち切られ空応答となりリトライが多発します。不足時は自動的に2倍へ拡張されます。')} />
                        </div>
                        <input
                          type="number"
                          min={0}
                          step={1024}
                          value={ollamaNumCtx}
                          onChange={(e) => setOllamaNumCtx(e.target.value)}
                          placeholder="0 (自動)"
                          className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
                        />
                      </div>

                      <div>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <label className="text-xs font-semibold text-slate-300">
                            {t('settings.ollama_max_image_edge', '送信画像の最大長辺 (px)')}
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
                        <span>{t('settings.llm_debug_logging', 'LLM診断ログを出力する（開発用）')}</span>
                      </label>
                      <TooltipHelp align="right" text={t('settings.llm_debug_logging_help', 'リクエストごとにプロンプト種別・num_ctx・トークン消費量・終了理由(done_reason)を、解析失敗時には生レスポンスをログへ記録します。リトライの原因調査に使用します。ログ量が増えるため通常はOFFにしてください。')} />
                    </div>
                  </div>
                )}

                {/* Manual VRAM Unload for Ollama */}
                {provider === 'ollama' && onUnloadModel && (
                  <div className="pt-3 border-t border-white/5 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-300 font-medium">手動VRAMメモリ解放</span>
                      <TooltipHelp text={t('settings.unload_vram_help', 'Ollamaでロード中のモデルをVRAMから即座にメモリ解放（アンロード）します。WebUIや他のアプリケーション等で同一モデルを使用中の場合でも、VRAMからアンロードされます。')} />
                    </div>
                    <button
                      onClick={handleManualUnload}
                      className="flex items-center gap-1.5 px-3 py-1 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-semibold transition cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      {unloadedStatus ? '解放完了!' : 'VRAMメモリ解放'}
                    </button>
                  </div>
                )}
                {/* 概念スペクトラム検索（タグ埋め込み） */}
                <div className="pt-3 border-t border-white/5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Radar className="w-3.5 h-3.5 text-indigo-400" />
                    <label className="text-xs font-semibold text-slate-300">
                      {t('settings.spectrum_section', '似ているメディアの検索（タグのベクトル化）')}
                    </label>
                    <TooltipHelp
                      text={t(
                        'settings.spectrum_help',
                        'タグの意味をベクトル化し、タグが完全一致しなくても意味的に近いメディアを探せるようにします。ベクトル化は手動で実行する必要があり、スキャン処理には影響しません。',
                      )}
                    />
                  </div>

                  <select
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50"
                  >
                    {availableModels.length === 0 ? (
                      <option value={embeddingModel}>{embeddingModel} (Current)</option>
                    ) : (
                      [...new Set([embeddingModel, ...availableModels])].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))
                    )}
                  </select>

                  {/* 推奨埋め込みモデル */}
                  <div className="grid grid-cols-3 gap-2 mt-2">
                    {RECOMMENDED_EMBEDDING_MODELS.map((item) => {
                      const isInstalled = isModelInstalled(item.name, availableModels);
                      const isSelected = isModelSelected(item.name, embeddingModel);
                      return (
                        <div
                          key={item.name}
                          onClick={() => handleSelectPreset(item, 'embedding')}
                          className={`p-2 rounded-xl border cursor-pointer transition ${
                            isSelected
                              ? 'bg-indigo-950/60 border-indigo-500/60'
                              : 'bg-slate-900/80 border-white/5 hover:border-indigo-500/30'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[9px] font-bold text-slate-400">{item.badgeJa}</span>
                            <span className="text-[10px] text-slate-500 font-mono">{item.size}</span>
                          </div>
                          <div className="text-[11px] font-bold text-white font-mono truncate mt-0.5">{item.name}</div>
                          <div className="mt-1 text-[10px]">
                            {isInstalled ? (
                              <span className="text-emerald-400 flex items-center gap-1">
                                <Check className="w-3 h-3" /> 導入済
                              </span>
                            ) : (
                              <span className="text-indigo-400 flex items-center gap-1">
                                <Download className="w-3 h-3" /> 要DL
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 現在の状態 */}
                  {embeddingStatus && (
                    <div className="mt-2.5 p-2.5 rounded-xl bg-slate-950/60 border border-white/5 text-[11px] text-slate-300 space-y-1">
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <span>
                          {t('settings.spectrum_embedded', 'ベクトル化済みタグ')}: {embeddingStatus.embedded_tags} /{' '}
                          {embeddingStatus.total_tags}
                        </span>
                        <span className={embeddingStatus.missing_tags > 0 ? 'text-amber-300' : ''}>
                          {t('settings.spectrum_missing', '未生成')}: {embeddingStatus.missing_tags}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
                        <span>
                          {t('settings.spectrum_eligible', '検索対象メディア')}: {embeddingStatus.eligible_media}
                        </span>
                        {/* タグ不足で対象外になるメディアを黙って隠さない */}
                        <span>
                          {t('settings.spectrum_excluded', 'タグ')}
                          {embeddingStatus.min_basic_tags}
                          {t('settings.spectrum_excluded_suffix', '個未満で対象外')}: {embeddingStatus.excluded_media}
                        </span>
                      </div>
                      {!embeddingStatus.model_available && (
                        <div className="text-amber-300 flex items-start gap-1.5 pt-1">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                          <span>
                            {t(
                              'settings.spectrum_model_missing',
                              'このモデルは Ollama に導入されていません。上のカードから取得してください。',
                            )}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 生成 */}
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleGenerateEmbeddings}
                      disabled={isGeneratingEmbeddings || !embeddingStatus || embeddingStatus.missing_tags === 0}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-[11px] font-semibold transition cursor-pointer"
                    >
                      {isGeneratingEmbeddings ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      {t('settings.spectrum_generate', '未生成のタグをベクトル化')}
                    </button>
                    <button
                      type="button"
                      onClick={handleRunDiagnostics}
                      disabled={diagnosticsLoading || isGeneratingEmbeddings}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-xl text-[11px] font-semibold transition cursor-pointer border border-white/10"
                    >
                      {diagnosticsLoading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <FlaskConical className="w-3.5 h-3.5 text-indigo-400" />
                      )}
                      {t('settings.spectrum_diagnostics', '類似度分布を計測')}
                    </button>
                    {isGeneratingEmbeddings && embeddingProgress && embeddingProgress.total > 0 && (
                      <span className="text-[11px] text-slate-400 tabular-nums">
                        {embeddingProgress.current} / {embeddingProgress.total}
                      </span>
                    )}
                  </div>

                  {embeddingError && (
                    <div className="mt-2 p-2 rounded-lg bg-red-950/40 border border-red-500/30 text-[11px] text-red-200">
                      {embeddingError}
                    </div>
                  )}

                  {/* 実験用トグル（Phase 1 の実測比較用） */}
                  <div className="mt-3 space-y-2">
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={spectrumCentering}
                        onChange={(e) => setSpectrumCentering(e.target.checked)}
                        className="mt-0.5 accent-indigo-500"
                      />
                      <span className="text-[11px] text-slate-300">
                        {t('settings.spectrum_centering', 'ハブ化対策 (centering) を有効にする')}
                        <span className="block text-[10px] text-slate-500">
                          {t(
                            'settings.spectrum_centering_help',
                            'OFFにすると、タグ本数の多いメディアが何とでも似ていると判定されやすくなります。',
                          )}
                        </span>
                      </span>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={spectrumIncludeDescriptive}
                        onChange={(e) => setSpectrumIncludeDescriptive(e.target.checked)}
                        className="mt-0.5 accent-indigo-500"
                      />
                      <span className="text-[11px] text-slate-300">
                        {t('settings.spectrum_descriptive', '記述的タグも類似度計算に含める')}
                        <span className="block text-[10px] text-slate-500">
                          {t(
                            'settings.spectrum_descriptive_help',
                            'ONにすると、高精度モデルで解析したメディア同士が優先的に似ていると判定される場合があります。',
                          )}
                        </span>
                      </span>
                    </label>
                  </div>

                  {/* 計測結果 */}
                  {diagnostics && (
                    <div className="mt-2.5 p-2.5 rounded-xl bg-slate-950/60 border border-white/5 text-[11px] text-slate-300 space-y-1.5">
                      <div className="text-slate-400">
                        {diagnostics.model} / {diagnostics.dim}次元 / centering{' '}
                        {diagnostics.centering ? 'ON' : 'OFF'} / descriptive{' '}
                        {diagnostics.include_descriptive ? 'ON' : 'OFF'}
                      </div>
                      <div className="tabular-nums">
                        min {diagnostics.sim_min.toFixed(3)} / mean {diagnostics.sim_mean.toFixed(3)} / max{' '}
                        {diagnostics.sim_max.toFixed(3)} / sd {diagnostics.sim_stddev.toFixed(3)}
                      </div>
                      <div className="tabular-nums text-slate-400">
                        {t('settings.spectrum_hub_corr', 'タグ本数と平均類似度の相関')}:{' '}
                        {diagnostics.tagcount_similarity_corr.toFixed(3)}
                      </div>
                      {diagnostics.desc_intra_mean !== null && diagnostics.inter_group_mean !== null && (
                        <div className="tabular-nums text-slate-400">
                          {t('settings.spectrum_group_sep', '記述的タグ 群内/群間')}:{' '}
                          {diagnostics.desc_intra_mean.toFixed(3)} / {diagnostics.inter_group_mean.toFixed(3)}
                        </div>
                      )}
                      <div className="text-slate-500">
                        {t('settings.spectrum_sample', '標本')} {diagnostics.sample_size} /{' '}
                        {diagnostics.eligible_media} · {diagnostics.load_ms + diagnostics.centroid_ms}ms +{' '}
                        {diagnostics.pairwise_ms}ms
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Tag Granularity Change Notice */}
        {hasGranularityChanged && (
          <div className="mt-4 p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl flex items-start gap-2 text-indigo-200 text-[11px] leading-relaxed">
            <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <span>{t('settings.granularity_changed_notice', 'タグ粒度を変更しました。新しい粒度はこれから解析するメディアにのみ適用されます。既存メディアのタグを揃えるには、フォルダ管理から再解析してください。')}</span>
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 border-t border-white/10 pt-4 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-slate-400 hover:text-white transition cursor-pointer"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-900/30 cursor-pointer disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 text-white animate-spin" /> 保存中...
              </>
            ) : savedStatus ? (
              <>
                <Check className="w-4 h-4 text-emerald-400" /> 保存完了!
              </>
            ) : (
              '設定を保存'
            )}
          </button>
        </div>
      </div>

      {/* Confirmation Modal for Downloading Ollama Model */}
      {confirmDownloadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30">
                <Download className="w-5 h-5" />
              </div>
              <div>
                <h4 className="text-base font-bold text-white">モデルのダウンロード確認</h4>
                <p className="text-xs text-slate-400">Ollamaモデルをローカルにダウンロードします</p>
              </div>
            </div>

            <div className="p-3 bg-slate-950/60 rounded-xl border border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-indigo-300 font-mono">{confirmDownloadModal.model.name}</span>
                <span className="text-xs font-mono px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded-md">
                  {confirmDownloadModal.model.size}
                </span>
              </div>
              <p className="text-xs text-slate-300">{confirmDownloadModal.model.description}</p>
            </div>

            <p className="text-[11px] text-slate-400 leading-relaxed">
              ※ ネットワーク回線の速度により、ダウンロードには数分〜十分程度かかる場合があります。<br />
              ※ ダウンロード中も設定画面やバックグラウンドで進捗状況を確認できます。
            </p>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
              <button
                onClick={() => setConfirmDownloadModal(null)}
                className="px-3.5 py-1.5 rounded-xl border border-white/10 hover:bg-slate-800 text-xs font-medium text-slate-300 transition cursor-pointer"
              >
                キャンセル
              </button>
              <button
                onClick={handleStartDownload}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                ダウンロード開始
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Granularity Comparison Modal (verification tool) */}
      {compareModalOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
          <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl max-w-3xl w-full p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                {compareImagePath ? (
                  <button
                    onClick={() => setCompareImageEnlarged(true)}
                    className="shrink-0 w-14 h-14 rounded-xl overflow-hidden border border-indigo-500/30 hover:border-indigo-400 transition cursor-pointer group relative"
                    title="クリックで拡大表示"
                  >
                    <img
                      src={convertFileSrc(compareImagePath)}
                      alt="解析対象プレビュー"
                      className="w-full h-full object-cover group-hover:scale-105 transition"
                    />
                  </button>
                ) : (
                  <div className="p-2.5 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30 shrink-0">
                    <FlaskConical className="w-5 h-5" />
                  </div>
                )}
                <div className="min-w-0">
                  <h4 className="text-base font-bold text-white">{t('settings.granularity_try', '粒度を試す（画像を選択）')}</h4>
                  <p className="text-xs text-slate-400 truncate" title={compareImagePath || undefined}>
                    {compareImagePath ? compareImagePath.split(/[/\\]/).pop() : 'Lv1 / Lv2 / Lv3 の解析結果を比較します'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setCompareModalOpen(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {compareError && (
              <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs">
                ⚠️ {compareError}
              </div>
            )}

            {!compareError && (
              <>
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <RefreshCw className={`w-3.5 h-3.5 text-indigo-400 ${Object.values(compareProgress).some((s) => s === 'running') ? 'animate-spin' : ''}`} />
                  <span>
                    {Object.values(compareProgress).filter((s) => s === 'done').length} / {GRANULARITY_LEVELS.length} 完了
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {GRANULARITY_LEVELS.map((level) => {
                    const status = compareProgress[level.value];
                    const item = compareResults.find((r) => r.granularity === level.value);
                    return (
                      <div key={level.value} className="p-3 bg-slate-950/60 rounded-xl border border-white/5 space-y-2 min-h-[110px]">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-indigo-300">
                            {t(level.labelKey, level.labelDefault)}
                          </span>
                          {status === 'running' && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />}
                          {status === 'done' && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                          {status === 'pending' && <span className="text-[10px] text-slate-500">待機中</span>}
                        </div>

                        {status !== 'done' && (
                          <div className="flex items-center justify-center py-6 text-[11px] text-slate-500">
                            {status === 'running' ? '解析中...' : '待機中...'}
                          </div>
                        )}

                        {status === 'done' && item?.error && (
                          <p className="text-[11px] text-rose-300">⚠️ {item.error}</p>
                        )}

                        {status === 'done' && item && !item.error && (
                          <>
                            <div className="flex flex-wrap gap-1">
                              {item.categories.map((c) => (
                                <span key={c} className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded">
                                  {c}
                                </span>
                              ))}
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {item.tags.map((tag) => (
                                <span key={tag.en} className="text-[10px] px-1.5 py-0.5 bg-indigo-500/15 text-indigo-300 rounded-full">
                                  #{tag.ja || tag.en}
                                </span>
                              ))}
                            </div>
                            {item.descriptive_tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 pt-1 border-t border-white/5">
                                {item.descriptive_tags.map((tag) => (
                                  <span key={tag.en} className="text-[10px] px-1.5 py-0.5 bg-slate-800/80 text-slate-400 rounded-full border border-white/5">
                                    {tag.ja || tag.en}
                                  </span>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Enlarged preview of the image being compared */}
      {compareImageEnlarged && compareImagePath && (
        <div
          onClick={() => setCompareImageEnlarged(false)}
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer animate-in fade-in duration-150 select-none"
        >
          <div onClick={(e) => e.stopPropagation()} className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center justify-center">
            <img
              src={convertFileSrc(compareImagePath)}
              alt="解析対象プレビュー拡大"
              className="max-w-full max-h-[80vh] object-contain rounded-2xl shadow-2xl border border-white/10"
            />
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs text-slate-300 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-white/10 truncate max-w-md">
                {compareImagePath.split(/[/\\]/).pop()}
              </span>
              <button
                onClick={() => setCompareImageEnlarged(false)}
                className="text-xs text-slate-300 hover:text-white bg-slate-800 px-3 py-1 rounded-lg border border-white/10 transition cursor-pointer"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
