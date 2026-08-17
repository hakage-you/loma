import React, { useState, useEffect, useRef } from 'react';
import { Terminal, ChevronUp, ChevronDown, Maximize2, Copy, Trash2, Check, RefreshCw, GripHorizontal, ArrowDown } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';

interface LogBottomConsoleProps {
  open: boolean;
  onToggle: () => void;
  onOpenFullModal: () => void;
  onGetLogs: (maxBytes?: number) => Promise<string>;
  onClearLogs: () => Promise<void>;
}

/**
 * 1回の取得で受け取るログの上限。**末尾しか受け取らない。**
 *
 * このコンソールは最大 1,000 行しか描画しないので、それ以上を受け取る意味が無い。
 * 1行 140 バイト程度なので 256KB あれば 1,000 行を十分まかなえる。
 *
 * 上限が無かったときの実測（2026-08-17）: ログ 5MB の状態で無操作放置すると、
 * 1.5 秒ごとの全文取得で renderer プロセスが 400MB/分 増え、JS ヒープ上限
 * 4,192MB に当たって Out of Memory で落ちた。
 */
const LOG_TAIL_BYTES = 256 * 1024;

export const LogBottomConsole: React.FC<LogBottomConsoleProps> = ({
  open,
  onToggle,
  onOpenFullModal,
  onGetLogs,
  onClearLogs,
}) => {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [height, setHeight] = useState<number>(220);
  const [isResizing, setIsResizing] = useState<boolean>(false);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    const text = await onGetLogs(LOG_TAIL_BYTES);
    setLogs(text);
  };

  // **閉じている間はポーリングしない。** 以前は依存配列が [] で `open` を見ておらず、
  // 32px のバーに畳んだ状態でも 1.5 秒ごとにログを取り続けていた。
  // このコンポーネントは App.tsx から常にマウントされるため、
  // 事実上アプリの起動中ずっと回りっぱなしで、これが無操作 OOM の原因だった。
  //
  // 畳んだバーにも行数・エラー件数・最新行を出しているので、
  // マウント時と開閉時には1回だけ取る。回し続けるのは開いている間だけ。
  useEffect(() => {
    fetchLogs();
    if (!open) return;
    const interval = setInterval(fetchLogs, 1500);
    return () => clearInterval(interval);
  }, [open]);

  // 新しいログ受信時の自動追従判定
  useEffect(() => {
    if (open && isAtBottom && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, open, isAtBottom]);

  // スクロール位置のハンドリング (最下部から20px以内かを判定)
  const handleScroll = () => {
    if (!scrollContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    setIsAtBottom(distanceToBottom <= 20);
  };

  const scrollToBottom = () => {
    setIsAtBottom(true);
    if (consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  // マウスドラッグによるペイン高さ変更処理
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!open) return;
    e.preventDefault();
    setIsResizing(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newHeight = window.innerHeight - e.clientY;
      if (newHeight >= 100 && newHeight <= window.innerHeight * 0.8) {
        setHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // 最大1,000行に制限
  let logLines = logs.split('\n').filter((line) => line.trim().length > 0);
  if (logLines.length > 1000) {
    logLines = logLines.slice(logLines.length - 1000);
  }
  const errorCount = logLines.filter((l) => l.includes('[ERROR]')).length;

  const handleCopy = () => {
    navigator.clipboard.writeText(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClear = async () => {
    await onClearLogs();
    setLogs('');
  };

  return (
    <div
      style={{ height: open ? `${height}px` : '32px' }}
      className={`relative w-full z-40 shrink-0 bg-slate-950/95 backdrop-blur-md border-t border-white/10 shadow-2xl flex flex-col ${
        isResizing ? 'select-none transition-none' : 'transition-all duration-200'
      }`}
    >
      {/* Resizable Top Drag Handle (When Open) */}
      {open && (
        <div
          onMouseDown={handleMouseDown}
          className="h-1.5 w-full bg-slate-800/80 hover:bg-indigo-500/80 cursor-row-resize flex items-center justify-center transition group shrink-0"
          title="Drag to resize console height"
        >
          <GripHorizontal className="w-6 h-3 text-slate-500 group-hover:text-white transition" />
        </div>
      )}

      {/* Console Header / Title Bar */}
      <div className="h-8 px-4 bg-slate-900/90 border-b border-white/10 flex items-center justify-between text-xs select-none shrink-0">
        <div
          onClick={onToggle}
          className="flex items-center gap-3 cursor-pointer hover:text-white text-slate-300 transition flex-1 min-w-0"
        >
          <div className="flex items-center gap-1.5 font-bold text-indigo-400 shrink-0">
            <Terminal className="w-3.5 h-3.5" />
            <span>{t('logs.title', '処理ログ')}</span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-slate-400 shrink-0">
            <span>{logLines.length} 行</span>
            {errorCount > 0 && (
              <span className="px-1.5 py-0.2 bg-red-500/20 text-red-300 border border-red-500/30 rounded font-semibold text-[10px]">
                {errorCount} エラー
              </span>
            )}
          </div>

          {!open && logLines.length > 0 && (
            <span className="text-[11px] text-slate-300 font-mono truncate flex-1 min-w-0 ml-2">
              Recent: {logLines[logLines.length - 1]}
            </span>
          )}
        </div>

        {/* Header Action Tools */}
        <div className="flex items-center gap-1.5 shrink-0">
          {open && (
            <>
              <button
                onClick={fetchLogs}
                className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition cursor-pointer"
                title="Refresh Logs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>

              <button
                onClick={handleCopy}
                disabled={!logs}
                className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition cursor-pointer disabled:opacity-40"
                title={t('logs.copy', 'Copy All Logs')}
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>

              <button
                onClick={handleClear}
                disabled={!logs}
                className="p-1 hover:bg-slate-800 text-slate-400 hover:text-red-400 rounded transition cursor-pointer disabled:opacity-40"
                title={t('logs.clear', 'Clear Logs')}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>

              <div className="w-[1px] h-3.5 bg-white/10 mx-1" />
            </>
          )}

          {/* Full Modal Trigger */}
          <button
            onClick={onOpenFullModal}
            className="flex items-center gap-1 px-2 py-0.5 bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-500/40 text-indigo-200 rounded text-[11px] font-medium transition cursor-pointer"
            title="Open Full Search & Diagnostic Modal"
          >
            <Maximize2 className="w-3 h-3" />
            <span>{t('logs.full_view', '全画面表示')}</span>
          </button>

          {/* Toggle Expand / Collapse */}
          <button
            onClick={onToggle}
            className="p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded transition cursor-pointer ml-1"
            title={open ? 'Collapse Console' : 'Expand Console'}
          >
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Terminal Output Area (When Open) */}
      {open && (
        <div className="relative flex-1 min-h-0">
          <div
            ref={scrollContainerRef}
            onScroll={handleScroll}
            className="h-full bg-black/95 p-3 font-mono text-[11px] overflow-y-auto space-y-0.5 select-text"
          >
            {logLines.length === 0 ? (
              <div className="text-slate-600 italic py-4">Console output is clean. No log entries yet.</div>
            ) : (
              logLines.map((line, idx) => {
                const isError = line.includes('[ERROR]');
                const isWarn = line.includes('[WARN]');
                return (
                  <div
                    key={idx}
                    className={`leading-tight break-all ${
                      isError
                        ? 'text-red-400 bg-red-950/30 px-1 rounded border-l-2 border-red-500 font-semibold'
                        : isWarn
                        ? 'text-amber-300 bg-amber-950/20 px-1 rounded border-l-2 border-amber-500'
                        : 'text-slate-300 hover:bg-slate-900/50 px-1 rounded'
                    }`}
                  >
                    {line}
                  </div>
                );
              })
            )}
            <div ref={consoleEndRef} />
          </div>

          {/* Scroll to Bottom Floating Button */}
          {!isAtBottom && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-4 right-6 flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full text-xs font-semibold shadow-xl border border-indigo-400/30 transition animate-in fade-in slide-in-from-bottom-2 duration-200 cursor-pointer"
            >
              <ArrowDown className="w-3.5 h-3.5" />
              <span>{t('logs.scroll_to_bottom', 'Scroll to Bottom')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
