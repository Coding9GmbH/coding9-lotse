// Anzeige-Texte für den Shop-Check (Startseite und Werkzeug), ohne DOM.
import { DEFAULT_LOCALE, INTL_LOCALE, messages, type Locale } from './i18n';
import type { CheckFinding, CheckRun } from './protocol';

/** „7 Punkte, 3 davon wichtig“ */
export function summaryText(findings: CheckFinding[], locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).lib.shopcheck;
  if (!findings.length) return t.allGood;
  const n = findings.length, hi = findings.filter(f => f.severity === 'hoch').length;
  const head = t.points(String(n), n);
  if (!hi) return head;
  return n === 1 ? t.oneImportant(head) : hi === n ? t.allImportant(head) : t.someImportant(head, hi);
}

/** „34 von 120 Produkten“, „mindestens 34 von 12.000 Produkten“ (gedeckelt), „3 betroffen“ */
export function countText(f: Pick<CheckFinding, 'count' | 'total' | 'unit' | 'atLeast'>, locale: Locale = DEFAULT_LOCALE): string {
  const n = (x: number) => x.toLocaleString(INTL_LOCALE[locale]), t = messages(locale).lib.shopcheck;
  const pre = f.atLeast ? t.atLeast : '';
  if (f.total == null) return `${pre}${t.affected(n(f.count))}`;
  return `${pre}${t.ofTotal(n(f.count), n(f.total))}${f.unit ? ` ${f.unit}` : ''}`;
}

export const SEVERITY_LABEL: Record<CheckFinding['severity'], string> = messages(DEFAULT_LOCALE).lib.shopcheck.severity;
export const severityLabel = (severity: CheckFinding['severity'], locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.shopcheck.severity[severity];

/** Zustand eines Durchlaufs: „unvollständig“, sobald mindestens die Hälfte der Prüfungen scheiterte (z. B. Shop nicht erreichbar).
 *  Dann gibt es weder „Alles im grünen Bereich“ noch 6 Std. Ruhe. */
export function runHealth(r: Pick<CheckRun, 'errors' | 'checks'>): 'ok' | 'teilweise' | 'unvollstaendig' {
  const failed = r.errors.length, checks = r.checks ?? 0;
  if (!failed) return 'ok';
  return !checks || failed * 2 >= checks ? 'unvollstaendig' : 'teilweise';
}

/** Befunde nach Bereich gruppieren; Reihenfolge der Bereiche = wichtigster Befund zuerst (Liste ist schon sortiert). */
export function groupByArea<T extends Pick<CheckFinding, 'area'>>(list: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const f of list) m.set(f.area, [...(m.get(f.area) ?? []), f]);
  return [...m.entries()];
}

/** Startseite: Reiter je Bereich (nur, wenn es mehr als einen gibt), gewählter Bereich und die sichtbaren Befunde.
 *  Ein Bereich, den es im neuen Durchlauf nicht mehr gibt, fällt auf „Alle“ zurück. */
export function findingsView<T extends Pick<CheckFinding, 'area'>>(findings: T[], area: string | null, all: boolean, limit: number) {
  const tabs = groupByArea(findings).map(([name, l]) => ({ area: name, count: l.length }));
  const active = area && tabs.some(t => t.area === area) ? area : null;
  const inArea = active ? findings.filter(f => f.area === active) : findings;
  return { tabs: tabs.length > 1 ? tabs : [], area: active, total: inArea.length, shown: all ? inArea : inArea.slice(0, limit), more: inArea.length > limit };
}
