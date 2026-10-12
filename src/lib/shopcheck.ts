// Anzeige-Texte für den Shop-Check (Startseite und Werkzeug), ohne DOM.
import type { CheckFinding, CheckRun } from './protocol';

/** „7 Punkte, 3 davon wichtig“ */
export function summaryText(findings: CheckFinding[]): string {
  if (!findings.length) return 'Alles im grünen Bereich';
  const n = findings.length, hi = findings.filter(f => f.severity === 'hoch').length;
  const head = `${n} ${n === 1 ? 'Punkt' : 'Punkte'}`;
  if (!hi) return head;
  return n === 1 ? `${head}, wichtig` : hi === n ? `${head}, alle wichtig` : `${head}, ${hi} davon wichtig`;
}

/** „34 von 120 Produkten“, „mindestens 34 von 12.000 Produkten“ (gedeckelt), „3 betroffen“ */
export function countText(f: Pick<CheckFinding, 'count' | 'total' | 'unit' | 'atLeast'>): string {
  const n = (x: number) => x.toLocaleString('de-DE');
  const pre = f.atLeast ? 'mindestens ' : '';
  if (f.total == null) return `${pre}${n(f.count)} betroffen`;
  return `${pre}${n(f.count)} von ${n(f.total)}${f.unit ? ` ${f.unit}` : ''}`;
}

export const SEVERITY_LABEL: Record<CheckFinding['severity'], string> = { hoch: 'Wichtig', mittel: 'Mittel', niedrig: 'Hinweis' };

/** Zustand eines Durchlaufs: „unvollständig“, sobald mindestens die Hälfte der Prüfungen scheiterte (z. B. Shop nicht erreichbar).
 *  Dann gibt es weder „Alles im grünen Bereich“ noch 6 Std. Ruhe. */
export function runHealth(r: Pick<CheckRun, 'errors' | 'checks'>): 'ok' | 'teilweise' | 'unvollstaendig' {
  const failed = r.errors.length, checks = r.checks ?? 0;
  if (!failed) return 'ok';
  return !checks || failed * 2 >= checks ? 'unvollstaendig' : 'teilweise';
}
