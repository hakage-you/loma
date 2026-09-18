import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useTranslation } from '../contexts/I18nContext';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface ErrorModalProps {
  open: boolean;
  /** バックエンドから返った生のエラー。翻訳しない */
  message: string;
  /** 「〜に失敗しました」の見出し。**文言の解決はここで行う** —— useMedia は Provider の外でも呼ばれる */
  messageKey?: string;
  /** Ollama 由来と見られるとき、対処の案内を足す */
  ollamaHint?: boolean;
  onClose: () => void;
}

export const ErrorModal: React.FC<ErrorModalProps> = ({
  open,
  message,
  messageKey,
  ollamaHint,
  onClose,
}) => {
  const { t } = useTranslation();
  useEscapeToClose({ open, onClose });
  if (!open) return null;

  const body = [
    messageKey ? t(messageKey, '') : '',
    message,
    // マーカーは Rust 側と同じ文字列。翻訳するのは後ろの案内文だけ
    ollamaHint ? `💡【対処のご案内】\n${t('errors.ollama_notice', '')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="glass-panel w-full max-w-md p-6 rounded-2xl shadow-2xl border border-red-500/30 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-red-500/10 text-red-400 rounded-xl border border-red-500/20">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-white">{t('errors.label_title', 'Notice / Error')}</h3>
              <p className="text-sm text-slate-400">{t('errors.label_subtitle', 'An issue occurred')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="mt-4 p-3 bg-slate-950/60 rounded-xl text-sm text-slate-300 font-mono break-all max-h-60 overflow-y-auto border border-white/5 whitespace-pre-wrap leading-relaxed">
          {body}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white rounded-xl text-sm font-medium transition shadow-lg shadow-red-900/20 cursor-pointer"
          >
            {t('errors.label_btn_close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};
