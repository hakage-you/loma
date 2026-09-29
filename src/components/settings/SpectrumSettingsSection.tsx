import React from 'react';
import { AlertTriangle, Check, FlaskConical, Loader2, Radar, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { RECOMMENDED_EMBEDDING_MODELS, RecommendedModel } from '../../constants/recommendedModels';
import { useTranslation } from '../../contexts/I18nContext';
import { EmbeddingSettings } from '../../hooks/useEmbeddingSettings';
import { EmbeddingDiagnosticsPanel } from '../EmbeddingDiagnosticsPanel';
import { TooltipHelp } from '../TooltipHelp';
import { EmbeddingPresetCards } from './ModelPresetCards';

interface Props {
  /** 埋め込みまわりの状態と操作（[[useEmbeddingSettings]]） */
  emb: EmbeddingSettings;
  /** Ollama に入っているモデルの一覧。カードの導入状況の判定に要る */
  availableModels: string[];
  /** おすすめカードを押したとき。未導入ならダウンロードの確認へ回す */
  onSelectPreset: (item: RecommendedModel, targetType: 'vlm' | 'text' | 'embedding') => void;
}

/**
 * 似ているメディアの検索（タグのベクトル化）の設定区画。
 *
 * **設定画面の他の項目と違って、値を入れるだけの場所ではない。**
 * 生成・計測・削除・破棄という実行があり、それぞれ進捗と結果を出す。
 * 状態と処理は [[useEmbeddingSettings]] が持ち、ここは見せ方だけを持つ。
 */
export const SpectrumSettingsSection: React.FC<Props> = ({ emb, availableModels, onSelectPreset }) => {
  const { t } = useTranslation();
  // **`emb.storageInfo` のままだと null の絞り込みが効かない**（プロパティ参照は
  // 途中で変わりうるものとして扱われる）ので、一度ここで受ける
  const storageInfo = emb.storageInfo;

  return (
    <div className="pt-3 border-t border-white/5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Radar className="w-3.5 h-3.5 text-indigo-400" />
        <label className="text-xs font-semibold text-slate-300">
          {t('settings.label_spectrum_section', '似ているメディアの検索（タグのベクトル化）')}
        </label>
        <TooltipHelp
          text={t(
            'settings.spectrum_help',
            'タグの意味をベクトル化し、タグが完全一致しなくても意味的に近いメディアを探せるようにします。ベクトル化は手動で実行する必要があり、スキャン処理には影響しません。',
          )}
        />
      </div>

      <select
        value={emb.embeddingModel}
        onChange={(e) => emb.setEmbeddingModel(e.target.value)}
        className="w-full bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500/50"
      >
        {availableModels.length === 0 ? (
          <option value={emb.embeddingModel}>{emb.embeddingModel} (Current)</option>
        ) : (
          [...new Set([emb.embeddingModel, ...availableModels])].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))
        )}
      </select>

      {/* 推奨埋め込みモデル */}
      <EmbeddingPresetCards
        models={RECOMMENDED_EMBEDDING_MODELS}
        availableModels={availableModels}
        selectedModel={emb.embeddingModel}
        onSelect={(item) => onSelectPreset(item, 'embedding')}
      />

      {/* 現在の状態 */}
      {emb.status && (
        <div className="mt-2.5 p-2.5 rounded-xl bg-slate-950/60 border border-white/5 text-[11px] text-slate-300 space-y-1">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>
              {t('settings.label_spectrum_embedded', 'ベクトル化済みタグ')}: {emb.status.embedded_tags} /{' '}
              {emb.status.total_tags}
            </span>
            <span className={emb.status.missing_tags > 0 ? 'text-amber-300' : ''}>
              {t('settings.label_spectrum_missing', '未生成')}: {emb.status.missing_tags}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
            <span>
              {t('settings.label_spectrum_eligible', '検索対象メディア')}: {emb.status.eligible_media}
            </span>
            {/* タグ不足で対象外になるメディアを黙って隠さない */}
            <span>
              {t('settings.label_spectrum_excluded', 'タグ')}
              {emb.status.min_basic_tags}
              {t('settings.label_spectrum_excluded_suffix', '個未満で対象外')}: {emb.status.excluded_media}
            </span>
          </div>
          {!emb.status.model_available && (
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
          onClick={emb.generate}
          disabled={emb.isGenerating || !emb.status || emb.status.missing_tags === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl text-[11px] font-semibold transition cursor-pointer"
        >
          {emb.isGenerating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          {t('settings.label_spectrum_generate', '未生成のタグをベクトル化')}
        </button>
        <button
          type="button"
          onClick={emb.runDiagnostics}
          disabled={emb.diagnosticsLoading || emb.isGenerating}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-xl text-[11px] font-semibold transition cursor-pointer border border-white/10"
        >
          {emb.diagnosticsLoading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FlaskConical className="w-3.5 h-3.5 text-indigo-400" />
          )}
          {t('settings.label_spectrum_diagnostics', '類似度分布を計測')}
        </button>
        {emb.isGenerating && emb.progress && emb.progress.total > 0 && (
          <span className="text-[11px] text-slate-400 tabular-nums">
            {emb.progress.current} / {emb.progress.total}
          </span>
        )}
      </div>

      {emb.error && (
        <div className="mt-2 p-2 rounded-lg bg-red-950/40 border border-red-500/30 text-[11px] text-red-200">
          {emb.error}
        </div>
      )}

      {/* 削除・破棄の結果。件数と解放量を出さないと、消えたのかどうかが分からない */}
      {emb.cleanupResult && (
        <div className="mt-2 p-2 rounded-lg bg-emerald-950/40 border border-emerald-500/30 text-[11px] text-emerald-200 flex items-start gap-1.5">
          <Check className="w-3.5 h-3.5 shrink-0 mt-px text-emerald-400" />
          <span>
            {emb.cleanupResult.deleted_rows > 0 ? (
              <>
                {t('settings.spectrum_cleanup_done', '{rows}件のベクトルを削除しました（{size} MB）。', {
                  rows: emb.cleanupResult.deleted_rows,
                  size: (emb.cleanupResult.freed_bytes / 1e6).toFixed(1),
                })}{' '}
                {/* VACUUM が走らないとファイルは縮まない。DB のサイズを見て「削除が失敗した」と
                    読まれるのを防ぐため、縮んだかどうかを必ず添える */}
                {emb.cleanupResult.vacuumed
                  ? t('settings.spectrum_cleanup_vacuumed', 'DBファイルも縮んでいます。')
                  : t(
                      'settings.spectrum_cleanup_not_vacuumed',
                      'DBファイルはまだ縮んでいません。空いた領域は次にベクトルを作り直すときに再利用されます。',
                    )}
              </>
            ) : (
              t('settings.spectrum_cleanup_none', '削除するベクトルはありませんでした。')
            )}
          </span>
        </div>
      )}

      {/* 実験用トグル。ベクトルには影響しないので、切り替えたら
          そのまま「類似度分布を計測」で比較できる（保存も再生成も不要） */}
      <div className="mt-3 space-y-2">
        <p className="text-[10px] text-slate-500 leading-relaxed">
          {t(
            'settings.spectrum_toggle_note',
            '下の2つはタグのベクトルに影響しません。切り替えてから「類似度分布を計測」を押すと、保存せずにその場で比較できます。',
          )}
        </p>
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={emb.centering}
            onChange={(e) => emb.setCentering(e.target.checked)}
            className="mt-0.5 accent-indigo-500"
          />
          <span className="text-[11px] text-slate-300">
            {t('settings.label_spectrum_centering', 'ハブ化対策 (centering) を有効にする')}
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
            checked={emb.includeDescriptive}
            onChange={(e) => emb.setIncludeDescriptive(e.target.checked)}
            className="mt-0.5 accent-indigo-500"
          />
          <span className="text-[11px] text-slate-300">
            {t('settings.label_spectrum_descriptive', '記述的タグも類似度計算に含める')}
            <span className="block text-[10px] text-slate-500">
              {t(
                'settings.spectrum_descriptive_help',
                'ONにすると、高精度モデルで解析したメディア同士が優先的に似ていると判定される場合があります。',
              )}
            </span>
          </span>
        </label>
      </div>

      {/* 保存領域とGC */}
      {storageInfo && storageInfo.models.length > 0 && (
        <div className="mt-2.5 p-2.5 rounded-xl bg-slate-950/60 border border-white/5 text-[11px] space-y-1.5">
          <div className="text-slate-400">{t('settings.label_spectrum_storage', 'ベクトルの保存量')}</div>
          {storageInfo.models.map((m) => (
            <div key={m.model} className="flex items-center gap-2 text-slate-300">
              <span className="font-mono truncate flex-1">{m.model}</span>
              {m.in_use && (
                <span className="px-1.5 py-0.5 rounded bg-indigo-600/40 text-indigo-200 text-[9px] font-bold shrink-0">
                  {t('settings.label_spectrum_in_use', '使用中')}
                </span>
              )}
              <span className="tabular-nums text-slate-400 shrink-0">
                {m.tag_count} / {storageInfo.total_tags}
              </span>
              <span className="tabular-nums text-slate-400 shrink-0 w-16 text-right">
                {(m.bytes / 1e6).toFixed(1)} MB
              </span>
            </div>
          ))}
          <div className="flex flex-wrap gap-2 pt-1">
            {storageInfo.reclaimable_bytes > 0 && (
              <button
                type="button"
                onClick={emb.cleanup}
                disabled={emb.isCleaningUp || emb.isGenerating}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-xl text-[11px] font-semibold transition cursor-pointer border border-white/10"
              >
                {emb.isCleaningUp ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                )}
                {t('settings.label_spectrum_gc', '使用中以外のモデルのベクトルを削除')} (
                {(storageInfo.reclaimable_bytes / 1e6).toFixed(1)} MB)
              </button>
            )}
            {/* 使用中のモデルを作り直したいとき用。GC では消えない */}
            {storageInfo.models.some((m) => m.in_use) && (
              <button
                type="button"
                onClick={() => emb.setConfirmDiscard(true)}
                disabled={emb.isCleaningUp || emb.isGenerating}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-xl text-[11px] font-semibold transition cursor-pointer border border-white/10"
              >
                <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
                {t('settings.label_spectrum_discard', '使用中のモデルのベクトルを破棄して作り直す')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 計測結果。生の数値だけでは評価できないため、判定と次の一手を添える */}
      {emb.diagnostics && <EmbeddingDiagnosticsPanel d={emb.diagnostics} />}
    </div>
  );
};
