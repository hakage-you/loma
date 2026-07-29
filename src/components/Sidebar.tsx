import React, { useState } from 'react';
import { 
  Filter, Folder, Tag, CheckSquare, Square, Layers, Dog, User, ShoppingBag, Palette, 
  Monitor, FileText, Mountain, Utensils, Smile, Cpu, HelpCircle, Film, Image as ImageIcon,
  ChevronDown, ChevronRight, FileCode, CheckCircle, Clock, AlertTriangle, FolderGit2, Radar
} from 'lucide-react';
import { TagItem, ScanFolderItem } from '../types';
import { useTranslation } from '../contexts/I18nContext';
import { STATUS_TAG_INSUFFICIENT } from '../constants/spectrum';

interface SidebarProps {
  tags: TagItem[];
  parentFolders: string[];
  scanFolders?: ScanFolderItem[];
  selectedCategories: string[];
  selectedParentFolder: string;
  selectedScanFolder?: string;
  selectedStatus: string;
  selectedMediaType: 'all' | 'image' | 'video';
  selectedExtensions: string[];
  ffmpegInstalled?: boolean;
  onToggleCategory: (categoryName: string) => void;
  onSelectParentFolder: (folder: string) => void;
  onSelectScanFolder?: (folder: string) => void;
  onSelectStatus: (status: string) => void;
  onSelectMediaType: (type: 'all' | 'image' | 'video') => void;
  onToggleExtension: (ext: string) => void;
  onClearFilters: () => void;
}

const CATEGORY_META: Record<string, { label: string; icon: React.ReactNode }> = {
  screenshot: { label: 'スクリーンショット', icon: <Monitor className="w-3.5 h-3.5" /> },
  document: { label: '書類・文書', icon: <FileText className="w-3.5 h-3.5" /> },
  landscape: { label: '風景・自然', icon: <Mountain className="w-3.5 h-3.5" /> },
  food: { label: '料理・食べ物', icon: <Utensils className="w-3.5 h-3.5" /> },
  character: { label: 'キャラクター', icon: <Smile className="w-3.5 h-3.5" /> },
  animal: { label: '動物・ペット', icon: <Dog className="w-3.5 h-3.5" /> },
  person: { label: '人物・顔写真', icon: <User className="w-3.5 h-3.5" /> },
  item_product: { label: '商品・雑貨', icon: <ShoppingBag className="w-3.5 h-3.5" /> },
  art_illustration: { label: 'イラスト・アート', icon: <Palette className="w-3.5 h-3.5" /> },
  text_heavy: { label: '文字主体', icon: <FileText className="w-3.5 h-3.5" /> },
  tech: { label: 'IT・技術', icon: <Cpu className="w-3.5 h-3.5" /> },
  other: { label: 'その他', icon: <HelpCircle className="w-3.5 h-3.5" /> },
};

const DEFAULT_CATEGORIES = [
  'screenshot',
  'document',
  'landscape',
  'food',
  'character',
  'animal',
  'person',
  'item_product',
  'art_illustration',
  'text_heavy',
  'tech',
  'other',
];

const COMMON_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'mov'];

