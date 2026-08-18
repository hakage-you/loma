import React, { useState, useRef, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { placeFloating, FloatingPlacement } from '../utils/floatingPosition';

/**
 * ホバーで出る補足説明。
 *
 * **位置は実測してビューポートに収める。** 以前は `absolute` ＋ `bottom-full` で
 * 常に上に出しており、モーダルの上端で切れていた（`overflow-hidden` と
 * `backdrop-blur` が効いた祖先の中では、はみ出したぶんが描画されない）。
 * 呼び出し側で `align` を変えて回避する運用は、置き場所が変わるたびに破綻する。
 *
 * そのため:
 *   1. `document.body` へ portal する —— 祖先の `overflow` / `backdrop-filter` で切られない
 *   2. 出したあとに実寸を測り、上下は広いほう・左右は画面内へ寄せる
 *
 * `align` は**希望**であって保証ではない。入りきらなければ寄せる。
 * `width` は既定 `w-64`。統計用語の説明のように長い本文では広げる。
 */
export const TooltipHelp: React.FC<{
  text: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
}> = ({ text, align = 'left', width = 'w-64' }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<FloatingPlacement | null>(null);

  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const tip = tipRef.current;
    if (!trigger || !tip) return;
    setPos(
      placeFloating(
        trigger.getBoundingClientRect(),
        { width: tip.offsetWidth, height: tip.offsetHeight },
        align
      )
    );
  }, [align]);

  // 表示のたびに測る。本文が変われば寸法も変わる
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    // 開いている間にスクロールやリサイズが起きたら追従する
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, text, place]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <HelpCircle className="w-3.5 h-3.5 text-slate-400 hover:text-indigo-300 transition cursor-help shrink-0" />

      {open &&
        createPortal(
          <div
            ref={tipRef}
            style={{
              left: pos ? `${pos.left}px` : 0,
              top: pos ? `${pos.top}px` : 0,
              maxHeight: pos ? `${pos.maxHeight}px` : undefined,
              // 測り終わるまでは出さない。出してから動かすと1フレーム跳ねて見える
              visibility: pos ? 'visible' : 'hidden',
            }}
            // whitespace-pre-line で本文中の改行をそのまま段落として出す。
            // 統計用語の説明は1段落だと読めないため必要。
            className={`fixed z-[200] ${width} max-w-[calc(100vw-16px)] overflow-y-auto p-2.5 bg-slate-900 border border-indigo-500/50 rounded-xl text-[11px] text-slate-200 shadow-2xl backdrop-blur-md pointer-events-none leading-relaxed whitespace-pre-line animate-in fade-in duration-150`}
          >
            {text}
            {pos && (
              <div
                style={{ left: `${pos.arrowLeft}px` }}
                className={`absolute -translate-x-1/2 border-4 border-transparent ${
                  pos.below ? 'bottom-full border-b-slate-900' : 'top-full border-t-slate-900'
                }`}
              />
            )}
          </div>,
          document.body
        )}
    </span>
  );
};
