import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useMedia } from './hooks/useMedia';
import { SearchBar } from './components/SearchBar';
import { Sidebar } from './components/Sidebar';
import { GalleryGrid } from './components/GalleryGrid';
import { SettingsModal } from './components/SettingsModal';
import { ErrorModal } from './components/ErrorModal';
import { MediaDetailModal } from './components/MediaDetailModal';
import { FolderManagerModal } from './components/FolderManagerModal';
import { LogViewerModal } from './components/LogViewerModal';
import { LogBottomConsole } from './components/LogBottomConsole';
import { TagManagementModal } from './components/TagManagementModal';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { MediaItem, OllamaPullProgressPayload, SearchGroup, TagFilterNode } from './types';
import { Sparkles, FolderPlus, RefreshCw, Tags, HardDrive, Settings, Play, Pause, StopCircle, Loader2 } from 'lucide-react';
import { I18nProvider, useTranslation } from './contexts/I18nContext';
import { AboutModal } from './components/AboutModal';
import { SearchModal } from './components/SearchModal';
import { SpectrumModal } from './components/SpectrumModal';
import { STATUS_TAG_INSUFFICIENT } from './constants/spectrum';

function AppContent() {
  const { t } = useTranslation();
  const {
    media,
    tags,
    scanFolders,
    parentFolders,
    loading,
    progress,
    scanning,
    settings,
    availableModels,
    visionModels,
    errorModal,
    setErrorModal,
    fetchMasterData,
    fetchMedia,
    fetchModels,
    startScan,
    cancelScan,
    pauseScan,
    resumeScan,
    rescanAllFolders,
    reanalyzeAllMedia,
    reanalyzeFolder,
    customAnalyzeVideo,
    removeScanFolder,
    openFile,
    openFolder,
    retryMedia,
    renameTag,
    mergeTags,
    addTagToMedia,
    removeTagFromMedia,
    unloadModel,
    getLogs,
    clearLogs,
    updateSetting,
    reanalyzeSingleMedia,
  } = useMedia();

  const [globalDownloadProgress, setGlobalDownloadProgress] = useState<OllamaPullProgressPayload | null>(null);
  /** 概念スペクトラム探索の起点。null で閉じる */
  const [spectrumBase, setSpectrumBase] = useState<MediaItem | null>(null);

  useEffect(() => {
    const unlistenPromise = listen<OllamaPullProgressPayload>('ollama-pull-progress', (event) => {
      const payload = event.payload;
      setGlobalDownloadProgress(payload);
      if (payload.done && !payload.error) {
        fetchModels();
      }
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [fetchModels]);

  const handleStartScanWithCheck = async (folderPath: string) => {
    if (globalDownloadProgress && !globalDownloadProgress.done) {
      setErrorModal({
        open: true,
        message: t('app.download_in_progress', '', { model: globalDownloadProgress.model }),
      });
      return;
    }
    await startScan(folderPath);
  };

  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [advancedSearchGroups, setAdvancedSearchGroups] = useState<SearchGroup[]>([]);
  const [searchPrefillTag, setSearchPrefillTag] = useState<string>('');
  const [selectedParentFolder, setSelectedParentFolder] = useState<string>('');
  const [selectedScanFolder, setSelectedScanFolder] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [selectedMediaType, setSelectedMediaType] = useState<'all' | 'image' | 'video'>('all');
  const [selectedExtensions, setSelectedExtensions] = useState<string[]>([]);

  const [gridColumns, setGridColumns] = useState<number>(5);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFolderManagerOpen, setIsFolderManagerOpen] = useState(false);
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);
  const [isLogConsoleOpen, setIsLogConsoleOpen] = useState(false);
  const [isTagManagementOpen, setIsTagManagementOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [ffmpegInstalled, setFfmpegInstalled] = useState<boolean>(true);
  const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);

  useEffect(() => {
    invoke<boolean>('check_ffmpeg_installed')
      .then((installed: boolean) => setFfmpegInstalled(installed))
      .catch(() => setFfmpegInstalled(false));
  }, []);

  // ドキュメント用スクリーンショット撮影を自動化するためのフック(モックモード限定)。
  // 例: http://localhost:xxxx/?debugOpen=settings でSettings modalを自動的に開いた状態で読み込む。
  useEffect(() => {
    if (import.meta.env.MODE !== 'mock') return;
    const debugOpen = new URLSearchParams(window.location.search).get('debugOpen');
    if (debugOpen === 'settings') setIsSettingsOpen(true);
    if (debugOpen === 'search') setIsSearchModalOpen(true);
    if (debugOpen === 'about') setIsAboutOpen(true);
  }, []);

  const handleSyncFolders = async () => {
    try {
      await invoke('sync_folders');
      fetchMasterData();
    } catch (e: any) {
      console.error('Sync failed:', e);
    }
  };

  const groupsToFilterTree = (groups: SearchGroup[]): TagFilterNode | null => {
    if (groups.length === 0) return null;
    const children: TagFilterNode[] = [];
    for (const group of groups) {
      if (group.tags.length === 0) continue;
      const tagNodes: TagFilterNode[] = group.tags.map((t) => ({ type: 'tag' as const, value: t }));
      if (group.operator === 'not') {
        const inner: TagFilterNode =
          tagNodes.length === 1 ? tagNodes[0] : { type: 'or' as const, children: tagNodes };
        children.push({ type: 'not' as const, child: inner });
      } else if (group.operator === 'or') {
        children.push(tagNodes.length === 1 ? tagNodes[0] : { type: 'or' as const, children: tagNodes });
      } else {
        children.push(tagNodes.length === 1 ? tagNodes[0] : { type: 'and' as const, children: tagNodes });
      }
    }
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    return { type: 'and' as const, children };
  };

  const filterTreeToDisplayString = (node: TagFilterNode): string => {
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
  };

  const isAdvancedSearchActive =
    advancedSearchGroups.length > 0 && advancedSearchGroups.some((g) => g.tags.length > 0);

  const advancedSearchSummary = isAdvancedSearchActive
    ? filterTreeToDisplayString(groupsToFilterTree(advancedSearchGroups)!)
    : '';

  useEffect(() => {
    const tree = isAdvancedSearchActive ? groupsToFilterTree(advancedSearchGroups) : undefined;
    fetchMedia({
      categories: selectedCategories,
      tags: isAdvancedSearchActive ? undefined : selectedTags,
      tagFilterTree: tree || undefined,
      parentFolder: selectedParentFolder,
      scanFolder: selectedScanFolder,
      status: selectedStatus,
      mediaType: selectedMediaType,
      fileExtensions: selectedExtensions,
    });
  }, [
    selectedCategories,
    selectedTags,
    advancedSearchGroups,
    selectedParentFolder,
    selectedScanFolder,
    selectedStatus,
    selectedMediaType,
    selectedExtensions,
  ]);

  useEffect(() => {
    fetchMasterData();
  }, []);

  const handleToggleCategory = (categoryName: string) => {
    setSelectedCategories((prev) =>
      prev.includes(categoryName)
        ? prev.filter((c) => c !== categoryName)
        : [...prev, categoryName]
    );
  };

  const handleToggleExtension = (ext: string) => {
    setSelectedExtensions((prev) =>
      prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]
    );
  };

  const handleAddTag = (tag: string) => {
    if (isAdvancedSearchActive) {
      setSearchPrefillTag(tag);
      setIsSearchModalOpen(true);
    } else {
      if (!selectedTags.includes(tag)) {
        setSelectedTags((prev) => [...prev, tag]);
      }
    }
  };

  const handleRemoveTag = (tag: string) => {
    setSelectedTags((prev) => prev.filter((t) => t !== tag));
  };

  const handleClearFilters = () => {
    setSelectedCategories([]);
    setSelectedTags([]);
    setAdvancedSearchGroups([]);
    setSelectedParentFolder('');
    setSelectedScanFolder('');
    setSelectedStatus('');
    setSelectedMediaType('all');
    setSelectedExtensions([]);
  };

  const failedMediaItems = media.filter((m) => m.analysis_status === 'failed');
  const handleRetryAllFailed = async () => {
    const failedIds = failedMediaItems.map((m) => m.id);
    if (failedIds.length > 0) {
      await retryMedia(failedIds);
    }
  };

  const handleSelectFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === 'string') {
        handleStartScanWithCheck(selected);
      }
    } catch (e) {
      console.error('Folder selection failed:', e);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden select-none">
      {/* Top Header Bar (Matching Sketch Layout) */}
      <header className="px-5 py-2.5 bg-slate-900/90 border-b border-white/10 flex items-center justify-between gap-4 shrink-0 glass-panel rounded-none border-x-0 border-t-0">
        {/* Top-Left: App Title / Logo (Width = 16rem / w-64 to match Sidebar) */}
        <div
          onClick={() => setIsAboutOpen(true)}
          className="w-64 flex items-center gap-2.5 cursor-pointer group px-2 py-1 rounded-xl hover:bg-white/5 transition shrink-0"
          title={t('app.label_title_about', 'About Loma')}
        >
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 p-0.5 shadow-lg group-hover:scale-105 transition">
            <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-indigo-400" />
            </div>
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-wide leading-none group-hover:text-indigo-300 transition">
              Loma
            </h1>
            <span className="text-[10px] text-indigo-300 font-medium leading-none">
              Local Ollama Media Analyzer
            </span>
          </div>
        </div>

        {/* Top-Right Header Action Groups */}
        <div className="flex items-center gap-2.5 shrink-0">
          {/* 1. Add / Sync Action Group */}
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-white/10 shadow-sm">
            {scanning ? (
              <>
                {progress?.is_paused ? (
                  <button
                    onClick={resumeScan}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold transition cursor-pointer shadow-lg shadow-emerald-900/30"
                    title={t('app.label_title_resume', 'Resume processing')}
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Resume
                  </button>
                ) : (
                  <button
                    onClick={pauseScan}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 border border-amber-500/40 rounded-lg text-xs font-semibold transition cursor-pointer"
                    title={t('app.label_title_pause', 'Pause processing')}
                  >
                    <Pause className="w-3.5 h-3.5 fill-current" />
                    Pause
                  </button>
                )}
                <button
                  onClick={cancelScan}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 rounded-lg text-xs font-medium transition cursor-pointer"
                  title={t('app.label_title_cancel_scan', 'Cancel scan')}
                >
                  <StopCircle className="w-3.5 h-3.5" />
                  Cancel
                </button>
              </>
            ) : (
              <>
                {/* [Add Folder] Button */}
                <button
                  onClick={handleSelectFolder}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-lg text-xs font-semibold transition shadow-lg shadow-indigo-900/30 cursor-pointer"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                  <span>{t('search.label_add_folder', 'フォルダ追加')}</span>
                </button>

                {/* [Sync] Button */}
                <button
                  onClick={handleSyncFolders}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-white border border-indigo-500/30 rounded-lg text-xs font-semibold transition cursor-pointer"
                  title={t('app.label_title_sync', 'Sync all registered folders')}
                >
                  <RefreshCw className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{t('search.label_sync', '同期')}</span>
                </button>
              </>
            )}

            {!scanning && failedMediaItems.length > 0 && (
              <button
                onClick={handleRetryAllFailed}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/30 rounded-lg text-xs font-medium transition cursor-pointer"
                title={t('app.label_title_retry', 'Retry failed items')}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>{t('search.label_retry', '再試行')} ({failedMediaItems.length})</span>
              </button>
            )}
          </div>

          {/* 2. Tags & Folders Group */}
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-white/10 shadow-sm">
            <button
              onClick={() => setIsTagManagementOpen(true)}
              className="px-2.5 py-1.5 text-slate-300 hover:text-white rounded-lg transition cursor-pointer flex items-center gap-1.5 text-xs font-medium hover:bg-slate-800"
              title={t('app.label_title_tags', 'Tag Management & Consolidation')}
            >
              <Tags className="w-3.5 h-3.5 text-indigo-400" />
              <span>{t('search.label_tags_btn', 'タグ管理')}</span>
            </button>

            <button
              onClick={() => setIsFolderManagerOpen(true)}
              className="px-2.5 py-1.5 text-slate-300 hover:text-white rounded-lg transition cursor-pointer flex items-center gap-1.5 text-xs font-medium hover:bg-slate-800"
              title={t('app.label_title_folders', 'Manage Registered Folders')}
            >
              <HardDrive className="w-3.5 h-3.5 text-indigo-400" />
              <span>{t('search.label_folders_btn', 'フォルダ管理')}</span>
            </button>
          </div>

          {/* 3. Settings Group */}
          <div className="flex items-center gap-1 bg-slate-950/80 p-1 rounded-xl border border-white/10 shadow-sm">
            <button
              onClick={() => setIsSettingsOpen(true)}
              className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
              title={t('app.label_title_settings', 'Settings')}
            >
              <Settings className="w-4 h-4 text-indigo-400" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Body */}
      <div className="flex flex-1 p-4 pb-2 gap-4 overflow-hidden min-h-0">
        {/* Left Sidebar (Filters) */}
        <Sidebar
          tags={tags}
          parentFolders={parentFolders}
          scanFolders={scanFolders}
          selectedCategories={selectedCategories}
          selectedParentFolder={selectedParentFolder}
          selectedScanFolder={selectedScanFolder}
          selectedStatus={selectedStatus}
          selectedMediaType={selectedMediaType}
          selectedExtensions={selectedExtensions}
          ffmpegInstalled={ffmpegInstalled}
          onToggleCategory={handleToggleCategory}
          onSelectParentFolder={setSelectedParentFolder}
          onSelectScanFolder={setSelectedScanFolder}
          onSelectStatus={setSelectedStatus}
          onSelectMediaType={setSelectedMediaType}
          onToggleExtension={handleToggleExtension}
          onClearFilters={handleClearFilters}
        />

        {/* Right Main Area */}
        <div className="flex-1 flex flex-col gap-3 overflow-hidden min-w-0">
          {/* Top Search & Actions Bar (Search Input + S/M/L/XL Switcher) */}
          <SearchBar
            tags={tags}
            selectedTags={selectedTags}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onStartScan={handleStartScanWithCheck}
            onSyncFolders={handleSyncFolders}
            onCancelScan={cancelScan}
            onPauseScan={pauseScan}
            onResumeScan={resumeScan}
            onRetryFailed={handleRetryAllFailed}
            onOpenFolderManager={() => setIsFolderManagerOpen(true)}
            onOpenTagManagement={() => setIsTagManagementOpen(true)}
            onOpenAdvancedSearch={() => setIsSearchModalOpen(true)}
            onOpenAbout={() => setIsAboutOpen(true)}
            failedCount={failedMediaItems.length}
            gridColumns={gridColumns}
            onGridColumnsChange={setGridColumns}
            onOpenSettings={() => setIsSettingsOpen(true)}
            scanning={scanning}
            progress={progress}
            advancedSearchActive={isAdvancedSearchActive}
            advancedSearchSummary={advancedSearchSummary}
            onClearAdvancedSearch={() => setAdvancedSearchGroups([])}
          />

          {/* Media Grid */}
          <GalleryGrid
            items={media}
            loading={loading}
            gridColumns={gridColumns}
            onSelectItem={(item) => setSelectedMedia(item)}
            onSelectTagFilter={handleAddTag}
            onFindSimilar={(item) => setSpectrumBase(item)}
          />
        </div>
      </div>

      {/* VSCode-style Collapsible Bottom Log Console */}
      <LogBottomConsole
        open={isLogConsoleOpen}
        onToggle={() => setIsLogConsoleOpen((prev) => !prev)}
        onOpenFullModal={() => setIsLogsModalOpen(true)}
        onGetLogs={getLogs}
        onClearLogs={clearLogs}
      />

      {/* Media Detail Modal */}
      <MediaDetailModal
        item={selectedMedia}
        allTags={tags}
        onClose={() => setSelectedMedia(null)}
        onOpenFolder={openFolder}
        onOpenFile={openFile}
        onRemoveTagFromMedia={removeTagFromMedia}
        onAddTagToMedia={addTagToMedia}
        onCustomAnalyzeVideo={customAnalyzeVideo}
        onReanalyzeSingleMedia={reanalyzeSingleMedia}
        onRetry={async (id) => retryMedia([id])}
        onSelectTagFilter={handleAddTag}
        isScanning={scanning}
        onFindSimilar={(item) => {
          // 探索モーダルは詳細モーダルの上に重ねず、詳細を閉じてから開く
          setSelectedMedia(null);
          setSpectrumBase(item);
        }}
      />

      {/* 概念スペクトラム探索 */}
      <SpectrumModal
        base={spectrumBase}
        onClose={() => setSpectrumBase(null)}
        onOpenSettings={() => {
          setSpectrumBase(null);
          setIsSettingsOpen(true);
        }}
        // カードのクリックは他画面と同じく詳細を開く。探索モーダルは開いたまま
        // 背面に残るので、詳細を閉じれば探索に戻れる
        onOpenDetail={(item) => setSelectedMedia(item)}
        onShowExcluded={() => {
          // 対象外メディアをメイングリッドで絞り込んで見せる。
          // 探索結果をグリッドに流し込むのではなく既存のフィルタ機構に載せるので、
          // 状態モデルは壊れない
          setSpectrumBase(null);
          setSelectedStatus(STATUS_TAG_INSUFFICIENT);
        }}
      />

      {/* Folder Manager Modal */}
      <FolderManagerModal
        open={isFolderManagerOpen}
        folders={scanFolders}
        onClose={() => setIsFolderManagerOpen(false)}
        onStartScan={handleStartScanWithCheck}
        onRemoveFolder={removeScanFolder}
        onRescanAll={rescanAllFolders}
        onReanalyzeAll={reanalyzeAllMedia}
        onReanalyzeFolder={reanalyzeFolder}
        scanning={scanning}
      />

      {/* Tag Management Modal */}
      <TagManagementModal
        open={isTagManagementOpen}
        tags={tags}
        onClose={() => setIsTagManagementOpen(false)}
        onRenameTag={async (id, name, nameJa) => {
          await renameTag(id, name, nameJa);
          await fetchMasterData();
          await fetchMedia();
        }}
        onMergeTags={async (targetId, sourceIds) => {
          await mergeTags(targetId, sourceIds);
          await fetchMasterData();
          await fetchMedia();
        }}
        onDataChanged={async () => {
          await fetchMasterData();
          await fetchMedia();
        }}
        onSelectTagFilter={handleAddTag}
        isScanning={scanning}
      />

      {/* Full Log Diagnostic Modal */}
      <LogViewerModal
        open={isLogsModalOpen}
        onClose={() => setIsLogsModalOpen(false)}
        onGetLogs={getLogs}
        onClearLogs={clearLogs}
      />

      {/* Settings Modal */}
      <SettingsModal
        open={isSettingsOpen}
        settings={settings}
        availableModels={availableModels}
        visionModels={visionModels}
        onClose={() => setIsSettingsOpen(false)}
        onUpdateSetting={updateSetting}
        onFetchModels={fetchModels}
        onUnloadModel={unloadModel}
      />

      {/* Floating Download Progress Indicator (when Settings modal is closed) */}
      {globalDownloadProgress && !globalDownloadProgress.done && !isSettingsOpen && (
        <div className="fixed bottom-14 right-6 z-40 bg-slate-900/90 backdrop-blur-md border border-indigo-500/50 rounded-2xl p-3.5 shadow-2xl flex items-center gap-4 animate-in slide-in-from-bottom-5 duration-200">
          <div className="p-2 bg-indigo-500/20 text-indigo-400 rounded-xl border border-indigo-500/30">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-bold text-white font-mono">DL: {globalDownloadProgress.model}</span>
              <span className="font-mono text-indigo-400 font-bold">{globalDownloadProgress.percent.toFixed(1)}%</span>
            </div>
            <div className="w-48 h-1.5 bg-slate-950 rounded-full overflow-hidden border border-white/10">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-200"
                style={{ width: `${Math.max(2, globalDownloadProgress.percent)}%` }}
              />
            </div>
            <p className="text-[10px] text-slate-400 truncate max-w-[200px]">{globalDownloadProgress.status}</p>
          </div>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="px-2.5 py-1.5 text-xs font-bold bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 rounded-xl border border-indigo-500/40 transition cursor-pointer"
          >
            {t('app.label_open_settings', 'Open settings')}
          </button>
        </div>
      )}

      {/* About Modal */}
      <AboutModal
        open={isAboutOpen}
        onClose={() => setIsAboutOpen(false)}
      />

      {/* Advanced Search Modal */}
      <SearchModal
        open={isSearchModalOpen}
        onClose={() => {
          setIsSearchModalOpen(false);
          setSearchPrefillTag('');
        }}
        tags={tags}
        initialGroups={advancedSearchGroups.length > 0 ? advancedSearchGroups : undefined}
        prefillTag={searchPrefillTag}
        onApplySearch={(groups) => {
          setAdvancedSearchGroups(groups);
          setSelectedTags([]);
          setSearchPrefillTag('');
        }}
        onClearSearch={() => {
          setAdvancedSearchGroups([]);
          setSearchPrefillTag('');
        }}
      />

      {/* Error Modal */}
      <ErrorModal
        open={errorModal.open}
        message={errorModal.message}
        messageKey={errorModal.messageKey}
        ollamaHint={errorModal.ollamaHint}
        onClose={() => setErrorModal({ open: false, message: '' })}
      />
    </div>
  );
}

export function App() {
  const { settings, updateSetting } = useMedia();
  return (
    <I18nProvider initialLanguage={(settings.ui_language as any) || 'ja'} onLanguageChange={(lang) => updateSetting('ui_language', lang)}>
      <AppContent />
    </I18nProvider>
  );
}

export default App;
