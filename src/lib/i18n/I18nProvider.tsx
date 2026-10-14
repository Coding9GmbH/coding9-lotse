'use client';

// UI language on the client. The server renders with the same language (cookie/Accept-Language),
// switching sets the cookie and reloads the server parts: no flicker, no second render.
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

/** Language, dictionary and switcher. Outside the provider (tests, isolated parts): default language. */
export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  return ctx ?? { locale: 'de', t: messages('de'), setLocale: () => {} };
}

/** Shorthand for components that only need texts. */
export const useT = (): Messages => useI18n().t;
export const useLocale = (): Locale => useI18n().locale;
