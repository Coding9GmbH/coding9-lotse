// Custom shop checks (declarative, platform-neutral): conditions over neutral product fields, without code.
// Pure (server, UI, tests). Stored locally (server/custom-checks.ts), evaluated per platform via scanProducts.
import { DEFAULT_LOCALE, INTL_LOCALE, messages, type Locale } from './i18n';
import type { CheckSeverity } from './protocol';

/** Neutral view of an active product, the same for Shopware, Shopify, Magento and OpenMage. null = not readable on this platform. */
export interface NeutralProduct {
  id: string; label: string;
  name: string; description: string; metaTitle: string; metaDescription: string;
  price: number | null; listPrice: number | null; stock: number | null; hasImage: boolean | null;
}

/** Result of platform.scanProducts: active products (up to a cap), total = all active, capped = catalog larger than what was read */
export interface NeutralScan { rows: NeutralProduct[]; total: number; capped: boolean }

export type FieldKind = 'number' | 'bool';
const FIELD_LABEL = messages(DEFAULT_LOCALE).lib.checks.fields;
/** Fields for conditions; label = German (AI, server), per language: checkFieldLabel(field, locale) */
export const CHECK_FIELDS = {
  descriptionWords: { label: FIELD_LABEL.descriptionWords, kind: 'number' },
  descriptionChars: { label: FIELD_LABEL.descriptionChars, kind: 'number' },
  metaTitleChars: { label: FIELD_LABEL.metaTitleChars, kind: 'number' },
  metaDescriptionChars: { label: FIELD_LABEL.metaDescriptionChars, kind: 'number' },
  nameChars: { label: FIELD_LABEL.nameChars, kind: 'number' },
  price: { label: FIELD_LABEL.price, kind: 'number' },
  listPrice: { label: FIELD_LABEL.listPrice, kind: 'number' },
  stock: { label: FIELD_LABEL.stock, kind: 'number' },
  hasImage: { label: FIELD_LABEL.hasImage, kind: 'bool' },
} as const satisfies Record<string, { label: string; kind: FieldKind }>;
export type CheckField = keyof typeof CHECK_FIELDS;
export const checkFieldLabel = (f: CheckField, locale: Locale = DEFAULT_LOCALE): string => messages(locale).lib.checks.fields[f];

export const CHECK_OPS = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', neq: '≠' } as const;
export type CheckOp = keyof typeof CHECK_OPS;

export interface CheckCondition { field: CheckField; op: CheckOp; value: number | boolean }
export interface CustomCheck {
  id: string; title: string; severity: CheckSeverity; area: string; hint?: string;
  /** all = every condition must match (and), any = at least one (or) */
  match: 'all' | 'any'; conditions: CheckCondition[]; createdAt: string;
}

export const CUSTOM_MAX = 20, CONDITIONS_MAX = 5, TITLE_MAX = 80, HINT_MAX = 300, AREA_MAX = 30;
export const CUSTOM_PREFIX = 'custom.';
const SEVERITIES: CheckSeverity[] = ['hoch', 'mittel', 'niedrig'];

const text = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
export const slugify = (t: string) => t.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Field value of a product; null = unknown (the condition then never matches, nothing is guessed) */
export function fieldValue(p: NeutralProduct, f: CheckField): number | boolean | null {
  switch (f) {
    case 'descriptionWords': { const t = text(p.description); return t ? t.split(' ').length : 0; }
    case 'descriptionChars': return text(p.description).length;
    case 'metaTitleChars': return p.metaTitle.trim().length;
    case 'metaDescriptionChars': return p.metaDescription.trim().length;
    case 'nameChars': return p.name.trim().length;
    case 'price': return p.price;
    case 'listPrice': return p.listPrice;
    case 'stock': return p.stock;
    case 'hasImage': return p.hasImage;
  }
}

function holds(v: number | boolean | null, c: CheckCondition): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return c.op === 'eq' ? v === c.value : c.op === 'neq' ? v !== c.value : false;
  const x = Number(c.value);
  switch (c.op) { case 'lt': return v < x; case 'lte': return v <= x; case 'gt': return v > x; case 'gte': return v >= x; case 'eq': return v === x; case 'neq': return v !== x; }
}

export const matches = (p: NeutralProduct, chk: Pick<CustomCheck, 'match' | 'conditions'>): boolean =>
  chk.conditions.length > 0 && (chk.match === 'any' ? chk.conditions.some(c => holds(fieldValue(p, c.field), c)) : chk.conditions.every(c => holds(fieldValue(p, c.field), c)));

