import React from 'react';
import { Check, Edit2, Eye, Filter, RefreshCw, Search } from 'lucide-react';
import { TagItem } from '../../types';
import { useTranslation } from '../../contexts/I18nContext';
import { SampleThumbStack } from './TagThumbs';

export type TagSortBy = 'count_desc' | 'count_asc' | 'alpha_asc' | 'ja_asc';
export type TagKindFilter = 'all' | 'basic' | 'descriptive';

interface Props {
  /** 絞り込みと並べ替えを済ませた一覧。**この順で上から出す** */
  sortedTags: TagItem[];
  /** 手動統合の「残すタグ」の選択肢。カテゴリを含まない全タグ */
  freeTags: TagItem[];
  /** いま DOM に置く件数。**上限ではない** —— 末尾まで来たら足していく */
  visibleTagCount: number;

  search: string;
  setSearch: (v: string) => void;
  sortBy: TagSortBy;
  setSortBy: React.Dispatch<React.SetStateAction<TagSortBy>>;
  kindFilter: TagKindFilter;
  setKindFilter: (v: TagKindFilter) => void;

  editingTagId: number | null;
  editName: string;
  setEditName: (v: string) => void;
  editNameJa: string;
  setEditNameJa: (v: string) => void;
  onStartEdit: (tag: TagItem) => void;
  onSaveEdit: (tag: TagItem) => void;

  selectedTagIds: number[];
  setSelectedTagIds: React.Dispatch<React.SetStateAction<number[]>>;
  targetTagId: number | null;
  setTargetTagId: (v: number | null) => void;
  onExecuteManualMerge: () => void;
  applyingMerges: boolean;

  /** タグ id → サムネのパス。一覧の右端に出す */
  tagThumbs: Record<number, string[]>;
  onOpenTagPreview: (tag: TagItem) => void;
  onTriggerSearchFilter: (tagName: string) => void;
  /** タグ名で絞り込む経路があるか。無ければ絞り込みボタンを出さない */
  onSelectTagFilter?: (tagName: string) => void;

  isScanning: boolean;
  /** 排他コマンド実行中の遮断。押せない理由も持つ */
  exclusive: { blocked: boolean; reason?: string };

  scrollRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * タグ管理の「すべてのタグ」タブ。
 *
 * **一覧と手動統合はここで完結する。** AI提案タブとは扱うものが別で、
 * 共有しているのは開いているタグ一覧そのものだけ。
 */
export const AllTagsTab: React.FC<Props> = ({
  sortedTags,
  freeTags,
  visibleTagCount,
  search,
  setSearch,
  sortBy,
  setSortBy,
  kindFilter,
  setKindFilter,
  editingTagId,
  editName,
  setEditName,
  editNameJa,
  setEditNameJa,
  onStartEdit,
  onSaveEdit,
  selectedTagIds,
  setSelectedTagIds,
  targetTagId,
  setTargetTagId,
  onExecuteManualMerge,
  applyingMerges,
  tagThumbs,
  onOpenTagPreview,
  onTriggerSearchFilter,
  onSelectTagFilter,
  isScanning,
  exclusive,
  scrollRef,
  sentinelRef,
}) => {
  // `translate` は `t` の別名。元のコードが両方の名前で呼んでいたのでそのまま残す
  const { t, t: translate, language } = useTranslation();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Search & Manual Merge Toolbar */}
      <div className="p-3 bg-slate-900/50 border-b border-white/5 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[240px]">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('tag_modal.label_filter_placeholder', 'Filter tags...')}
              className="w-full bg-slate-950 border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-slate-950 border border-white/10 text-xs text-slate-300 px-2.5 py-1.5 rounded-xl focus:outline-none focus:border-indigo-500/50 shrink-0 font-medium"
          >
            <option value="count_desc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_count_desc','Count (High → Low)')}</option>
            <option value="count_asc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_count_asc','Count (Low → High)')}</option>
            <option value="alpha_asc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_name_asc','Name (A → Z)')}</option>
            <option value="ja_asc">{t('tag_modal.label_sort_label','Sort')}: {t('tag_modal.label_sort_ja_asc','Japanese')}</option>
          </select>

          {/* タグ種別フィルタ: 基本語 / 記述的タグ */}
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-white/5 shrink-0">
            {(['all', 'basic', 'descriptive'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKindFilter(k)}
                className={`px-2.5 py-1 text-[11px] font-semibold rounded-lg transition cursor-pointer ${
                  kindFilter === k ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {k === 'all'
                  ? t('tag_modal.label_kind_all', 'すべて')
                  : k === 'basic'
                  ? t('tag_modal.label_kind_basic', '基本語')
                  : t('tag_modal.label_kind_descriptive', '修飾語')}
              </button>
            ))}
          </div>
        </div>

        {selectedTagIds.length >= 2 && (
          <div className="flex items-center gap-2 bg-indigo-950/60 border border-indigo-500/40 p-1.5 rounded-xl animate-in fade-in">
            <span className="text-[11px] text-indigo-300 font-semibold px-1">
              {t('tag_modal.label_selected_count','Selected')} ({selectedTagIds.length})
            </span>
            <select
              value={targetTagId || ''}
              onChange={(e) => setTargetTagId(Number(e.target.value))}
              className="bg-slate-900 text-xs text-white border border-white/10 rounded-lg px-2 py-1 focus:outline-none"
            >
              <option value="">{t('tag_modal.label_choose_master','-- Choose the tag to keep --')}</option>
              {freeTags
                .filter((t) => selectedTagIds.includes(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name_ja ? `${t.name_ja} (${t.name})` : t.name} ({t.count ?? 0})
                  </option>
                ))}
            </select>
            <button
              onClick={onExecuteManualMerge}
              disabled={!targetTagId || applyingMerges || isScanning || exclusive.blocked}
              title={exclusive.reason}
              className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition disabled:opacity-40 cursor-pointer flex items-center gap-1"
            >
              {applyingMerges && <RefreshCw className="w-3 h-3 animate-spin" />}
              <span>{t('tag_modal.label_btn_merge_manual','Consolidate manually')}</span>
            </button>
          </div>
        )}
      </div>

      {/* List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1 min-h-0">
        {sortedTags.slice(0, visibleTagCount).map((t) => {
          const isEditing = editingTagId === t.id;
          const isSelected = selectedTagIds.includes(t.id);
          return (
            <div
              key={t.id}
              className={`flex items-center justify-between px-3 py-2 rounded-xl border transition ${
                isSelected
                  ? 'bg-indigo-900/30 border-indigo-500/50'
                  : 'bg-slate-950/60 border-white/5 hover:border-white/10'
              }`}
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedTagIds((prev) => [...prev, t.id]);
                    } else {
                      setSelectedTagIds((prev) => prev.filter((id) => id !== t.id));
                      if (targetTagId === t.id) setTargetTagId(null);
                    }
                  }}
                  className="rounded border-white/20 bg-slate-900 text-indigo-600 focus:ring-0 cursor-pointer"
                />

                {isEditing ? (
                  <div className="flex items-center gap-2 flex-1 max-w-md">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder={translate('tag_modal.label_placeholder_name_en', 'English name')}
                      className="bg-slate-900 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
                    />
                    <input
                      type="text"
                      value={editNameJa}
                      onChange={(e) => setEditNameJa(e.target.value)}
                      placeholder={translate('tag_modal.label_placeholder_name_ja', 'Japanese name')}
                      className="bg-slate-900 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 truncate">
                    <span
                      onClick={() => onTriggerSearchFilter(t.name)}
                      className="font-mono font-semibold text-xs text-indigo-300 hover:text-indigo-200 cursor-pointer hover:underline"
                      title={translate('tag_modal.label_title_search_tag', 'Click to search this tag in gallery')}
                    >
                      #{t.name}
                    </span>
                    {t.name_ja ? (
                      <span
                        onClick={() => onTriggerSearchFilter(t.name_ja || t.name)}
                        className="text-xs text-slate-300 bg-slate-800 px-2 py-0.5 rounded-md border border-white/5 font-medium hover:text-white cursor-pointer hover:underline"
                        title={translate('tag_modal.label_title_search_tag', 'Click to search this tag in gallery')}
                      >
                        {t.name_ja}
                      </span>
                    ) : (
                      // 似ているメディアの検索は name_ja をベクトル化する。
                      // 未設定だと英語名にフォールバックするが、英語名は
                      // normalize_tag_en の単数形化で壊れていることがある
                      // （lens -> len）。直せる場所で気付けるようにしておく。
                      <span
                        className="text-[10px] text-amber-300/90 bg-amber-950/30 px-1.5 py-0.5 rounded border border-amber-500/25 font-medium"
                        title={translate(
                          'tag_modal.no_name_ja_help',
                          '日本語名が未設定です。似ているメディアの検索では英語名で代替されるため、精度が落ちることがあります。',
                        )}
                      >
                        {translate('tag_modal.label_no_name_ja', '日本語名なし')}
                      </span>
                    )}
                    <span className="text-[11px] font-bold text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-white/5">
                      ({t.count ?? 0})
                    </span>
                    {t.kind === 'descriptive' && (
                      <span className="text-[9px] font-bold text-slate-500 bg-slate-900/60 px-1.5 py-0.5 rounded border border-white/5 uppercase tracking-wide">
                        {translate('tag_modal.label_kind_descriptive', 'Descriptive')}
                      </span>
                    )}

                    {/* 目のアイコンで開くまで中身が分からないと、
                        どのタグを統合してよいか判断できない。AI提案のカードと同じ見せ方に揃える */}
                    {tagThumbs[t.id] && tagThumbs[t.id].length > 0 && (
                      <SampleThumbStack
                        thumbnails={tagThumbs[t.id]}
                        totalImagesCount={t.count ?? 0}
                      />
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0 ml-2">
                {onSelectTagFilter && (
                  <button
                    onClick={() =>
                      onTriggerSearchFilter(language === 'ja' && t.name_ja ? t.name_ja : t.name)
                    }
                    className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                    title={translate('tag_modal.label_title_filter', 'Filter gallery by this tag')}
                  >
                    <Filter className="w-3.5 h-3.5" />
                  </button>
                )}

                <button
                  onClick={() => onOpenTagPreview(t)}
                  className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                  title={translate('tag_modal.label_title_preview', 'Preview media with this tag')}
                >
                  <Eye className="w-3.5 h-3.5" />
                </button>

                {isEditing ? (
                  <button
                    onClick={() => onSaveEdit(t)}
                    className="p-1.5 bg-emerald-600 text-white hover:bg-emerald-500 rounded-lg transition cursor-pointer"
                    title={translate('tag_modal.label_title_save', 'Save')}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    onClick={() => onStartEdit(t)}
                    className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
                    title={translate('tag_modal.label_title_edit', 'Edit tag name & translation')}
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {/* 末尾に来たら次を足す。上限ではないので全件に到達できる */}
        <div ref={sentinelRef} className="h-px" />
      </div>
    </div>
  );
};
