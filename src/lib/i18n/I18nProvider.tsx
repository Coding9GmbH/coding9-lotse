'use client';

// Sprache der Oberfläche im Client. Der Server rendert mit derselben Sprache (Cookie/Accept-Language),
// ein Wechsel setzt das Cookie und lädt die Server-Teile neu – kein Springen, kein zweites Rendern.
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { LOCALE_COOKIE, type Locale } from './locales';
import { messages, type Messages } from './index';

interface I18n { locale: Locale; t: Messages; setLocale: (l: Locale) => void }

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ locale: initial, children }: { locale: Locale; children: React.ReactNode }) {
  const router = useRouter();
  const [locale, setState] = useState<Locale>(initial);
  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l;
    setState(l);
    router.refresh();
  }, [router]);
  const value = useMemo(() => ({ locale, t: messages(locale), setLocale }), [locale, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Sprache, Wörterbuch und Umschalter. Außerhalb des Providers (Tests, isolierte Teile): Standardsprache. */
export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  return ctx ?? { locale: 'de', t: messages('de'), setLocale: () => {} };
}

/** Kurzform für Komponenten, die nur Texte brauchen. */
export const useT = (): Messages => useI18n().t;
export const useLocale = (): Locale => useI18n().locale;