export const conditionText = (c: CheckCondition, locale: Locale = DEFAULT_LOCALE): string => {
  const f = CHECK_FIELDS[c.field], t = messages(locale).lib.checks, label = t.fields[c.field];
  return f.kind === 'bool' ? `${label}: ${c.value === true ? t.yes : t.no}` : `${label} ${CHECK_OPS[c.op]} ${Number(c.value).toLocaleString(INTL_LOCALE[locale])}`;
};
export const conditionsText = (chk: Pick<CustomCheck, 'match' | 'conditions'>, locale: Locale = DEFAULT_LOCALE) => {
  const t = messages(locale).lib.checks;
  return chk.conditions.map(c => conditionText(c, locale)).join(chk.match === 'any' ? t.or : t.and);
};

/** Evaluation: count + examples with the triggering value, so the finding is traceable */
export function evaluate(rows: NeutralProduct[], chk: Pick<CustomCheck, 'match' | 'conditions'>, locale: Locale = DEFAULT_LOCALE) {
  const hits = rows.filter(p => matches(p, chk));
  const detail = (p: NeutralProduct) => {
    const c = chk.conditions[0], v = fieldValue(p, c.field);
    return v == null || typeof v === 'boolean' ? p.label : `${p.label}: ${checkFieldLabel(c.field, locale)} ${Number(v).toLocaleString(INTL_LOCALE[locale])}`;
  };
  return { count: hits.length, sample: hits.slice(0, 5).map(p => ({ id: p.id, label: detail(p) })) };
}

/** Validate and sanitize input (AI/UI); throws with an understandable message */
export function parseCheckInput(raw: unknown): Omit<CustomCheck, 'id' | 'createdAt'> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const title = String(r.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('Titel fehlt');
  if (title.length > TITLE_MAX) throw new Error(`Titel zu lang (max. ${TITLE_MAX} Zeichen)`);
  const severity = (SEVERITIES.includes(r.severity as CheckSeverity) ? r.severity : 'mittel') as CheckSeverity;
  const area = String(r.area ?? '').replace(/\s+/g, ' ').trim().slice(0, AREA_MAX) || 'Eigene Prüfungen';
  const hint = String(r.hint ?? '').replace(/\s+/g, ' ').trim().slice(0, HINT_MAX) || undefined;
  const match = r.match === 'any' ? 'any' : 'all';
  if (!Array.isArray(r.conditions) || !r.conditions.length) throw new Error('Mindestens eine Bedingung nötig');
  if (r.conditions.length > CONDITIONS_MAX) throw new Error(`Höchstens ${CONDITIONS_MAX} Bedingungen`);
  const conditions = r.conditions.map((c, i): CheckCondition => {
    const x = (c ?? {}) as Record<string, unknown>, field = x.field as CheckField, def = CHECK_FIELDS[field];
    if (!def) throw new Error(`Bedingung ${i + 1}: unbekanntes Feld „${String(x.field)}“ (erlaubt: ${Object.keys(CHECK_FIELDS).join(', ')})`);
    const op = (x.op ?? 'eq') as CheckOp;
    if (!(op in CHECK_OPS)) throw new Error(`Bedingung ${i + 1}: unbekannter Vergleich „${String(x.op)}“ (erlaubt: ${Object.keys(CHECK_OPS).join(', ')})`);
    if (def.kind === 'bool') {
      if (typeof x.value !== 'boolean') throw new Error(`Bedingung ${i + 1}: ${field} braucht true oder false`);
      if (op !== 'eq' && op !== 'neq') throw new Error(`Bedingung ${i + 1}: ${field} kennt nur eq oder neq`);
      return { field, op, value: x.value };
    }
    const n = typeof x.value === 'number' ? x.value : Number(x.value);
    if (x.value === null || x.value === '' || typeof x.value === 'boolean' || !Number.isFinite(n)) throw new Error(`Bedingung ${i + 1}: ${field} braucht eine Zahl`);
    return { field, op, value: n };
  });
  return { title, severity, area, ...(hint ? { hint } : {}), match, conditions };
}

// ---- Titles of the built-in checks (management list) ----
export function builtinTitle(id: string, locale: Locale = DEFAULT_LOCALE): string {
  const t = messages(locale).lib.checks, byId = t.byId as Record<string, string>;
  if (byId[id]) return byId[id];
  const suffix = id.split('.').slice(1).join('.');
  return (t.bySuffix as Record<string, string>)[suffix] ?? id;
}

/** Entry of the management list (GET /api/shopcheck/checks) */
export interface CheckListItem { id: string; title: string; area: string; enabled: boolean; custom: boolean; severity?: CheckSeverity; rule?: string }
