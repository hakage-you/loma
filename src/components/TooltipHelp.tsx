import React from 'react';
import { HelpCircle } from 'lucide-react';

/**
 * ホバーで出る補足説明。
 *
 * 元は SettingsModal 内のローカル定義だったが、計測結果パネルでも必要になったため
 * 切り出した。`width` は既定 `w-64`。統計用語の説明のように長い本文では広げる。
 */
export const TooltipHelp: React.FC<{
  text: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
}> = ({ text, align = 'left', width = 'w-64' }) => {
  const containerClasses =
    align === 'right'
      ? 'right-0 bottom-full mb-2'
      : align === 'center'
      ? 'left-1/2 -translate-x-1/2 bottom-full mb-2'
      : 'left-0 bottom-full mb-2';

  const arrowClasses =
    align === 'right'
      ? 'right-2'
      : align === 'center'
      ? 'left-1/2 -translate-x-1/2'
      : 'left-2';

  return (
    <div className="relative group inline-flex items-center">
      <HelpCircle className="w-3.5 h-3.5 text-slate-400 hover:text-indigo-300 transition cursor-help shrink-0" />
      <div
        // whitespace-pre-line で本文中の改行をそのまま段落として出す。
        // 統計用語の説明は1段落だと読めないため必要。
        className={`absolute ${containerClasses} hidden group-hover:block z-50 ${width} p-2.5 bg-slate-900 border border-indigo-500/50 rounded-xl text-[11px] text-slate-200 shadow-2xl backdrop-blur-md pointer-events-none leading-relaxed whitespace-pre-line animate-in fade-in zoom-in-95 duration-150`}
      >
        {text}
        <div className={`absolute top-full ${arrowClasses} border-4 border-transparent border-t-slate-900`} />
      </div>
    </div>
  );
};
