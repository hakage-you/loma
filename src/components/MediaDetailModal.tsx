import React, { useState, useMemo, useRef, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { MediaItem, TagItem } from '../types';
import { X, ExternalLink, RotateCcw, AlertTriangle, CheckCircle, Clock, Tag, FolderOpen, Sparkles, Plus, Loader2, Radar } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { MIN_BASIC_TAGS, isTagInsufficient } from '../constants/spectrum';
import { useExclusiveGuard } from '../hooks/useExclusiveGuard';

interface MediaDetailModalProps {
  item: MediaItem | null;
  allTags?: TagItem[];
  isScanning?: boolean;
  onClose: () => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (filePath: string) => void;
  onRetry: (mediaId: number) => void;
  onReanalyzeSingleMedia?: (mediaId: number) => void;
  onCustomAnalyzeVideo?: (mediaId: number, timestampSeconds: number) => void;
  onCancelScan?: () => void;
  onSelectTagFilter?: (tagName: string) => void;
  onAddTagToMedia?: (mediaId: number, tagName: string, tagNameJa?: string) => Promise<void>;
  onRemoveTagFromMedia?: (mediaId: number, tagId: number) => Promise<void>;
  onFindSimilar?: (item: MediaItem) => void;
}

export const MediaDetailModal: React.FC<MediaDetailModalProps> = ({
  item,
  allTags,
  isScanning,
  onClose,
  onOpenFile,
  onOpenFolder,
  onRetry,
  onReanalyzeSingleMedia,
  onCustomAnalyzeVideo,
  onCancelScan,
  onSelectTagFilter,
  onAddTagToMedia,
  onRemoveTagFromMedia,
  onFindSimilar,
}) => {
  const { t, language } = useTranslation();
  // タグの追加・削除も再解析も Rust の排他ロックを取る。走っている間は押させない
  const exclusive = useExclusiveGuard();
  const [videoError, setVideoError] = React.useState(false);
  const [manualTime, setManualTime] = React.useState('5.0');
  const videoRef = React.useRef<HTMLVideoElement>(null);

  // Tag editing state & auto-suggest (English & Japanese)
  const [newTagName, setNewTagName] = useState('');
  const [newTagNameJa, setNewTagNameJa] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isSavingTag, setIsSavingTag] = useState(false);
  const suggestBoxRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  /**
   * タグを足した直後に入力欄へ戻すための予約。
   * 追加中は画面全体が inert になる（排他ロックを取るため）ので、そのとき focus が外れる。
   * 何個も続けて足すのが普通の使い方なので、解除されたら戻す。
   */
  const [refocusTagInput, setRefocusTagInput] = useState(false);

  // High performance auto-suggest calculation (max 15 items)
  const filteredSuggestions = useMemo(() => {
    const enQuery = newTagName.trim().toLowerCase();
    const jaQuery = newTagNameJa.trim().toLowerCase();
    if ((!enQuery && !jaQuery) || !allTags || allTags.length === 0) return [];

    const currentTagNames = new Set((item?.tags || []).map((t) => t.name.toLowerCase()));
    const list: TagItem[] = [];

    for (let i = 0; i < allTags.length; i++) {
      const t = allTags[i];
      if (!t || t.is_category) continue;
      const nameMatch = enQuery ? t.name.toLowerCase().includes(enQuery) : false;
      const jaMatch = jaQuery && t.name_ja ? t.name_ja.toLowerCase().includes(jaQuery) : false;
      if ((nameMatch || jaMatch) && !currentTagNames.has(t.name.toLowerCase())) {
        list.push(t);
        if (list.length >= 15) break;
      }
    }
    return list;
  }, [newTagName, newTagNameJa, allTags, item?.tags]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAddTagSubmit = async (enName: string, jaName?: string) => {
    const cleanEn = enName.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanJa = jaName?.trim();
    if (!cleanEn || !item || !onAddTagToMedia) return;
    setIsSavingTag(true);
    try {
      await onAddTagToMedia(item.id, cleanEn, cleanJa || undefined);
      setNewTagName('');
      setNewTagNameJa('');
      setShowSuggestions(false);
      setRefocusTagInput(true);
    } finally {
      setIsSavingTag(false);
    }
  };

  // ブロックが解けてから戻す。inert が付いたままでは focus() が効かない
  useEffect(() => {
    if (!refocusTagInput || exclusive.blocked) return;
    setRefocusTagInput(false);
    tagInputRef.current?.focus();
  }, [refocusTagInput, exclusive.blocked]);

  const handleSelectSuggestion = (sug: TagItem) => {
    setNewTagName(sug.name);
    setNewTagNameJa(sug.name_ja || '');
    handleAddTagSubmit(sug.name, sug.name_ja || undefined);
  };

  const handleRemoveTagClick = async (tagName: string) => {
    if (!item || !onRemoveTagFromMedia) return;
    const found = allTags?.find((t) => t.name === tagName || (t.name_ja && t.name_ja === tagName));
    if (!found) return;
    setIsSavingTag(true);
    try {
      await onRemoveTagFromMedia(item.id, found.id);
    } finally {
      setIsSavingTag(false);
    }
  };

  if (!item) return null;

  const isVideo = /\.(mp4|webm|mov|mkv|avi|flv|wmv)$/i.test(item.file_path);
  const fileSrc = convertFileSrc(item.file_path);
  const imageSrc = item.thumbnail_path
    ? convertFileSrc(item.thumbnail_path)
    : fileSrc;

  const fileName = item.file_path.split(/[/\\]/).pop() || '';
  const fileSizeMB = (item.file_size / (1024 * 1024)).toFixed(2);
  // basic タグが足りず、似ているメディアの検索の候補集合から外れている状態
  const tagInsufficient = isTagInsufficient(item);

  const handleCustomAnalyzeCurrentTime = () => {
    if (!onCustomAnalyzeVideo) return;
    let sec = 0;
    if (isVideo && !videoError && videoRef.current) {
      sec = videoRef.current.currentTime || 0;
    } else {
      sec = parseFloat(manualTime) || 0;
    }
    onCustomAnalyzeVideo(item.id, sec);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="glass-panel w-full max-w-4xl max-h-[90vh] flex flex-col md:flex-row overflow-hidden rounded-2xl shadow-2xl border border-white/10">
        {/* Left Preview */}
        <div className="md:w-1/2 bg-black/90 flex flex-col items-center justify-center relative p-4 min-h-[340px]">
          {isVideo && !videoError ? (
            <video
              ref={videoRef}
              src={fileSrc}
              controls
              onError={() => setVideoError(true)}
              className="max-h-[60vh] w-auto max-w-full object-contain rounded-lg shadow-lg"
            />
          ) : (
            <div className="relative flex flex-col items-center justify-center w-full">
              <img
                src={imageSrc}
                alt={fileName}
                className="max-h-[60vh] w-auto max-w-full object-contain rounded-lg shadow-lg"
              />
              {isVideo && videoError && (
                <div className="mt-2 px-3 py-1 bg-amber-950/80 border border-amber-500/40 rounded-lg text-[11px] text-amber-300 font-mono text-center">
                  ⚠️ {t('media_modal.codec_unsupported', '')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Info Panel */}
        <div className="md:w-1/2 p-6 flex flex-col justify-between overflow-y-auto gap-4 bg-slate-900/60 select-none">
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-base font-bold text-white break-all select-text" title={fileName}>
                  {fileName}
                </h2>
                <div className="flex items-center gap-2 mt-1">
                  {item.analysis_status === 'completed' && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 rounded-full text-xs font-semibold">
                      <CheckCircle className="w-3.5 h-3.5" /> {t('sidebar.label_status_completed', '解析完了')}
                    </span>
                  )}
                  {item.analysis_status === 'pending' && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-full text-xs font-semibold">
                      <Clock className="w-3.5 h-3.5 animate-pulse" /> {t('sidebar.label_status_pending', '未解析')}
                    </span>
                  )}
                  {item.analysis_status === 'failed' && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded-full text-xs font-semibold">
                      <AlertTriangle className="w-3.5 h-3.5" /> {t('sidebar.label_status_failed', '解析失敗')}
                    </span>
                  )}
                  {item.needs_attention && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-red-600/20 text-red-300 border border-red-500/30 rounded-full text-xs font-semibold">
                      <AlertTriangle className="w-3.5 h-3.5" />{' '}
                      {t('failure_modal.label_needs_attention', '要確認')}
                    </span>
                  )}
                  {item.excluded && (
                    <span className="flex items-center gap-1 px-2.5 py-0.5 bg-slate-600/30 text-slate-300 border border-slate-500/30 rounded-full text-xs font-semibold">
                      {t('failure_modal.label_excluded_badge', '解析対象外')}
                    </span>
                  )}
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tags & Categories Section */}
            <div>
              <h3 className="text-xs font-bold text-slate-300 mb-2 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5 text-indigo-400" />
                {t('media_modal.label_tags_categories', 'タグ & カテゴリ')}
              </h3>
              <div className="space-y-2">
                {/* 候補集合から外れている事実を黙って隠さない。
                    ユーザーはこの画面でタグを足せるので、対処可能な情報として出す */}
                {tagInsufficient && (
                  <div className="flex items-start gap-1.5 px-2.5 py-2 rounded-xl bg-slate-800/60 border border-white/10 text-[11px] text-slate-300">
                    <Radar className="w-3.5 h-3.5 shrink-0 mt-px text-slate-400" />
                    <span>
                      {t(
                        'spectrum.label_badge_excluded',
                        'タグが {n} 個未満のため、似ているメディアの検索の対象外です',
                      ).replace('{n}', String(MIN_BASIC_TAGS))}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 bg-slate-950/40 rounded-xl border border-white/5">
                  {/* Categories */}
                  {item.categories && item.categories.map((cat) => (
                    <button
                      key={`cat-${cat}`}
                      onClick={() => onSelectTagFilter && onSelectTagFilter(cat)}
                      className="px-2.5 py-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-lg text-xs font-semibold hover:bg-indigo-500/30 transition cursor-pointer"
                    >
                      📁 {cat}
                    </button>
                  ))}
                  {/* Tags (basic tags first, descriptive tags rendered with muted styling) */}
                  {item.tags && [...item.tags]
                    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'descriptive' ? 1 : -1))
                    .map((tItem, idx) => (
                    <div
                      key={`tag-${idx}-${tItem.name}`}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 border rounded-lg text-xs font-medium transition group ${
                        tItem.kind === 'descriptive'
                          ? 'bg-slate-900/60 text-slate-500 border-white/5 hover:bg-slate-800/60 hover:text-slate-300'
                          : 'bg-slate-800 text-slate-300 border-white/10 hover:bg-slate-700 hover:text-white'
                      }`}
                    >
                      <span
                        onClick={() =>
                          onSelectTagFilter &&
                          onSelectTagFilter(language === 'ja' && tItem.name_ja ? tItem.name_ja : tItem.name)
                        }
                        className="cursor-pointer hover:underline"
                        title={t('media_modal.label_title_search_tag', 'Click to search tag in gallery')}
                      >
                        {tItem.name_ja ? `${tItem.name_ja} (${tItem.name})` : tItem.name}
                      </span>
                      {onRemoveTagFromMedia && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveTagClick(tItem.name);
                          }}
                          disabled={isSavingTag || exclusive.blocked}
                          className="p-0.5 text-slate-400 hover:text-red-400 rounded transition cursor-pointer ml-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={exclusive.reason ?? t('media_modal.label_title_remove_tag', 'Remove this tag from media')}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                  {(!item.categories || item.categories.length === 0) && (!item.tags || item.tags.length === 0) && (
                    <span className="text-xs text-slate-500 italic p-1">
                      {t('media_modal.no_tags', 'タグが設定されていません')}
                    </span>
                  )}
                </div>

                {/* Free Text Add Tag Inputs (English & Japanese) with Auto-Suggest */}
                {onAddTagToMedia && (
                  <div className="relative pt-1" ref={suggestBoxRef}>
                    <div className="flex items-center gap-1.5 flex-wrap sm:flex-nowrap">
                      {/* English Tag Name Input ([a-zA-Z0-9_-] only) */}
                      <div className="relative flex-1 min-w-[110px]">
                        <input
                          ref={tagInputRef}
                          type="text"
                          value={newTagName}
                          onChange={(e) => {
                            const sanitized = e.target.value.replace(/[^a-zA-Z0-9_-]/g, '');
                            setNewTagName(sanitized);
                            setShowSuggestions(true);
                          }}
                          onFocus={() => setShowSuggestions(true)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddTagSubmit(newTagName, newTagNameJa);
                            }
                          }}
                          placeholder={t('media_modal.label_tag_placeholder_en', '英語タグ (a-Z, _)')}
                          className="w-full bg-slate-950 border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50 font-mono"
                        />
                      </div>

                      {/* Japanese Translation Input */}
                      <div className="relative flex-1 min-w-[110px]">
                        <input
                          type="text"
                          value={newTagNameJa}
                          onChange={(e) => {
                            setNewTagNameJa(e.target.value);
                            setShowSuggestions(true);
                          }}
                          onFocus={() => setShowSuggestions(true)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddTagSubmit(newTagName, newTagNameJa);
                            }
                          }}
                          placeholder={t('media_modal.label_tag_placeholder_ja', '日本語訳 (例: 山脈)')}
                          className="w-full bg-slate-950 border border-white/10 rounded-xl px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500/50"
                        />
                        {isSavingTag && (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400 absolute right-2 top-2" />
                        )}
                      </div>

                      <button
                        onClick={() => handleAddTagSubmit(newTagName, newTagNameJa)}
                        disabled={!newTagName.trim() || isSavingTag || exclusive.blocked}
                        title={exclusive.reason}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition disabled:opacity-40 cursor-pointer flex items-center gap-1 shrink-0 shadow"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>{t('media_modal.label_add_tag_btn', '追加')}</span>
                      </button>
                    </div>

                    {/* Auto-suggest dropdown (Max 15 items high-performance list) */}
                    {showSuggestions && filteredSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-1 z-30 bg-slate-900/95 backdrop-blur-md border border-indigo-500/40 rounded-xl shadow-2xl overflow-hidden max-h-48 overflow-y-auto divide-y divide-white/5 animate-in fade-in zoom-in-95 duration-100">
                        {filteredSuggestions.map((sug) => (
                          <div
                            key={sug.id}
                            onClick={() => handleSelectSuggestion(sug)}
                            className="px-3 py-2 hover:bg-indigo-600/30 cursor-pointer transition flex items-center justify-between text-xs"
                          >
                            <span className="font-mono text-indigo-300 font-semibold">
                              #{sug.name} {sug.name_ja ? `(${sug.name_ja})` : ''}
                            </span>
                            <span className="text-[10px] text-slate-400 font-sans">
                              {sug.count ?? 0} media
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Metadata File Info */}
            <div className="space-y-2 text-xs text-slate-300">
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-slate-400">{t('media_modal.label_file_size', 'ファイルサイズ')}:</span>
                <span className="font-mono text-white">{fileSizeMB} MB</span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span className="text-slate-400">{t('media_modal.label_folder', '登録フォルダ')}:</span>
                <span className="font-mono text-indigo-300 break-all">{item.parent_folder}</span>
              </div>
              <div className="text-slate-400 break-all font-mono text-[11px] bg-slate-950/50 p-2 rounded-lg border border-white/5 select-all">
                {item.file_path}
              </div>
            </div>
          </div>

          {/* Custom Timestamp & Deep Analysis Panel for Videos */}
          {isVideo && (
            <div className="p-3 bg-indigo-950/40 border border-indigo-500/30 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5 text-indigo-400" />
                  {t('media_modal.label_video_time_thumbnail', '時間指定サムネイル変更 ＆ 高精度VLM解析')}
                </span>
                {videoError && (
                  <div className="flex items-center gap-1 text-[11px] text-slate-300">
                    <span>{t('media_modal.label_seconds_input', 'Timestamp')}:</span>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      value={manualTime}
                      onChange={(e) => setManualTime(e.target.value)}
                      className="w-16 px-1.5 py-0.5 bg-slate-900 border border-white/20 rounded text-center text-xs font-mono text-indigo-300"
                    />
                    <span>{t('media_modal.label_seconds_unit', 's')}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleCustomAnalyzeCurrentTime}
                  disabled={isScanning || exclusive.blocked}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition cursor-pointer shadow-lg shadow-indigo-900/30 disabled:opacity-50"
                  title={
                    exclusive.reason ??
                    t('media_modal.label_title_custom_analyze', 'Change the thumbnail from the current frame (or the given timestamp) and run multi-frame analysis')
                  }
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                  {t('media_modal.label_video_time_btn', '📍 この場面でサムネイル変更 ＆ 解析')}
                </button>
                {isScanning && onCancelScan && (
                  <button
                    onClick={onCancelScan}
                    className="px-3 py-2 bg-red-600/80 hover:bg-red-500 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
                  >
                    {t('media_modal.label_cancel', 'キャンセル')}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Single Image/Media Re-analyze Button */}
          {!isVideo && onReanalyzeSingleMedia && (
            <div className="p-3 bg-violet-950/40 border border-violet-500/30 rounded-xl flex items-center justify-between gap-2">
              <div className="text-xs text-violet-300 font-semibold flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                {t('media_modal.label_reanalyze_image', '画像AI単体再解析')}
              </div>
              <button
                onClick={() => onReanalyzeSingleMedia(item.id)}
                disabled={isScanning || exclusive.blocked}
                title={exclusive.reason}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 text-white rounded-xl text-xs font-semibold transition cursor-pointer shadow-lg shadow-violet-900/30 disabled:opacity-50"
              >
                <Sparkles className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                {t('media_modal.label_reanalyze_image_btn', 'この画像を再解析')}
              </button>
            </div>
          )}

          {/* 失敗の理由。DBには入っていたのに画面のどこにも出ていなかったので、
              ユーザーは再試行を押す以外に判断のしようがなかった */}
          {item.analysis_status === 'failed' && item.analysis_error && (
            <div className="rounded-xl border border-rose-500/25 bg-rose-950/25 p-3 space-y-1">
              <p className="text-[11px] text-rose-200/90 break-all font-mono">
                {item.analysis_error}
              </p>
              {item.needs_attention && (
                <p className="text-[11px] text-slate-300">
                  {t(
                    'failure_modal.needs_attention_hint',
                    '再試行しても同じ結果になる見込みのファイルです。ファイル自体が壊れているか、対応していない形式の可能性があります。',
                  )}
                </p>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-between gap-3 pt-3 border-t border-white/10">
            {item.analysis_status === 'failed' && !item.needs_attention && (
              <button
                onClick={() => onRetry(item.id)}
                disabled={exclusive.blocked}
                title={exclusive.reason}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-xl text-xs font-semibold transition cursor-pointer shadow-lg shadow-amber-900/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t('media_modal.label_retry_analysis', '解析を再試行')}
              </button>
            )}
            <div className="flex items-center gap-2 ml-auto">
              {onFindSimilar && item.analysis_status === 'completed' && (
                // タグ不足なら押せなくし、理由を示す。黙って無反応にすると
                // 「壊れている」と読まれる
                <button
                  onClick={() => !tagInsufficient && onFindSimilar(item)}
                  disabled={tagInsufficient}
                  title={
                    tagInsufficient
                      ? t('spectrum.label_badge_excluded', 'タグが {n} 個未満のため、似ているメディアの検索の対象外です').replace(
                          '{n}',
                          String(MIN_BASIC_TAGS),
                        )
                      : undefined
                  }
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer border border-white/10 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-slate-800"
                >
                  <Radar className="w-3.5 h-3.5 text-indigo-400" />
                  {t('spectrum.label_trigger', '似ているメディアを探す')}
                </button>
              )}
              <button
                onClick={() => onOpenFolder(item.file_path)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-semibold transition cursor-pointer border border-white/10"
              >
                <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                {t('media_modal.label_open_folder', 'フォルダを開く')}
              </button>
              <button
                onClick={() => onOpenFile(item.file_path)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition cursor-pointer shadow-lg shadow-indigo-900/30"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                {t('media_modal.label_open_file', 'ファイルを開く')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
