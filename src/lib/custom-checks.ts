// Eigene Shop-Prüfungen (deklarativ, plattform-neutral): Bedingungen über neutrale Produktfelder, ohne Code.
// Rein (Server, Oberfläche, Tests). Gespeichert wird lokal (server/custom-checks.ts), ausgewertet je Plattform über scanProducts.
import type { CheckSeverity } from './protocol';

/** Neutrale Sicht auf ein aktives Produkt, gleich für Shopware, Shopify, Magento und OpenMage. null = auf dieser Plattform nicht lesbar. */
export interface NeutralProduct {
  id: string; label: string;
  name: string; description: string; metaTitle: string; metaDescription: string;
  price: number | null; listPrice: number | null; stock: number | null; hasImage: boolean | null;
}

/** Ergebnis von platform.scanProducts: aktive Produkte (höchstens ein Deckel), total = alle aktiven, capped = Katalog größer als gelesen */
export interface NeutralScan { rows: NeutralProduct[]; total: number; capped: boolean }

export type FieldKind = 'number' | 'bool';
export const CHECK_FIELDS = {
  descriptionWords: { label: 'Wörter der Beschreibung', kind: 'number' },
  descriptionChars: { label: 'Zeichen der Beschreibung (ohne HTML)', kind: 'number' },
  metaTitleChars: { label: 'Zeichen des Meta-Titles', kind: 'number' },
  metaDescriptionChars: { label: 'Zeichen der Meta-Description', kind: 'number' },
  nameChars: { label: 'Zeichen des Produktnamens', kind: 'number' },
  price: { label: 'Preis (brutto)', kind: 'number' },
  listPrice: { label: 'Streichpreis', kind: 'number' },
  stock: { label: 'Bestand', kind: 'number' },
  hasImage: { label: 'Hat ein Bild', kind: 'bool' },
} as const satisfies Record<string, { label: string; kind: FieldKind }>;
export type CheckField = keyof typeof CHECK_FIELDS;

export const CHECK_OPS = { lt: '<', lte: '≤', gt: '>', gte: '≥', eq: '=', neq: '≠' } as const;
export type CheckOp = keyof typeof CHECK_OPS;

export interface CheckCondition { field: CheckField; op: CheckOp; value: number | boolean }
export interface CustomCheck {
  id: string; title: string; severity: CheckSeverity; area: string; hint?: string;
  /** all = jede Bedingung muss zutreffen (und), any = mindestens eine (oder) */
  match: 'all' | 'any'; conditions: CheckCondition[]; createdAt: string;
}

export const CUSTOM_MAX = 20, CONDITIONS_MAX = 5, TITLE_MAX = 80, HINT_MAX = 300, AREA_MAX = 30;
export const CUSTOM_PREFIX = 'custom.';
const SEVERITIES: CheckSeverity[] = ['hoch', 'mittel', 'niedrig'];

const text = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
export const slugify = (t: string) => t.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/** Feldwert eines Produkts; null = unbekannt (Bedingung trifft dann nie zu, es wird nichts geraten) */
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

export const conditionText = (c: CheckCondition): string => {
  const f = CHECK_FIELDS[c.field];
  return f.kind === 'bool' ? `${f.label}: ${c.value === true ? 'ja' : 'nein'}` : `${f.label} ${CHECK_OPS[c.op]} ${Number(c.value).toLocaleString('de-DE')}`;
};
export const conditionsText = (chk: Pick<CustomCheck, 'match' | 'conditions'>) => chk.conditions.map(conditionText).join(chk.match === 'any' ? ' ODER ' : ' UND ');

/** Auswertung: Anzahl + Beispiele mit dem auslösenden Wert, damit der Befund nachvollziehbar ist */
export function evaluate(rows: NeutralProduct[], chk: Pick<CustomCheck, 'match' | 'conditions'>) {
  const hits = rows.filter(p => matches(p, chk));
  const detail = (p: NeutralProduct) => {
    const c = chk.conditions[0], v = fieldValue(p, c.field);
    return v == null || typeof v === 'boolean' ? p.label : `${p.label}: ${CHECK_FIELDS[c.field].label} ${Number(v).toLocaleString('de-DE')}`;
  };
  return { count: hits.length, sample: hits.slice(0, 5).map(p => ({ id: p.id, label: detail(p) })) };
}

/** Eingabe (KI/Oberfläche) prüfen und bereinigen; wirft mit verständlicher Meldung */
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

// ---- Titel der eingebauten Prüfungen (Verwaltungsliste) ----
const BY_SUFFIX: Record<string, string> = {
  'meta-description': 'Produkte ohne Meta-Description', 'meta-title': 'Produkte ohne Meta-Title', 'meta-title-long': 'Zu lange Meta-Titles',
  'meta-title-duplicate': 'Doppelte Meta-Titles', 'description-thin': 'Dünne Produktbeschreibungen', 'no-image': 'Produkte ohne Bild',
  'alt-missing': 'Bilder ohne Alt-Text', 'stock-zero': 'Aktiv und lieferbar ohne Bestand', 'stock-oversell': 'Bestellbar ohne Bestand',
  'sold-out': 'Aktiv, aber ausverkauft', 'price-zero': 'Preis ist 0', 'below-purchase': 'Preis unter Einkaufspreis',
  'list-price': 'Streichpreis nicht über dem Preis', 'special-not-below': 'Sonderpreis nicht unter dem Preis', 'price-spread': 'Auffällige Preisspanne der Varianten',
  'description-links': 'Kaputte Links in Produkttexten', 'page-links': 'Kaputte Links in Seiten', 'cms-links': 'Kaputte Links in CMS-Seiten',
  'category-meta': 'Kategorien ohne Meta-Description', 'category-description': 'Kategorien ohne Beschreibung', collections: 'Kollektionen ohne Meta/Beschreibung',
  translations: 'Fehlende Übersetzungen',
};
const BY_ID: Record<string, string> = {
  'recht.gpsr': 'GPSR-Pflichtangaben', 'recht.grundpreis': 'Grundpreisangaben', 'recht.rechtstexte': 'Rechtstexte',
  'bfsg.texte': 'Barrierefreiheit: Texte', 'bfsg.kontrast': 'Barrierefreiheit: Kontraste',
  'gsc.low-ctr': 'Search Console: niedrige Klickrate', 'gsc.measure-due': 'Search Console: Messung fällig',
};
export function builtinTitle(id: string): string {
  if (BY_ID[id]) return BY_ID[id];
  const suffix = id.split('.').slice(1).join('.');
  return BY_SUFFIX[suffix] ?? id;
}

/** Eintrag der Verwaltungsliste (GET /api/shopcheck/checks) */
export interface CheckListItem { id: string; title: string; area: string; enabled: boolean; custom: boolean; severity?: CheckSeverity; rule?: string }
