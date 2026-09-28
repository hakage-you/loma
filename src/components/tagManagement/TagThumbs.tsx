import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AlertCircle, Film } from 'lucide-react';
import { MediaItem } from '../../types';
import { useTranslation } from '../../contexts/I18nContext';
import { placeFloating, FloatingPlacement } from '../../utils/floatingPosition';

/**
 * 提案カードのサンプルサムネと、ホバー時の拡大表示。
 *
 * **ホバーの状態をここに閉じ込めるためだけに切り出してある。**
 * モーダル直下に持つと、サムネの上をマウスが通るたびにモーダル全体が再描画される。
 *
 * 拡大表示は `document.body` へ portal する。モーダルの内側は
 * `backdrop-blur` と `zoom-in-95` が position:fixed の基準を作るため、
 * その場に置くとスクロール領域で切られる。
 */
/** 拡大表示の一辺。位置決めに実寸が要るので定数で持つ */
const THUMB_PREVIEW_SIZE = 128;

export const SampleThumbStack: React.FC<{
  thumbnails: string[];
  totalImagesCount?: number;
}> = ({ thumbnails, totalImagesCount }) => {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<{ src: string; pos: FloatingPlacement } | null>(null);

  return (
    <div className="flex items-center gap-1 shrink-0 ml-1">
      <div
        className="flex items-center -space-x-2 p-0.5"
        title={t('tag_modal.label_title_sample_media', 'Group sample media')}
      >
        {thumbnails.slice(0, 5).map((thumbPath, idx) => (
          <img
            key={idx}
            src={convertFileSrc(thumbPath)}
            alt="sample"
            width={28}
            height={28}
            loading="lazy"
            decoding="async"
            className="w-7 h-7 rounded-md object-cover border-2 border-slate-900 shadow-md cursor-pointer transition-transform hover:scale-110 relative"
            onMouseEnter={(e) => {
              setHovered({
                src: convertFileSrc(thumbPath),
                // 端のサムネでも切れないよう、位置はツールチップと同じ関数で出す
                pos: placeFloating(
                  e.currentTarget.getBoundingClientRect(),
                  { width: THUMB_PREVIEW_SIZE, height: THUMB_PREVIEW_SIZE },
                  'center'
                ),
              });
            }}
            onMouseLeave={() => setHovered(null)}
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        ))}
      </div>

      {/* 最大枚数以上の画像がある場合の「続きあり (+N / ...)」インジケーター */}
      {totalImagesCount !== undefined && totalImagesCount > thumbnails.length && (
        <span
          className="px-1.5 py-0.5 bg-slate-800/90 text-slate-300 border border-white/10 rounded-md text-[10px] font-mono font-bold tracking-tight shrink-0 shadow-sm"
          title={`${t('tag_modal.label_title_total_media', 'Media with this tag')}: ${totalImagesCount}${t(
            'tag_modal.label_tag_count_unit',
            ''
          )}`}
        >
          +{totalImagesCount - thumbnails.length}…
        </span>
      )}

      {hovered &&
        createPortal(
          <div
            style={{ left: `${hovered.pos.left}px`, top: `${hovered.pos.top}px` }}
            className="fixed w-32 h-32 rounded-2xl overflow-hidden border-2 border-indigo-500 bg-slate-950 shadow-2xl z-[120] pointer-events-none animate-in fade-in zoom-in-95 duration-100 flex items-center justify-center select-none"
          >
            <img src={hovered.src} alt="floating preview" className="w-full h-full object-cover" />
          </div>,
          document.body
        )}
    </div>
  );
};

export const TagPreviewCard: React.FC<{
  media: MediaItem;
  onClick: () => void;
}> = ({ media, onClick }) => {
  const { t } = useTranslation();
  const isVideo = /\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i.test(media.file_path);
  const primarySrc = media.thumbnail_path
    ? convertFileSrc(media.thumbnail_path)
    : isVideo
    ? ''
    : convertFileSrc(media.file_path);
  const fallbackSrc = isVideo ? '' : convertFileSrc(media.file_path);

  const [imgSrc, setImgSrc] = useState<string>(primarySrc);
  const [hasError, setHasError] = useState<boolean>(!primarySrc);

  const handleImgError = () => {
    if (imgSrc === primarySrc && fallbackSrc && fallbackSrc !== primarySrc) {
      setImgSrc(fallbackSrc);
    } else {
      setHasError(true);
    }
  };

  const fileName = media.file_path.split(/[/\\]/).pop() || '';

  return (
    <div
      onClick={onClick}
      className="group relative bg-slate-950 border border-white/10 rounded-xl overflow-hidden shadow aspect-square flex flex-col items-center justify-center cursor-pointer transition hover:border-indigo-500/50 select-none"
      title={fileName}
    >
      {!hasError && imgSrc ? (
        <img
          src={imgSrc}
          alt={fileName}
          onError={handleImgError}
          className="w-full h-full object-cover group-hover:scale-105 transition duration-200"
          loading="lazy"
        />
      ) : (
        <div className="flex flex-col items-center justify-center p-2 text-center gap-1.5 w-full h-full bg-slate-900/90 text-slate-400">
          {isVideo ? (
            <Film className="w-7 h-7 text-indigo-400 opacity-80" />
          ) : (
            <AlertCircle className="w-6 h-6 text-amber-400/80" />
          )}
          <span className="text-[10px] font-mono text-slate-300 truncate max-w-full px-1">{fileName}</span>
          <span className="text-[9px] text-indigo-300 font-semibold">{isVideo ? t('tag_modal.label_video_file', 'Video') : t('tag_modal.label_image_file', 'Image')}</span>
        </div>
      )}

      {/* Video Badge */}
      {isVideo && !hasError && (
        <div className="absolute top-2 left-2 z-10 px-1.5 py-0.5 bg-slate-950/80 backdrop-blur-md border border-white/20 text-indigo-300 rounded-md text-[9px] font-bold flex items-center gap-1">
          <Film className="w-3 h-3 text-indigo-400" />
          <span>VIDEO</span>
        </div>
      )}

      {/* Hover Overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition p-2 flex flex-col justify-end pointer-events-none">
        <p className="text-[10px] text-white font-medium truncate">{fileName}</p>
        <p className="text-[9px] text-indigo-300 font-semibold">{isVideo ? t('tag_modal.label_click_play', 'Click to play') : t('tag_modal.label_click_zoom', 'Click to enlarge')}</p>
      </div>
    </div>
  );
};
