import React, { useEffect } from 'react';

/**
 * リスト末尾に置いた番兵が見えたら `onMore` を呼ぶ。
 *
 * 全件を一度に DOM へ出すのをやめるための道具。タグ管理の提案一覧と
 * ギャラリーで共有している。**仮想化ではない** ——
 * 一度出したものは消さず、下に向かって足していくだけ。
 *
 * `active` は表示の出し分けで DOM ごと入れ替わる画面のために渡す
 * （非表示の間は ref が null で、購読を張れない）。
 */
export function useLoadMoreOnScroll(
  rootRef: React.RefObject<HTMLDivElement | null>,
  sentinelRef: React.RefObject<HTMLDivElement | null>,
  active: boolean,
  hasMore: boolean,
  /** いま出ている件数。**購読を張り直すためだけに要る** ——
   *  交差したままだと IntersectionObserver は二度目を通知しないので、
   *  1回足すごとに張り直して、画面が埋まるまで続けさせる */
  loadedCount: number,
  onMore: () => void
) {
  useEffect(() => {
    if (!active || !hasMore) return;
    const root = rootRef.current;
    const target = sentinelRef.current;
    if (!root || !target) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMore();
      },
      // 末尾に着く前に足す。スクロールが止まって見えないようにするため
      { root, rootMargin: '600px' }
    );
    io.observe(target);
    return () => io.disconnect();
  }, [rootRef, sentinelRef, active, hasMore, loadedCount, onMore]);
}
