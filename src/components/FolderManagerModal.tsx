import React, { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ScanFolderItem } from '../types';
import { Folder, RefreshCw, Trash2, FolderPlus, X, HardDrive, Play, RotateCcw, AlertTriangle } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { useExclusiveGuard } from '../hooks/useExclusiveGuard';

interface FolderManagerModalProps {
  open: boolean;
  folders: ScanFolderItem[];
  scanning: boolean;
  onClose: () => void;
  onStartScan: (folderPath: string) => void;
  onRescanAll: () => void;
  onReanalyzeAll: () => void;
  onReanalyzeFolder?: (folderPath: string) => void;
  onRemoveFolder: (folderId: number) => void;
}

export const FolderManagerModal: React.FC<FolderManagerModalProps> = ({
  open,
  folders,
  scanning,
  onClose,
  onStartScan,
  onRescanAll,
  onReanalyzeAll,
  onReanalyzeFolder,
  onRemoveFolder,
}) => {
  const { t } = useTranslation();
  // スキャン中だけでなく、Rust の排他ロックを取る処理が走っている間はどれも失敗する
  const exclusive = useExclusiveGuard();
  const [showConfirmReanalyze, setShowConfirmReanalyze] = useState(false);

  if (!open) return null;

  const handleAddNewFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === 'string') {
        onStartScan(selected);
        onClose();
      }
    } catch (e) {
      console.error('Folder selection failed:', e);
    }
  };

  const handleConfirmFullReanalyze = () => {
    setShowConfirmReanalyze(false);
    onReanalyzeAll();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="glass-panel w-full max-w-2xl p-6 rounded-2xl shadow-2xl border border-indigo-500/20 flex flex-col gap-5 max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-indigo-500/10 text-indigo-400 rounded-xl border border-indigo-500/20">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">{t('folder_modal.label_title', '登録フォルダ管理')}</h3>
              <p className="text-xs text-slate-400">
                {t('folder_modal.label_subtitle', 'Manage scan folders and re-analyze in bulk')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Action Panel (Two Separate Processing Modes) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Mode 1: Process Pending Only */}
          <div className="p-4 bg-slate-900/80 border border-indigo-500/30 rounded-xl flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold text-indigo-300">
                <Play className="w-4 h-4 text-indigo-400" />
                {t('folder_modal.label_mode_pending', '1. Process pending & new items')}
              </div>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                {t('folder_modal.mode_pending_body', '')}
              </p>
            </div>
            <button
              onClick={() => {
                onRescanAll();
                onClose();
              }}
              disabled={exclusive.blocked || folders.length === 0}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600/30 hover:bg-indigo-600/40 text-indigo-200 border border-indigo-500/40 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
              {t('folder_modal.label_rescan_all', 'Re-scan all folders')}
            </button>
          </div>

          {/* Mode 2: Re-analyze ALL Media */}
          <div className="p-4 bg-slate-900/80 border border-amber-500/30 rounded-xl flex flex-col justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
                <RotateCcw className="w-4 h-4 text-amber-400" />
                {t('folder_modal.label_mode_reanalyze', '2. Force re-analyze all media')}
              </div>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                {t('folder_modal.mode_reanalyze_body', '')}
              </p>
            </div>
            <button
              onClick={() => setShowConfirmReanalyze(true)}
              disabled={exclusive.blocked || folders.length === 0}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border border-amber-500/40 rounded-xl text-xs font-semibold transition cursor-pointer disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {t('folder_modal.label_reanalyze_all', 'Re-analyze all media')}
            </button>
          </div>
        </div>

        {/* Confirmation Sub-Modal for Re-analyze All */}
        {showConfirmReanalyze && (
          <div className="p-4 bg-amber-950/80 border border-amber-500/50 rounded-xl flex flex-col gap-3 animate-in fade-in duration-150">
            <div className="flex items-center gap-2 text-xs font-bold text-amber-200">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              {t('folder_modal.confirm_reanalyze_title', '')}
            </div>
            <p className="text-xs text-amber-100/80">
              {t('folder_modal.confirm_reanalyze_body', '')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirmReanalyze(false)}
                className="px-3 py-1 bg-slate-900 text-slate-300 text-xs rounded-lg hover:bg-slate-800"
              >
                {t('folder_modal.label_cancel', 'Cancel')}
              </button>
              <button
                onClick={handleConfirmFullReanalyze}
                className="px-3 py-1 bg-amber-600 text-white font-bold text-xs rounded-lg hover:bg-amber-500 shadow-md"
              >
                {t('folder_modal.label_confirm_reanalyze', 'Re-analyze all')}
              </button>
            </div>
          </div>
        )}

        {/* Registered Folders Bar */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-300">
            {t('folder_modal.label_registered', 'Registered folders')} ({folders.length})
          </span>
          <button
            onClick={handleAddNewFolder}
            disabled={exclusive.blocked}
            className="flex items-center gap-1.5 px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition border border-white/10 cursor-pointer disabled:opacity-50"
          >
            <FolderPlus className="w-3.5 h-3.5 text-indigo-400" />
            {t('folder_modal.label_add_folder', 'Add folder')}
          </button>
        </div>

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[160px]">
          {folders.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center border border-dashed border-white/10 rounded-xl">
              <Folder className="w-8 h-8 text-slate-500 mb-2" />
              <p className="text-sm font-medium text-slate-300">{t('folder_modal.empty_folders', '')}</p>
            </div>
          ) : (
            folders.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-3 bg-slate-900/60 hover:bg-slate-800/60 border border-white/5 rounded-xl transition group"
              >
                <div className="flex items-center gap-3 overflow-hidden">
                  <div className="p-2 bg-slate-800 text-indigo-400 rounded-lg shrink-0 border border-white/5">
                    <Folder className="w-4 h-4" />
                  </div>
                  <div className="truncate">
                    <div className="text-xs font-medium text-slate-200 truncate" title={item.path}>
                      {item.path}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                      {t('folder_modal.label_added', 'Added')}: {new Date(item.created_at * 1000).toLocaleDateString()}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0 ml-2">
                  <button
                    onClick={() => {
                      onStartScan(item.path);
                      onClose();
                    }}
                    disabled={exclusive.blocked}
                    className="p-1.5 text-slate-400 hover:text-indigo-300 hover:bg-indigo-600/20 rounded-lg transition cursor-pointer"
                    title={t('folder_modal.label_title_scan_pending', 'Process pending/new items in this folder')}
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  {onReanalyzeFolder && (
                    <button
                      onClick={() => {
                        onReanalyzeFolder(item.path);
                        onClose();
                      }}
                      disabled={exclusive.blocked}
                      className="p-1.5 text-slate-400 hover:text-amber-300 hover:bg-amber-600/20 rounded-lg transition cursor-pointer"
                      title={t('folder_modal.label_title_reanalyze', 'Force re-analyze ALL items in this folder')}
                    >
                      <RotateCcw className="w-4 h-4 text-amber-400/80" />
                    </button>
                  )}
                  <button
                    onClick={() => onRemoveFolder(item.id)}
                    className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/20 rounded-lg transition cursor-pointer"
                    title={t('folder_modal.label_title_remove', 'Remove folder')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end pt-3 border-t border-white/10">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium transition cursor-pointer"
          >
            {t('folder_modal.label_close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};
