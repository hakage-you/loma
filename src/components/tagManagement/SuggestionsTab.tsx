import React from 'react';
import { Check, Eye, PlusCircle, RefreshCw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { MergeSuggestion, TagItem } from '../../types';
import { ruleLabelKey } from '../../constants/suggestMethods';
import { useTranslation } from '../../contexts/I18nContext';
import { SampleThumbStack } from './TagThumbs';

interface Props {
  /** 並べ替え済みの提案。**グループの大きい順**（先頭ほど重い） */
  sortedSuggestions: MergeSuggestion[];
  /** 絞り込み前の全件。空表示の出し分けに要る */
  suggestions: MergeSuggestion[];
  /** いま DOM に置く件数。**上限ではない** —— 末尾まで来たら足していく */
  visibleSuggestionCount: number;

  /** 承認した提案の id。ここに入っているものだけが適用される */
  acceptedIds: Set<string>;
  /** 却下した提案の id */
  rejectedIds: Set<string>;
  onToggleAccept: (suggestionId: string) => void;
  onToggleReject: (suggestionId: string) => void;

  /** 提案ごとの「残すタグ」。id → タグ id */
  selectedMasterTagIds: Record<string, number>;
  onSelectMasterTag: (suggestionId: string, tagId: number) => void;
  /** 手で打ち直した残し名。id → { name, nameJa } */
  customMasterTags: Record<string, { name: string; nameJa: string }>;
  onCustomMasterTagChange: (suggestionId: string, field: 'name' | 'nameJa', value: string) => void;
  /** 統合から外したタグ。id → タグ id の集合 */
  excludedTagIds: Record<string, Set<number>>;
  onToggleExcludeTag: (suggestionId: string, tagId: number) => void;

  onOpenTagPreview: (tag: TagItem) => void;
  /** 承認済みの提案をまとめて適用する */
  onApplySelected: () => void;

  loadingSuggestions: boolean;
  applyingMerges: boolean;
  applyProgressText: string;
  isScanning: boolean;
  /** 排他コマンド実行中の遮断。押せない理由も持つ */
  exclusive: { blocked: boolean; reason?: string };

  scrollRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * タグ管理の「AI提案」タブ。
 *
 * **並んでいるのは候補であって、決定ではない。** 承認したものだけが統合され、
 * 残すタグも提案ごとに選び直せる（手で打ち直すこともできる）。
 * 却下と除外は別物で、却下は提案そのもの、除外はその中の1タグを外す。
 */
export const SuggestionsTab: React.FC<Props> = ({
  sortedSuggestions,
  suggestions,
  visibleSuggestionCount,
  acceptedIds,
  rejectedIds,
  onToggleAccept,
  onToggleReject,
  selectedMasterTagIds,
  onSelectMasterTag,
  customMasterTags,
  onCustomMasterTagChange,
  excludedTagIds,
  onToggleExcludeTag,
  onOpenTagPreview,
  onApplySelected,
  loadingSuggestions,
  applyingMerges,
  applyProgressText,
  isScanning,
  exclusive,
  scrollRef,
  sentinelRef,
}) => {
  // `translate` は `t` の別名。元のコードが両方の名前で呼んでいたのでそのまま残す
  const { t, t: translate } = useTranslation();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {loadingSuggestions ? (
        // **空表示にしない。** 読み込み中に「提案はまだありません」を出すと、
        // 0件だったのか待っているだけなのかが区別できない
        <div className="flex-1 overflow-hidden p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-indigo-400" />
            <span>{t('tag_modal.label_loading_suggestions', 'Loading suggestions...')}</span>
          </div>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-28 rounded-2xl border border-white/5 bg-slate-950/40 animate-pulse-subtle"
            />
          ))}
        </div>
      ) : suggestions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <Sparkles className="w-10 h-10 text-indigo-400/50 mb-2" />
          <h3 className="text-sm font-semibold text-slate-300">{t('tag_modal.label_proposals_empty_title','No suggestions yet')}</h3>
          <p className="text-xs text-slate-500 max-w-sm mt-1">
            {t(
              'tag_modal.proposals_empty_body',
              'Press "Scan Similar Tags" to look for spelling variants, singular/plural forms and tags close in meaning, and list them as consolidation candidates.',
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="p-3 bg-slate-950/80 border-b border-white/10 flex items-center justify-between">
            <span className="text-xs text-slate-300 font-medium">
              {t('tag_modal.label_proposals_summary','Selected suggestions')} ({acceptedIds.size} / {suggestions.length})
            </span>

            <button
              onClick={onApplySelected}
              disabled={acceptedIds.size === 0 || applyingMerges || isScanning || exclusive.blocked}
              title={exclusive.reason}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-900/30 cursor-pointer disabled:opacity-40"
            >
              {applyingMerges ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  <span>{applyProgressText || t('tag_modal.label_btn_applying','Consolidating...')}</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>{t('tag_modal.label_btn_apply_merges','Consolidate selected')} ({acceptedIds.size})</span>
                </>
              )}
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
            {sortedSuggestions.slice(0, visibleSuggestionCount).map((sug) => {
              if (!sug || !sug.target_tag) return null;
              const sources = Array.isArray(sug.source_tags)
                ? sug.source_tags.filter(Boolean)
                : (sug as any).source_tag
                ? [(sug as any).source_tag]
                : [];
              const allMembers = [sug.target_tag, ...sources];
              const currentMasterId = selectedMasterTagIds[sug.id] ?? sug.target_tag.id;
              const isCustomMaster = currentMasterId === -1;
              const masterTag = allMembers.find((t) => t && t.id === currentMasterId) || sug.target_tag;
              const sourceTags = allMembers.filter((t) => t && t.id !== currentMasterId);

              const customInfo = customMasterTags[sug.id] || { name: '', nameJa: '' };
              const excludedSet = excludedTagIds[sug.id] || new Set();
              const activeSourceCount = sourceTags.filter((t) => !excludedSet.has(t.id)).length;

              const isAccepted = acceptedIds.has(sug.id) && !rejectedIds.has(sug.id);
              const isRejected = rejectedIds.has(sug.id);

              return (
                <div
                  key={sug.id}
                  className={`p-4 rounded-2xl border transition-all ${
                    isAccepted
                      ? 'bg-slate-950/90 border-indigo-500/50 shadow-lg'
                      : isRejected
                      ? 'bg-slate-950/40 border-red-500/30 opacity-60'
                      : 'bg-slate-950/60 border-white/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="flex items-center gap-2 max-w-[65%] min-w-0 flex-wrap">
                      {/* **どの規則で候補になったかを個別に出す。**
                          これが無いと、提案が妥当かどうかを判断する材料が無い。
                          複数該当は確度が高いので、件数も併記する */}
                      {sug.rules && sug.rules.length > 0 ? (
                        sug.rules.map((r) => (
                          <span
                            key={r}
                            title={r}
                            className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full text-[11px] font-semibold shrink-0"
                          >
                            {t(ruleLabelKey(r), r)}
                          </span>
                        ))
                      ) : (
                        <span
                          className="px-2.5 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full text-[11px] font-semibold truncate"
                          title={sug.reason}
                        >
                          {sug.reason}
                        </span>
                      )}
                      {sug.rules && sug.rules.length > 1 && (
                        <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-[11px] font-bold shrink-0">
                          {t('tag_modal.label_rules_matched', 'matches {n} rules', { n: sug.rules.length })}
                        </span>
                      )}
                      <span className="text-xs text-slate-400 shrink-0">
                        ({t('tag_modal.label_member_count', '{n} tags', { n: allMembers.length })})
                      </span>

                      {/* サンプルサムネイルのアバタースタック表示 & ホバーフローティング拡大 & 続きありインジケーター */}
                      {sug.sample_thumbnails && sug.sample_thumbnails.length > 0 && (
                        <SampleThumbStack
                          thumbnails={sug.sample_thumbnails}
                          totalImagesCount={sug.total_images_count}
                        />
                      )}
                    </div>

                    {/* Accept / Reject Buttons */}
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onToggleAccept(sug.id)}
                        className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                          isAccepted
                            ? 'bg-emerald-600 text-white shadow'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <ThumbsUp className="w-3.5 h-3.5" />
                        {t('tag_modal.label_btn_accept', 'Approve')}
                      </button>

                      <button
                        onClick={() => onToggleReject(sug.id)}
                        title={isRejected ? t('tag_modal.reject_cancel_hint','') : t('tag_modal.reject_hint','')}
                        className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                          isRejected
                            ? 'bg-red-600 text-white shadow animate-pulse'
                            : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        <ThumbsDown className="w-3.5 h-3.5" />
                        {isRejected ? t('tag_modal.label_btn_reject_pending','Reject (removed in 3s)') : t('tag_modal.label_btn_reject','Reject')}
                      </button>
                    </div>
                  </div>

                  {/* Group Selection Area */}
                  <div className="bg-slate-900/90 p-3 rounded-xl border border-white/5 space-y-3">
                    {/* Master Selection Dropdown & Custom Input */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] text-emerald-400 font-bold uppercase tracking-wider shrink-0">
                            {t('tag_modal.label_keep_master', 'Tag to keep')}
                          </span>
                          {!isCustomMaster && (
                            <button
                              onClick={() => onOpenTagPreview(masterTag)}
                              className="p-1 text-slate-400 hover:text-indigo-300 rounded hover:bg-slate-800 transition cursor-pointer"
                              title={t('tag_modal.label_title_preview_master', 'Preview media with the tag to keep')}
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>

                        <select
                          value={currentMasterId}
                          onChange={(e) => onSelectMasterTag(sug.id, Number(e.target.value))}
                          className="bg-slate-950 border border-indigo-500/40 text-xs font-bold text-white px-3 py-1.5 rounded-lg focus:outline-none flex-1 max-w-md"
                        >
                          {allMembers.map((m) => (
                            <option key={m.id} value={m.id}>
                              #{m.name} {m.name_ja ? `(${m.name_ja})` : ''} ({m.count ?? 0})
                            </option>
                          ))}
                          <option value={-1}>
                            ✏️ {t('tag_modal.label_custom_master', 'Enter my own')}
                          </option>
                        </select>
                      </div>

                      {/* Custom Hand-typed Inputs */}
                      {isCustomMaster && (
                        <div className="flex items-center gap-2 pl-4 pt-1 animate-in fade-in zoom-in-95">
                          <PlusCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                          <input
                            type="text"
                            value={customInfo.name}
                            onChange={(e) => onCustomMasterTagChange(sug.id, 'name', e.target.value)}
                            placeholder={t('tag_modal.label_placeholder_custom_en','English name (e.g. drink)')}
                            className="bg-slate-950 border border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none flex-1 font-mono"
                          />
                          <input
                            type="text"
                            value={customInfo.nameJa}
                            onChange={(e) => onCustomMasterTagChange(sug.id, 'nameJa', e.target.value)}
                            placeholder={t('tag_modal.label_placeholder_custom_ja','Japanese name')}
                            className="bg-slate-950 border border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none flex-1"
                          />
                        </div>
                      )}
                    </div>

                    {/* Sources to be Merged & Removed */}
                    <div className="flex items-start gap-2 pt-2 border-t border-white/5">
                      <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider shrink-0 mt-1">
                        {t('tag_modal.label_merge_and_remove','Tags to consolidate and remove')} ({activeSourceCount})
                      </span>
                      <div className="flex flex-wrap gap-1.5 flex-1">
                        {sourceTags.map((st) => {
                          const isExcluded = excludedSet.has(st.id);
                          return (
                            <div
                              key={st.id}
                              // **打ち消し線と減光はタグ名だけに掛ける。**
                              // ここに置くと「戻す」ボタンと目のアイコンにも継承され、
                              // 押せないボタンに見える
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border transition ${
                                isExcluded
                                  ? 'bg-slate-950/40 border-white/5'
                                  : 'bg-slate-950 text-slate-300 border-white/10'
                              }`}
                            >
                              <span className={isExcluded ? 'line-through text-slate-600 opacity-60' : ''}>
                                #{st.name}
                                {st.name_ja && (
                                  <span className="text-[10px] font-normal text-slate-500 ml-1 no-underline">
                                    ({st.name_ja})
                                  </span>
                                )}
                                <span className="text-[10px] text-slate-500 ml-1 font-sans">
                                  ({st.count ?? 0})
                                </span>
                              </span>

                              {/* Preview Button */}
                              <button
                                onClick={() => onOpenTagPreview(st)}
                                className="text-slate-400 hover:text-indigo-300 transition cursor-pointer"
                                title={translate('tag_modal.label_title_preview', 'Preview media with this tag')}
                              >
                                <Eye className="w-3 h-3" />
                              </button>

                              {/* Exclude / Include Toggle Button */}
                              <button
                                onClick={() => onToggleExcludeTag(sug.id, st.id)}
                                className={`p-0.5 rounded transition cursor-pointer text-[10px] font-bold ${
                                  isExcluded
                                    ? 'text-emerald-400 hover:bg-emerald-950/50'
                                    : 'text-red-400 hover:bg-red-950/50'
                                }`}
                                title={
                                  isExcluded
                                    ? t('tag_modal.label_title_include', 'Include back in the consolidation')
                                    : t('tag_modal.label_title_exclude', 'Exclude from the consolidation')
                                }
                              >
                                {isExcluded ? t('tag_modal.label_btn_include','Include') : t('tag_modal.label_btn_exclude','Exclude')}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {/* 末尾に来たら次を足す。上限ではないので全件に到達できる */}
            <div ref={sentinelRef} className="h-px" />
          </div>
        </>
      )}
    </div>
  );
};
