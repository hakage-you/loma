import React from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Image as ImageIcon, RefreshCw, X } from 'lucide-react';
import { MediaItem, TagItem } from '../../types';
import { useTranslation } from '../../contexts/I18nContext';
import { TagPreviewCard } from './TagThumbs';

const VIDEO_EXT = /\.(mp4|webm|mov|avi|mkv|flv|wmv)$/i;

interface ListProps {
  /** どのタグの中身を見ているか。null なら出さない */
  tag: TagItem | null;
  media: MediaItem[];
  loading: boolean;
  onClose: () => void;
  onSelect: (media: MediaItem) => void;
}

/**
 * そのタグが付いているメディアの一覧。
 *
 * **タグ名だけでは何に付いているか分からない。** 統合してよいかの判断は
 * 中身を見ないとできないので、一覧から開けるようにしてある。
 */
export const TagMediaListModal: React.FC<ListProps> = ({
  tag,
  media,
  loading,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation();
  if (!tag) return null;

  return (
    <div className="fixed inset-0 z-60 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="p-4 bg-slate-950 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4 text-indigo-400" />
            <h3 className="text-xs font-bold text-white">
              {t('tag_modal.label_preview_title', 'Media with this tag')}{' '}
              <span className="text-indigo-300 font-mono">#{tag.name}</span>
              {tag.name_ja && <span className="text-slate-400 ml-1">({tag.name_ja})</span>}
              <span className="text-indigo-400 ml-1">
                ({tag.count ?? 0}
                {t('tag_modal.label_tag_count_unit', '')})
              </span>
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-400 text-xs">
              <RefreshCw className="w-4 h-4 animate-spin mr-2 text-indigo-400" />
              {t('tag_modal.label_preview_loading', 'Loading...')}
            </div>
          ) : media.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              {t('tag_modal.preview_empty', 'No media currently carries this tag.')}
            </div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {media.map((item) => (
                <TagPreviewCard key={item.id} media={item} onClick={() => onSelect(item)} />
              ))}
            </div>
          )}
        </div>

        <div className="p-3 bg-slate-950 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-semibold transition cursor-pointer"
          >
            {t('tag_modal.label_btn_close_preview', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface OverlayProps {
  /** 拡大して見るメディア。null なら出さない */
  media: MediaItem | null;
  onClose: () => void;
}

/** 1件を大きく見る／動画を再生する。背景のどこを押しても閉じる */
export const MediaPreviewOverlay: React.FC<OverlayProps> = ({ media, onClose }) => {
  const { t } = useTranslation();
  if (!media) return null;

  const fileName = media.file_path.split(/[/\\]/).pop();

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-md flex items-center justify-center p-4 cursor-pointer animate-in fade-in duration-150 select-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative max-w-[90vw] max-h-[90vh] flex flex-col items-center justify-center"
      >
        {VIDEO_EXT.test(media.file_path) ? (
          <video
            src={convertFileSrc(media.file_path)}
            controls
            autoPlay
            className="max-w-full max-h-[80vh] rounded-2xl shadow-2xl border border-white/10"
          />
        ) : (
          <img
            src={
              media.thumbnail_path
                ? convertFileSrc(media.thumbnail_path)
                : convertFileSrc(media.file_path)
            }
            alt={fileName}
            className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-2xl border border-white/10"
            onError={(e) => {
              // サムネが壊れている・まだ無いときは元のファイルを直接出す
              (e.target as HTMLImageElement).src = convertFileSrc(media.file_path);
            }}
          />
        )}
        <div className="mt-3 flex items-center gap-3">
          <span className="text-xs text-slate-300 font-mono bg-slate-900/80 px-3 py-1 rounded-lg border border-white/10 truncate max-w-md">
            {fileName}
          </span>
          <button
            onClick={onClose}
            className="text-xs text-slate-300 hover:text-white bg-slate-800 px-3 py-1 rounded-lg border border-white/10 transition cursor-pointer"
          >
            {t('tag_modal.label_btn_close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};
