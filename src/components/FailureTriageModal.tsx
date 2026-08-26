import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Clock, FolderOpen, RotateCcw, Trash2, X, EyeOff, Undo2 } from 'lucide-react';
import { MediaItem, ExcludedPathItem } from '../types';
import { useTranslation } from '../contexts/I18nContext';

/**
 * 種別コードから表示ラベルのキーを引く。
 *
 * **ここに無いコードが来ることを前提にしている。** バックエンドが知らない
 * エラーは `unknown` に落ちるし、将来コードが増えてもフロントが追いつく前に
 * 一覧へ出る。その場合はエラー文面そのものを見出しに使う。
 */
const KIND_LABEL_KEYS: Record<string, string> = {
  not_decodable: 'label_kind_not_decodable',
  encode_failed: 'label_kind_encode_failed',
  image_rejected: 'label_kind_image_rejected',
  no_video_frame: 'label_kind_no_video_frame',
  context_exhausted: 'label_kind_context_exhausted',
  rate_limit: 'label_kind_rate_limit',
  server_unavailable: 'label_kind_server_unavailable',
};

/**
 * エラー文面から、そのファイル固有の部分を落として比較できる形にする。
 *
 * 未知のエラーは種別コードでは分けられないので、文面で束ねる。パスや数値を
 * 残すと1ファイル1グループになって束ねる意味が無くなる。
 */
const normalizeMessage = (message: string): string =>
  message
    // Windows / POSIX どちらのパスも落とす
    .replace(/[A-Za-z]:[\\/][^\s()]*/g, '<path>')
    .replace(/\/[^\s()]*\/[^\s()]*/g, '<path>')
    .replace(/\d+/g, 'N')
    .trim();

interface FailureGroup {
  key: string;
  heading: string;
  /** 既知の種別なら翻訳済みラベル、未知なら生の文面である */
  translated: boolean;
  needsAttention: boolean;
  items: MediaItem[];
}

const buildGroups = (
  items: MediaItem[],
  t: (k: string, d?: string) => string,
): FailureGroup[] => {
  const map = new Map<string, FailureGroup>();

  for (const item of items) {
    const kind = item.analysis_error_kind || 'unknown';
    const labelKey = KIND_LABEL_KEYS[kind];
    // 既知の種別は種別ごと、未知はエラー文面ごとに束ねる
    const key = labelKey ? kind : `unknown:${normalizeMessage(item.analysis_error || '')}`;

    let group = map.get(key);
    if (!group) {
      group = {
        key,
        heading: labelKey
          ? t(`failure_modal.${labelKey}`)
          : normalizeMessage(item.analysis_error || '') || kind,
        translated: Boolean(labelKey),
        needsAttention: item.needs_attention,
        items: [],
      };
      map.set(key, group);
    }
    // 同じグループ内で判定が割れるのは、未知が降格の途中にある場合だけ。
    // 1件でも要確認なら、グループごと上に出して目に入るようにする
    group.needsAttention = group.needsAttention || item.needs_attention;
    group.items.push(item);
  }

  return [...map.values()].sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return b.items.length - a.items.length;
  });
};

const fileNameOf = (path: string): string => path.split(/[\\/]/).pop() || path;

interface FailureTriageModalProps {
  open: boolean;
  failedItems: MediaItem[];
  scanning: boolean;
  onClose: () => void;
  onRetry: (mediaIds: number[]) => void | Promise<void>;
  onExclude: (mediaIds: number[], reason?: string) => Promise<number>;
  onDelete: (mediaIds: number[], reason?: string) => Promise<number>;
  onUnexclude: (paths: string[]) => Promise<number>;
  onLoadExcluded: () => Promise<ExcludedPathItem[]>;
  onOpenFolder: (filePath: string) => void;
}

