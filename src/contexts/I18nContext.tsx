import React, { createContext, useContext, useState, useEffect } from 'react';
// ロケールは名前空間ごとに1ファイル（`locales/<lang>/<namespace>.json`）。
// **ファイル名がそのまま名前空間になる**ので、`t('settings.label_title')` の
// 呼び方は分割前と変わらない。1ファイルに全部入れると、画面が増えるたびに
// 同じファイルで衝突する
const collect = (mods: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [path, mod] of Object.entries(mods)) {
    const ns = path.split('/').pop()!.replace(/\.json$/, '');
    out[ns] = (mod as { default?: unknown }).default ?? mod;
  }
  return out;
};

const jaDict = collect(import.meta.glob('../locales/ja/*.json', { eager: true }));
const enDict = collect(import.meta.glob('../locales/en/*.json', { eager: true }));

export type Language = 'ja' | 'en';

type Dictionaries = Record<string, any>;

const dicts: Record<Language, Dictionaries> = {
  ja: jaDict,
  en: enDict,
};

interface I18nContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  /**
   * `vars` を渡すと本文中の `{名前}` を置き換える。
   * 「3件を統合しました」のような文を、語順の違う言語でも1つの文言として持てる
   * （断片を JSX で連結すると英語で語順が崩れる）。
   */
  t: (keyPath: string, defaultText?: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextType | undefined>(undefined);

export const I18nProvider: React.FC<{ children: React.ReactNode; initialLanguage?: Language; onLanguageChange?: (lang: Language) => void }> = ({
  children,
  initialLanguage = 'ja',
  onLanguageChange,
}) => {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    setLanguageState(initialLanguage);
  }, [initialLanguage]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
    if (onLanguageChange) {
      onLanguageChange(lang);
    }
  };

  /** 本文中の `{名前}` を差し替える。渡されなかった名前はそのまま残す */
  const fill = (text: string, vars?: Record<string, string | number>): string => {
    if (!vars) return text;
    let out = text;
    for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
    return out;
  };

  const t = (
    keyPath: string,
    defaultText?: string,
    vars?: Record<string, string | number>
  ): string => {
    const keys = keyPath.split('.');
    let current: any = dicts[language] || dicts.ja;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        // フォールバック: ja辞書で再検索
        let fb: any = dicts.ja;
        for (const k of keys) {
          if (fb && typeof fb === 'object' && k in fb) {
            fb = fb[k];
          } else {
            return fill(defaultText || keyPath, vars);
          }
        }
        return fill(typeof fb === 'string' ? fb : defaultText || keyPath, vars);
      }
    }
    return fill(typeof current === 'string' ? current : defaultText || keyPath, vars);
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useTranslation = () => {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error('useTranslation must be used within an I18nProvider');
  }
  return context;
};