export const Sidebar: React.FC<SidebarProps> = ({
  tags,
  parentFolders,
  scanFolders = [],
  selectedCategories,
  selectedParentFolder,
  selectedScanFolder = '',
  selectedStatus,
  selectedMediaType,
  selectedExtensions,
  ffmpegInstalled = true,
  onToggleCategory,
  onSelectParentFolder,
  onSelectScanFolder,
  onSelectStatus,
  onSelectMediaType,
  onToggleExtension,
  onClearFilters,
}) => {
  const { t } = useTranslation();
  // 初期状態では categories のみ展開 (open)
  const [openSections, setOpenSections] = useState<{
    mediaType: boolean;
    categories: boolean;
    status: boolean;
    scanFolders: boolean;
    folders: boolean;
    extensions: boolean;
  }>({
    mediaType: false,
    categories: true, // 初期状態で展開
    status: false,
    scanFolders: false,
    folders: false,
    extensions: false,
  });

  const toggleSection = (section: keyof typeof openSections) => {
    setOpenSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const categoryTags = tags.filter((t) => t.is_category);
  const categories = categoryTags.map((t) => t.name);
  const displayCategories = categories.length > 0 ? categories : DEFAULT_CATEGORIES;

  const hasActiveFilters =
    selectedCategories.length > 0 ||
    selectedParentFolder !== '' ||
    selectedScanFolder !== '' ||
    selectedStatus !== '' ||
    selectedMediaType !== 'all' ||
    selectedExtensions.length > 0;

  return (
    <aside className="w-64 glass-panel p-4 flex flex-col gap-3 shrink-0 h-full min-h-0 overflow-y-auto select-none">
      {/* Sidebar Header */}
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-white">
          <Filter className="w-4 h-4 text-indigo-400" />
          <span>{t('sidebar.title', 'フィルター')}</span>
        </div>
        {hasActiveFilters && (
          <button
            onClick={onClearFilters}
            className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition cursor-pointer"
          >
            {t('sidebar.reset_all', 'すべてリセット')}
          </button>
        )}
      </div>

      {/* 1. Media Type Filter (Top) */}
      <div className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden shrink-0">
        <button
          onClick={() => toggleSection('mediaType')}
          className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition cursor-pointer text-left"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <Film className="w-3.5 h-3.5 text-indigo-400" />
            <span>{t('sidebar.media_type', 'メディア種別')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!openSections.mediaType && selectedMediaType !== 'all' && (
              <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold">
                {selectedMediaType === 'image' ? t('sidebar.images', '画像') : t('sidebar.videos', '動画')}
              </span>
            )}
            {openSections.mediaType ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </div>
        </button>

        {openSections.mediaType && (
          <div className="p-2 space-y-1 border-t border-white/5 bg-slate-900/40">
            {[
              { id: 'all', label: t('sidebar.all_media', 'すべてのメディア'), icon: <Film className="w-3.5 h-3.5" /> },
              { id: 'image', label: t('sidebar.images', '画像'), icon: <ImageIcon className="w-3.5 h-3.5 text-emerald-400" /> },
              { id: 'video', label: t('sidebar.videos', '動画'), icon: <Film className="w-3.5 h-3.5 text-amber-400" />, isVideo: true },
            ].map((type) => {
              const isVideoDisabled = type.isVideo && ffmpegInstalled === false;
              return (
                <button
                  key={type.id}
                  disabled={isVideoDisabled}
                  onClick={() => !isVideoDisabled && onSelectMediaType(type.id as any)}
                  title={
                    isVideoDisabled
                      ? t('sidebar.video_no_ffmpeg', 'FFmpeg is not installed. FFmpeg is required for video frame extraction & analysis.')
                      : ''
                  }
                  className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-medium transition ${
                    isVideoDisabled
                      ? 'opacity-40 bg-slate-950/40 text-slate-500 cursor-not-allowed border border-amber-500/20'
                      : selectedMediaType === type.id
                      ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold cursor-pointer'
                      : 'text-slate-300 hover:bg-slate-800/60 cursor-pointer'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div>{type.icon}</div>
                    <span className="text-left">{type.label}</span>
                  </div>
                  {isVideoDisabled && (
                    <span title={t('sidebar.video_no_ffmpeg', 'FFmpeg is not installed. FFmpeg is required for video frame extraction & analysis.')}>
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. Categories Filter (Expanded by Default) */}
      <div className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden shrink-0">
        <button
          onClick={() => toggleSection('categories')}
          className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition cursor-pointer text-left"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <Layers className="w-3.5 h-3.5 text-indigo-400" />
            <span>{t('sidebar.categories', 'カテゴリ')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!openSections.categories && selectedCategories.length > 0 && (
              <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold">
                {selectedCategories.length} selected
              </span>
            )}
            {openSections.categories ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </div>
        </button>

        {openSections.categories && (
          <div className="p-2 space-y-1 border-t border-white/5 bg-slate-900/40">
            {displayCategories.map((cat) => {
              const isSelected = selectedCategories.includes(cat);
              const meta = CATEGORY_META[cat] || { label: cat, icon: <Tag className="w-3.5 h-3.5" /> };
              return (
                <button
                  key={cat}
                  onClick={() => onToggleCategory(cat)}
                  className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                    isSelected
                      ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold'
                      : 'text-slate-300 hover:bg-slate-800/60'
                  }`}
                >
                  <div className="text-indigo-400">{meta.icon}</div>
                  <span className="flex-1 text-left">{meta.label}</span>
                  {isSelected ? (
                    <CheckSquare className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                  ) : (
                    <Square className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. Analysis Status Filter */}
      <div className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden shrink-0">
        <button
          onClick={() => toggleSection('status')}
          className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition cursor-pointer text-left"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <Tag className="w-3.5 h-3.5 text-indigo-400" />
            <span>{t('sidebar.analysis_status', '解析ステータス')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!openSections.status && selectedStatus !== '' && (
              <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold capitalize">
                {selectedStatus}
              </span>
            )}
            {openSections.status ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </div>
        </button>

        {openSections.status && (
          <div className="p-2 space-y-1 border-t border-white/5 bg-slate-900/40">
            {[
              { id: '', label: t('sidebar.status_all', 'すべてのステータス'), icon: <Tag className="w-3.5 h-3.5 text-slate-400" /> },
              { id: 'completed', label: t('sidebar.status_completed', '解析完了'), icon: <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> },
              { id: 'pending', label: t('sidebar.status_pending', '未解析'), icon: <Clock className="w-3.5 h-3.5 text-amber-400" /> },
              { id: 'failed', label: t('sidebar.status_failed', '解析失敗'), icon: <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> },
              // 類似検索の対象外。タグを手で足せば対象に入るので、辿れるようにしておく
              { id: STATUS_TAG_INSUFFICIENT, label: t('sidebar.status_tag_insufficient', 'タグ不足（類似検索の対象外）'), icon: <Radar className="w-3.5 h-3.5 text-slate-400" /> },
            ].map((st) => (
              <button
                key={st.id}
                onClick={() => onSelectStatus(selectedStatus === st.id ? '' : st.id)}
                className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                  selectedStatus === st.id
                    ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                <div>{st.icon}</div>
                <span className="flex-1 text-left">{st.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 4. Added Folders Filter (Scan Folders) */}
      {scanFolders.length > 0 && (
        <div className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden shrink-0">
          <button
            onClick={() => toggleSection('scanFolders')}
            className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition cursor-pointer text-left"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <FolderGit2 className="w-3.5 h-3.5 text-indigo-400" />
              <span>{t('sidebar.added_folders', '登録済みフォルダ')} ({scanFolders.length})</span>
            </div>
            <div className="flex items-center gap-1.5">
              {!openSections.scanFolders && selectedScanFolder !== '' && (
                <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold truncate max-w-[80px]">
                  {selectedScanFolder.split(/[/\\]/).filter(Boolean).pop() || selectedScanFolder}
                </span>
              )}
              {openSections.scanFolders ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              )}
            </div>
          </button>

          {openSections.scanFolders && (
            <div className="p-2 space-y-1 border-t border-white/5 bg-slate-900/40">
              <button
                onClick={() => onSelectScanFolder && onSelectScanFolder('')}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer truncate ${
                  selectedScanFolder === ''
                    ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {t('sidebar.added_folders', 'すべての登録フォルダ')}
              </button>
              {scanFolders.map((sf) => {
                const name = sf.path.split(/[/\\]/).filter(Boolean).pop() || sf.path;
                return (
                  <button
                    key={sf.id}
                    onClick={() => onSelectScanFolder && onSelectScanFolder(sf.path)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer ${
                      selectedScanFolder === sf.path
                        ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                    title={sf.path}
                  >
                    <div className="font-medium truncate">{name}</div>
                    <div className="text-[10px] text-slate-400 font-mono truncate">{sf.path}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 5. Parent Folders Filter */}
      {parentFolders.length > 0 && (
        <div className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden shrink-0">
          <button
            onClick={() => toggleSection('folders')}
            className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition cursor-pointer text-left"
          >
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Folder className="w-3.5 h-3.5 text-indigo-400" />
              <span>{t('sidebar.parent_folders', '親フォルダ')} ({parentFolders.length})</span>
            </div>
            <div className="flex items-center gap-1.5">
              {!openSections.folders && selectedParentFolder !== '' && (
                <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold truncate max-w-[80px]">
                  {selectedParentFolder}
                </span>
              )}
              {openSections.folders ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              )}
            </div>
          </button>

          {openSections.folders && (
            <div className="p-2 space-y-1 border-t border-white/5 bg-slate-900/40">
              <button
                onClick={() => onSelectParentFolder('')}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer truncate ${
                  selectedParentFolder === ''
                    ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold'
                    : 'text-slate-300 hover:bg-slate-800/60'
                }`}
              >
                {t('sidebar.parent_folders', 'すべての親フォルダ')}
              </button>
              {parentFolders.map((folder) => (
                <button
                  key={folder}
                  onClick={() => onSelectParentFolder(folder)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-medium transition cursor-pointer truncate ${
                    selectedParentFolder === folder
                      ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 font-bold'
                      : 'text-slate-300 hover:bg-slate-800/60'
                  }`}
                  title={folder}
                >
                  {folder}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 5. File Extensions Filter (Bottom) */}
      <div className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden shrink-0">
        <button
          onClick={() => toggleSection('extensions')}
          className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-white/5 transition cursor-pointer text-left"
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
            <FileCode className="w-3.5 h-3.5 text-indigo-400" />
            <span>{t('sidebar.file_extensions', 'ファイル拡張子')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!openSections.extensions && selectedExtensions.length > 0 && (
              <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold">
                {selectedExtensions.length} selected
              </span>
            )}
            {openSections.extensions ? (
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            )}
          </div>
        </button>

        {openSections.extensions && (
          <div className="p-2 space-y-1 border-t border-white/5 bg-slate-900/40">
            <div className="grid grid-cols-2 gap-1">
              {COMMON_EXTENSIONS.map((ext) => {
                const isSelected = selectedExtensions.includes(ext);
                return (
                  <button
                    key={ext}
                    onClick={() => onToggleExtension(ext)}
                    className={`flex items-center justify-between px-2 py-1.5 rounded-lg text-xs font-mono font-medium transition cursor-pointer ${
                      isSelected
                        ? 'bg-indigo-600/40 text-indigo-200 border border-indigo-500/50 font-bold'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <span>.{ext}</span>
                    {isSelected ? (
                      <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                    ) : (
                      <Square className="w-3.5 h-3.5 text-slate-600" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
};
