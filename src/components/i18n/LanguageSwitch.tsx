'use client';

import { LOCALES, LOCALE_NAMES } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { Segmented } from '@/components/ui/Segmented';

/** Sprachwahl (Oberfläche + KI-Antworten); speichert im Cookie, gilt sofort. */
export function LanguageSwitch({ className }: { className?: string }) {
  const { locale, t, setLocale } = useI18n();
  return (
    <Segmented className={className} label={t.common.language} value={locale} onChange={setLocale}
      options={LOCALES.map(l => ({ value: l, label: l.toUpperCase(), title: LOCALE_NAMES[l] }))} />
  );
}
