import React from 'react';
import { AlertTriangle, Download, Radar } from 'lucide-react';
import { EmbeddingStorageInfo } from '../../types';
import { RecommendedModel } from '../../constants/recommendedModels';
import { useTranslation } from '../../contexts/I18nContext';

/**
 * 設定画面から出る確認ダイアログ3つ。
 *
 * **どれも「押した瞬間に取り返しがつかなくなる」ものの手前に置く。**
 * 見た目の骨格が共通なので同じファイルにまとめてある。
 */

interface DiscardProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** いま使っているモデル名を出す。何を捨てるのか分からないまま押させない */
  currentModel: string | undefined;
}

/** ベクトル破棄の確認。作り直すには再ベクトル化が要るので必ず通す */
export const DiscardEmbeddingsDialog: React.FC<DiscardProps> = ({
  open,
  onCancel,
  onConfirm,
  currentModel,
}) => {
  const { t } = useTranslation();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="bg-slate-900 border border-amber-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-amber-500/20 text-amber-300 rounded-xl border border-amber-500/30">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="text-base font-bold text-white">
              {t('settings.label_spectrum_discard_title', 'ベクトルを破棄しますか')}
            </h4>
            <p className="text-xs text-slate-300 font-mono truncate">{currentModel}</p>
          </div>
        </div>
        <ul className="text-[11px] text-slate-300 space-y-1.5 list-disc pl-4 leading-relaxed">
          <li>
            {t(
              'settings.item_spectrum_discard_regen',
              '破棄後は「未生成のタグをベクトル化」で作り直す必要があります'
            )}
          </li>
          <li>
            {t(
              'settings.item_spectrum_discard_note',
              'centering と記述的タグの設定を変えるだけなら破棄は不要です。設定を変えて「類似度分布を計測」を押せばその場で反映されます'
            )}
          </li>
        </ul>
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-xl border border-white/10 hover:bg-slate-800 text-xs font-medium text-slate-200 transition cursor-pointer"
          >
            {t('settings.label_spectrum_switch_cancel', 'やめる')}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-xs font-bold text-white transition cursor-pointer"
          >
            {t('settings.label_spectrum_discard_ok', '破棄する')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface SwitchProps {
  /** 切り替え元と切り替え先。null なら出さない */
  target: { from: string; to: string } | null;
  onCancel: () => void;
  onConfirm: () => void;
  storageInfo: EmbeddingStorageInfo | null;
}

/**
 * 埋め込みモデル切り替えの確認。
 *
 * **切り替えると類似度の数値がすべて変わる。** 他の設定と違って
 * 「保存したら結果が別物になる」ので黙って通さない。
 */
export const SwitchEmbeddingModelDialog: React.FC<SwitchProps> = ({
  target,
  onCancel,
  onConfirm,
  storageInfo,
}) => {
  const { t } = useTranslation();
  if (!target) return null;

  const needsRegen = Math.max(
    0,
    (storageInfo?.total_tags ?? 0) -
      (storageInfo?.models.find((m) => m.model === target.to)?.tag_count ?? 0)
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-500/20 text-indigo-300 rounded-xl border border-indigo-500/30">
            <Radar className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h4 className="text-base font-bold text-white">
              {t('settings.label_spectrum_switch_title', '埋め込みモデルの切り替え')}
            </h4>
            <p className="text-xs text-slate-300 font-mono truncate">
              {target.from} → {target.to}
            </p>
          </div>
        </div>

        <ul className="text-[11px] text-slate-300 space-y-1.5 list-disc pl-4 leading-relaxed">
          <li>
            {t('settings.item_spectrum_switch_regen', '再ベクトル化が必要です')}: {needsRegen}{' '}
            {t('settings.label_spectrum_switch_tags', '件')}
          </li>
          <li>{t('settings.item_spectrum_switch_scores', '表示される類似度の数値が変わります')}</li>
          {/* 「戻せば復元される」と伝えるので、GC は自動で走らせない */}
          <li>
            {t(
              'settings.item_spectrum_switch_kept',
              '以前のモデルのベクトルは保持され、モデルを戻せば即座に復元されます'
            )}
          </li>
        </ul>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-xl border border-white/10 hover:bg-slate-800 text-xs font-medium text-slate-200 transition cursor-pointer"
          >
            {t('settings.label_spectrum_switch_cancel', 'やめる')}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition cursor-pointer"
          >
            {t('settings.label_spectrum_switch_ok', '切り替えて保存')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface DownloadProps {
  /** 落とすモデル。null なら出さない */
  model: RecommendedModel | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** モデルのダウンロード確認。**何 GB 落ちるのかを出してから始める** */
export const ConfirmDownloadDialog: React.FC<DownloadProps> = ({ model, onCancel, onConfirm }) => {
  const { t } = useTranslation();
  if (!model) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
      <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30">
            <Download className="w-5 h-5" />
          </div>
          <div>
            <h4 className="text-base font-bold text-white">
              {t('settings.label_confirm_download', 'Confirm model download')}
            </h4>
            <p className="text-xs text-slate-400">{t('settings.confirm_download_body', '')}</p>
          </div>
        </div>

        <div className="p-3 bg-slate-950/60 rounded-xl border border-white/5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-indigo-300 font-mono">{model.name}</span>
            <span className="text-xs font-mono px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded-md">
              {model.size}
            </span>
          </div>
          <p className="text-xs text-slate-300">
            {t(model.descriptionKey, model.descriptionDefault)}
          </p>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          {t('settings.download_note_1', '')}
          <br />
          {t('settings.download_note_2', '')}
        </p>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 rounded-xl border border-white/10 hover:bg-slate-800 text-xs font-medium text-slate-300 transition cursor-pointer"
          >
            {t('settings.label_btn_cancel', 'Cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition flex items-center gap-1.5 shadow-lg shadow-indigo-600/30 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            {t('settings.label_btn_start_download', 'Start download')}
          </button>
        </div>
      </div>
    </div>
  );
};
