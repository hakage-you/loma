import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { BusyKind, useBusy } from '../hooks/useBusy';
import { useTranslation } from '../contexts/I18nContext';

/**
 * 見た目が出るまでの猶予。
 * タグ1件の追加のように短く終わる操作で暗転が一瞬走ると、かえって壊れて見える。
 * **入力の遮断は最初から効いている**（誤操作を止めるのが目的なので遅らせない）。
 */
const REVEAL_DELAY_MS = 200;

/**
 * 排他処理の実行中に画面全体を塞ぐ層。
 *
 * Rust 側で `try_acquire_task_lock` を取るコマンドは、走っている間ほかを必ず弾く。
 * 押せるのに必ず失敗するボタンを残さないため、UI 側も同じ範囲を塞ぐ。
 * 長時間のバックグラウンド解析はここでは塞がない（`useBusy` の `background`）。
 */
export const BusyOverlay: React.FC = () => {
  const { kind } = useBusy();
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!kind) {
      setRevealed(false);
      return;
    }
    const timer = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [kind]);

  if (!kind) return null;

  // 文言はここで解決する。useMedia は I18nProvider の外側でも呼ばれるため、
  // 呼び出し側は「何をしているか」しか渡せない
  const labels: Record<BusyKind, string> = {
    saving_settings: t('busy.label_saving_settings', '設定を保存しています'),
    editing_tags: t('busy.label_editing_tags', 'タグを更新しています'),
    applying_tag_merges: t('busy.label_applying_tag_merges', 'タグの統合を適用しています'),
    building_tag_suggestions: t('busy.label_building_tag_suggestions', 'タグの提案を作っています'),
    syncing_folders: t('busy.label_syncing_folders', 'フォルダを同期しています'),
    reanalyzing_media: t('busy.label_reanalyzing_media', 'メディアを再解析しています'),
    processing_embeddings: t('busy.label_processing_embeddings', 'ベクトルを処理しています'),
  };

  // 呼び出し位置は App の中だが、実体は body 直下に出す。
  // App の中身は排他処理の間 inert になるので、その内側に置くとこの層まで死ぬ
  return createPortal(
    <div
      className={`fixed inset-0 z-[400] flex items-center justify-center transition-colors duration-200 ${
        revealed ? 'bg-black/60 backdrop-blur-sm' : 'bg-transparent'
      }`}
      // 読み上げ環境にも「いま操作できない」ことを伝える
      role="alertdialog"
      aria-busy="true"
      aria-label={labels[kind]}
    >
      {revealed && (
        <div className="glass-panel flex items-center gap-3 px-5 py-4 rounded-2xl border border-white/10 shadow-2xl">
          <Loader2 className="w-5 h-5 animate-spin text-indigo-400 shrink-0" />
          <div>
            <div className="text-sm font-semibold text-white">{labels[kind]}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {t('busy.label_wait', '完了するまでお待ちください')}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
