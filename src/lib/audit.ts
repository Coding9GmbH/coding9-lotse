import { DEFAULT_LOCALE, messages, type Locale } from './i18n';
import type { AuditCheck, DraftAudit } from './protocol';

// Quality check: normalize check items. Depending on its version, the server returns
// { area, w, msg } (legacy) or { label, weight, level } (contract); both are understood.

export type AuditArea = 'SEO' | 'CRO' | 'UX' | 'other';
export interface AuditRow { area: AuditArea; ok: boolean; important: boolean; text: string; hint?: string }

export const AREA_LABEL: Record<AuditArea, string> = messages(DEFAULT_LOCALE).lib.auditArea;
export const areaLabel = (area: AuditArea, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.auditArea[area];

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function normalizeCheck(c: AuditCheck): AuditRow {
  const a = str(c.area)?.toUpperCase();
  const area: AuditArea = a === 'SEO' || a === 'CRO' || a === 'UX' ? a : 'other';
  const weight = num(c.weight) ?? num(c.w) ?? 0;
  return { area, ok: !!c.ok, important: c.level === 'wichtig' || weight >= 3, text: str(c.label) ?? str(c.msg) ?? '', hint: c.ok ? undefined : str(c.hint) };
}

export function groupAudit(a: DraftAudit): { area: AuditArea; rows: AuditRow[] }[] {
  const rows = (a.checks ?? []).map(normalizeCheck);
  return (['SEO', 'CRO', 'UX', 'other'] as const).map(area => ({ area, rows: rows.filter(r => r.area === area) })).filter(g => g.rows.length);
}

export const scoreClass = (score: number): 'hi' | 'mid' | 'lo' => (score >= 85 ? 'hi' : score >= 65 ? 'mid' : 'lo');
