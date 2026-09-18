import { useEffect, useRef } from 'react';

/**
 * Esc キーでモーダルを閉じる。
 *
 * **一番手前の層だけが反応する。** モーダルの上にモーダルが乗っているとき
 * （タグ管理の上の画像プレビュー、詳細モーダルの上のスペクトラム探索など）に
 * 両方が閉じてしまわないよう、開いている順に積んで最後の1つだけが受け取る。
 *
 * **入力途中の内容があるときは確認してから閉じる。** 何を「途中」とみなすかは
 * 画面ごとに違うので、判定は呼び出し側が `isDirty` で渡す。
 * 確認の文言も呼び出し側が渡す（`t()` はコンポーネントの中でしか呼べないため）。
 *
 * `onEscapeFirst` は、モーダルの中にさらに確認パネルが開いているときに使う。
 * `true` を返すとそこで止まり、モーダルは閉じない（パネルだけ閉じる）。
 */
interface EscapeOptions {
  open: boolean;
  onClose: () => void;
  /** 入力途中の内容があるか。`true` のときだけ `confirm` を呼ぶ */
  isDirty?: () => boolean;
  /**
   * 閉じてよいかを尋ねる。`false` を返すと閉じない。
   * 未指定なら `isDirty` が `true` でもそのまま閉じる。
   */
  confirm?: () => Promise<boolean>;
  /**
   * モーダル本体より先に Esc を受け取る層。`true` を返すと本体は閉じない。
   * 確認パネルが開いているときに、パネルだけ閉じるために使う。
   */
  onEscapeFirst?: () => boolean;
}

/**
 * 開いている層の積み重ね。**React の外に置く。**
 * どのモーダルが一番手前かは、個々のコンポーネントからは分からない。
 */
const stack: symbol[] = [];

export function useEscapeToClose(options: EscapeOptions): void {
  const idRef = useRef<symbol>(Symbol('modal'));
  // 毎回の描画で作り直される関数を購読し直さなくて済むよう、最新版を持っておく
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!options.open) return;
    const id = idRef.current;
    stack.push(id);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // 一番手前の層でなければ何もしない
      if (stack[stack.length - 1] !== id) return;
      // IME の変換中は Esc が変換の取り消しに使われる。**そちらを優先する**
      if (event.isComposing) return;

      const current = latest.current;
      if (current.onEscapeFirst?.()) {
        event.preventDefault();
        return;
      }

      event.preventDefault();
      if (current.isDirty?.() && current.confirm) {
        void current.confirm().then((ok) => {
          if (ok) current.onClose();
        });
        return;
      }
      current.onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const at = stack.lastIndexOf(id);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [options.open]);
}
