import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Settings, RefreshCw, Check, X, Cpu, FileText, AlertTriangle, ShieldAlert, Sparkles, Loader2, HardDrive, Layers, FlaskConical, Info } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  RECOMMENDED_VLM_MODELS,
  RECOMMENDED_TEXT_MODELS,
  RecommendedModel,
} from '../constants/recommendedModels';
import { resolveInstalledModel } from '../utils/modelMatch';
import {
  OllamaPullProgressPayload,
  TagGranularity,
  GranularityComparisonItem,
  SettingEntry,
  ApiKeyEntry,
  SaveSettingsResult,
} from '../types';
import { useTranslation } from '../contexts/I18nContext';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { ask } from '@tauri-apps/plugin-dialog';
import { TooltipHelp } from './TooltipHelp';
import { GRANULARITY_LEVELS } from '../constants/granularityLevels';
import { GranularityCompareModal } from './settings/GranularityCompareModal';
import {
  ConfirmDownloadDialog,
  DiscardEmbeddingsDialog,
  SwitchEmbeddingModelDialog,
} from './settings/SettingsConfirmDialogs';
import { ModelPresetCards } from './settings/ModelPresetCards';
import { useEmbeddingSettings } from '../hooks/useEmbeddingSettings';
import { AdvancedSettingsSection } from './settings/AdvancedSettingsSection';
import { CloudProviderSection } from './settings/CloudProviderSection';

interface SettingsModalProps {
  open: boolean;
  settings: Record<string, string>;
  availableModels: string[];
  /** `availableModels` のうち vision を宣言しているモデル。null は「判定できていない」 */
  visionModels: string[] | null;
  onClose: () => void;
  /** 設定を1往復でまとめて保存する。項目ごとに保存すると途中で止まった状態が生まれる */
  onSaveSettings: (entries: SettingEntry[], apiKeys: ApiKeyEntry[]) => Promise<SaveSettingsResult>;
  /** `refresh` を true にすると vision 宣言のキャッシュを捨てて取り直す */
  onFetchModels: (refresh?: boolean) => Promise<void>;
  onUnloadModel?: () => Promise<void>;
}




