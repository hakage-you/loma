import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { MediaItem } from '../types';
import { Clock, AlertCircle, ExternalLink, Image as ImageIcon, Folder, Tag, Radar, EyeOff, Loader2 } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { MIN_BASIC_TAGS, isTagInsufficient } from '../constants/spectrum';
import { categoryLabelKey } from '../constants/categories';

interface GalleryGridProps {
  items: MediaItem[];
  loading: boolean;
  gridColumns: number; // 2 ~ 8
  onSelectItem: (item: MediaItem) => void;
  onSelectTagFilter?: (tagName: string) => void;
  onFindSimilar?: (item: MediaItem) => void;
}

export const GalleryGrid: React.FC<GalleryGridProps> = ({
  items,
  loading,
  gridColumns,
  onSelectItem,
  onSelectTagFilter,
  onFindSimilar,
}) => {
  const { t, language } = useTranslation();
  if (loading && items.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3 text-slate-400">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm">{t('gallery.label_loading', '読み込み中')}</p>
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex-1 glass-panel flex flex-col items-center justify-center min-h-[400px] p-8 text-center border-dashed border-white/10">
        <div className="p-4 bg-slate-800/50 rounded-2xl text-slate-500 mb-3 border border-white/5">
          <ImageIcon className="w-8 h-8" />
        </div>
        <h3 className="text-base font-semibold text-slate-200">
          {t('gallery.label_empty_title', '該当するメディアがありません')}
        </h3>
        <p className="text-xs text-slate-400 max-w-sm mt-1">
          {t('gallery.empty_hint', '「フォルダ追加」から取り込むか、絞り込みを変えてください。')}
        </p>
      </div>
    );
  }

  // 列数に応じた Tailwind grid クラスマップ (画面幅に応じて安全にレスポンシブ変化)
  const gridClassMap: Record<number, string> = {
    2: 'grid-cols-1 sm:grid-cols-2',
    3: 'grid-cols-1 sm:grid-cols-2 md:grid-cols-3',
    4: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5',
    6: 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6',
    7: 'grid-cols-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-7',
    8: 'grid-cols-2 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8',
  };

  const currentGridClass = gridClassMap[gridColumns] || 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5';

  return (
    <div className="flex-1 overflow-y-auto pr-2 pb-4 min-h-0 relative">
      {/*
        絞り込み直しの間に出す表示。**一覧は消さない**（消すと画面が跳ねる）。
        スピナーの回転は当てにしないこと —— 取得後の再描画はメインスレッドを
        占有するので、その間アニメーションは止まる。「いま読み込んでいる」という
        事実を出すのが目的
      */}
      {loading && (
        <div className="sticky top-0 z-20 flex justify-center pointer-events-none">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/95 border border-indigo-500/30 shadow-lg text-[11px] text-slate-200">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
            {t('gallery.label_loading', '読み込み中')}
          </div>
        </div>
      )}
      <div
        className={`grid ${currentGridClass} gap-4 auto-rows-max transition-opacity ${
          loading ? 'opacity-40' : ''
        }`}
      >
        {items.map((item) => {
          const imageSrc = item.thumbnail_path
            ? convertFileSrc(item.thumbnail_path)
            : convertFileSrc(item.file_path);

          const fileName = item.file_path.split(/[/\\]/).pop() || '';

          return (
            <div
              key={item.id}
              onClick={() => onSelectItem(item)}
              className="group glass-panel glass-panel-hover overflow-hidden flex flex-col cursor-pointer transition-all duration-200 rounded-xl border border-white/10"
            >
              {/* Thumbnail Container (固定アスペクト比) */}
              <div className="relative aspect-square bg-slate-950/80 overflow-hidden flex items-center justify-center">
                <img
                  src={imageSrc}
                  alt={fileName}
                  loading="lazy"
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  onError={(e) => {
                    (e.target as HTMLElement).style.display = 'none';
                  }}
                />

                {/* Status Badges */}
                <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-none z-10">
                  {item.analysis_status === 'pending' && (
                    <span className="flex items-center gap-1 px-2 py-0.5 bg-amber-500/90 backdrop-blur-md text-slate-950 rounded-full text-[10px] font-bold shadow-lg animate-pulse-subtle">
                      <Clock className="w-3 h-3" />
                      {t('sidebar.label_status_pending', '未解析')}
                    </span>
                  )}
                  {item.excluded ? (
                    <span className="flex items-center gap-1 px-2 py-0.5 bg-slate-600/90 backdrop-blur-md text-slate-200 rounded-full text-[10px] font-bold shadow-lg">
                      <EyeOff className="w-3 h-3" />
                      {t('failure_modal.label_excluded_badge', '解析対象外')}
                    </span>
                  ) : (
                    item.analysis_status === 'failed' && (
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-red-500/90 backdrop-blur-md text-white rounded-full text-[10px] font-bold shadow-lg">
                        <AlertCircle className="w-3 h-3" />
                        {t('sidebar.label_status_failed', '解析失敗')}
                      </span>
                    )
                  )}
                  {item.categories && item.categories.length > 0 && (
                    <span className="flex items-center gap-1 px-2 py-0.5 bg-indigo-600/90 backdrop-blur-md text-white rounded-full text-[10px] font-medium shadow-lg ml-auto">
                      {t(categoryLabelKey(item.categories[0]), item.categories[0])}
                    </span>
                  )}
                </div>

                {/* Hover Overlay */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 z-10">
                  <div className="p-2 bg-white/20 backdrop-blur-md rounded-full text-white">
                    <ExternalLink className="w-5 h-5" />
                  </div>
                  {onFindSimilar && item.analysis_status === 'completed' && (
                    // タグ不足なら押せなくし、理由を示す。MediaDetailModal 側の
                    // トリガーと挙動を揃える（片方だけ押せると壊れて見える）
                    <button
                      type="button"
                      disabled={isTagInsufficient(item)}
                      onClick={(e) => {
                        // カード全体のクリック（詳細を開く）に伝播させない
                        e.stopPropagation();
                        onFindSimilar(item);
                      }}
                      title={
                        isTagInsufficient(item)
                          ? t(
                              'spectrum.label_badge_excluded',
                              'タグが {n} 個未満のため、似ているメディアの検索の対象外です',
                            ).replace('{n}', String(MIN_BASIC_TAGS))
                          : t('spectrum.label_trigger', '似ているメディアを探す')
                      }
                      className="p-2 bg-white/20 hover:bg-indigo-500/70 backdrop-blur-md rounded-full text-white transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/20"
                    >
                      <Radar className="w-5 h-5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Info Area */}
              <div className="p-2.5 flex flex-col gap-1 flex-1 justify-between bg-slate-900/60 min-w-0">
                <div className="text-xs font-medium text-slate-200 truncate" title={fileName}>
                  {fileName}
                </div>

                {/* Parent Folder */}
                {item.parent_folder && (
                  <div className="flex items-center gap-1 text-[11px] text-slate-400 truncate">
                    <Folder className="w-3 h-3 text-indigo-400 shrink-0" />
                    <span className="truncate">{item.parent_folder}</span>
                  </div>
                )}

                {/* Tags list */}
                {item.tags && item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {item.tags.slice(0, 3).map((tagObj) => {
                      const displayTag = tagObj.name_ja || tagObj.name;
                      return (
                        <span
                          key={tagObj.name}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onSelectTagFilter) {
                              onSelectTagFilter(language === 'ja' ? displayTag : tagObj.name);
                            }
                          }}
                          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-slate-800 text-slate-300 hover:text-indigo-200 hover:bg-indigo-900/50 rounded text-[10px] truncate max-w-[120px] cursor-pointer transition"
                          title={t('gallery.label_title_search_tag', 'Click to search this tag')}
                        >
                          <Tag className="w-2.5 h-2.5 text-indigo-400 shrink-0" />
                          <span className="truncate">{displayTag}</span>
                        </span>
                      );
                    })}
                    {item.tags.length > 3 && (
                      <span className="text-[10px] text-slate-500 self-center">
                        +{item.tags.length - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
