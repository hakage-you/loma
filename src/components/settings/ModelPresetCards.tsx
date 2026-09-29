import React from 'react';
import { Check, Download, Loader2, RefreshCw } from 'lucide-react';
import { RecommendedModel, badgeLabelKey } from '../../constants/recommendedModels';
import { isModelInstalled, resolveInstalledModel } from '../../utils/modelMatch';
import { useTranslation } from '../../contexts/I18nContext';

/**
 * おすすめモデルのカード。
 *
 * **VLM 用と Text LLM 用は、変数名以外まったく同じ形だった。**
 * 片方だけ直して食い違うのを防ぐため1つにしている。
 * 埋め込みモデル用だけは作りが違う（説明文・VRAM適合・選択中の印が無い）ので別にした。
 */

/**
 * そのおすすめモデルが、いま選ばれているものかどうか。
 *
 * **系統名だけで比べない。** `gemma4:12b` を選んでいるときに `gemma4:26b` を
 * 「選択中」と出すと、推奨した意味が消える。
 */
const isModelSelected = (recommendedName: string, selectedModel: string): boolean =>
  resolveInstalledModel(recommendedName, [selectedModel]) !== null;

interface Props {
  models: RecommendedModel[];
  /** Ollama に入っているモデルの一覧 */
  availableModels: string[];
  /** いま選ばれているモデル名 */
  selectedModel: string;
  /** VRAM から割り出した最適候補。無ければ null */
  bestMatchName: string | null;
  /** モデル一覧を取得中か。取得前に「要DL」と出すと嘘になる */
  loadingModels: boolean;
  /** いま落としている最中のモデル名。無ければ null */
  downloadingModel: string | null;
  onSelect: (item: RecommendedModel) => void;
}

export const ModelPresetCards: React.FC<Props> = ({
  models,
  availableModels,
  selectedModel,
  bestMatchName,
  loadingModels,
  downloadingModel,
  onSelect,
}) => {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-2 gap-2">
      {models.map((item) => {
        const isInstalled = isModelInstalled(item.name, availableModels);
        const isSelected = isModelSelected(item.name, selectedModel);
        const isBestMatch = bestMatchName !== null && item.name === bestMatchName;

        const badgeColor =
          item.badge === 'Lightweight'
            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            : item.badge === 'Standard'
              ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
              : 'bg-purple-500/10 text-purple-400 border-purple-500/20';

        return (
          <div
            key={item.name}
            onClick={() => onSelect(item)}
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
                    {t(badgeLabelKey(item.badge), item.badge)}
                  </span>
                  {isBestMatch && (
                    <span className="bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow">
                      {t('settings.label_recommended_vram_best', '★ VRAM適合のおすすめ')}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-400 font-mono shrink-0">{item.size}</span>
              </div>
              <div className="text-xs font-bold text-white font-mono mt-0.5">{item.name}</div>
              <p className="text-[10px] text-slate-400 mt-1 line-clamp-2 leading-tight">
                {t(item.descriptionKey, item.descriptionDefault)}
              </p>
            </div>

            <div className="mt-2 pt-2 border-t border-white/5 flex items-center justify-between">
              {loadingModels ? (
                <span className="text-[10px] font-medium text-slate-400 flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 animate-spin text-indigo-400" />{' '}
                  {t('settings.label_loading', 'Loading...')}
                </span>
              ) : downloadingModel === item.name ? (
                <span className="text-[10px] font-medium text-amber-400 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin text-amber-400" />{' '}
                  {t('settings.label_installing', 'Installing...')}
                </span>
              ) : isInstalled ? (
                <span className="text-[10px] font-medium text-emerald-400 flex items-center gap-1">
                  <Check className="w-3 h-3" /> {t('settings.label_installed', 'Installed')}
                </span>
              ) : (
                <span className="text-[10px] font-medium text-indigo-400 flex items-center gap-1 hover:text-indigo-300">
                  <Download className="w-3 h-3" /> {t('settings.label_needs_download', 'Download')}
                </span>
              )}
              {isSelected && (
                <span className="text-[9px] px-1.5 py-0.5 bg-indigo-600 text-white rounded font-bold">
                  {t('settings.label_selected', 'Selected')}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

interface EmbeddingProps {
  models: RecommendedModel[];
  availableModels: string[];
  selectedModel: string;
  onSelect: (item: RecommendedModel) => void;
}

/** 埋め込みモデル用の簡易カード。3列で、名前と導入状況だけ出す */
export const EmbeddingPresetCards: React.FC<EmbeddingProps> = ({
  models,
  availableModels,
  selectedModel,
  onSelect,
}) => {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-3 gap-2 mt-2">
      {models.map((item) => {
        const isInstalled = isModelInstalled(item.name, availableModels);
        const isSelected = isModelSelected(item.name, selectedModel);
        return (
          <div
            key={item.name}
            onClick={() => onSelect(item)}
            className={`p-2 rounded-xl border cursor-pointer transition ${
              isSelected
                ? 'bg-indigo-950/60 border-indigo-500/60'
                : 'bg-slate-900/80 border-white/5 hover:border-indigo-500/30'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[9px] font-bold text-slate-400">
                {t(badgeLabelKey(item.badge), item.badge)}
              </span>
              <span className="text-[10px] text-slate-500 font-mono">{item.size}</span>
            </div>
            <div className="text-[11px] font-bold text-white font-mono truncate mt-0.5">
              {item.name}
            </div>
            <div className="mt-1 text-[10px]">
              {isInstalled ? (
                <span className="text-emerald-400 flex items-center gap-1">
                  <Check className="w-3 h-3" /> {t('settings.label_present', 'Present')}
                </span>
              ) : (
                <span className="text-indigo-400 flex items-center gap-1">
                  <Download className="w-3 h-3" /> {t('settings.label_needs_download', 'Download')}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