export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  availableModels,
  visionModels,
  onClose,
  onSaveSettings,
  onFetchModels,
  onUnloadModel,
}) => {
  const { t } = useTranslation();
  const [provider, setProvider] = useState(settings.llm_provider || 'ollama');

  // Ollama
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollama_url || 'http://localhost:11434');
  const [selectedVlmModel, setSelectedVlmModel] = useState(settings.ollama_model || 'qwen3-vl:8b-instruct');
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

  // 概念スペクトラム検索（タグ埋め込み）。
  // 生成・計測・削除・破棄という実行を伴い、それぞれ進捗と結果を持つので別のフックにしてある。
  // **画面側の名前は変えていない**（useEmbeddingSettings 側の名前に読み替えるだけ）
  const emb = useEmbeddingSettings(settings);
  // 区画の外（保存する値の組み立て・確認ダイアログ・開いたときの取得）で使うものだけ取り出す。
  // 区画の中で使うものは `emb` ごと SpectrumSettingsSection に渡す
  const {
    embeddingModel,
    setEmbeddingModel,
    includeDescriptive: spectrumIncludeDescriptive,
    centering: spectrumCentering,
    storageInfo,
    confirmDiscard,
    refreshStatus: refreshEmbeddingStatus,
    syncFromSettings: syncEmbeddingFromSettings,
    discard: handleDiscardEmbeddings,
  } = emb;
  /** 埋め込みモデルを切り替えて保存しようとしたときの確認 */
  const [confirmModelSwitch, setConfirmModelSwitch] = useState<{ from: string; to: string } | null>(null);

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
  /**
   * API キーの読み出しに失敗したプロバイダー。
   * 欄が空なのが「未設定」なのか「読めなかった」なのかは、出さないと区別できない。
   */
  const [apiKeyReadFailed, setApiKeyReadFailed] = useState<Record<string, boolean>>({});
  /**
   * ユーザーが実際に触った API キー。**触っていないものは保存に含めない。**
   * 読み出しに失敗すると state は空のままなので、そのまま送ると
   * 資格情報ストアに保存済みのキーを空文字で上書きして消してしまう。
   */
  const [apiKeyDirty, setApiKeyDirty] = useState<Record<string, boolean>>({});
  /** API キーは伏せ字が既定。入力し直さずに確認できるよう切り替えられるようにする */
  const [showApiKey, setShowApiKey] = useState(false);

  // External LLM Settings
  const [extMaxBatchItems, setExtMaxBatchItems] = useState(settings.ext_llm_max_batch_items || '50');
  const [extRetryEnabled, setExtRetryEnabled] = useState(settings.ext_llm_retry_enabled !== 'false');
  const [extRetryAttempts, setExtRetryAttempts] = useState(settings.ext_llm_retry_max_attempts || '3');

  // General Settings
  const [uiLanguage, setUiLanguage] = useState<'ja' | 'en'>((settings.ui_language as any) || 'ja');
  const [ffmpegNoticeEnabled, setFfmpegNoticeEnabled] = useState<boolean>(settings.ffmpeg_notice_enabled !== 'false');

  const [loadingModels, setLoadingModels] = useState(false);
  /** VLM プルダウンで vision 未宣言のモデルも出すか。既定は絞り込んだ状態 */
  const [showNonVisionModels, setShowNonVisionModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  /**
   * 保存が失敗した理由。**握り潰さない。**
   * 以前は console.error だけで、ユーザーには「モーダルが閉じない」しか手がかりが無かった
   */
  const [saveError, setSaveError] = useState<string | null>(null);
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

    syncEmbeddingFromSettings(settings);

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

  }, [settings, open]);

  /**
   * API キーを OS の資格情報ストアから読む。
   *
   * **`settings` の変化では読み直さない。** 以前は上の useEffect に同居していたため、
   * 設定を保存するたびに読み直され、入力中の値を上書きする経路になっていた。
   */
  useEffect(() => {
    if (!open) return;
    setApiKeyDirty({});
    setApiKeyReadFailed({});
    const load = (name: string, set: (value: string) => void) =>
      invoke<string>('get_provider_api_key', { provider: name })
        .then((key) => set(key || ''))
        .catch(() => {
          set('');
          setApiKeyReadFailed((prev) => ({ ...prev, [name]: true }));
        });
    void load('gemini', setGeminiApiKey);
    void load('openai', setOpenaiApiKey);
    void load('claude', setClaudeApiKey);
  }, [open]);

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

  /** null は「判定できていない」。その場合は絞り込みも表記も行わない */
  const visionModelSet = useMemo(() => (visionModels ? new Set(visionModels) : null), [visionModels]);

  /**
   * VLM プルダウンに出す選択肢。
   *
   * 既定は vision 宣言のあるものだけ。ただし**現在選択中のモデルは宣言が無くても必ず残す**。
   * 消してしまうと `<select>` の value が選択肢に無くなり、
   * 保存済みのモデルがあるのに何も選んでいないように見える。
   */
  const vlmModelOptions = useMemo(() => {
    if (!visionModelSet || showNonVisionModels) return availableModels;
    const filtered = availableModels.filter((m) => visionModelSet.has(m));
    if (selectedVlmModel && availableModels.includes(selectedVlmModel) && !filtered.includes(selectedVlmModel)) {
      return [selectedVlmModel, ...filtered];
    }
    return filtered;
  }, [availableModels, visionModelSet, showNonVisionModels, selectedVlmModel]);

  /** 絞り込みで隠れうる件数。0 件ならトグルを出しても何も起きない */
  const nonVisionModelCount = useMemo(
    () => (visionModelSet ? availableModels.filter((m) => !visionModelSet.has(m)).length : 0),
    [availableModels, visionModelSet]
  );

  /**
   * 保存する値の一覧。**保存と「変更途中か」の判定で同じものを見る。**
   * 別々に書くと、片方に項目を足したときにもう片方がずれる。
   */
  const settingEntries: SettingEntry[] = [
    { key: 'llm_provider', value: provider },
    { key: 'ollama_url', value: ollamaUrl },
    { key: 'ollama_model', value: selectedVlmModel },
    { key: 'ollama_text_model', value: selectedTextModel },
    // 空欄・不正値は自動(0) / 既定値(1536) にフォールバックさせる
    { key: 'ollama_num_ctx', value: String(Math.max(0, parseInt(ollamaNumCtx, 10) || 0)) },
    {
      key: 'ollama_max_image_edge',
      value: String(
        Math.max(
          0,
          Number.isFinite(parseInt(ollamaMaxImageEdge, 10)) ? parseInt(ollamaMaxImageEdge, 10) : 1536
        )
      ),
    },
    { key: 'llm_debug_logging', value: llmDebugLogging ? 'true' : 'false' },
    { key: 'force_detailed_prompt', value: forceDetailedPrompt ? 'true' : 'false' },
    { key: 'tag_granularity', value: tagGranularity },

    { key: 'gemini_model', value: geminiModel },
    // *_text_model はクラウド側では **Rust のどこからも読まれていない**
    // （読まれるのは ollama_text_model だけ / tag_organize.rs）。
    // 動かない入力欄を作らないため UI は用意していない。既定値を書き戻すだけ
    { key: 'gemini_text_model', value: geminiTextModel },

    { key: 'openai_base_url', value: openaiBaseUrl },
    { key: 'openai_model', value: openaiModel },

    { key: 'claude_model', value: claudeModel },
    { key: 'claude_text_model', value: claudeTextModel },

    { key: 'ext_llm_max_batch_items', value: extMaxBatchItems },
    { key: 'ext_llm_retry_enabled', value: extRetryEnabled ? 'true' : 'false' },
    { key: 'ext_llm_retry_max_attempts', value: extRetryAttempts },
    { key: 'ui_language', value: uiLanguage },
    { key: 'ffmpeg_notice_enabled', value: ffmpegNoticeEnabled ? 'true' : 'false' },

    { key: 'spectrum_embedding_model', value: embeddingModel },
    { key: 'spectrum_include_descriptive', value: spectrumIncludeDescriptive ? 'true' : 'false' },
    { key: 'spectrum_centering', value: spectrumCentering ? 'true' : 'false' },
  ];

  /**
   * 開いた時点の値。**保存済みの設定との差ではなく、開いてから触ったかで見る。**
   * 保存されたことのない項目は設定に無く、差で見ると常に「変更あり」になる。
   */
  const openedWith = useRef<string>('');
  useEffect(() => {
    if (open) openedWith.current = JSON.stringify(settingEntries);
    // 開いた瞬間の値だけを控える。開いている間の変化は追わない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc で閉じる。**確認のパネルが開いていたら、そちらだけ閉じる**
  useEscapeToClose({
    open,
    onClose,
    onEscapeFirst: () => {
      if (confirmModelSwitch) {
        setConfirmModelSwitch(null);
        return true;
      }
      if (confirmDownloadModal) {
        setConfirmDownloadModal(null);
        return true;
      }
      return false;
    },
    isDirty: () =>
      JSON.stringify(settingEntries) !== openedWith.current ||
      Object.values(apiKeyDirty).some(Boolean),
    confirm: () =>
      ask(t('app.discard_confirm', ''), {
        title: t('app.label_discard_title', 'Discard changes'),
        kind: 'warning',
      }),
  });

  // フックは早期 return より前にすべて並べる（`if (!open) return null` の後ろに置くと
  // 閉じている間だけ呼ばれず、React が「フックの順序が変わった」で描画ごと落とす）
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

  /** vision 宣言のキャッシュを捨てて取り直す。明示的な取得はこのボタンだけ */
  const handleRefreshModels = async () => {
    setLoadingModels(true);
    await onFetchModels(true);
    setLoadingModels(false);
  };

  /**
   * 保存の入口。埋め込みモデルを切り替えるときだけ、先に影響を説明して同意を取る。
   *
   * 切り替えると類似度の数値がすべて変わり、再ベクトル化も必要になる。
   * 他の設定と違って「保存したら結果が別物になる」ため、黙って通さない。
   */
  const handleSave = async () => {
    const savedModel = settings.spectrum_embedding_model || 'bge-m3';
    const hasVectors = (storageInfo?.models.length ?? 0) > 0;
    if (embeddingModel !== savedModel && hasVectors) {
      setConfirmModelSwitch({ from: savedModel, to: embeddingModel });
      return;
    }
    await doSave();
  };

  /** 現在のプロバイダーが使うモデル設定のキーと、いま画面に出ている値 */
  const cloudModel =
    provider === 'gemini' ? geminiModel : provider === 'openai' ? openaiModel : claudeModel;

  const setCloudModel = (value: string) => {
    if (provider === 'gemini') setGeminiModel(value);
    else if (provider === 'openai') setOpenaiModel(value);
    else if (provider === 'claude') setClaudeModel(value);
  };

  /** プロバイダーごとの既定モデル。db.rs の初期値と揃える */
  const CLOUD_MODEL_PLACEHOLDER: Record<string, string> = {
    gemini: 'gemini-2.0-flash',
    openai: 'gpt-4o-mini',
    claude: 'claude-3-5-sonnet-20241022',
  };

  const apiKey =
    provider === 'gemini' ? geminiApiKey : provider === 'openai' ? openaiApiKey : claudeApiKey;

  const setApiKey = (value: string) => {
    setApiKeyDirty((prev) => ({ ...prev, [provider]: true }));
    if (provider === 'gemini') setGeminiApiKey(value);
    else if (provider === 'openai') setOpenaiApiKey(value);
    else if (provider === 'claude') setClaudeApiKey(value);
  };

  const dirtyApiKeyEntries = (): ApiKeyEntry[] =>
    (
      [
        ['gemini', geminiApiKey],
        ['openai', openaiApiKey],
        ['claude', claudeApiKey],
      ] as const
    )
      .filter(([name]) => apiKeyDirty[name])
      .map(([name, value]) => ({ provider: name, api_key: value }));

  const doSave = async () => {
    setConfirmModelSwitch(null);
    setSaveError(null);
    setIsSaving(true);
    try {
      // **1往復で全部入るか、1つも入らないか。**
      // 以前は update_setting を23回 + save_provider_api_key を3回、逐次に await していた。
      // 保存が終わるまでの間に別の値を触られても、DB に入るのは押した時点の値だけで、
      // 画面には触った後の値が出たままモーダルが閉じていた
      const result = await onSaveSettings(
        // **組み立ては settingEntries に1本化してある。**
        // ここに直接書くと、Esc の「変更途中か」の判定とずれる
        settingEntries,
        // API キーの保存先は OS の資格情報ストア。設定本体とは別に扱われる。
        // **触っていないキーは送らない。** 読み出しに失敗していると state は空のままで、
        // 送ると保存済みのキーを空文字で消してしまう
        dirtyApiKeyEntries()
      );

      // 設定本体は入ったが API キーだけ入らなかった、を黙って成功にしない
      if (result.api_key_failures.length > 0) {
        setSaveError(
          t('settings.api_key_save_failed', '', {
            list: result.api_key_failures.map((f) => `・${f.provider}: ${f.message}`).join('\n'),
          })
        );
        setIsSaving(false);
        return;
      }

      setSavedStatus(true);
      setTimeout(() => {
        setSavedStatus(false);
        setIsSaving(false);
        onClose();
      }, 700);
    } catch (e) {
      console.error('Failed to save settings:', e);
      setSaveError(String(e));
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
    // **系統名だけで探さない。** サイズ違いを掴むと推奨した意味が消える
    // （`gemma4:12b` を押して `gemma4:26b` が選ばれていた）
    const installedModelName = resolveInstalledModel(item.name, availableModels);
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

  const handleStartDownload = async () => {
    if (!confirmDownloadModal) return;
    const targetModel = confirmDownloadModal.model;
    const targetType = confirmDownloadModal.targetType;
    setConfirmDownloadModal(null);

    setIsDownloading(true);
    setDownloadProgress({
      model: targetModel.name,
      status: t('settings.label_download_starting', 'Starting download...'),
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

  // Determine best recommended VLM model based on system VRAM.
  //
  // gemma4:12b は qwen3-vl:8b-instruct と精度が同等で速度だけ劣ることが実測で分かっている
  // （tools/prompt-check）。VRAM に余裕があるというだけで自動的に格上げすると
  // 「重い方が高精度」という誤解を UI 側で強化してしまうため、しきい値には含めない。
  const getBestVlmModelName = () => {
    if (!vramGb || vramGb <= 0) return null;
    if (vramGb >= 7.0) return 'qwen3-vl:8b-instruct';
    return 'translategemma:4b';
  };
  const bestVlmName = getBestVlmModelName();

  // Determine best recommended Text model based on system VRAM
  //
  // 2026-08-05 の実測（tools/text-check）に基づく。詳細は RECOMMENDED_TEXT_MODELS 側のコメント。
  //
  // **VRAM が多いほど上位モデル、という並びにしない。** gemma4:12b (7.0GB) が
  // qwen3:14b (8.6GB) を全指標で上回った（包括語の抽出 5/5 対 4/5、段2の発明タグ
  // 0件 対 平均31件、所要も短い）。上に足すべきモデルが無いので上限を設けていない。
  //
  // **6GB 未満に推奨できるモデルは無いので null を返す。** 7B クラスは包括語を
  // 1〜2/5 しか選べず、見落とした親はその下の階層が丸ごと出なくなる。
  // 動かないモデルを勧めるより、推奨なしの方が誤解が少ない。
  const getBestTextModelName = () => {
    if (!vramGb || vramGb <= 0) return null;
    if (vramGb >= 8.0) return 'gemma4:12b';
    if (vramGb >= 7.0) return 'qwen3.5:9b';
    return null;
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
              <h3 className="text-lg font-bold text-white">{t('settings.label_title', '設定')}</h3>
              <p className="text-xs text-slate-400">{t('settings.label_subtitle', '')}</p>
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
            <h4 className="text-xs font-bold text-indigo-300 uppercase tracking-wider">{t('settings.label_general', '一般設定')}</h4>

            <div className="flex flex-col gap-3.5">
              {/* Language Selection */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-[11px] font-semibold text-slate-300">
                    {t('settings.label_language', 'UI表示言語')}
                  </label>
                  <TooltipHelp text={t('settings.language_help', 'アプリケーション全体の表示言語（日本語 / English）を切り替えます。')} />
                </div>
                <select
                  value={uiLanguage}
                  onChange={(e) => setUiLanguage(e.target.value as any)}
                  className="w-full bg-slate-950 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="ja">{t('settings.label_language_ja', '日本語 (Japanese)')}</option>
                  <option value="en">{t('settings.label_language_en', 'English (US)')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Analysis Prompt Settings (provider-independent common section) */}
          <div className="p-4 bg-slate-900/50 rounded-xl border border-white/5 space-y-3.5">
            <h4 className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" />
              {t('settings.label_prompt_section', '解析プロンプト設定')}
            </h4>

            {/* Tag Granularity Selection */}
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  {t('settings.label_tag_granularity', 'タグ粒度')}
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
                  {t('settings.label_granularity_try', '粒度を試す（画像を選択）')}
                </button>
              </div>
            </div>
          </div>

          {/* Privacy Disclaimer Banner for External LLMs */}
          {provider !== 'ollama' && (
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl flex items-start gap-2 text-amber-300 text-[11px] leading-relaxed">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold text-amber-200">⚠️ {t('settings.label_privacy_title', 'Unofficial feature & privacy disclaimer')}: </span>
                {t('settings.privacy_body_1', '')}
                {t('settings.privacy_body_2', '')}
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
                      {t('settings.label_downloading', 'Downloading')}: <span className="font-mono text-indigo-300">{downloadProgress?.model}</span>
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
                        {t('settings.label_btn_cancel_download', 'Cancel download')}
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
                      {t('settings.download_done', '')}
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
                      {t('settings.label_vlm_model', '使用するVLM (視覚言語) モデル')}
                    </label>
                    <TooltipHelp text={t('settings.vlm_model_help', '画像や動画フレームの解釈・説明文の自動作成を行う視覚言語モデル（例: minicpm-v, llama3.2-vision）を選択します。')} />
                  </div>
                  <button
                    onClick={handleRefreshModels}
                    disabled={loadingModels}
                    className="text-[11px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingModels ? 'animate-spin' : ''}`} />
                    {t('settings.label_btn_fetch_models', 'Fetch model list')}
                  </button>
                </div>
                <select
                  value={selectedVlmModel}
                  onChange={(e) => setSelectedVlmModel(e.target.value)}
                  className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50"
                >
                  {vlmModelOptions.length === 0 ? (
                    <option value={selectedVlmModel}>{selectedVlmModel} ({t('settings.label_current', 'Current')})</option>
                  ) : (
                    vlmModelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                        {/* 印を付けるのは「宣言が無い」側だけ。宣言があることを強調すると
                            動作確認済みのように読めるが、宣言は候補に出す根拠でしかない */}
                        {visionModelSet && !visionModelSet.has(m)
                          ? ` — ${t('settings.label_model_vision_undeclared', 'vision 未宣言')}`
                          : ''}
                      </option>
                    ))
                  )}
                </select>

                {/* vision 宣言による絞り込みの状態。判定できていない（null）ときは何も出さない */}
                {visionModelSet && (
                  <div className="mt-1.5 space-y-1">
                    {!showNonVisionModels && vlmModelOptions.length === 0 && availableModels.length > 0 && (
                      <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg text-amber-300 text-[11px] leading-relaxed">
                        {t('settings.no_vision_models', 'vision 対応を宣言しているモデルが見つかりませんでした。下のチェックを入れると、宣言が無いモデルも選べます。')}
                      </div>
                    )}
                    {nonVisionModelCount > 0 && (
                      <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer w-fit">
                        <input
                          type="checkbox"
                          checked={showNonVisionModels}
                          onChange={(e) => setShowNonVisionModels(e.target.checked)}
                          className="accent-indigo-500 cursor-pointer"
                        />
                        {t('settings.label_show_non_vision_models', 'vision 未宣言のモデルも表示')}
                        <span className="font-mono text-slate-500">({nonVisionModelCount})</span>
                      </label>
                    )}
                    <p className="text-[10px] text-slate-500 leading-relaxed">
                      {t('settings.vision_filter_note', 'vision の対応状況は Ollama の宣言で判定しています。宣言があっても解析が安定するとは限りません。')}
                    </p>
                  </div>
                )}

                {/* VLM Recommended Preset Cards */}
                <div className="mt-3 space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-400 flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      {t('settings.label_preset_vlm', 'Recommended VLM presets (click to select / auto-download)')}
                    </span>
                    {vramGb !== null && vramGb > 0 && (
                      <span className="text-[10px] text-indigo-300 font-mono flex items-center gap-1">
                        <HardDrive className="w-3 h-3 text-indigo-400" /> {t('settings.label_detected_vram', 'Detected VRAM')}: ~{vramGb.toFixed(1)} GB
                      </span>
                    )}
                  </div>
                  <ModelPresetCards
                    models={RECOMMENDED_VLM_MODELS}
                    availableModels={availableModels}
                    selectedModel={selectedVlmModel}
                    bestMatchName={bestVlmName}
                    loadingModels={loadingModels}
                    downloadingModel={isDownloading ? (downloadProgress?.model ?? null) : null}
                    onSelect={(item) => handleSelectPreset(item, 'vlm')}
                  />
                </div>
              </div>

              {/* Text LLM Selection & Presets */}
              <div className="pt-2 border-t border-white/5">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <FileText className="w-3.5 h-3.5 text-indigo-400" />
                  <label className="text-xs font-semibold text-slate-300">
                    {t('settings.label_text_model', 'テキスト解析・タグ翻訳モデル')}
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
                      {t('settings.label_preset_text', 'Recommended text LLM presets (click to select / auto-download)')}
                    </span>
                  </div>
                  <ModelPresetCards
                    models={RECOMMENDED_TEXT_MODELS}
                    availableModels={availableModels}
                    selectedModel={selectedTextModel}
                    bestMatchName={bestTextName}
                    loadingModels={loadingModels}
                    downloadingModel={isDownloading ? (downloadProgress?.model ?? null) : null}
                    onSelect={(item) => handleSelectPreset(item, 'text')}
                  />
                </div>
              </div>
            </div>
          )}

          {provider !== 'ollama' && (
            <CloudProviderSection
              provider={provider}
              cloudModel={cloudModel}
              setCloudModel={setCloudModel}
              modelPlaceholder={CLOUD_MODEL_PLACEHOLDER}
              openaiBaseUrl={openaiBaseUrl}
              setOpenaiBaseUrl={setOpenaiBaseUrl}
              apiKey={apiKey}
              setApiKey={setApiKey}
              apiKeyReadFailed={apiKeyReadFailed}
              showApiKey={showApiKey}
              setShowApiKey={setShowApiKey}
            />
          )}

          <AdvancedSettingsSection
            open={advancedOpen}
            setOpen={setAdvancedOpen}
            provider={provider}
            setProvider={setProvider}
            ollamaUrl={ollamaUrl}
            setOllamaUrl={setOllamaUrl}
            forceDetailedPrompt={forceDetailedPrompt}
            setForceDetailedPrompt={setForceDetailedPrompt}
            ffmpegNoticeEnabled={ffmpegNoticeEnabled}
            setFfmpegNoticeEnabled={setFfmpegNoticeEnabled}
            llmDebugLogging={llmDebugLogging}
            setLlmDebugLogging={setLlmDebugLogging}
            ollamaNumCtx={ollamaNumCtx}
            setOllamaNumCtx={setOllamaNumCtx}
            ollamaMaxImageEdge={ollamaMaxImageEdge}
            setOllamaMaxImageEdge={setOllamaMaxImageEdge}
            onUnloadModel={onUnloadModel}
            onManualUnload={handleManualUnload}
            unloadedStatus={unloadedStatus}
            emb={emb}
            availableModels={availableModels}
            onSelectPreset={handleSelectPreset}
          />
        </div>

        {/* Tag Granularity Change Notice */}
        {hasGranularityChanged && (
          <div className="mt-4 p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-xl flex items-start gap-2 text-indigo-200 text-[11px] leading-relaxed">
            <Info className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
            <span>{t('settings.granularity_changed_notice', 'タグ粒度を変更しました。新しい粒度はこれから解析するメディアにのみ適用されます。既存メディアのタグを揃えるには、フォルダ管理から再解析してください。')}</span>
          </div>
        )}

        {/* 保存の失敗。閉じないので、なぜ閉じないのかをここで出す */}
        {saveError && (
          <div className="mt-4 p-3 rounded-xl bg-red-950/40 border border-red-500/30 text-[11px] text-red-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-px text-red-400" />
            <div className="whitespace-pre-wrap break-all">
              <div className="font-semibold mb-0.5">{t('settings.label_save_failed', '保存できませんでした')}</div>
              {saveError}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="mt-6 border-t border-white/10 pt-4 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs text-slate-400 hover:text-white transition cursor-pointer"
          >
            {t('settings.label_btn_cancel', 'Cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-900/30 cursor-pointer disabled:opacity-50"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 text-white animate-spin" /> {t('settings.label_saving', 'Saving...')}
              </>
            ) : savedStatus ? (
              <>
                <Check className="w-4 h-4 text-emerald-400" /> {t('settings.label_saved', 'Saved')}
              </>
            ) : (
              t('settings.label_btn_save', 'Save settings')
            )}
          </button>
        </div>
      </div>

      <DiscardEmbeddingsDialog
        open={confirmDiscard}
        onCancel={() => emb.setConfirmDiscard(false)}
        onConfirm={handleDiscardEmbeddings}
        currentModel={storageInfo?.current_model}
      />

      <SwitchEmbeddingModelDialog
        target={confirmModelSwitch}
        onCancel={() => setConfirmModelSwitch(null)}
        onConfirm={doSave}
        storageInfo={storageInfo}
      />

      <ConfirmDownloadDialog
        model={confirmDownloadModal?.model ?? null}
        onCancel={() => setConfirmDownloadModal(null)}
        onConfirm={handleStartDownload}
      />

      <GranularityCompareModal
        open={compareModalOpen}
        onClose={() => setCompareModalOpen(false)}
        imagePath={compareImagePath}
        results={compareResults}
        progress={compareProgress}
        error={compareError}
      />
    </div>
  );
};
