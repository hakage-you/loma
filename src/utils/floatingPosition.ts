/**
 * ホバーで出す浮遊要素の位置決め。
 *
 * **「上に出す」「右に出す」を決め打ちしない。** 置き場所が変わるたびに切れる。
 * 対象の矩形と自分の実寸から、ビューポートに収まる位置を出す。
 *
 * 呼ぶ側は必ず `document.body` へ portal すること。祖先に `overflow: hidden` や
 * `backdrop-filter` があると、位置が正しくても、はみ出したぶんは描画されない。
 */

/** 画面の端との余白 */
const MARGIN = 8;
/** 対象と浮遊要素の間隔 */
const GAP = 8;

export interface FloatingPlacement {
  left: number;
  top: number;
  /** 対象の下に出したか。矢印の向きに使う */
  below: boolean;
  /** 浮遊要素の左端から見た矢印の位置。寄せたぶん対象の中心からズレる */
  arrowLeft: number;
  /** 上下が足りないときの詰め先。これを超える本文はスクロールさせる */
  maxHeight: number;
}

/**
 * @param anchor 対象の矩形（`getBoundingClientRect()`）
 * @param size   浮遊要素の実寸。測ってから渡す
 * @param align  左右の**希望**。入りきらなければ画面内へ寄せるので保証ではない
 */
export function placeFloating(
  anchor: DOMRect,
  size: { width: number; height: number },
  align: 'left' | 'center' | 'right' = 'left'
): FloatingPlacement {
  const { width: w, height: h } = size;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 上下。入るほうを選び、どちらにも入らなければ広いほうに出して高さを詰める
  const spaceAbove = anchor.top - GAP - MARGIN;
  const spaceBelow = vh - anchor.bottom - GAP - MARGIN;
  const below = h > spaceAbove && spaceBelow > spaceAbove;
  const maxHeight = Math.max(64, below ? spaceBelow : spaceAbove);
  const top = below
    ? anchor.bottom + GAP
    : Math.max(MARGIN, anchor.top - GAP - Math.min(h, maxHeight));

  // 左右。希望の位置から、はみ出すぶんだけ画面内へ寄せる
  const desired =
    align === 'right'
      ? anchor.right - w
      : align === 'center'
      ? anchor.left + anchor.width / 2 - w / 2
      : anchor.left;
  const left = Math.min(Math.max(MARGIN, desired), Math.max(MARGIN, vw - w - MARGIN));

  // 矢印は対象の中心を指す。ただし浮遊要素の外には出さない
  const arrowLeft = Math.min(
    Math.max(10, anchor.left + anchor.width / 2 - left),
    Math.max(10, w - 10)
  );

  return { left, top, below, arrowLeft, maxHeight };
}
