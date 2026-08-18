import React, { useState, useEffect, useRef } from 'react';
import { Search, RefreshCw, X, Hash, Pause, Clock, Zap, Sliders } from 'lucide-react';
import { TagItem, ProgressPayload } from '../types';
import { useTranslation } from '../contexts/I18nContext';

interface SearchBarProps {
  tags: TagItem[];
  selectedTags: string[];
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onStartScan?: (folderPath: string) => void;
  onSyncFolders?: () => void;
  onCancelScan?: () => void;
  onPauseScan?: () => void;
  onResumeScan?: () => void;
  onRetryFailed?: () => void;
  onOpenFolderManager?: () => void;
  onOpenTagManagement?: () => void;
  onOpenAdvancedSearch?: () => void;
  onOpenAbout?: () => void;
  failedCount?: number;
  gridColumns: number;
  onGridColumnsChange: (cols: number) => void;
  onOpenSettings?: () => void;
  scanning: boolean;
  progress: ProgressPayload | null;
  advancedSearchActive?: boolean;
  advancedSearchSummary?: string;
  onClearAdvancedSearch?: () => void;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  tags,
  selectedTags,
  onAddTag,
  onRemoveTag,
  onOpenAdvancedSearch,
  gridColumns,
  onGridColumnsChange,
  scanning,
  progress,
  advancedSearchActive,
  advancedSearchSummary,
  onClearAdvancedSearch,
}) => {
  const { t } = useTranslation();
  const [inputTag, setInputTag] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  // 残り時間の計測基準点。
  // 進捗イベントは「登録フェーズ」と「解析フェーズ」で系列が切り替わり、
  // 切替時に current が 1 へ巻き戻る。系列をまたいで平均を取ると、
  // 高速な登録処理の速度で低速な解析処理を見積もってしまうため系列ごとに取り直す。
  const baselineRef = useRef<{ current: number; time: number } | null>(null);
  // 系列の切り替わりは「直前のイベント」との比較でしか判定できない。
  // 新規スキャンでは両フェーズの total が同数になり得るので total の変化だけでは足りず、
  // current が巻き戻ったこと（例: 838 → 1）が唯一の手掛かりになる。
  const lastProgressRef = useRef<{ total: number; current: number } | null>(null);

  // 1件の解析に数分かかるため、進捗イベントが届かない間も残り時間を更新する
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [scanning]);

  useEffect(() => {
    if (!scanning) {
      baselineRef.current = null;
      lastProgressRef.current = null;
      return;
    }
    // スキャン実行中にアプリを起動した場合、scanning が true になった時点では
    // progress が null のことがある。progress を依存に含めることで、
    // 最初の進捗イベントが届いた時点で確実に基準を取得する。
    if (!progress) return;

    const last = lastProgressRef.current;
    // 初回、フェーズ切替(totalが変化)、または current の巻き戻り = 新しい系列
    const isNewSeries =
      !last || last.total !== progress.total || progress.current < last.current;

    if (isNewSeries) {
      baselineRef.current = { current: progress.current, time: Date.now() };
    }
    lastProgressRef.current = { total: progress.total, current: progress.current };
  }, [scanning, progress]);

  let speedText = '';
  let etaText = '';
  const baseline = baselineRef.current;
  if (scanning && progress && baseline) {
    const elapsedMs = Date.now() - baseline.time;
    // progress.current は「解析中の件番号」であり完了数ではない。
    // 基準取得時の件番号との差が、実際に完了した件数になる。
    const processedItems = progress.current - baseline.current;

    if (processedItems > 0 && elapsedMs > 500) {
      const secPerItem = (elapsedMs / 1000) / processedItems;
      // 解析中の1件も残りに含める
      const itemsRemaining = Math.max(0, progress.total - progress.current + 1);
      const etaSec = Math.round(secPerItem * itemsRemaining);

      const days = Math.floor(etaSec / 86400);
      const hours = Math.floor((etaSec % 86400) / 3600);
      const minutes = Math.floor((etaSec % 3600) / 60);
      const seconds = etaSec % 60;

      const etaLabel = t('progress.label_eta', '残り時間');
      const secUnit = t('progress.label_sec_per_item', '秒/件');

      if (days > 0) {
        etaText = `${etaLabel}: ${t('progress.label_eta_dhm', '{d}d {h}h {m}m', { d: days, h: hours, m: minutes })}`;
      } else if (hours > 0) {
        etaText = `${etaLabel}: ${t('progress.label_eta_hm', '{h}h {m}m', { h: hours, m: minutes })}`;
      } else if (minutes > 0) {
        etaText = `${etaLabel}: ${t('progress.label_eta_ms', '{m}m {s}s', { m: minutes, s: seconds })}`;
      } else {
        etaText = `${etaLabel}: ${t('progress.label_eta_s', '{s}s', { s: seconds })}`;
      }

      speedText = `${secPerItem.toFixed(1)} ${secUnit}`;
    } else {
      // 1件目が完了するまでは平均速度を出せないため、その旨を明示する
      // （従来の "--:--" は不具合と区別がつかなかった）
      speedText = t('progress.label_calculating', '計算中...');
      etaText = `${t('progress.label_eta', '残り時間')}: ${t('progress.label_measuring', '計測中')}`;
    }
  }

  const freeTags = tags.filter((t) => !t.is_category);

  const query = inputTag.trim().toLowerCase();
  const suggestions = query
    ? freeTags
        .filter(
          (t) =>
            (t.name.toLowerCase().includes(query) || (t.name_ja && t.name_ja.toLowerCase().includes(query))) &&
            !selectedTags.includes(t.name_ja || t.name) &&
            !selectedTags.includes(t.name)
        )
        // 基本語タグを優先し、修飾語タグは後置する
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'descriptive' ? 1 : -1))
    : [];



  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputTag.trim()) {
      onAddTag(inputTag.trim());
      setInputTag('');
      setIsFocused(false);
    }
  };

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-3 shrink-0 select-none w-full">
      {/* Mid Area Bar: Left Search Bar + Right S/M/L/XL Switcher */}
      <div className="flex items-center gap-3 w-full">
        {/* Left: Tag Search Input & Chips / Advanced Search Active Badge */}
        <div className="relative flex-1 min-w-[280px]">
          {advancedSearchActive ? (
            <div className="glass-panel px-3 py-2 flex items-center gap-2 rounded-xl border border-indigo-500/40 transition bg-indigo-950/30">
              <Search className="w-4 h-4 text-indigo-400 shrink-0" />
              <span
                onClick={() => onOpenAdvancedSearch && onOpenAdvancedSearch()}
                className="flex-1 text-xs text-indigo-200 font-medium cursor-pointer hover:text-white transition truncate"
                title={advancedSearchSummary}
              >
                {t('search.label_advanced_active', '詳細検索条件')}: {advancedSearchSummary || '...'}
              </span>
              <button
                onClick={() => onOpenAdvancedSearch && onOpenAdvancedSearch()}
                className="px-2 py-0.5 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 rounded-lg text-[11px] font-semibold transition cursor-pointer border border-indigo-500/30 shrink-0"
              >
                {t('search.label_edit_advanced', '編集')}
              </button>
              <button
                onClick={() => onClearAdvancedSearch && onClearAdvancedSearch()}
                className="p-0.5 text-slate-400 hover:text-red-400 transition cursor-pointer shrink-0 ml-1"
                title={t('search.label_clear_advanced', '解除')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="glass-panel px-3 py-1.5 flex items-center gap-2 flex-wrap rounded-xl border border-white/10 focus-within:border-indigo-500/50 transition">
                <Search className="w-4 h-4 text-slate-400 shrink-0" />

                {/* Selected Tag Chips */}
                {selectedTags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 rounded-lg text-xs font-medium"
                  >
                    #{tag}
                    <button
                      onClick={() => onRemoveTag(tag)}
                      className="hover:text-white transition cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}

                <input
                  type="text"
                  value={inputTag}
                  onChange={(e) => setInputTag(e.target.value)}
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setTimeout(() => setIsFocused(false), 200)}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    selectedTags.length === 0
                      ? t('search.label_placeholder_empty', 'Search tags by English or Japanese (e.g. #cat, #sunset)...')
                      : t('search.label_placeholder_add', 'Add filter tag...')
                  }
                  className="bg-transparent text-xs text-white placeholder-slate-500 focus:outline-none flex-1 min-w-[180px]"
                />
              </div>

              {/* Autocomplete Suggestions Dropdown Popup */}
              {isFocused && (
                <div className="absolute z-50 top-full left-0 right-0 mt-2 bg-slate-900 border border-indigo-500/40 rounded-xl shadow-2xl overflow-hidden max-h-60 overflow-y-auto animate-in fade-in zoom-in-95 duration-150">
                  <div className="px-3 py-1.5 bg-slate-950/80 border-b border-white/10 text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                    <span>{t('search.label_matching_tags', 'Matching Tags')}</span>

                    {/* Advanced Search Link */}
                    {onOpenAdvancedSearch && (
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onOpenAdvancedSearch();
                        }}
                        className="flex items-center gap-1 text-indigo-400 hover:text-indigo-200 transition cursor-pointer text-[11px] font-bold"
                      >
                        <Sliders className="w-3 h-3" />
                        <span>[{t('search.label_advanced_search', 'Advanced Search')}]</span>
                      </button>
                    )}
                  </div>

                  {suggestions.length > 0 ? (
                    <div className="p-1 space-y-0.5">
                      {suggestions.map((st) => {
                        const tagValue = st.name_ja || st.name;
                        return (
                          <button
                            key={st.id}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault();
                              onAddTag(tagValue);
                              setInputTag('');
                              setIsFocused(false);
                            }}
                            className={`w-full flex items-center justify-between px-3 py-2 text-xs hover:text-white hover:bg-indigo-600/60 rounded-lg transition text-left cursor-pointer group ${
                              st.kind === 'descriptive' ? 'text-slate-400' : 'text-slate-200'
                            }`}
                          >
                            <span className="flex items-center gap-1.5 font-medium">
                              <Hash className={`w-3.5 h-3.5 group-hover:text-indigo-200 ${st.kind === 'descriptive' ? 'text-slate-500' : 'text-indigo-400'}`} />
                              {st.name_ja ? `${st.name_ja} (${st.name})` : st.name}
                            </span>
                            <span className="text-[10px] text-slate-500 group-hover:text-indigo-200 font-mono">
                              + Select
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="p-3 text-center text-slate-500 text-xs italic">
                      No direct tag matches. Press Enter or click Advanced Search.
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Right: Grid Size Switcher (S M L XL) */}
        <div className="flex items-center bg-slate-900/90 rounded-xl p-1 border border-white/10 shadow-sm shrink-0">
          {[
            { label: 'S', cols: 7 },
            { label: 'M', cols: 5 },
            { label: 'L', cols: 3 },
            { label: 'XL', cols: 2 },
          ].map((g) => (
            <button
              key={g.label}
              onClick={() => onGridColumnsChange(g.cols)}
              className={`px-3 py-1 text-xs font-bold rounded-lg transition cursor-pointer ${
                gridColumns === g.cols
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* Progress Bar Display with Speed & ETA */}
      {scanning && progress && (
        <div className="glass-panel p-3 rounded-xl border border-indigo-500/30 bg-slate-900/90 shadow-xl space-y-2 animate-in fade-in duration-200">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 truncate">
              {progress.is_paused ? (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full font-bold text-[11px] shrink-0 animate-pulse">
                  <Pause className="w-3 h-3 fill-current" /> {t('progress.label_paused', '一時停止中')}
                </span>
              ) : (
                <span className="flex items-center gap-1 px-2 py-0.5 bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 rounded-full font-bold text-[11px] shrink-0">
                  <RefreshCw className="w-3 h-3 animate-spin" /> {t('progress.label_processing', '解析処理中')}
                </span>
              )}
              <span className="font-semibold text-slate-200">{progress.status}</span>
              <span className="text-slate-400 truncate max-w-xs font-mono text-[11px]">
                {progress.current_file.split(/[/\\]/).pop()}
              </span>
            </div>

            <div className="flex items-center gap-3 shrink-0 text-[11px]">
              {speedText && (
                <span className="flex items-center gap-1 text-indigo-300 font-mono">
                  <Zap className="w-3.5 h-3.5 text-amber-400" />
                  {speedText}
                </span>
              )}
              {etaText && (
                <span className="flex items-center gap-1 text-slate-300 font-mono font-semibold">
                  <Clock className="w-3.5 h-3.5 text-indigo-400" />
                  {etaText}
                </span>
              )}
              <span className="font-bold text-white font-mono bg-slate-800 px-2 py-0.5 rounded border border-white/10">
                {progress.current} / {progress.total} ({progressPercent}%)
              </span>
            </div>
          </div>

          <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden border border-white/10">
            <div
              className={`h-full transition-all duration-300 rounded-full ${
                progress.is_paused
                  ? 'bg-amber-500'
                  : 'bg-gradient-to-r from-indigo-500 via-violet-500 to-emerald-400'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
