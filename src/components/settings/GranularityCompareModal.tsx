import React, { useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Check, FlaskConical, Loader2, RefreshCw, X } from 'lucide-react';
import { GranularityComparisonItem, TagGranularity } from '../../types';
import { GRANULARITY_LEVELS } from '../../constants/granularityLevels';
import { useTranslation } from '../../contexts/I18nContext';

export type GranularityCompareProgress = Record<TagGranularity, 'pending' | 'running' | 'done'>;

interface Props {
  open: boolean;
  onClose: () => void;
  /** 比較に使った画像。選ばれていないときは見出しの説明だけ出す */
  imagePath: string | null;
  results: GranularityComparisonItem[];
  progress: GranularityCompareProgress;
  error: string | null;
}

/**
 * タグ粒度の比較モーダル。3段階を同じ画像で並べて見せる。
 *
 * **段階ごとにタグの出方が違うことを見るためのもの。** 基本語タグは
 * どの段階でも5〜10個で、変わるのは記述的タグの本数（[[GRANULARITY_LEVELS]]）。
 *
 * 画像の拡大表示はこの中だけで完結するので、外に状態を出さない。
 */
export const GranularityCompareModal: React.FC<Props> = ({
  open,
  onClose,
  imagePath,
  results,
  progress,
  error,
}) => {
  const { t } = useTranslation();
  const [enlarged, setEnlarged] = useState(false);

  if (!open) return null;

  const doneCount = Object.values(progress).filter((s) => s === 'done').length;
  const anyRunning = Object.values(progress).some((s) => s === 'running');

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-150">
        <div className="bg-slate-900 border border-indigo-500/40 rounded-2xl max-w-3xl w-full p-5 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              {imagePath ? (
                <button
                  onClick={() => setEnlarged(true)}
                  className="shrink-0 w-14 h-14 rounded-xl overflow-hidden border border-indigo-500/30 hover:border-indigo-400 transition cursor-pointer group relative"
                  title={t('settings.label_title_zoom', 'Click to enlarge')}
                >
                  <img
                    src={convertFileSrc(imagePath)}
                    alt={t('settings.label_alt_preview', 'Preview of the target')}
                    className="w-full h-full object-cover group-hover:scale-105 transition"
                  />
                </button>
              ) : (
                <div className="p-2.5 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30 shrink-0">
                  <FlaskConical className="w-5 h-5" />
                </div>
              )}
              <div className="min-w-0">
                <h4 className="text-base font-bold text-white">
                  {t('settings.label_granularity_try', '粒度を試す（画像を選択）')}
                </h4>
                <p className="text-xs text-slate-400 truncate" title={imagePath || undefined}>
                  {imagePath ? imagePath.split(/[/\\]/).pop() : t('settings.compare_hint', '')}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {error && (
            <div className="p-3 bg-rose-500/10 border border-rose-500/30 rounded-xl text-rose-300 text-xs">
              ⚠️ {error}
            </div>
          )}

          {!error && (
            <>
              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <RefreshCw
                  className={`w-3.5 h-3.5 text-indigo-400 ${anyRunning ? 'animate-spin' : ''}`}
                />
                <span>
                  {doneCount} / {GRANULARITY_LEVELS.length} {t('settings.label_done', 'done')}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {GRANULARITY_LEVELS.map((level) => {
                  const status = progress[level.value];
                  const item = results.find((r) => r.granularity === level.value);
                  return (
                    <div
                      key={level.value}
                      className="p-3 bg-slate-950/60 rounded-xl border border-white/5 space-y-2 min-h-[110px]"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-indigo-300">
                          {t(level.labelKey, level.labelDefault)}
                        </span>
                        {status === 'running' && (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                        )}
                        {status === 'done' && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                        {status === 'pending' && (
                          <span className="text-[10px] text-slate-500">
                            {t('settings.label_waiting', 'Waiting')}
                          </span>
                        )}
                      </div>

                      {status !== 'done' && (
                        <div className="flex items-center justify-center py-6 text-[11px] text-slate-500">
                          {status === 'running'
                            ? t('settings.label_analyzing', 'Analyzing...')
                            : t('settings.label_waiting_dots', 'Waiting...')}
                        </div>
                      )}

                      {status === 'done' && item?.error && (
                        <p className="text-[11px] text-rose-300">⚠️ {item.error}</p>
                      )}

                      {status === 'done' && item && !item.error && (
                        <>
                          <div className="flex flex-wrap gap-1">
                            {item.categories.map((c) => (
                              <span
                                key={c}
                                className="text-[10px] px-1.5 py-0.5 bg-slate-800 text-slate-300 rounded"
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {item.tags.map((tag) => (
                              <span
                                key={tag.en}
                                className="text-[10px] px-1.5 py-0.5 bg-indigo-500/15 text-indigo-300 rounded-full"
                              >
                                #{tag.ja || tag.en}
                              </span>
                            ))}
                          </div>
                          {item.descriptive_tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 pt-1 border-t border-white/5">
                              {item.descriptive_tags.map((tag) => (
                                <span
                                  key={tag.en}
                                  className="text-[10px] px-1.5 py-0.5 bg-slate-800/80 text-slate-400 rounded-full border border-white/5"
                                >
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

      {/* 比較に使った画像の拡大表示 */}
      {enlarged && imagePath && (
        <div
          onClick={() => setEnlarged(false)}
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer animate-in fade-in duration-150 select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center justify-center"
          >
            <img
              src={convertFileSrc(imagePath)}
              alt={t('settings.label_alt_preview_zoom', 'Enlarged preview of the target')}
              className="max-w-full max-h-[80vh] object-contain rounded-2xl shadow-2xl border border-white/10"
            />
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs text-slate-300 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-white/10 truncate max-w-md">
                {imagePath.split(/[/\\]/).pop()}
              </span>
              <button
                onClick={() => setEnlarged(false)}
                className="text-xs text-slate-300 hover:text-white bg-slate-800 px-3 py-1 rounded-lg border border-white/10 transition cursor-pointer"
              >
                {t('settings.label_btn_close', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
