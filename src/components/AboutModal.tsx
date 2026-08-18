import React from 'react';
import { X, ExternalLink, Sparkles, Github, Twitter } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useTranslation } from '../contexts/I18nContext';

interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

export const AboutModal: React.FC<AboutModalProps> = ({ open, onClose }) => {
  const { t } = useTranslation();

  if (!open) return null;

  const handleOpenLink = async (url: string) => {
    try {
      await openUrl(url);
    } catch (e) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-slate-900 border border-indigo-500/30 rounded-2xl shadow-2xl overflow-hidden p-6 space-y-6 animate-in zoom-in-95 duration-150 text-slate-200 select-none">
        {/* Header Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* App Title Header */}
        <div className="flex flex-col items-center text-center space-y-3 pt-2">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-tr from-indigo-600 via-violet-600 to-purple-500 p-0.5 shadow-xl shadow-indigo-900/40 flex items-center justify-center">
            <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center">
              <Sparkles className="w-8 h-8 text-indigo-400 animate-pulse" />
            </div>
          </div>

          <div className="space-y-1">
            <h2 className="text-xl font-bold text-white tracking-wide">Loma</h2>
            <p className="text-xs text-indigo-300 font-medium">Local Ollama Media Analyzer</p>
            <div className="inline-block px-2.5 py-0.5 bg-indigo-600/30 text-indigo-200 border border-indigo-500/40 rounded-full text-[11px] font-mono font-semibold mt-1">
              v{__APP_VERSION__}
            </div>
          </div>
        </div>

        {/* Informational Details */}
        <div className="bg-slate-950/70 rounded-xl p-4 border border-white/10 space-y-3 text-xs">
          <div className="flex justify-between items-center pb-2 border-b border-white/5">
            <span className="text-slate-400">{t('about.label_author', 'Author')}:</span>
            <span className="font-semibold text-white">@hakage-you</span>
          </div>

          <div className="flex justify-between items-center">
            <span className="text-slate-400">{t('about.label_copyright', 'Copyright')}:</span>
            <span className="font-mono text-slate-300">©2026 hakage-you</span>
          </div>
        </div>

        {/* Links */}
        <div className="space-y-2">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            {t('about.label_links', 'Official Links')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => handleOpenLink('https://x.com/hakage_you')}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-xl border border-white/10 text-xs font-medium transition cursor-pointer"
            >
              <Twitter className="w-3.5 h-3.5 text-sky-400" />
              <span>X (@hakage_you)</span>
              <ExternalLink className="w-3 h-3 text-slate-400 ml-auto" />
            </button>

            <button
              onClick={() => handleOpenLink('https://github.com/hakage-you/loma')}
              className="flex items-center justify-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-xl border border-white/10 text-xs font-medium transition cursor-pointer"
            >
              <Github className="w-3.5 h-3.5 text-purple-400" />
              <span>GitHub Repo</span>
              <ExternalLink className="w-3 h-3 text-slate-400 ml-auto" />
            </button>
          </div>
        </div>

        {/* Footer Close */}
        <div className="pt-2 text-center">
          <button
            onClick={onClose}
            className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-semibold text-xs transition cursor-pointer shadow-lg shadow-indigo-900/30"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
