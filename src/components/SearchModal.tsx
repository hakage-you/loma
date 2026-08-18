import React, { useState, useEffect, useMemo, useRef } from 'react';
import { X, Search, Sliders, Hash, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { TagItem, SearchGroup, TagFilterNode } from '../types';

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
  tags: TagItem[];
  initialGroups?: SearchGroup[];
  prefillTag?: string;
  onApplySearch: (groups: SearchGroup[]) => void;
  onClearSearch: () => void;
}

function filterTreeToDisplayString(node: TagFilterNode): string {
  switch (node.type) {
    case 'tag':
      return `#${node.value}`;
    case 'and':
      return node.children
        .map((c) => {
          const s = filterTreeToDisplayString(c);
          return c.type === 'or' ? `(${s})` : s;
        })
        .join(' AND ');
    case 'or':
      return node.children.map((c) => filterTreeToDisplayString(c)).join(' OR ');
    case 'not': {
      const inner = filterTreeToDisplayString(node.child);
      return `NOT ${node.child.type === 'or' || node.child.type === 'and' ? `(${inner})` : inner}`;
    }
  }
}

function groupsToFilterTree(groups: SearchGroup[]): TagFilterNode | null {
  if (groups.length === 0) return null;
  const children: TagFilterNode[] = [];
  for (const group of groups) {
    if (group.tags.length === 0) continue;
    const tagNodes: TagFilterNode[] = group.tags.map((t) => ({ type: 'tag', value: t }));
    if (group.operator === 'not') {
      const inner: TagFilterNode =
        tagNodes.length === 1 ? tagNodes[0] : { type: 'or', children: tagNodes };
      children.push({ type: 'not', child: inner });
    } else if (group.operator === 'or') {
      children.push(tagNodes.length === 1 ? tagNodes[0] : { type: 'or', children: tagNodes });
    } else {
      children.push(tagNodes.length === 1 ? tagNodes[0] : { type: 'and', children: tagNodes });
    }
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { type: 'and', children };
}

export const SearchModal: React.FC<SearchModalProps> = ({
  open,
  onClose,
  tags = [],
  initialGroups,
  prefillTag,
  onApplySearch,
  onClearSearch,
}) => {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [tagInputs, setTagInputs] = useState<Record<string, string>>({});
  const [showSuggestionsForGroupId, setShowSuggestionsForGroupId] = useState<string | null>(null);

  const suggestBoxRef = useRef<HTMLDivElement>(null);

  // Initialize modal state when opened
  useEffect(() => {
    if (open) {
      let init: SearchGroup[];
      if (initialGroups && initialGroups.length > 0) {
        init = initialGroups.map((g) => ({ ...g, tags: [...g.tags] }));
      } else {
        init = [{ id: crypto.randomUUID(), operator: 'and', tags: [] }];
      }

      if (prefillTag) {
        const cleanPrefill = prefillTag.replace(/^#+/, '').trim();
        if (cleanPrefill) {
          const lastGroup = init[init.length - 1];
          if (!lastGroup.tags.includes(cleanPrefill)) {
            setTagInputs({ [lastGroup.id]: cleanPrefill });
          }
        }
      } else {
        setTagInputs({});
      }

      setGroups(init);
    }
  }, [open, initialGroups, prefillTag]);

  // Click outside to close suggestion popup
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(e.target as Node)) {
        setShowSuggestionsForGroupId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const previewString = useMemo(() => {
    const tree = groupsToFilterTree(groups);
    return tree ? filterTreeToDisplayString(tree) : '';
  }, [groups]);

  if (!open) return null;

  const handleAddGroup = () => {
    const newGroup: SearchGroup = {
      id: crypto.randomUUID(),
      operator: 'and',
      tags: [],
    };
    setGroups([...groups, newGroup]);
  };

  const handleRemoveGroup = (groupId: string) => {
    if (groups.length <= 1) return;
    setGroups(groups.filter((g) => g.id !== groupId));
    setTagInputs((prev) => {
      const next = { ...prev };
      delete next[groupId];
      return next;
    });
  };

  const handleOperatorChange = (groupId: string, operator: 'and' | 'or' | 'not') => {
    setGroups(
      groups.map((g) => (g.id === groupId ? { ...g, operator } : g))
    );
  };

  const handleAddTagToGroup = (groupId: string, tagName: string) => {
    const clean = tagName.trim().replace(/^#+/, '');
    if (!clean) return;
    setGroups(
      groups.map((g) => {
        if (g.id === groupId) {
          if (!g.tags.includes(clean)) {
            return { ...g, tags: [...g.tags, clean] };
          }
        }
        return g;
      })
    );
    setTagInputs((prev) => ({ ...prev, [groupId]: '' }));
    setShowSuggestionsForGroupId(null);
  };

  const handleRemoveTagFromGroup = (groupId: string, tagName: string) => {
    setGroups(
      groups.map((g) => {
        if (g.id === groupId) {
          return { ...g, tags: g.tags.filter((t) => t !== tagName) };
        }
        return g;
      })
    );
  };

  const getFilteredSuggestions = (groupId: string) => {
    const inputVal = (tagInputs[groupId] || '').trim().toLowerCase();
    if (!inputVal || !tags || tags.length === 0) return [];
    const targetGroup = groups.find((g) => g.id === groupId);
    const existingTags = new Set((targetGroup?.tags || []).map((t) => t.toLowerCase()));

    const freeTags = tags.filter((t) => !t.is_category);
    const result: TagItem[] = [];
    for (let i = 0; i < freeTags.length; i++) {
      const item = freeTags[i];
      const matchEn = item.name.toLowerCase().includes(inputVal);
      const matchJa = item.name_ja ? item.name_ja.toLowerCase().includes(inputVal) : false;
      const tagVal = item.name_ja || item.name;

      if (
        (matchEn || matchJa) &&
        !existingTags.has(tagVal.toLowerCase()) &&
        !existingTags.has(item.name.toLowerCase())
      ) {
        result.push(item);
        if (result.length >= 12) break;
      }
    }
    // 基本語タグを優先し、修飾語タグは後置する
    return result.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'descriptive' ? 1 : -1));
  };

  const handleApply = () => {
    const activeGroups = groups.filter((g) => g.tags.length > 0);
    onApplySearch(activeGroups);
    onClose();
  };

  const handleClearAll = () => {
    onClearSearch();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-3xl max-h-[90vh] bg-slate-900 border border-indigo-500/30 rounded-2xl shadow-2xl overflow-hidden flex flex-col p-6 gap-5 animate-in zoom-in-95 duration-150 text-slate-200 select-none">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4 shrink-0">
          <div className="flex items-center gap-2.5 text-lg font-bold text-white">
            <Sliders className="w-5 h-5 text-indigo-400" />
            <span>{t('search_modal.label_title', '詳細検索ビルダー')}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Readonly Logical Search Query Preview */}
        <div className="space-y-1.5 shrink-0">
          <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
            {t('search_modal.label_query_preview', '検索条件プレビュー')}
          </label>
          <div className="relative">
            <input
              type="text"
              readOnly
              value={previewString || t('search_modal.label_no_condition', '(no conditions set)')}
              className="w-full bg-slate-950 px-3.5 py-2.5 rounded-xl border border-white/10 text-xs font-mono text-indigo-200 focus:outline-none select-all"
            />
          </div>
        </div>

        {/* Groups List Container */}
        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {groups.map((group, groupIdx) => {
            const suggestions = getFilteredSuggestions(group.id);
            const isShowingSug = showSuggestionsForGroupId === group.id;

            return (
              <React.Fragment key={group.id}>
                {/* AND Connector Between Groups */}
                {groupIdx > 0 && (
                  <div className="flex items-center justify-center py-0.5">
                    <span className="text-[11px] font-bold text-slate-400 bg-slate-800/80 px-3 py-0.5 rounded-full border border-white/10 tracking-widest">
                      {t('search_modal.label_between_groups', 'AND')}
                    </span>
                  </div>
                )}

                {/* Group Box */}
                <div className="bg-slate-950/60 p-4 rounded-xl border border-white/10 space-y-3 relative">
                  {/* Group Header */}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-bold text-slate-300">
                      {t('search_modal.label_group_label', 'グループ')} {groupIdx + 1}
                    </span>

                    <div className="flex items-center gap-2">
                      {/* Operator Select */}
                      <select
                        value={group.operator}
                        onChange={(e) =>
                          handleOperatorChange(group.id, e.target.value as 'and' | 'or' | 'not')
                        }
                        className={`text-xs font-bold px-2.5 py-1 rounded-lg border focus:outline-none cursor-pointer ${
                          group.operator === 'and'
                            ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/40'
                            : group.operator === 'or'
                            ? 'bg-emerald-600/30 text-emerald-200 border-emerald-500/40'
                            : 'bg-red-600/30 text-red-200 border-red-500/40'
                        }`}
                      >
                        <option value="and" className="bg-slate-900 text-white">
                          {t('search_modal.label_operator_and', 'すべて含む (AND)')}
                        </option>
                        <option value="or" className="bg-slate-900 text-white">
                          {t('search_modal.label_operator_or', 'いずれか含む (OR)')}
                        </option>
                        <option value="not" className="bg-slate-900 text-white">
                          {t('search_modal.label_operator_not', '除外する (NOT)')}
                        </option>
                      </select>

                      {/* Remove Group Button */}
                      {groups.length > 1 && (
                        <button
                          onClick={() => handleRemoveGroup(group.id)}
                          className="p-1 text-slate-400 hover:text-red-400 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                          title={t('search_modal.label_remove_group', 'グループ削除')}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Add Tag Input & Chips */}
                  <div className="space-y-2">
                    <div className="relative" ref={isShowingSug ? suggestBoxRef : undefined}>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={tagInputs[group.id] || ''}
                          onChange={(e) => {
                            setTagInputs({ ...tagInputs, [group.id]: e.target.value });
                            setShowSuggestionsForGroupId(group.id);
                          }}
                          onFocus={() => setShowSuggestionsForGroupId(group.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (tagInputs[group.id] || '').trim()) {
                              handleAddTagToGroup(group.id, tagInputs[group.id] || '');
                            }
                          }}
                          placeholder={t('search_modal.label_input_placeholder', 'タグ名を入力...')}
                          className="flex-1 bg-slate-900 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                        />
                        <button
                          onClick={() =>
                            handleAddTagToGroup(group.id, tagInputs[group.id] || '')
                          }
                          disabled={!(tagInputs[group.id] || '').trim()}
                          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold transition cursor-pointer disabled:opacity-40"
                        >
                          {t('search_modal.label_add_btn', '追加')}
                        </button>
                      </div>

                      {/* Autocomplete Suggestions Dropdown */}
                      {isShowingSug && suggestions.length > 0 && (
                        <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-slate-900 border border-indigo-500/40 rounded-xl shadow-2xl overflow-hidden max-h-48 overflow-y-auto divide-y divide-white/5 animate-in fade-in zoom-in-95 duration-100">
                          {suggestions.map((sug) => {
                            const tagVal = sug.name_ja || sug.name;
                            return (
                              <div
                                key={sug.id}
                                onClick={() => handleAddTagToGroup(group.id, tagVal)}
                                className="px-3 py-2 hover:bg-indigo-600/30 cursor-pointer transition flex items-center justify-between text-xs"
                              >
                                <span className={`flex items-center gap-1.5 font-medium ${sug.kind === 'descriptive' ? 'text-slate-400' : 'text-indigo-200'}`}>
                                  <Hash className={`w-3.5 h-3.5 ${sug.kind === 'descriptive' ? 'text-slate-500' : 'text-indigo-400'}`} />
                                  {sug.name_ja ? `${sug.name_ja} (${sug.name})` : sug.name}
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono">
                                  {sug.count ?? 0} media
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Chips Display */}
                    <div className="flex flex-wrap gap-1.5 min-h-[36px] p-2 bg-slate-900/50 rounded-lg border border-white/5 items-center">
                      {group.tags.map((tag) => (
                        <span
                          key={tag}
                          className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border ${
                            group.operator === 'and'
                              ? 'bg-indigo-600/30 text-indigo-200 border-indigo-500/40'
                              : group.operator === 'or'
                              ? 'bg-emerald-600/30 text-emerald-200 border-emerald-500/40'
                              : 'bg-red-600/30 text-red-200 border-red-500/40'
                          }`}
                        >
                          {group.operator === 'not' ? `NOT #${tag}` : `#${tag}`}
                          <X
                            className="w-3.5 h-3.5 cursor-pointer hover:text-white transition ml-0.5"
                            onClick={() => handleRemoveTagFromGroup(group.id, tag)}
                          />
                        </span>
                      ))}

                      {group.tags.length === 0 && (
                        <span className="text-slate-500 italic text-[11px]">
                          {t('search_modal.no_tags_group', 'タグが追加されていません')}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })}

          {/* Add Group Button */}
          <button
            onClick={handleAddGroup}
            className="w-full py-2 bg-slate-800/60 hover:bg-slate-800 text-indigo-300 hover:text-indigo-200 rounded-xl text-xs font-bold transition border border-dashed border-indigo-500/30 flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>{t('search_modal.label_add_group', 'グループ追加')}</span>
          </button>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-3 border-t border-white/10 shrink-0">
          <button
            onClick={handleClearAll}
            className="px-3 py-1.5 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition cursor-pointer font-semibold"
          >
            {t('search_modal.label_clear_all', '条件をすべてクリア')}
          </button>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition cursor-pointer"
            >
              {t('search_modal.label_cancel', 'キャンセル')}
            </button>
            <button
              onClick={handleApply}
              className="px-5 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-900/30 transition cursor-pointer flex items-center gap-1.5"
            >
              <Search className="w-3.5 h-3.5" />
              <span>{t('search_modal.label_apply', '検索を適用')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
