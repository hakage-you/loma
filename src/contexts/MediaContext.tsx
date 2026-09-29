import React, { createContext, useContext } from 'react';
import { useMedia, UseMediaResult } from '../hooks/useMedia';

/**
 * `useMedia` をアプリ全体で**1つだけ**にするための入れ物。
 *
 * **フックを2回呼ぶと、その回数だけ丸ごと複製される。**
 * `useMedia` は自前の state・`batch_progress` の購読・起動時の取得を抱えているので、
 * 2回呼べば購読が2本、起動時の取得も2組になる。
 * 以前は `App` が言語設定のためだけに呼び、`AppContent` が本体として呼んでいて、
 * 起動時の IPC がそのぶん倍になっていた（実測: get_media が3回、合計38本）。
 *
 * ここに1つ置いて、言語を読む側も本体も同じものを見る。
 */
const MediaContext = createContext<UseMediaResult | undefined>(undefined);

export const MediaProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useMedia();
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
};

export const useMediaContext = (): UseMediaResult => {
  const context = useContext(MediaContext);
  if (!context) {
    throw new Error('useMediaContext must be used within a MediaProvider');
  }
  return context;
};
