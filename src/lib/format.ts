// Small, pure helpers for display texts (also run on the server, without DOM).

import { DEFAULT_LOCALE, INTL_LOCALE, messages, type Locale } from './i18n';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape HTML special characters (for the few places that produce HTML strings). */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** "vor 5 Min." · "vor 3 Std." · date, as in the previous UI. */
export function ago(iso: string, now: number = Date.now(), locale: Locale = DEFAULT_LOCALE): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.round((now - t) / 60000), c = messages(locale).common;
  if (m < 1) return c.justNow;
  if (m < 60) return c.minutesAgo(m);
  if (m < 1440) return c.hoursAgo(Math.round(m / 60));
  return new Date(iso).toLocaleDateString(INTL_LOCALE[locale]);
}

/** Date + time for logs. */
export function dateTime(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(INTL_LOCALE[locale], { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** Hex colors (#rgb/#rrggbb) from a color object, at most n. */
export function swatches(colors: Record<string, string | undefined> | undefined, n: number): string[] {
  const hex = Object.values(colors ?? {}).filter((v): v is string => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v));
  return [...new Set(hex.map(v => v.toUpperCase()))].slice(0, n); // same color only once
}

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Bulk card: the visible rows are a sample, the approval applies to the checked groups. */
export const sampleSummary = (shown: number, total: number, locale: Locale = DEFAULT_LOCALE): string => {
  const fmt = (n: number) => n.toLocaleString(INTL_LOCALE[locale]);
  return messages(locale).common.sampleSummary(fmt(shown), fmt(total));
};

/** Group history by day: today · yesterday · last 7 days · older (empty groups are dropped, order is kept). */
export function groupByDay<T extends { updatedAt: string }>(items: T[], now: Date = new Date(), locale: Locale = DEFAULT_LOCALE): { label: string; items: T[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), day = 86_400_000, c = messages(locale).common;
  const groups = [{ label: c.today, from: start }, { label: c.yesterday, from: start - day }, { label: c.last7Days, from: start - 6 * day }, { label: c.older, from: -Infinity }]
    .map(g => ({ ...g, items: [] as T[] }));
  for (const it of items) {
    const t = new Date(it.updatedAt).getTime();
    (groups.find(g => (Number.isNaN(t) ? g.from === -Infinity : t >= g.from)) ?? groups[3]).items.push(it);
  }
  return groups.filter(g => g.items.length).map(({ label, items: list }) => ({ label, items: list }));
}
