import React, { useState } from 'react';
import { 
  Filter, Folder, Tag, CheckSquare, Square, Layers, Dog, User, ShoppingBag, Palette, 
  Monitor, FileText, Mountain, Utensils, Smile, Cpu, HelpCircle, Film, Image as ImageIcon,
  ChevronDown, ChevronRight, FileCode, CheckCircle, Clock, AlertTriangle, FolderGit2, Radar, EyeOff
} from 'lucide-react';
import { TagItem, ScanFolderItem } from '../types';
import { useTranslation } from '../contexts/I18nContext';
import { STATUS_TAG_INSUFFICIENT, STATUS_EXCLUDED } from '../constants/spectrum';
import { CATEGORY_IDS, categoryLabelKey } from '../constants/categories';

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

/** カテゴリの見出しアイコン。**表示名はここに持たない** → `constants/categories.ts` */
const CATEGORY_ICON: Record<string, React.ReactNode> = {
  screenshot: <Monitor className="w-3.5 h-3.5" />,
  document: <FileText className="w-3.5 h-3.5" />,
  landscape: <Mountain className="w-3.5 h-3.5" />,
  food: <Utensils className="w-3.5 h-3.5" />,
  character: <Smile className="w-3.5 h-3.5" />,
  animal: <Dog className="w-3.5 h-3.5" />,
  person: <User className="w-3.5 h-3.5" />,
  item_product: <ShoppingBag className="w-3.5 h-3.5" />,
  art_illustration: <Palette className="w-3.5 h-3.5" />,
  text_heavy: <FileText className="w-3.5 h-3.5" />,
  tech: <Cpu className="w-3.5 h-3.5" />,
  other: <HelpCircle className="w-3.5 h-3.5" />,
};

/** DB にカテゴリがまだ無いときの並び。識別子は共通定義から取る */
const DEFAULT_CATEGORIES: readonly string[] = CATEGORY_IDS;

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
          <span>{t('sidebar.label_title', 'フィルター')}</span>
        </div>
        {hasActiveFilters && (
          <button
            onClick={onClearFilters}
            className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold transition cursor-pointer"
          >
            {t('sidebar.label_reset_all', 'すべてリセット')}
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
            <span>{t('sidebar.label_media_type', 'メディア種別')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!openSections.mediaType && selectedMediaType !== 'all' && (
              <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold">
                {selectedMediaType === 'image' ? t('sidebar.label_images', '画像') : t('sidebar.label_videos', '動画')}
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
              { id: 'all', label: t('sidebar.label_all_media', 'すべてのメディア'), icon: <Film className="w-3.5 h-3.5" /> },
              { id: 'image', label: t('sidebar.label_images', '画像'), icon: <ImageIcon className="w-3.5 h-3.5 text-emerald-400" /> },
              { id: 'video', label: t('sidebar.label_videos', '動画'), icon: <Film className="w-3.5 h-3.5 text-amber-400" />, isVideo: true },
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
            <span>{t('sidebar.label_categories', 'カテゴリ')}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {!openSections.categories && selectedCategories.length > 0 && (
              <span className="px-1.5 py-0.5 bg-indigo-600 text-white rounded text-[10px] font-bold">
                {t('sidebar.label_selected_count', '{n} selected', { n: selectedCategories.length })}
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
              const icon = CATEGORY_ICON[cat] || <Tag className="w-3.5 h-3.5" />;
              const label = t(categoryLabelKey(cat), cat);
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
                  <div className="text-indigo-400">{icon}</div>
                  <span className="flex-1 text-left">{label}</span>
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
            <span>{t('sidebar.label_analysis_status', '解析ステータス')}</span>
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
              { id: '', label: t('sidebar.label_status_all', 'すべてのステータス'), icon: <Tag className="w-3.5 h-3.5 text-slate-400" /> },
              { id: 'completed', label: t('sidebar.label_status_completed', '解析完了'), icon: <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> },
              { id: 'pending', label: t('sidebar.label_status_pending', '未解析'), icon: <Clock className="w-3.5 h-3.5 text-amber-400" /> },
              { id: 'failed', label: t('sidebar.label_status_failed', '解析失敗'), icon: <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> },
              // 類似検索の対象外。タグを手で足せば対象に入るので、辿れるようにしておく
              { id: STATUS_TAG_INSUFFICIENT, label: t('sidebar.label_status_tag_insufficient', 'タグ不足（類似検索の対象外）'), icon: <Radar className="w-3.5 h-3.5 text-slate-400" /> },
              // ユーザーが解析対象から外したもの。除外したことを忘れて「解析されない」と読まれないよう辿れるようにする
              { id: STATUS_EXCLUDED, label: t('failure_modal.label_excluded_badge', '解析対象外'), icon: <EyeOff className="w-3.5 h-3.5 text-slate-400" /> },
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
              <span>{t('sidebar.label_added_folders', '登録済みフォルダ')} ({scanFolders.length})</span>
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
                {t('sidebar.label_added_folders', 'すべての登録フォルダ')}
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
              <span>{t('sidebar.label_parent_folders', '親フォルダ')} ({parentFolders.length})</span>
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
                {t('sidebar.label_parent_folders', 'すべての親フォルダ')}
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
            <span>{t('sidebar.label_file_extensions', 'ファイル拡張子')}</span>
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
