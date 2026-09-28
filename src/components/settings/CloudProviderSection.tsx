import React from 'react';
import { AlertTriangle, Cpu, Eye, EyeOff, Server, ShieldAlert } from 'lucide-react';
import { useTranslation } from '../../contexts/I18nContext';
import { TooltipHelp } from '../TooltipHelp';

interface Props {
  /** 'gemini' | 'openai' | 'claude'。Ollama のときはそもそも出さない */
  provider: string;
  /** いま選んでいるプロバイダーのモデル名 */
  cloudModel: string;
  setCloudModel: (v: string) => void;
  /** プロバイダーごとの既定モデル。入力欄の薄い文字に出す */
  modelPlaceholder: Record<string, string>;
  /** OpenAI 互換サーバーを指すための URL。openai のときだけ使う */
  openaiBaseUrl: string;
  setOpenaiBaseUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  /**
   * 保存済みキーの読み出しに失敗したプロバイダー。
   * **空欄の意味を取り違えさせないために要る** —— 読めなかっただけなら、
   * 空欄のまま保存してもキーは消えない
   */
  apiKeyReadFailed: Record<string, boolean>;
  showApiKey: boolean;
  setShowApiKey: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * 外部LLM（Gemini / OpenAI / Claude）のモデルとAPIキー。
 *
 * **Ollama のモデル選択と同じ位置に置く。** プロバイダーを切り替えたときに
 * 「モデルを選ぶ欄が消えた」ようには見せない。
 */
export const CloudProviderSection: React.FC<Props> = ({
  provider,
  cloudModel,
  setCloudModel,
  modelPlaceholder,
  openaiBaseUrl,
  setOpenaiBaseUrl,
  apiKey,
  setApiKey,
  apiKeyReadFailed,
  showApiKey,
  setShowApiKey,
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-4 bg-slate-900/50 rounded-xl border border-white/5">
      <h4 className="text-xs font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1.5">
        <Cpu className="w-3.5 h-3.5" />
        {t('settings.label_cloud_section', 'モデルとAPIキー')}
      </h4>

      {/* OpenAI 互換エンドポイント。互換サーバーを指すために要る */}
      {provider === 'openai' && (
        <div>
          <div className="flex items-center gap-1.5 mb-1.5">
            <Server className="w-3.5 h-3.5 text-indigo-400" />
            <label className="text-xs font-semibold text-slate-300">
              {t('settings.label_openai_base_url', 'OpenAI 互換エンドポイント URL')}
            </label>
            <TooltipHelp text={t('settings.openai_base_url_help', 'OpenAI 互換のAPIを提供するサーバーのURLです。')} />
          </div>
          <input
            type="text"
            value={openaiBaseUrl}
            onChange={(e) => setOpenaiBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
          />
        </div>
      )}

      {/* モデル名。一覧の取得には対応していないので直接入力させる */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <Cpu className="w-3.5 h-3.5 text-indigo-400" />
          <label className="text-xs font-semibold text-slate-300">
            {t('settings.label_cloud_model', '使用するモデル')}
          </label>
          <TooltipHelp text={t('settings.cloud_model_help', 'モデル一覧の取得には対応していないため、プロバイダーが公開しているモデルIDをそのまま入力してください。')} />
        </div>
        <input
          type="text"
          value={cloudModel}
          onChange={(e) => setCloudModel(e.target.value)}
          placeholder={modelPlaceholder[provider]}
          className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
        />
      </div>

      {/* API キー */}
      <div>
        <div className="flex items-center gap-1.5 mb-1.5">
          <ShieldAlert className="w-3.5 h-3.5 text-indigo-400" />
          <label className="text-xs font-semibold text-slate-300">
            {t('settings.label_api_key', 'APIキー')}
          </label>
          <TooltipHelp text={t('settings.api_key_help', 'OSの資格情報ストアに保存します。設定ファイルやデータベースには書き込みません。')} />
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('settings.label_api_key_placeholder', '未設定')}
            autoComplete="off"
            spellCheck={false}
            className="flex-1 bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50 font-mono"
          />
          <button
            type="button"
            onClick={() => setShowApiKey((v) => !v)}
            title={
              showApiKey
                ? t('settings.label_api_key_hide', '隠す')
                : t('settings.label_api_key_show', '表示する')
            }
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition cursor-pointer shrink-0"
          >
            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        {/* 空欄の意味を取り違えさせない。読めなかっただけなら、保存しても消えない */}
        {apiKeyReadFailed[provider] && (
          <div className="mt-2 p-2 rounded-lg bg-amber-950/40 border border-amber-500/30 text-[11px] text-amber-200 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px text-amber-400" />
            <span>{t('settings.api_key_read_failed', '保存済みのキーを読み出せませんでした。空欄のまま保存しても消えません。入力すると上書きします。')}</span>
          </div>
        )}
      </div>
    </div>
  );
};
