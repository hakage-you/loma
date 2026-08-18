import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { MediaItem, TagItem, ScanFolderItem, ProgressPayload, TagFilterNode } from '../types';
import { STATUS_TAG_INSUFFICIENT, isTagInsufficient } from '../constants/spectrum';

export interface FilterState {
  categories?: string[];
  tags?: string[];
  tagFilterTree?: TagFilterNode;
  parentFolder?: string;
  scanFolder?: string;
  status?: string;
  mediaType?: 'all' | 'image' | 'video';
  fileExtensions?: string[];
}

export function useMedia() {
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [scanFolders, setScanFolders] = useState<ScanFolderItem[]>([]);
  const [parentFolders, setParentFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [scanning, setScanning] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  /**
   * `availableModels` のうち Ollama が `vision` を宣言しているモデルの名前。
   *
   * `null` は「まだ取れていない / 取得に失敗した」であって「0件」ではない。
   * 表示側はこの2つを区別すること（判定できないときに選択肢を消してはいけない）。
   */
  const [visionModels, setVisionModels] = useState<string[] | null>(null);
  /**
   * エラー表示。**ここで文言を組み立てない。**
   * `useMedia` は I18nProvider の外側でも呼ばれるため `useTranslation` を使えない。
   * 何が失敗したかは `messageKey` で渡し、文言の解決は表示側で行う。
   */
  const [errorModal, setErrorModal] = useState<{
    open: boolean;
    /** バックエンドから返った生のエラー。翻訳しない */
    message: string;
    /** 「〜に失敗しました」の見出しのロケールキー */
    messageKey?: string;
    /** Ollama 由来と見られるとき、表示側が対処の案内を足す */
    ollamaHint?: boolean;
  }>({
    open: false,
    message: '',
  });

  // 現在適用中のフィルター条件を保持する Ref
  const activeFiltersRef = useRef<FilterState>({});

  // batch_progress を受けての DB 再取得を間引く間隔 (ms)。
  // 進捗バーの更新は間引かず、DB を叩く fetchMedia / fetchMasterData だけを対象にする。
  const PROGRESS_REFRESH_DEBOUNCE_MS = 1000;

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);

  const fetchMedia = useCallback(async (filters?: FilterState) => {
    // 引数でフィルターが渡された場合はアクティブフィルターを更新
    if (filters !== undefined) {
      activeFiltersRef.current = filters;
    }
    const currentFilters = activeFiltersRef.current;

    setLoading(true);
    try {
      const result = await invoke<MediaItem[]>('get_media', {
        categoryFilter: currentFilters.categories && currentFilters.categories.length > 0 ? currentFilters.categories : null,
        tagFilter: currentFilters.tagFilterTree ? null : (currentFilters.tags && currentFilters.tags.length > 0 ? currentFilters.tags : null),
        tagFilterTree: currentFilters.tagFilterTree ? JSON.stringify(currentFilters.tagFilterTree) : null,
        parentFolderFilter: currentFilters.parentFolder || null,
        scanFolderFilter: currentFilters.scanFolder || null,
        // 疑似ステータス（unanalyzed / tag_insufficient）はバックエンドの
        // analysis_status に存在しないため送らず、下で結果から絞り込む
        statusFilter:
          currentFilters.status &&
          currentFilters.status !== 'unanalyzed' &&
          currentFilters.status !== STATUS_TAG_INSUFFICIENT
            ? currentFilters.status
            : null,
        mediaTypeFilter: currentFilters.mediaType && currentFilters.mediaType !== 'all' ? currentFilters.mediaType : null,
        extensionFilter: currentFilters.fileExtensions && currentFilters.fileExtensions.length > 0 ? currentFilters.fileExtensions : null,
      });
      if (currentFilters.status === 'unanalyzed') {
        setMedia(result.filter((item) => item.tags.length === 0 && item.categories.length === 0));
      } else if (currentFilters.status === STATUS_TAG_INSUFFICIENT) {
        // 類似検索の候補集合から外れているメディア。黙って除外せず、
        // ユーザーがタグを手で足せるよう一覧できるようにする
        setMedia(result.filter(isTagInsufficient));
      } else {
        setMedia(result);
      }
    } catch (e: any) {
      console.error('Failed to fetch media:', e);
      setErrorModal({ open: true, messageKey: 'errors.fetch_media', message: String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchMasterData = useCallback(async () => {
    try {
      const fetchedTags = await invoke<TagItem[]>('get_all_tags');
      setTags(fetchedTags);

      const fetchedFolders = await invoke<string[]>('get_parent_folders');
      setParentFolders(fetchedFolders);

      const fetchedScanFolders = await invoke<ScanFolderItem[]>('get_scan_folders');
      setScanFolders(fetchedScanFolders);

      const fetchedSettings = await invoke<Record<string, string>>('get_settings');
      setSettings(fetchedSettings);
    } catch (e) {
      console.error('Failed to fetch master data:', e);
    }
  }, []);

  // fetchMedia + fetchMasterData を「同時に 1 組だけ」実行する。
  // 実行中に来た要求は refreshPendingRef に畳んで、完了後にまとめて 1 回だけ追加実行する。
  const runRefresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      do {
        refreshPendingRef.current = false;
        await fetchMedia();
        await fetchMasterData();
      } while (refreshPendingRef.current);
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [fetchMedia, fetchMasterData]);

  const scheduleRefresh = useCallback(
    (immediate: boolean) => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (immediate) {
        void runRefresh();
        return;
      }
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void runRefresh();
      }, PROGRESS_REFRESH_DEBOUNCE_MS);
    },
    [runRefresh]
  );

  /**
   * モデル一覧と vision 宣言の一覧を取り直す。
   *
   * `refresh` は vision 宣言のキャッシュ（Rust 側でプロセス内に持っている）を捨てるかどうか。
   * 明示的な「モデル一覧を取得」ボタンからのみ true にする。
   * 一覧の取得と vision の取得は別々に握り潰す —— vision 側が落ちても、
   * モデル一覧そのものは表示できるため。
   */
  const fetchModels = useCallback(async (refresh = false) => {
    try {
      const models = await invoke<string[]>('get_available_models');
      setAvailableModels(models);
    } catch (e) {
      console.error('Failed to fetch available models:', e);
    }
    try {
      const vision = await invoke<string[]>('get_vision_capable_models', { refresh });
      setVisionModels(vision);
    } catch (e) {
      console.error('Failed to fetch vision capabilities:', e);
      setVisionModels(null);
    }
  }, []);

  const startScan = async (folderPath: string) => {
    setScanning(true);
    setProgress({
      total: 0,
      current: 0,
      current_file: '',
      status: 'Starting scan...',
      error_count: 0,
    });
    try {
      await invoke('start_scan', { folderPath });
    } catch (e: any) {
      console.error('Failed to start scan:', e);
      setErrorModal({ open: true, message: String(e) });
      setScanning(false);
    }
  };

  const cancelScan = async () => {
    try {
      if (progress) {
        setProgress((prev) => (prev ? { ...prev, status: 'Canceling...' } : null));
      }
      await invoke('cancel_scan');
    } catch (e) {
      console.error('Failed to cancel scan:', e);
    } finally {
      setScanning(false);
      setProgress(null);
      await fetchMedia(); // アクティブフィルターを引き継いで更新
      await fetchMasterData();
    }
  };

  const pauseScan = async () => {
    try {
      await invoke('pause_scan');
    } catch (e) {
      console.error('Failed to pause scan:', e);
    }
  };

  const resumeScan = async () => {
    try {
      await invoke('resume_scan');
    } catch (e) {
      console.error('Failed to resume scan:', e);
    }
  };

  const rescanAllFolders = async () => {
    setScanning(true);
    setProgress({
      total: 0,
      current: 0,
      current_file: '',
      status: 'Processing pending & updated items...',
      error_count: 0,
    });
    try {
      await invoke('rescan_all_folders');
    } catch (e: any) {
      console.error('Failed to rescan all folders:', e);
      setErrorModal({ open: true, message: String(e) });
      setScanning(false);
    }
  };

  const reanalyzeAllMedia = async () => {
    setScanning(true);
    setProgress({
      total: 0,
      current: 0,
      current_file: '',
      status: 'Re-analyzing all media with VLM...',
      error_count: 0,
    });
    try {
      await invoke('reanalyze_all_media');
    } catch (e: any) {
      console.error('Failed to reanalyze all media:', e);
      setErrorModal({ open: true, message: String(e) });
      setScanning(false);
    }
  };

  /**
   * Ollama 由来と見られるエラーか。**案内の文言はここで作らない**（表示側が足す）。
   *
   * **`💡【対処のご案内】` は Rust 側も出すマーカーなので翻訳しない**
   * （`batch.rs` が同じ文字列を含むエラーを返す）。既に入っていれば案内は不要。
   */
  const looksLikeOllamaIssue = (e: any): boolean => {
    const errStr = String(e);
    if (errStr.includes('💡【対処のご案内】')) return false;
    return (
      errStr.includes('Ollama') ||
      errStr.includes('llama-server') ||
      errStr.includes('500') ||
      errStr.includes('CUDA') ||
      errStr.includes('0xc0000409') ||
      errStr.includes('buffer') ||
      errStr.includes('out of memory')
    );
  };

  const reanalyzeFolder = async (folderPath: string) => {
    setScanning(true);
    setProgress({
      total: 0,
      current: 0,
      current_file: folderPath,
      status: 'Re-analyzing folder media with VLM...',
      error_count: 0,
    });
    try {
      await invoke('reanalyze_folder', { folderPath });
    } catch (e: any) {
      console.error('Failed to reanalyze folder:', e);
      setErrorModal({ open: true, messageKey: 'errors.reanalyze_folder', message: String(e), ollamaHint: looksLikeOllamaIssue(e) });
      setScanning(false);
    }
  };

  const customAnalyzeVideo = async (mediaId: number, timestampSeconds: number) => {
    setScanning(true);
    setProgress({
      total: 1,
      current: 0,
      current_file: `Custom timestamp (${timestampSeconds.toFixed(1)}s)...`,
      status: 'Deep VLM analyzing with custom video frame...',
      error_count: 0,
    });
    try {
      await invoke('custom_analyze_video', { mediaId, timestampSeconds });
      await fetchMedia();
      await fetchMasterData();
    } catch (e: any) {
      console.error('Failed custom video analysis:', e);
      setErrorModal({ open: true, messageKey: 'errors.custom_video', message: String(e), ollamaHint: looksLikeOllamaIssue(e) });
    } finally {
      setScanning(false);
    }
  };

  const removeScanFolder = async (folderId: number) => {
    try {
      await invoke('remove_scan_folder', { folderId });
      await fetchMasterData();
      await fetchMedia();
    } catch (e: any) {
      console.error('Failed to remove scan folder:', e);
    }
  };

  const cleanupMissingMedia = async () => {
    try {
      await invoke('cleanup_missing_media');
      await fetchMedia();
      await fetchMasterData();
    } catch (e: any) {
      console.error('Failed to cleanup missing media:', e);
    }
  };

  const openFile = async (filePath: string) => {
    try {
      await invoke('open_file', { filePath });
    } catch (e: any) {
      setErrorModal({ open: true, message: `Could not open file: ${e}` });
    }
  };

  const openFolder = async (filePath: string) => {
    try {
      await invoke('open_folder', { filePath });
    } catch (e: any) {
      setErrorModal({ open: true, message: `Could not open folder: ${e}` });
    }
  };

  const retryMedia = async (mediaIds: number[]) => {
    if (mediaIds.length === 0) return;
    setScanning(true);
    setProgress({
      total: mediaIds.length,
      current: 0,
      current_file: '',
      status: 'Retrying analysis...',
      error_count: 0,
    });
    try {
      await invoke('retry_media', { mediaIds });
      await fetchMedia(); // アクティブフィルターを引き継いで更新
    } catch (e: any) {
      console.error('Failed to retry media:', e);
      setErrorModal({ open: true, messageKey: 'errors.retry_media', message: String(e), ollamaHint: looksLikeOllamaIssue(e) });
      setScanning(false);
    }
  };

  const reanalyzeSingleMedia = async (mediaId: number) => {
    setScanning(true);
    try {
      await invoke('reanalyze_single_media', { mediaId });
      await fetchMedia();
      await fetchMasterData();
    } catch (e: any) {
      console.error('Failed to reanalyze single media:', e);
      setErrorModal({ open: true, messageKey: 'errors.reanalyze_media', message: String(e), ollamaHint: looksLikeOllamaIssue(e) });
    } finally {
      setScanning(false);
    }
  };


  const unloadModel = async () => {
    try {
      await invoke('unload_model');
    } catch (e: any) {
      console.error('Failed to unload model:', e);
    }
  };

  /**
   * ログの末尾を取得する。
   *
   * **定期的に呼ぶ場合は必ず `maxBytes` を渡すこと。** 返り値はそのまま
   * WebView の JS ヒープに載る。省略時はバックエンドの既定（8MB）まで読む。
   */
  const getLogs = async (maxBytes?: number): Promise<string> => {
    try {
      return await invoke<string>('get_app_logs', { maxBytes });
    } catch (e: any) {
      console.error('Failed to get logs:', e);
      return '';
    }
  };

  const clearLogs = async () => {
    try {
      await invoke('clear_app_logs');
    } catch (e: any) {
      console.error('Failed to clear logs:', e);
    }
  };

  const renameTag = async (tagId: number, newName: string, newNameJa?: string) => {
    try {
      await invoke('rename_tag', { tagId, newName, newNameJa });
      await fetchMasterData();
      await fetchMedia();
    } catch (e: any) {
      console.error('Failed to rename tag:', e);
      setErrorModal({ open: true, message: String(e) });
    }
  };

  const mergeTags = async (targetTagId: number, sourceTagIds: number[]) => {
    try {
      await invoke('merge_tags', { targetTagId, sourceTagIds });
      await fetchMasterData();
      await fetchMedia();
    } catch (e: any) {
      console.error('Failed to merge tags:', e);
      setErrorModal({ open: true, message: String(e) });
    }
  };

  const addTagToMedia = async (mediaId: number, tagName: string, tagNameJa?: string) => {
    try {
      await invoke<TagItem>('add_tag_to_media', { mediaId, tagName, tagNameJa: tagNameJa || null });
      await fetchMasterData();
      await fetchMedia();
    } catch (e: any) {
      console.error('Failed to add tag to media:', e);
      setErrorModal({ open: true, message: String(e) });
    }
  };

  const removeTagFromMedia = async (mediaId: number, tagId: number) => {
    try {
      await invoke('remove_tag_from_media', { mediaId, tagId });
      await fetchMasterData();
      await fetchMedia();
    } catch (e: any) {
      console.error('Failed to remove tag from media:', e);
      setErrorModal({ open: true, message: String(e) });
    }
  };

  const updateSetting = async (key: string, value: string) => {
    try {
      await invoke('update_setting', { key, value });
      setSettings((prev) => ({ ...prev, [key]: value }));
    } catch (e) {
      console.error('Failed to update setting:', e);
    }
  };

  const checkScanStatus = useCallback(async () => {
    try {
      const isRunning = await invoke<boolean>('get_scan_status');
      if (isRunning) {
        setScanning(true);
      }
    } catch (e) {
      console.error('Failed to check scan status:', e);
    }
  }, []);

  useEffect(() => {
    fetchMedia();
    fetchMasterData();
    checkScanStatus();

    const unlistenPromise = listen<ProgressPayload>('batch_progress', (event) => {
      setProgress(event.payload);
      const statusText = event.payload.status || '';
      const isFinished =
        statusText === 'Completed' ||
        (statusText.includes('Stopped') && !event.payload.is_paused);

      setScanning(!isFinished);
      // 進行中イベントの際も、アクティブなフィルター条件を確実に適用してメディア更新。
      // ただし batch_progress は登録フェーズで 5 ファイルごと、解析フェーズで 1 ファイルごとに
      // 飛んでくる。毎回そのまま呼ぶと get_media / get_all_tags / get_parent_folders /
      // get_scan_folders / get_settings の 5 本が積み上がり、max_connections(5) の
      // SQLite プールを食い潰して get_media が
      // "pool timed out while waiting for an open connection" で失敗する。
      // 終了イベントだけは即時、進行中は間引いて取得する。
      scheduleRefresh(isFinished);
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [fetchMedia, fetchMasterData, checkScanStatus, scheduleRefresh]);

  return {
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
    fetchMedia,
    fetchMasterData,
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
    cleanupMissingMedia,
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
  };
}

