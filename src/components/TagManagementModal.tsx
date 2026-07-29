import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { convertFileSrc } from '@tauri-apps/api/core';
import { X, Edit2, Check, GitMerge, Search, Sparkles, ThumbsUp, ThumbsDown, RefreshCw, Eye, Image as ImageIcon, PlusCircle, CheckCircle2, Filter, Film, AlertCircle } from 'lucide-react';
import { TagItem, MergeSuggestion, MediaItem } from '../types';
import { useTranslation } from '../contexts/I18nContext';

interface TagManagementModalProps {
  open: boolean;
  tags: TagItem[];
  isScanning?: boolean;
  onClose: () => void;
  onRenameTag: (tagId: number, newName: string, newNameJa?: string) => Promise<void>;
  onMergeTags: (targetTagId: number, sourceTagIds: number[]) => Promise<void>;
  onSuggestMerges?: () => Promise<MergeSuggestion[]>;
  onSelectTagFilter?: (tagName: string) => void;
}

const TagPreviewCard: React.FC<{
  media: MediaItem;
  onClick: () => void;
}> = ({ media, onClick }) => {
  const isVideo = /\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(media.file_path);
  const primarySrc = media.thumbnail_path
    ? convertFileSrc(media.thumbnail_path)
    : isVideo
    ? ''
    : convertFileSrc(media.file_path);
  const fallbackSrc = isVideo ? '' : convertFileSrc(media.file_path);

  const [imgSrc, setImgSrc] = useState<string>(primarySrc);
  const [hasError, setHasError] = useState<boolean>(!primarySrc);

  const handleImgError = () => {
    if (imgSrc === primarySrc && fallbackSrc && fallbackSrc !== primarySrc) {
      setImgSrc(fallbackSrc);
    } else {
      setHasError(true);
    }
  };

  const fileName = media.file_path.split(/[/\\]/).pop() || '';

  return (
    <div
      onClick={onClick}
      className="group relative bg-slate-950 border border-white/10 rounded-xl overflow-hidden shadow aspect-square flex flex-col items-center justify-center cursor-pointer transition hover:border-indigo-500/50 select-none"
      title={fileName}
    >
      {!hasError && imgSrc ? (
        <img
          src={imgSrc}
          alt={fileName}
          onError={handleImgError}
          className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
          loading="lazy"
        />
      ) : (
        <div className="flex flex-col items-center justify-center p-2 text-center gap-1.5 w-full h-full bg-slate-900/90 text-slate-400">
          {isVideo ? (
            <Film className="w-7 h-7 text-indigo-400 opacity-80" />
          ) : (
            <AlertCircle className="w-6 h-6 text-amber-400/80" />
          )}
          <span className="text-[10px] font-mono text-slate-300 truncate max-w-full px-1">{fileName}</span>
          <span className="text-[9px] text-indigo-300 font-semibold">{isVideo ? '動画ファイル' : '画像ファイル'}</span>
        </div>
      )}

      {/* Video Badge */}
      {isVideo && !hasError && (
        <div className="absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-slate-950/80 backdrop-blur-md border border-white/20 text-indigo-300 rounded-md text-[9px] font-bold flex items-center gap-1">
          <Film className="w-3 h-3 text-indigo-400" />
          <span>VIDEO</span>
        </div>
      )}

      {/* Hover Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition p-2 flex flex-col justify-end pointer-events-none">
        <p className="text-[10px] text-white font-medium truncate">{fileName}</p>
        <p className="text-[9px] text-indigo-300 font-semibold">{isVideo ? 'クリックで再生' : 'クリックで拡大'}</p>
      </div>
    </div>
  );
};

export const TagManagementModal: React.FC<TagManagementModalProps> = ({
  open,
  tags,
  isScanning = false,
  onClose,
  onRenameTag,
  onMergeTags,
  onSuggestMerges,
  onSelectTagFilter,
}) => {
  // タグ一覧の map では変数名 `t` がタグを指すため、翻訳関数に別名を用意しておく
  const { t, t: translate, language } = useTranslation();
  const [activeTab, setActiveTab] = useState<'all' | 'suggestions'>('all');
  const [search, setSearch] = useState('');
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editNameJa, setEditNameJa] = useState('');

  // 手動マージ用の選択状態
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [targetTagId, setTargetTagId] = useState<number | null>(null);

  // AI自動提案用の状態
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([]);
  const [scanningSuggestions, setScanningSuggestions] = useState<boolean>(false);
  const [applyingMerges, setApplyingMerges] = useState<boolean>(false);
  const [applyProgressText, setApplyProgressText] = useState<string>('');
  const [successToast, setSuccessToast] = useState<string | null>(null);

  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());
  const [previewMediaItem, setPreviewMediaItem] = useState<MediaItem | null>(null);
  const [hoveredThumb, setHoveredThumb] = useState<{ src: string; x: number; y: number } | null>(null);

  // アプリ起動・モーダル開口時に AppData キャッシュから自動復元 ＆ 不整合ファイルのクリーンアップ
  useEffect(() => {
    if (open) {
      invoke('cleanup_missing_media').catch(() => {});
      invoke<MergeSuggestion[]>('load_tag_suggestions_cache')
        .then((cached) => {
          if (cached && cached.length > 0) {
            setSuggestions(cached);
            const initMasterMap: Record<string, number> = {};
            cached.forEach((s) => {
              initMasterMap[s.id] = s.target_tag.id;
            });
            setSelectedMasterTagIds(initMasterMap);
            setAcceptedIds(new Set()); // デフォルトは未選択 (0 accepted)
          }
        })
        .catch((e) => console.error('Failed to load tag suggestions cache:', e));
    }
  }, [open]);

  // バックエンドからの自動タグ解析完了イベントを受信
  useEffect(() => {
    const unlistenPromise = listen<MergeSuggestion[]>('tag_suggestions_updated', (event) => {
      if (event.payload) {
        setSuggestions(event.payload);
        const initMasterMap: Record<string, number> = {};
        event.payload.forEach((s) => {
          initMasterMap[s.id] = s.target_tag.id;
        });
        setSelectedMasterTagIds(initMasterMap);
        setAcceptedIds(new Set()); // デフォルトは未選択 (0 accepted)
      }
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // 提案ごとの選択された Master Tag ID (-1 は手入力カスタム)
  const [selectedMasterTagIds, setSelectedMasterTagIds] = useState<Record<string, number>>({});
  // 提案ごとの手入力マスタータグ内容 (suggestionId -> { name, nameJa })
  const [customMasterTags, setCustomMasterTags] = useState<Record<string, { name: string; nameJa: string }>>({});

  // 提案ごとの「マージから除外された Tag ID」集合 (suggestionId -> Set<tagId>)
  const [excludedTagIds, setExcludedTagIds] = useState<Record<string, Set<number>>>({});

  // 画像プレビューモーダル用の状態
  const [previewTag, setPreviewTag] = useState<TagItem | null>(null);
  const [previewMediaList, setPreviewMediaList] = useState<MediaItem[]>([]);
  const [loadingPreview, setLoadingPreview] = useState<boolean>(false);

  // ソート順（デフォルト: 件数が多い順）
  const [sortBy, setSortBy] = useState<'count_desc' | 'count_asc' | 'alpha_asc' | 'ja_asc'>('count_desc');

  // タグ種別フィルタ（基本語 / 記述的タグ）
  const [kindFilter, setKindFilter] = useState<'all' | 'basic' | 'descriptive'>('all');

  // AI Merge 提案を常に対象タグ件数（グループ内タグ数）が多い順（降順）にソート
  const sortedSuggestions = React.useMemo(() => {
    if (!suggestions || !Array.isArray(suggestions)) return [];
    return [...suggestions].filter((s) => s && s.target_tag).sort((a, b) => {
      const aCount = (Array.isArray(a.source_tags) ? a.source_tags.length : 1) + 1;
      const bCount = (Array.isArray(b.source_tags) ? b.source_tags.length : 1) + 1;
      return bCount - aCount;
    });
  }, [suggestions]);

  const rejectTimersRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  React.useEffect(() => {
    return () => {
      Object.values(rejectTimersRef.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  if (!open) return null;

  const freeTags = tags.filter((t) => !t.is_category);
  const filteredTags = freeTags.filter(
    (t) =>
      (kindFilter === 'all' || t.kind === kindFilter) &&
      (t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.name_ja && t.name_ja.toLowerCase().includes(search.toLowerCase())))
  );

  // タグをクリックしてメイン画面で即座に絞り込み検索
  const handleTriggerSearchFilter = (tagName: string) => {
    if (onSelectTagFilter) {
      onSelectTagFilter(tagName);
      onClose();
    }
  };

  // 画像プレビューモーダルの開閉
  const handleOpenTagPreview = async (tag: TagItem) => {
    setPreviewTag(tag);
    setLoadingPreview(true);
    try {
      const mediaList = await invoke<MediaItem[]>('get_media_by_tag', { tagId: tag.id });
      setPreviewMediaList(mediaList);
    } catch (e) {
      console.error('Failed to fetch media for tag:', e);
      setPreviewMediaList([]);
    } finally {
      setLoadingPreview(false);
    }
  };

  // 編集開始
  const handleStartEdit = (t: TagItem) => {
    setEditingTagId(t.id);
    setEditName(t.name);
    setEditNameJa(t.name_ja || '');
  };

  // 編集保存
  const handleSaveEdit = async (t: TagItem) => {
    if (!editName.trim()) return;
    await onRenameTag(t.id, editName.trim(), editNameJa.trim() || undefined);
    setEditingTagId(null);
    setSuccessToast(`Tag #${t.name} updated!`);
    setTimeout(() => setSuccessToast(null), 2500);
  };

  // 手動マージ実行
  const handleExecuteManualMerge = async () => {
    if (!targetTagId || selectedTagIds.length < 2) return;
    const sourceIds = selectedTagIds.filter((id) => id !== targetTagId);
    setApplyingMerges(true);
    try {
      await onMergeTags(targetTagId, sourceIds);
      setSelectedTagIds([]);
      setTargetTagId(null);
      setSuccessToast('Manual merge executed successfully!');
      setTimeout(() => setSuccessToast(null), 2500);
    } catch (e) {
      console.error('Failed to execute manual merge:', e);
    } finally {
      setApplyingMerges(false);
    }
  };

  // 自動提案のスキャン
  const handleScanSuggestions = async () => {
    if (!onSuggestMerges || isScanning) return;
    setScanningSuggestions(true);
    try {
      await invoke('clear_tag_suggestions_cache');
      setSuggestions([]);
      const results = await onSuggestMerges();
      setSuggestions(results);

      const initMasterMap: Record<string, number> = {};
      results.forEach((s) => {
        initMasterMap[s.id] = s.target_tag.id;
      });

      setSelectedMasterTagIds(initMasterMap);
      setCustomMasterTags({});
      setExcludedTagIds({});
      setAcceptedIds(new Set()); // デフォルトは未選択
      setRejectedIds(new Set());
      setActiveTab('suggestions');
    } catch (e) {
      console.error('Failed to scan suggestions:', e);
    } finally {
      setScanningSuggestions(false);
    }
  };

  // 提案カード内のマスタータグ変更
  const handleSelectMasterTag = (suggestionId: string, masterId: number) => {
    setSelectedMasterTagIds((prev) => ({
      ...prev,
      [suggestionId]: masterId,
    }));
  };

  // 手入力マスタータグの更新
  const handleCustomMasterTagChange = (suggestionId: string, field: 'name' | 'nameJa', value: string) => {
    setCustomMasterTags((prev) => ({
      ...prev,
      [suggestionId]: {
        name: field === 'name' ? value : prev[suggestionId]?.name || '',
        nameJa: field === 'nameJa' ? value : prev[suggestionId]?.nameJa || '',
      },
    }));
  };

  // 特定のタグをマージ対象から除外 / 復帰（トグル）
  const handleToggleExcludeTag = (suggestionId: string, tagId: number) => {
    setExcludedTagIds((prev) => {
      const currentSet = new Set(prev[suggestionId] || []);
      if (currentSet.has(tagId)) {
        currentSet.delete(tagId);
      } else {
        currentSet.add(tagId);
      }
      return {
        ...prev,
        [suggestionId]: currentSet,
      };
    });
  };

  // Accept / Reject 切り替え
  const handleToggleAccept = (suggestionId: string) => {
    setAcceptedIds((prev) => {
      const next = new Set(prev);
      if (next.has(suggestionId)) {
        next.delete(suggestionId);
      } else {
        next.add(suggestionId);
      }
      return next;
    });
    setRejectedIds((prev) => {
      const next = new Set(prev);
      next.delete(suggestionId);
      return next;
    });
  };

  const handleToggleReject = (suggestionId: string) => {
    if (rejectedIds.has(suggestionId)) {
      if (rejectTimersRef.current[suggestionId]) {
        clearTimeout(rejectTimersRef.current[suggestionId]);
        delete rejectTimersRef.current[suggestionId];
      }
      setRejectedIds((prev) => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });
    } else {
      setRejectedIds((prev) => {
        const next = new Set(prev);
        next.add(suggestionId);
        return next;
      });
      setAcceptedIds((prev) => {
        const next = new Set(prev);
        next.delete(suggestionId);
        return next;
      });

      if (rejectTimersRef.current[suggestionId]) {
        clearTimeout(rejectTimersRef.current[suggestionId]);
      }

      rejectTimersRef.current[suggestionId] = setTimeout(() => {
        setSuggestions((prev) => {
          const updated = prev.filter((s) => s.id !== suggestionId);
          invoke('save_tag_suggestions_cache', { suggestions: updated }).catch((e) =>
            console.error('Failed to update cache on reject:', e)
          );
          return updated;
        });
        setRejectedIds((prev) => {
          const next = new Set(prev);
          next.delete(suggestionId);
          return next;
        });
        delete rejectTimersRef.current[suggestionId];
      }, 3000);
    }
  };

  // 承認されたグループ提案を一括適用
  const handleApplySelectedSuggestions = async () => {
    const toApply = suggestions.filter((s) => acceptedIds.has(s.id) && !rejectedIds.has(s.id));
    if (toApply.length === 0) return;

    setApplyingMerges(true);
    let successCount = 0;

    for (let i = 0; i < toApply.length; i++) {
      const sug = toApply[i];
      setApplyProgressText(`Applying merge (${i + 1}/${toApply.length})...`);

      const sources = Array.isArray(sug.source_tags)
        ? sug.source_tags
        : (sug as any).source_tag
        ? [(sug as any).source_tag]
        : [];
      const allMembers = [sug.target_tag, ...sources];

      let masterId = selectedMasterTagIds[sug.id] ?? sug.target_tag.id;

      // 手入力カスタムマスタータグが選択されている場合 (-1)
      if (masterId === -1) {
        const customInfo = customMasterTags[sug.id];
        if (customInfo && customInfo.name.trim()) {
          try {
            const createdTag = await invoke<TagItem>('get_or_create_tag', {
              name: customInfo.name.trim(),
              nameJa: customInfo.nameJa.trim() || undefined,
            });
            masterId = createdTag.id;
          } catch (e) {
            console.error('Failed to create custom master tag:', e);
            continue;
          }
        } else {
          masterId = sug.target_tag.id;
        }
      }

      const excludedSet = excludedTagIds[sug.id] || new Set();
      const sourceIds = allMembers
        .filter((t) => t.id !== masterId && !excludedSet.has(t.id))
        .map((t) => t.id);

      if (sourceIds.length > 0) {
        try {
          await onMergeTags(masterId, sourceIds);
          successCount++;
        } catch (err) {
          console.error('Merge failed for suggestion:', sug.id, err);
        }
      }
    }

    setSuggestions((prev) => prev.filter((s) => !acceptedIds.has(s.id)));
    setAcceptedIds(new Set());
    setApplyingMerges(false);
    setApplyProgressText('');

    setSuccessToast(`✓ Successfully applied ${successCount} group merges!`);
    setTimeout(() => setSuccessToast(null), 3000);
  };

  const sortedTags = [...filteredTags].sort((a, b) => {
    if (sortBy === 'count_desc') return (b.count ?? 0) - (a.count ?? 0);
    if (sortBy === 'count_asc') return (a.count ?? 0) - (b.count ?? 0);
    if (sortBy === 'alpha_asc') return a.name.localeCompare(b.name);
    if (sortBy === 'ja_asc') {
      const nameA = a.name_ja || a.name;
      const nameB = b.name_ja || b.name;
      return nameA.localeCompare(nameB, 'ja');
    }
    return 0;
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 relative">
        {/* Toast Alert Notification */}
        {successToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-70 bg-emerald-600 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-xl border border-emerald-400/50 flex items-center gap-2 animate-in fade-in zoom-in-95">
            <CheckCircle2 className="w-4 h-4" />
            <span>{successToast}</span>
          </div>
        )}

        {/* Header */}
        <div className="p-4 bg-slate-950/80 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitMerge className="w-5 h-5 text-indigo-400" />
            <h2 className="text-sm font-bold text-white">{t('tag_modal.title', 'Tag Management & Group Consolidation')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection & Scanning Action Bar */}
        <div className="px-4 py-2.5 bg-slate-900 border-b border-white/10 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-white/5">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition cursor-pointer ${
                activeTab === 'all'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t('tag_modal.tab_all', 'All Free Tags')} ({freeTags.length})
            </button>
            <button
              onClick={() => setActiveTab('suggestions')}
              className={`px-3 py-1 text-xs font-semibold rounded-lg transition cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'suggestions'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              {t('tag_modal.tab_proposals', 'AI Merge Proposals')} ({suggestions.length})
            </button>
          </div>

          <button
            onClick={handleScanSuggestions}
            disabled={scanningSuggestions || applyingMerges || isScanning}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-indigo-900/30 cursor-pointer disabled:opacity-50"
          >
            {scanningSuggestions ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            <span>{t('tag_modal.btn_scan', 'Scan Similar Tags')}</span>
          </button>
        </div>

        {/* Warning Banner when analysis is running in background */}
        {isScanning && (
          <div className="mx-4 mt-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-amber-300 text-xs flex items-center gap-2 animate-in fade-in shrink-0">
            <RefreshCw className="w-4 h-4 animate-spin shrink-0 text-amber-400" />
            <span>{t('tag_modal.scan_warning', 'Currently, image/media analysis is running in the background, so tag editing/merging is temporarily locked.')}</span>
          </div>
        )}

        {/* Tab 1: All Tags List */}
        {activeTab === 'all' && (
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
                    placeholder={t('tag_modal.filter_placeholder', 'Filter tags...')}
                    className="w-full bg-slate-950 border border-white/10 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
                  />
                </div>

                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="bg-slate-950 border border-white/10 text-xs text-slate-300 px-2.5 py-1.5 rounded-xl focus:outline-none focus:border-indigo-500/50 shrink-0 font-medium"
                >
                  <option value="count_desc">Sort: Count (High → Low)</option>
                  <option value="count_asc">Sort: Count (Low → High)</option>
                  <option value="alpha_asc">Sort: Alphabet (A → Z)</option>
                  <option value="ja_asc">Sort: Japanese (50音順)</option>
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
                        ? t('tag_modal.kind_all', 'すべて')
                        : k === 'basic'
                        ? t('tag_modal.kind_basic', '基本語')
                        : t('tag_modal.kind_descriptive', '修飾語')}
                    </button>
                  ))}
                </div>
              </div>

              {selectedTagIds.length >= 2 && (
                <div className="flex items-center gap-2 bg-indigo-950/60 border border-indigo-500/40 p-1.5 rounded-xl animate-in fade-in">
                  <span className="text-[11px] text-indigo-300 font-semibold px-1">
                    Selected ({selectedTagIds.length})
                  </span>
                  <select
                    value={targetTagId || ''}
                    onChange={(e) => setTargetTagId(Number(e.target.value))}
                    className="bg-slate-900 text-xs text-white border border-white/10 rounded-lg px-2 py-1 focus:outline-none"
                  >
                    <option value="">-- Choose Master Tag to Keep --</option>
                    {freeTags
                      .filter((t) => selectedTagIds.includes(t.id))
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name_ja ? `${t.name_ja} (${t.name})` : t.name} ({t.count ?? 0})
                        </option>
                      ))}
                  </select>
                  <button
                    onClick={handleExecuteManualMerge}
                    disabled={!targetTagId || applyingMerges || isScanning}
                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition disabled:opacity-40 cursor-pointer flex items-center gap-1"
                  >
                    {applyingMerges && <RefreshCw className="w-3 h-3 animate-spin" />}
                    <span>Merge Manual</span>
                  </button>
                </div>
              )}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1 min-h-0">
              {sortedTags.map((t) => {
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
                            placeholder="English name"
                            className="bg-slate-900 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
                          />
                          <input
                            type="text"
                            value={editNameJa}
                            onChange={(e) => setEditNameJa(e.target.value)}
                            placeholder="日本語訳"
                            className="bg-slate-900 border border-white/20 rounded px-2 py-1 text-xs text-white focus:outline-none"
                          />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 truncate">
                          <span
                            onClick={() => handleTriggerSearchFilter(t.name)}
                            className="font-mono font-semibold text-xs text-indigo-300 hover:text-indigo-200 cursor-pointer hover:underline"
                            title="Click to search this tag in gallery"
                          >
                            #{t.name}
                          </span>
                          {t.name_ja ? (
                            <span
                              onClick={() => handleTriggerSearchFilter(t.name_ja || t.name)}
                              className="text-xs text-slate-300 bg-slate-800 px-2 py-0.5 rounded-md border border-white/5 font-medium hover:text-white cursor-pointer hover:underline"
                              title="Click to search this tag in gallery"
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
                              {translate('tag_modal.no_name_ja', '日本語名なし')}
                            </span>
                          )}
                          <span className="text-[11px] font-bold text-slate-500 bg-slate-900 px-1.5 py-0.5 rounded border border-white/5">
                            ({t.count ?? 0})
                          </span>
                          {t.kind === 'descriptive' && (
                            <span className="text-[9px] font-bold text-slate-500 bg-slate-900/60 px-1.5 py-0.5 rounded border border-white/5 uppercase tracking-wide">
                              修飾語
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      {onSelectTagFilter && (
                        <button
                          onClick={() =>
                            handleTriggerSearchFilter(language === 'ja' && t.name_ja ? t.name_ja : t.name)
                          }
                          className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                          title="Filter Gallery by this Tag"
                        >
                          <Filter className="w-3.5 h-3.5" />
                        </button>
                      )}

                      <button
                        onClick={() => handleOpenTagPreview(t)}
                        className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-slate-800 rounded-lg transition cursor-pointer"
                        title="Preview Images with this Tag"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>

                      {isEditing ? (
                        <button
                          onClick={() => handleSaveEdit(t)}
                          className="p-1.5 bg-emerald-600 text-white hover:bg-emerald-500 rounded-lg transition cursor-pointer"
                          title="Save"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStartEdit(t)}
                          className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
                          title="Edit Tag Name & Translation"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tab 2: Group Proposals & Review */}
        {activeTab === 'suggestions' && (
          <div className="flex-1 flex flex-col min-h-0">
            {suggestions.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <Sparkles className="w-10 h-10 text-indigo-400/50 mb-2" />
                <h3 className="text-sm font-semibold text-slate-300">No proposals yet</h3>
                <p className="text-xs text-slate-500 max-w-sm mt-1">
                  Click "Scan Similar Tags" to group duplicate, plural, or synonymous tags into unified merge proposals.
                </p>
              </div>
            ) : (
              <>
                <div className="p-3 bg-slate-950/80 border-b border-white/10 flex items-center justify-between">
                  <span className="text-xs text-slate-300 font-medium">
                    Group Proposals ({acceptedIds.size} accepted / {suggestions.length} total)
                  </span>

                  <button
                    onClick={handleApplySelectedSuggestions}
                    disabled={acceptedIds.size === 0 || applyingMerges || isScanning}
                    className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-emerald-900/30 cursor-pointer disabled:opacity-40"
                  >
                    {applyingMerges ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>{applyProgressText || 'Applying Merges...'}</span>
                      </>
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        <span>Apply Selected Merges ({acceptedIds.size})</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0">
                  {sortedSuggestions.map((sug) => {
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
                          <div className="flex items-center gap-2 max-w-[65%] min-w-0">
                            <span
                              className="px-2.5 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full text-[11px] font-semibold truncate"
                              title={sug.reason}
                            >
                              {sug.reason}
                            </span>
                            <span className="text-xs text-slate-400 shrink-0">
                              ({allMembers.length} tags)
                            </span>

                            {/* サンプルサムネイルのアバタースタック表示 & ホバーフローティング拡大 & 続きありインジケーター */}
                            {sug.sample_thumbnails && sug.sample_thumbnails.length > 0 && (
                              <div className="flex items-center gap-1 shrink-0 ml-1">
                                <div className="flex items-center -space-x-2 p-0.5" title="Group sample media">
                                  {sug.sample_thumbnails.slice(0, 5).map((thumbPath, idx) => (
                                    <img
                                      key={idx}
                                      src={convertFileSrc(thumbPath)}
                                      alt="sample"
                                      className="w-7 h-7 rounded-md object-cover border-2 border-slate-900 shadow-md cursor-pointer transition-transform hover:scale-110 relative"
                                      onMouseEnter={(e) => {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        setHoveredThumb({
                                          src: convertFileSrc(thumbPath),
                                          x: rect.left + rect.width / 2,
                                          y: rect.top,
                                        });
                                      }}
                                      onMouseLeave={() => setHoveredThumb(null)}
                                      onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
                                    />
                                  ))}
                                </div>

                                {/* 最大枚数以上の画像がある場合の「続きあり (+N / ...)」インジケーター */}
                                {sug.total_images_count !== undefined && sug.total_images_count > sug.sample_thumbnails.length && (
                                  <span
                                    className="px-1.5 py-0.5 bg-slate-800/90 text-slate-300 border border-white/10 rounded-md text-[10px] font-mono font-bold tracking-tight shrink-0 shadow-sm"
                                    title={`${sug.total_images_count} total images (${sug.total_images_count - sug.sample_thumbnails.length} more)`}
                                  >
                                    +{sug.total_images_count - sug.sample_thumbnails.length}…
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {/* Accept / Reject Buttons */}
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleToggleAccept(sug.id)}
                              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                                isAccepted
                                  ? 'bg-emerald-600 text-white shadow'
                                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                              Accept
                            </button>

                            <button
                              onClick={() => handleToggleReject(sug.id)}
                              title={isRejected ? 'クリックでRejectをキャンセル' : '3秒後に結果から削除されます'}
                              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                                isRejected
                                  ? 'bg-red-600 text-white shadow animate-pulse'
                                  : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                              }`}
                            >
                              <ThumbsDown className="w-3.5 h-3.5" />
                              {isRejected ? 'Reject (3秒後削除)' : 'Reject'}
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
                                  Keep Master Tag:
                                </span>
                                {!isCustomMaster && (
                                  <button
                                    onClick={() => handleOpenTagPreview(masterTag)}
                                    className="p-1 text-slate-400 hover:text-indigo-300 rounded hover:bg-slate-800 transition cursor-pointer"
                                    title="Preview images with master tag"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>

                              <select
                                value={currentMasterId}
                                onChange={(e) => handleSelectMasterTag(sug.id, Number(e.target.value))}
                                className="bg-slate-950 border border-indigo-500/40 text-xs font-bold text-white px-3 py-1.5 rounded-lg focus:outline-none flex-1 max-w-md"
                              >
                                {allMembers.map((m) => (
                                  <option key={m.id} value={m.id}>
                                    #{m.name} {m.name_ja ? `(${m.name_ja})` : ''} ({m.count ?? 0})
                                  </option>
                                ))}
                                <option value={-1}>
                                  ✏️ -- Custom Master Tag (手入力) --
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
                                  onChange={(e) => handleCustomMasterTagChange(sug.id, 'name', e.target.value)}
                                  placeholder="English tag (e.g. drink)"
                                  className="bg-slate-950 border border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none flex-1 font-mono"
                                />
                                <input
                                  type="text"
                                  value={customInfo.nameJa}
                                  onChange={(e) => handleCustomMasterTagChange(sug.id, 'nameJa', e.target.value)}
                                  placeholder="日本語訳 (e.g. 飲み物)"
                                  className="bg-slate-950 border border-emerald-500/50 rounded-lg px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:outline-none flex-1"
                                />
                              </div>
                            )}
                          </div>

                          {/* Sources to be Merged & Removed */}
                          <div className="flex items-start gap-2 pt-2 border-t border-white/5">
                            <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider shrink-0 mt-1">
                              Merge & Remove ({activeSourceCount}):
                            </span>
                            <div className="flex flex-wrap gap-1.5 flex-1">
                              {sourceTags.map((st) => {
                                const isExcluded = excludedSet.has(st.id);
                                return (
                                  <div
                                    key={st.id}
                                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono border transition ${
                                      isExcluded
                                        ? 'bg-slate-950/40 text-slate-600 border-white/5 line-through opacity-50'
                                        : 'bg-slate-950 text-slate-300 border-white/10'
                                    }`}
                                  >
                                    <span className={isExcluded ? 'line-through' : ''}>
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
                                      onClick={() => handleOpenTagPreview(st)}
                                      className="text-slate-400 hover:text-indigo-300 transition cursor-pointer"
                                      title="Preview Images with this Tag"
                                    >
                                      <Eye className="w-3 h-3" />
                                    </button>

                                    {/* Exclude / Include Toggle Button */}
                                    <button
                                      onClick={() => handleToggleExcludeTag(sug.id, st.id)}
                                      className={`p-0.5 rounded transition cursor-pointer text-[10px] font-bold ${
                                        isExcluded
                                          ? 'text-emerald-400 hover:bg-emerald-950/50'
                                          : 'text-red-400 hover:bg-red-950/50'
                                      }`}
                                      title={isExcluded ? 'Include back in merge' : 'Exclude from merge'}
                                    >
                                      {isExcluded ? '+ Include' : '✕ Exclude'}
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
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Image Preview Modal */}
      {previewTag && (
        <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-4 bg-slate-950 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-indigo-400" />
                <h3 className="text-xs font-bold text-white">
                  Images with tag: <span className="text-indigo-300 font-mono">#{previewTag.name}</span>
                  {previewTag.name_ja && <span className="text-slate-400 ml-1">({previewTag.name_ja})</span>}
                  <span className="text-indigo-400 ml-1">({previewTag.count ?? 0} images)</span>
                </h3>
              </div>
              <button
                onClick={() => setPreviewTag(null)}
                className="p-1 text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body: Image Grid */}
            <div className="flex-1 overflow-y-auto p-4 min-h-0">
              {loadingPreview ? (
                <div className="flex items-center justify-center py-12 text-slate-400 text-xs">
                  <RefreshCw className="w-4 h-4 animate-spin mr-2 text-indigo-400" />
                  Loading tagged images...
                </div>
              ) : previewMediaList.length === 0 ? (
                <div className="text-center py-12 text-slate-500 text-xs">
                  No images currently assigned to this tag.
                </div>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {previewMediaList.map((media) => (
                    <TagPreviewCard
                      key={media.id}
                      media={media}
                      onClick={() => setPreviewMediaItem(media)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-3 bg-slate-950 border-t border-white/10 flex justify-end">
              <button
                onClick={() => setPreviewTag(null)}
                className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      {/* High-Res Media Preview / Video Player Overlay */}
      {previewMediaItem && (
        <div
          onClick={() => setPreviewMediaItem(null)}
          className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer animate-in fade-in duration-150 select-none"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center justify-center"
          >
            {/\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(previewMediaItem.file_path) ? (
              <video
                src={convertFileSrc(previewMediaItem.file_path)}
                controls
                autoPlay
                className="max-w-full max-h-[80vh] rounded-2xl shadow-2xl border border-white/10"
              />
            ) : (
              <img
                src={
                  previewMediaItem.thumbnail_path
                    ? convertFileSrc(previewMediaItem.thumbnail_path)
                    : convertFileSrc(previewMediaItem.file_path)
                }
                alt={previewMediaItem.file_path.split(/[/\\]/).pop()}
                className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl border border-white/10"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = convertFileSrc(previewMediaItem.file_path);
                }}
              />
            )}
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs text-slate-300 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-white/10 truncate max-w-md">
                {previewMediaItem.file_path.split(/[/\\]/).pop()}
              </span>
              <button
                onClick={() => setPreviewMediaItem(null)}
                className="text-xs text-slate-300 hover:text-white bg-slate-800 px-3 py-1 rounded-lg border border-white/10 transition cursor-pointer"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Hover Preview Tooltip (Always fully visible above all modal scrollports) */}
      {hoveredThumb && (
        <div
          style={{
            left: `${hoveredThumb.x}px`,
            top: hoveredThumb.y < 160 ? `${hoveredThumb.y + 36}px` : `${hoveredThumb.y - 136}px`,
          }}
          className="fixed -translate-x-1/2 w-32 h-32 rounded-2xl overflow-hidden border-2 border-indigo-500 bg-slate-950 shadow-2xl z-[120] pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex items-center justify-center select-none"
        >
          <img
            src={hoveredThumb.src}
            alt="floating preview"
            className="w-full h-full object-cover"
          />
        </div>
      )}
    </div>
  );
};
