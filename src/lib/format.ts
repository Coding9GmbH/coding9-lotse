// Kleine, reine Hilfsfunktionen für Anzeige-Texte (auch auf dem Server lauffähig, ohne DOM).

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-Sonderzeichen maskieren (für die wenigen Stellen, die HTML-Strings erzeugen). */
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

/** „vor 5 Min.“ · „vor 3 Std.“ · Datum – wie in der bisherigen Oberfläche. */
export function ago(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  if (m < 1440) return `vor ${Math.round(m / 60)} Std.`;
  return new Date(iso).toLocaleDateString('de-DE');
}

/** Datum + Uhrzeit für Protokolle. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** Hex-Farben (#rgb/#rrggbb) aus einem Farbobjekt, max. n Stück. */
export function swatches(colors: Record<string, string | undefined> | undefined, n: number): string[] {
  const hex = Object.values(colors ?? {}).filter((v): v is string => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v));
  return [...new Set(hex.map(v => v.toUpperCase()))].slice(0, n); // gleiche Farbe nur einmal
}

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Verlauf nach Tagen gruppieren: Heute · Gestern · Letzte 7 Tage · Älter (leere Gruppen entfallen, Reihenfolge bleibt). */
export function groupByDay<T extends { updatedAt: string }>(items: T[], now: Date = new Date()): { label: string; items: T[] }[] {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), day = 86_400_000;
  const groups = [{ label: 'Heute', from: start }, { label: 'Gestern', from: start - day }, { label: 'Letzte 7 Tage', from: start - 6 * day }, { label: 'Älter', from: -Infinity }]
    .map(g => ({ ...g, items: [] as T[] }));
  for (const it of items) {
    const t = new Date(it.updatedAt).getTime();
    (groups.find(g => (Number.isNaN(t) ? g.from === -Infinity : t >= g.from)) ?? groups[3]).items.push(it);
  }
  return groups.filter(g => g.items.length).map(({ label, items: list }) => ({ label, items: list }));
}