export const FailureTriageModal: React.FC<FailureTriageModalProps> = ({
  open,
  failedItems,
  scanning,
  onClose,
  onRetry,
  onExclude,
  onDelete,
  onUnexclude,
  onLoadExcluded,
  onOpenFolder,
}) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'failed' | 'excluded'>('failed');
  const [excluded, setExcluded] = useState<ExcludedPathItem[]>([]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [pendingDelete, setPendingDelete] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => buildGroups(failedItems, t), [failedItems, t]);

  const refreshExcluded = async () => setExcluded(await onLoadExcluded());

  useEffect(() => {
    if (open) void refreshExcluded();
  }, [open]);

  if (!open) return null;

  const runOnGroup = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refreshExcluded();
    } finally {
      setBusy(false);
    }
  };

  const confirmingIds = pendingDelete ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-200">
      <div className="glass-panel w-full max-w-3xl p-6 rounded-2xl shadow-2xl border border-indigo-500/20 flex flex-col gap-4 max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <h2 className="text-base font-semibold text-slate-100">
              {t('failure_modal.label_title', '解析できなかったファイル')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 transition cursor-pointer"
            title={t('failure_modal.label_close', '閉じる')}
          >
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 border-b border-white/10 shrink-0">
          {(['failed', 'excluded'] as const).map((id) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-2 text-xs font-semibold transition cursor-pointer border-b-2 ${
                tab === id
                  ? 'border-indigo-400 text-indigo-300'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {id === 'failed'
                ? `${t('failure_modal.label_tab_failed', '解析失敗')} (${failedItems.length})`
                : `${t('failure_modal.label_tab_excluded', '解析対象外')} (${excluded.length})`}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto flex-1 -mr-2 pr-2">
          {tab === 'failed' && (
            <div className="space-y-3">
              {groups.length === 0 && (
                <p className="text-xs text-slate-400 py-6 text-center">
                  {t('failure_modal.empty_failed', '解析に失敗したファイルはありません。')}
                </p>
              )}

              {groups.map((group) => {
                const ids = group.items.map((i) => i.id);
                const isOpen = openGroups[group.key] ?? false;
                return (
                  <div
                    key={group.key}
                    className="border border-white/5 bg-slate-950/40 rounded-xl overflow-hidden"
                  >
                    <div className="px-3 py-2.5 flex items-start justify-between gap-3">
                      <button
                        onClick={() =>
                          setOpenGroups((prev) => ({ ...prev, [group.key]: !isOpen }))
                        }
                        className="flex-1 text-left cursor-pointer min-w-0"
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          {group.needsAttention ? (
                            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-red-500/20 text-red-300 border border-red-500/30 rounded text-[10px] font-bold">
                              <AlertTriangle className="w-3 h-3" />
                              {t('failure_modal.label_needs_attention', '要確認')}
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded text-[10px] font-bold">
                              <Clock className="w-3 h-3" />
                              {t('failure_modal.label_transient', '一時的な失敗')}
                            </span>
                          )}
                          <span
                            className={`text-xs font-semibold text-slate-200 truncate ${
                              group.translated ? '' : 'font-mono'
                            }`}
                          >
                            {group.heading}
                          </span>
                          <span className="text-[10px] text-slate-400">
                            ({group.items.length})
                          </span>
                        </div>
                      </button>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          disabled={busy || scanning}
                          onClick={() => void onRetry(ids)}
                          title={t('failure_modal.label_retry_group', 'このグループを再試行')}
                          className="p-1.5 rounded-lg hover:bg-white/10 text-amber-300 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={busy || scanning}
                          onClick={() =>
                            void runOnGroup(() => onExclude(ids, group.translated ? group.key : 'unknown'))
                          }
                          title={t('failure_modal.label_exclude_group', 'このグループを今後解析しない')}
                          className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <EyeOff className="w-3.5 h-3.5" />
                        </button>
                        <button
                          disabled={busy || scanning}
                          onClick={() => setPendingDelete(ids)}
                          title={t('failure_modal.label_delete_group', 'このグループをライブラリから削除')}
                          className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-300 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {isOpen && (
                      <div className="border-t border-white/5 bg-slate-900/40 divide-y divide-white/5">
                        <p className="px-3 py-2 text-[11px] text-slate-400">
                          {group.needsAttention
                            ? t(
                                'failure_modal.needs_attention_hint',
                                '再試行しても同じ結果になる見込みのファイルです。ファイル自体が壊れているか、対応していない形式の可能性があります。',
                              )
                            : group.translated
                              ? t(
                                  'failure_modal.transient_hint',
                                  'サーバー側の一時的な問題です。時間をおいて再試行すると通ることがあります。',
                                )
                              : t(
                                  'failure_modal.unknown_hint',
                                  '分類できていないエラーです。同じエラーで2回続けて失敗したものは要確認に移ります。',
                                )}
                        </p>
                        {group.items.map((item) => (
                          <div
                            key={item.id}
                            className="px-3 py-2 flex items-center justify-between gap-3"
                          >
                            <div className="min-w-0">
                              <p className="text-xs text-slate-200 truncate">
                                {fileNameOf(item.file_path)}
                              </p>
                              <p className="text-[10px] text-slate-500 truncate font-mono">
                                {item.file_path}
                              </p>
                              {item.analysis_error && (
                                <p className="text-[10px] text-red-300/80 mt-0.5 break-all">
                                  {item.analysis_error}
                                </p>
                              )}
                              {item.consecutive_failures > 1 && (
                                <p className="text-[10px] text-slate-500 mt-0.5">
                                  {t('failure_modal.label_consecutive', '連続{count}回失敗', {
                                    count: item.consecutive_failures,
                                  })}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              <button
                                onClick={() => onOpenFolder(item.file_path)}
                                title={t('failure_modal.label_open_folder', 'フォルダを開く')}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 transition cursor-pointer"
                              >
                                <FolderOpen className="w-3.5 h-3.5" />
                              </button>
                              <button
                                disabled={busy || scanning}
                                onClick={() => void onRetry([item.id])}
                                title={t('failure_modal.label_retry', '再試行')}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-amber-300 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                              <button
                                disabled={busy || scanning}
                                onClick={() => void runOnGroup(() => onExclude([item.id]))}
                                title={t('failure_modal.label_exclude', '今後解析しない')}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-slate-300 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <EyeOff className="w-3.5 h-3.5" />
                              </button>
                              <button
                                disabled={busy || scanning}
                                onClick={() => setPendingDelete([item.id])}
                                title={t('failure_modal.label_delete', 'ライブラリから削除')}
                                className="p-1.5 rounded-lg hover:bg-red-500/20 text-red-300 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {tab === 'excluded' && (
            <div className="space-y-1">
              {excluded.length === 0 && (
                <p className="text-xs text-slate-400 py-6 text-center">
                  {t('failure_modal.empty_excluded', '解析対象から外しているファイルはありません。')}
                </p>
              )}
              {excluded.map((row) => (
                <div
                  key={row.path}
                  className="px-3 py-2 flex items-center justify-between gap-3 border border-white/5 bg-slate-950/40 rounded-lg"
                >
                  <div className="min-w-0">
                    <p className="text-xs text-slate-200 truncate">{fileNameOf(row.path)}</p>
                    <p className="text-[10px] text-slate-500 truncate font-mono">{row.path}</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void runOnGroup(() => onUnexclude([row.path]))}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/10 text-xs text-slate-300 transition cursor-pointer shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    {t('failure_modal.label_unexclude', '解除')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 削除は取り消せないので、押し間違いをそのまま通さない */}
        {pendingDelete && (
          <div className="shrink-0 border border-red-500/30 bg-red-950/30 rounded-xl p-3 flex items-center justify-between gap-3">
            <p className="text-xs text-red-200">
              {t(
                'failure_modal.delete_confirm',
                '{count}件をライブラリから削除します。ファイル本体は消えませんが、次のスキャンでも再登録されなくなります。',
                { count: confirmingIds.length },
              )}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => setPendingDelete(null)}
                className="px-2.5 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-white/10 transition cursor-pointer"
              >
                {t('failure_modal.label_close', '閉じる')}
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void runOnGroup(async () => {
                    await onDelete(confirmingIds);
                    setPendingDelete(null);
                  })
                }
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-500 text-white transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('failure_modal.label_delete', 'ライブラリから削除')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
