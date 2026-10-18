import 'server-only';
// Change layer: the AI ONLY PROPOSES (diff); writing happens exclusively here, after human approval.
import type { ChangeAsset, ChangeItem, ChangeSet, MeasureTarget, PublishedInfo, UndoOp } from '@/lib/protocol';
import { withScript } from '@/lib/script-scan';
import { auditAdd } from './db';
import { newId, type Shopware, type ShopReader, type SwEntity } from './shopware';
import { compile, type ImageObj, type PageSpec } from './cms';
import { renderPattern } from './patterns';
import { stagedMeta, uploadStaged, importFromUrl } from './media';
import { singleton } from './state';
import { checkHtmlItems } from './seo-links';
import type { PlatformKind } from '@/lib/platforms';
import type { ShopLookup } from './platform/types';
import { errMsg, pool } from './util';

export const DEFAULT_CURRENCY = 'b7d2554b0ce847cd82f3ac9bd1c0dfca';
export const MAX_ITEMS = 300;
// Spares the shop: at most this many concurrent writes (default 2, max. 8)
export const WRITE_CONCURRENCY = Math.min(8, Math.max(1, parseInt(process.env.LOTSE_WRITE_CONCURRENCY ?? '', 10) || 2));

type FieldKind = 'str' | 'html' | 'price' | 'int' | 'bool' | 'faq';
export interface FieldDef { label: string; kind: FieldKind }

export const PRODUCT_FIELDS: Record<string, FieldDef> = {
  name: { label: 'Name', kind: 'str' }, description: { label: 'Beschreibung', kind: 'html' }, metaTitle: { label: 'Meta-Title', kind: 'str' },
  metaDescription: { label: 'Meta-Description', kind: 'str' }, keywords: { label: 'Keywords', kind: 'str' },
  price: { label: 'Preis (brutto)', kind: 'price' }, listPrice: { label: 'Streichpreis (brutto)', kind: 'price' },
  stock: { label: 'Bestand', kind: 'int' }, active: { label: 'Aktiv', kind: 'bool' }, ean: { label: 'EAN', kind: 'str' }, manufacturerNumber: { label: 'Hersteller-Nr.', kind: 'str' },
  faq: { label: 'FAQ (Zusatzfeld)', kind: 'faq' },
};
export const CATEGORY_FIELDS: Record<string, FieldDef> = {
  name: { label: 'Name', kind: 'str' }, description: { label: 'Beschreibung', kind: 'html' }, metaTitle: { label: 'Meta-Title', kind: 'str' },
  metaDescription: { label: 'Meta-Description', kind: 'str' }, active: { label: 'Aktiv', kind: 'bool' },
};

export const eur = (v: number | null | undefined) => (v == null ? '–' : `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`);
/** Shorten text to one line (before/after in change cards); empty → "–" */
export const cut = (t: unknown, n = 220) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s || '–'; };
export const net = (gross: number, rate: number) => Math.round((gross / (1 + rate / 100)) * 10000) / 10000;
const cents = (v: number) => Math.round(v * 100) / 100;
// Rounding mode only in the form ".99" / ".95" / ".00" (comma allowed, leading 0 allowed); anything else is an error rather than a wrong price ("99" → 99 €)
const ROUND_MODE = /^0?\.\d{1,2}$/;
const roundTo = (v: number, mode: string | undefined) => {
  const m = String(mode ?? 'none').trim().replace(',', '.');
  if (!m || m === 'none') return cents(v);
  if (!ROUND_MODE.test(m)) throw new Error(`round "${mode}" ungültig: erlaubt sind ".99", ".95", ".00" oder "none"`);
  const f = parseFloat('0' + m.replace(/^0/, ''));
  return cents(Math.max(f, Math.round(v - f) + f));
};

// Compute the price rule server-side (no LLM mental arithmetic): number | {set} | {percent, round?} | {add, round?}
export type PriceSpec = number | null | { set?: number; percent?: number; add?: number; round?: string };
export function resolvePrice(cur: number | null, spec: PriceSpec): number | null {
  if (spec === null) return null;
  if (typeof spec === 'number') return cents(spec);
  if (spec.set != null) return roundTo(spec.set, spec.round ?? 'none');
  if (cur == null) throw new Error('Aktueller Preis unbekannt, Regel nicht anwendbar');
  if (spec.percent != null) return roundTo(cur * (1 + spec.percent / 100), spec.round ?? 'none');
  if (spec.add != null) return roundTo(cur + spec.add, spec.round ?? 'none');
  throw new Error('Unbekannte Preisregel (erlaubt: Zahl, {set}, {percent}, {add} + optional round)');
}

export const stripTags = (t: unknown) => String(t ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
export interface Faq { title: string; items: { q: string; a: string }[] }
export type RawFaq = { title?: unknown; items?: { q?: unknown; a?: unknown }[] } | { q?: unknown; a?: unknown }[] | null | undefined;
export function normFaq(raw: RawFaq, name: string): Faq {
  const arr = Array.isArray(raw) ? raw : raw?.items;
  if (!Array.isArray(arr) || arr.length < 2 || arr.length > 10) throw new Error('FAQ: 2 bis 10 Frage/Antwort-Paare erwartet');
  const items = arr.map(x => ({ q: stripTags(x?.q), a: stripTags(x?.a) }));
  if (items.some(i => !i.q || !i.a || i.q.length > 200 || i.a.length > 1200)) throw new Error('FAQ: jede Frage (≤200) und Antwort (≤1200 Zeichen) muss gefüllt sein');
  return { title: stripTags(Array.isArray(raw) ? undefined : raw?.title) || `Häufige Fragen zu ${name}`, items };
}
const faqText = (f: { items?: { q: string; a: string }[] } | null | undefined) => (f?.items ?? []).map(i => `F: ${i.q}\nA: ${i.a}`).join('\n\n');
export const faqHtml = (f: Faq) => renderPattern('faq', f);

function validate(def: FieldDef, field: string, v: unknown) {
  switch (def.kind) {
    case 'str': case 'html': if (typeof v !== 'string') throw new Error(`${def.label}: Text erwartet`); if (def.kind === 'str' && v.length > 255) throw new Error(`${def.label}: max. 255 Zeichen`); return v;
    case 'int': if (!Number.isInteger(v) || (v as number) < 0) throw new Error(`${def.label}: ganze Zahl ≥ 0 erwartet`); return v;
    case 'bool': if (typeof v !== 'boolean') throw new Error(`${def.label}: true/false erwartet`); return v;
  }
  return v;
}

// ---- Stale-write guard: between proposal and approval the changed value must not have changed in the shop ----
// Otherwise the human approves a diff that is no longer accurate (second chat, admin user). The builder remembers the raw value (beforeRaw),
// the executor compares it with the fresh state and does not write that item; the rest continue. Without beforeRaw (legacy data) no check.
export const STALE = 'inzwischen geändert, bitte neu vorschlagen';
/** Make values comparable: empty = null = ''; numbers to 4 decimals; text without formatting differences (whitespace); objects with sorted keys */
export function normValue(v: unknown): string {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v * 10000) / 10000);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  if (Array.isArray(v)) return v.length ? `[${v.map(normValue).join(',')}]` : '';
  if (typeof v === 'object') { const e = Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normValue(x)]).filter(([, x]) => x !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); return e.length ? `{${e.map(([k, x]) => `${k}:${x}`).join(',')}}` : ''; }
  return String(v);
}
export const isStale = (fresh: unknown, before: unknown) => before !== undefined && normValue(fresh) !== normValue(before);
/** Throws if the fresh value no longer matches the one remembered at proposal time */
export function assertFresh(label: string, fresh: unknown, before: unknown) { if (isStale(fresh, before)) throw new Error(`${label}: ${STALE}`); }

export interface ProposeArgs { title: string; reason: string; changes: { id: string; fields: Record<string, unknown> }[] }
async function build(ro: ShopReader, entity: 'product' | 'category', FIELDS: Record<string, FieldDef>, { title, reason, changes }: ProposeArgs): Promise<ChangeSet> {
  if (!changes?.length) throw new Error('changes ist leer');
  if (changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} ${entity === 'product' ? 'Produkte' : 'Kategorien'} pro Änderungsset. Bitte aufteilen.`);
  const ids = [...new Set(changes.map(c => c.id))];
  const rows = (await ro.search(entity, { ids, limit: ids.length, associations: entity === 'product' ? { tax: {} } : {} })).data;
  const by: Record<string, SwEntity> = Object.fromEntries(rows.map(r => [r.id, r]));
  // Variants inherit the price (price = null) from the parent product → current value is the parent product's
  const parentIds = entity === 'product' ? [...new Set(rows.filter(r => r.parentId && !r.price).map(r => r.parentId as string))] : [];
  const parents: Record<string, SwEntity> = parentIds.length ? Object.fromEntries((await ro.search('product', { ids: parentIds, limit: parentIds.length, associations: { tax: {} } })).data.map(r => [r.id, r])) : {};
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  for (const ch of changes) {
    const cur = by[ch.id];
    if (!cur) { skipped.push({ id: ch.id, reason: 'nicht gefunden' }); continue; }
    const label = entity === 'product' ? `${cur.translated?.name ?? cur.name ?? cur.productNumber}${cur.productNumber ? ` (${cur.productNumber})` : ''}` : (cur.translated?.name ?? cur.name);
    for (const [field, raw] of Object.entries(ch.fields ?? {})) {
      const def = FIELDS[field];
      if (!def) { skipped.push({ id: ch.id, reason: `Feld "${field}" nicht erlaubt` }); continue; }
      try {
        let before: string, after: string, afterRaw: unknown, beforeRaw: unknown = null; const warn: string[] = [];
        if (def.kind === 'faq') {
          const name = cur.translated?.name ?? cur.name ?? '';
          const faq = normFaq(raw as RawFaq, name); afterRaw = faq;
          const curFaq = cur.customFields?.aicb_blocks?.faq;
          before = curFaq?.length ? `${curFaq.length} Fragen` : '–'; after = `${faq.items.length} Fragen: „${cut(faq.items[0].q, 70)}“ …`;
          items.push({ id: `${ch.id}:${field}`, entity, entityId: ch.id, label, field, fieldLabel: def.label, before, after, afterRaw, beforeRaw: curFaq ?? null, html: { before: faqText({ items: curFaq }).slice(0, 4000), after: faqText(faq).slice(0, 4000) }, warn: [] });
          continue;
        }
        if (def.kind === 'price') {
          const inherited = !cur.price && !!cur.parentId, p = (cur.price ?? parents[cur.parentId]?.price)?.[0];
          if (inherited && !p) throw new Error('Preis des Hauptprodukts nicht lesbar');
          const curVal = field === 'price' ? p?.gross : p?.listPrice?.gross; beforeRaw = curVal ?? null;
          const price = resolvePrice(curVal ?? null, raw as PriceSpec); afterRaw = price;
          if (price !== null && (!(price >= 0) || !Number.isFinite(price))) throw new Error(`${def.label}: ungültiger Wert`);
          if (field === 'price' && price === null && !cur.parentId) throw new Error('Preis kann nur bei Varianten entfernt werden (dann erbt sie den Preis des Hauptprodukts)');
          if (price === curVal || (price == null && curVal == null) || (inherited && field === 'price' && price === null)) { unchanged++; continue; }
          before = `${eur(curVal)}${inherited ? ' (geerbt)' : ''}`; after = price === null ? (field === 'price' ? 'erbt vom Hauptprodukt' : 'entfernt') : eur(price);
          if (field === 'price') {
            if (price === 0) warn.push('Preis 0 €');
            if (curVal > 0 && price != null) { const d = ((price - curVal) / curVal) * 100; if (Math.abs(d) >= 30) warn.push(`Preisänderung ${d > 0 ? '+' : ''}${d.toFixed(0)} %`); }
          } else if (inherited && !changes.some(c => c.id === ch.id && c.fields?.price != null)) warn.push(`Preis wird fixiert (bisher geerbt: ${eur(p?.gross)})`); // list price only → own price, no longer follows the parent product
        } else {
          afterRaw = validate(def, field, raw);
          const curVal = cur[field] ?? cur.translated?.[field] ?? null; beforeRaw = curVal;
          if (afterRaw === curVal) { unchanged++; continue; }
          before = def.kind === 'bool' ? (curVal ? 'ja' : 'nein') : def.kind === 'int' ? String(curVal ?? '–') : cut(curVal);
          after = def.kind === 'bool' ? (afterRaw ? 'ja' : 'nein') : def.kind === 'int' ? String(afterRaw) : cut(afterRaw);
          if (field === 'stock' && curVal > 0 && afterRaw === 0) warn.push('Bestand auf 0');
          if (field === 'active' && afterRaw === false) warn.push('Wird deaktiviert');
        }
        items.push({ id: `${ch.id}:${field}`, entity, entityId: ch.id, label, field, fieldLabel: def.label, before, after, afterRaw, beforeRaw, html: def.kind === 'html' ? { before: String(cur[field] ?? cur.translated?.[field] ?? '').slice(0, 4000), after: String(afterRaw).slice(0, 4000) } : undefined, warn });
      } catch (e) { skipped.push({ id: ch.id, reason: `${field}: ${errMsg(e)}` }); }
    }
  }
  await checkHtmlItems(ro, items.filter(i => FIELDS[i.field ?? '']?.kind === 'html')); // check links in descriptions
  if (!items.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: entity === 'product' ? 'products' : 'categories', entity, title, reason, items, skipped, unchanged, atomic: false };
}
export const buildProductChangeSet = (ro: ShopReader, a: ProposeArgs) => build(ro, 'product', PRODUCT_FIELDS, a);
export const buildCategoryChangeSet = (ro: ShopReader, a: ProposeArgs) => build(ro, 'category', CATEGORY_FIELDS, a);

// ---- Create new products (e.g. from uploaded photos) ----
export interface NewProductInput {
  name: string; description: string; price: number; stock?: number; active?: boolean; productNumber?: string;
  metaTitle?: string; metaDescription?: string; keywords?: string; ean?: string; manufacturer?: string; taxRate?: number;
  categoryIds?: string[];
  /** Images: mediaId from uploads/media management or "staged:…"; the first one becomes the cover image */
  images?: string[];
}
export interface NewProductsArgs { title: string; reason: string; products: NewProductInput[] }
/** Payload per new product (an item's afterRaw); the executor creates the product from it */
export interface NewProductPayload extends NewProductInput { productNumber: string; taxId: string; taxRate: number; images: string[]; categoryIds: string[]; stock: number; active: boolean }

const slugNum = (name: string) => name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 3).map(w => w.slice(0, 4).toUpperCase()).join('-') || 'NEU';

export async function buildNewProductsChangeSet(ro: ShopReader, { title, reason, products }: NewProductsArgs): Promise<ChangeSet> {
  if (!products?.length) throw new Error('products ist leer');
  if (products.length > 50) throw new Error('Maximal 50 neue Produkte pro Änderungsset. Bitte aufteilen.');
  const taxes = (await ro.search('tax', { limit: 50 })).data;
  const catIds = [...new Set(products.flatMap(p => p.categoryIds ?? []))];
  const cats = catIds.length ? (await ro.search('category', { ids: catIds, limit: catIds.length })).data : [];
  const catName = Object.fromEntries(cats.map(c => [c.id, c.translated?.name ?? c.name]));
  const shopMedia = [...new Set(products.flatMap(p => p.images ?? []).filter(m => !m.startsWith('staged:')))];
  const media = shopMedia.length ? (await ro.search('media', { ids: shopMedia, limit: shopMedia.length })).data : [];
  const mediaUrl = Object.fromEntries(media.map(m => [m.id, m.url as string]));
  const numbers = products.map(p => p.productNumber?.trim()).filter(Boolean) as string[];
  const taken = new Set(numbers.length ? (await ro.search('product', { limit: numbers.length, filter: [{ type: 'equalsAny', field: 'productNumber', value: numbers }] })).data.map(p => p.productNumber) : []);
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], skipped: { id: string; reason: string }[] = [];
  products.forEach((p, i) => {
    const key = `neu-${i + 1}`;
    try {
      const name = stripTags(p.name);
      if (!name || name.length > 255) throw new Error('Name fehlt oder ist länger als 255 Zeichen');
      if (typeof p.description !== 'string' || !stripTags(p.description)) throw new Error('Beschreibung fehlt');
      if (!(typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0)) throw new Error('Preis (brutto) fehlt oder ist ungültig: wird nicht angelegt');
      const tax = taxes.find(t => t.taxRate === (p.taxRate ?? 19)) ?? taxes.find(t => t.taxRate === 19) ?? taxes[0];
      if (!tax) throw new Error('Kein Steuersatz im Shop gefunden');
      const productNumber = p.productNumber?.trim() || `${slugNum(name)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      if (taken.has(productNumber)) throw new Error(`Produktnummer ${productNumber} ist schon vergeben`);
      const unknownCats = (p.categoryIds ?? []).filter(c => !catName[c]);
      if (unknownCats.length) throw new Error(`Kategorie nicht gefunden: ${unknownCats.join(', ')}`);
      const images = (p.images ?? []).filter(m => m.startsWith('staged:') ? !!stagedMeta(m.slice(7)) : !!mediaUrl[m]);
      for (const m of [...(p.images ?? [])].filter(m => !images.includes(m))) skipped.push({ id: key, reason: `Bild ${m} nicht gefunden` });
      for (const m of images) {
        const sm = m.startsWith('staged:') ? stagedMeta(m.slice(7)) : null;
        assets.push({ name, url: sm ? `/staged/${sm.file}` : mediaUrl[m], alt: name, note: m === images[0] ? 'Titelbild' : 'weiteres Bild' });
      }
      const stock = Number.isInteger(p.stock) && (p.stock as number) >= 0 ? (p.stock as number) : 0, active = p.active === true;
      const payload: NewProductPayload = { ...p, name, productNumber, taxId: tax.id, taxRate: tax.taxRate, images, categoryIds: p.categoryIds ?? [], stock, active };
      const warn: string[] = [];
      if (!images.length) warn.push('Ohne Bild');
      if (p.price === 0) warn.push('Preis 0 €');
      if (active) warn.push('Wird sofort aktiv im Shop');
      const where = payload.categoryIds.map(c => catName[c]).join(', ');
      items.push({ id: key, entity: 'product', label: `${name} (${productNumber})`, field: 'create', fieldLabel: 'Neues Produkt',
        before: '–', after: `${eur(p.price)} · ${active ? 'aktiv' : 'inaktiv (Entwurf)'} · Bestand ${stock}${where ? ` · ${where}` : ''} · ${images.length} ${images.length === 1 ? 'Bild' : 'Bilder'}`,
        afterRaw: payload, html: { before: '', after: [`<h4>${name}</h4>`, p.description, p.metaTitle ? `<p><b>Meta-Title:</b> ${stripTags(p.metaTitle)}</p>` : '', p.metaDescription ? `<p><b>Meta-Description:</b> ${stripTags(p.metaDescription)}</p>` : ''].join('').slice(0, 6000) }, warn });
    } catch (e) { skipped.push({ id: key, reason: `${p?.name ?? key}: ${errMsg(e)}` }); }
  });
  if (!items.length) throw new Error(`Kein Produkt anlegbar: ${skipped.map(s => s.reason).join('; ')}`);
  return { id: newId(), kind: 'new-products', entity: 'product', title, reason, items, assets, skipped, atomic: false };
}

async function createProduct(swW: Shopware, p: NewProductPayload): Promise<UndoOp> {
  const taken = (await swW.search('product', { limit: 1, filter: [{ type: 'equals', field: 'productNumber', value: p.productNumber }] })).data[0];
  if (taken) throw new Error(`Produktnummer ${p.productNumber} ist schon vergeben`);
  const id = newId(), media = [];
  for (const [i, m] of p.images.entries()) media.push({ id: newId(), mediaId: m.startsWith('staged:') ? await uploadStaged(swW, m.slice(7)) : m, position: i });
  const channels = (await swW.salesChannels()).filter(s => s.domains?.length);
  const manufacturer = p.manufacturer ? ((await swW.search('product-manufacturer', { limit: 1, filter: [{ type: 'equals', field: 'name', value: p.manufacturer }] })).data[0]?.id ?? null) : null;
  const undo: UndoOp = { op: 'delete', entity: 'product', id };
  try {
    await swW.create('product', {
      id, name: p.name, productNumber: p.productNumber, description: p.description, stock: p.stock, active: p.active, taxId: p.taxId,
      price: [{ currencyId: DEFAULT_CURRENCY, gross: p.price, net: net(p.price, p.taxRate), linked: true }],
      ...(p.metaTitle ? { metaTitle: p.metaTitle } : {}), ...(p.metaDescription ? { metaDescription: p.metaDescription } : {}), ...(p.keywords ? { keywords: p.keywords } : {}), ...(p.ean ? { ean: p.ean } : {}),
      ...(manufacturer ? { manufacturerId: manufacturer } : p.manufacturer ? { manufacturer: { name: p.manufacturer } } : {}),
      categories: p.categoryIds.map(c => ({ id: c })), visibilities: channels.map(s => ({ salesChannelId: s.id, visibility: 30 })),
      ...(media.length ? { media, coverId: media[0].id } : {}),
    });
  } catch (e) { throw Object.assign(e instanceof Error ? e : new Error(String(e)), { undo: [undo] }); }
  return undo;
}

// ---- Publishing a page as a change set ----
/** Scope for layouts covering several pages: Shopware resolves it into fixed IDs (categoryIds/productIds) at proposal time, so the approval writes exactly what was shown. */
/** Pages whose layout a publish replaces, for the impact measurement (Search Console). Only for a handful of targets:
 *  a shop-wide layout can't be attributed to single pages. */
export const MEASURE_TARGETS_MAX = 50;
export function measureTargets(entity: MeasureTarget['entity'], list: { id: string; label: string }[]): { measureTargets?: MeasureTarget[] } {
  return list.length && list.length <= MEASURE_TARGETS_MAX ? { measureTargets: list.map(t => ({ entity, id: t.id, label: t.label })) } : {};
}

export interface PublishScopeArgs { categoryIds?: string[]; allCategories?: boolean; productsInCategoryId?: string; allProducts?: boolean; scopeLabel?: string }
export interface PublishArgs extends PublishScopeArgs { target: 'category' | 'product' | 'landingpage'; categoryId?: string; productIds?: string[]; url?: string; salesChannelId?: string; metaTitle?: string; metaDescription?: string }
/** Targets of a publication (categories or products) in fixed order */
export const publishCategoryIds = (a: PublishArgs) => (a.categoryIds?.length ? a.categoryIds : a.categoryId ? [a.categoryId] : []);
/** From this many targets on, the overview shows a summary with a sample instead of one row per page */
const BULK_ROWS = 15, BULK_SAMPLE = 8;
export interface PublishPayload { spec: PageSpec; args: PublishArgs }
/** Landing page path: lowercase letters, digits, - _ and /, without spaces, query or fragment (Shopware does not validate the URL) */
export function landingSlug(url: unknown): string {
  const s = String(url ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!s || /[^a-z0-9/_-]/.test(s) || s.includes('//')) throw new Error(`url „${String(url ?? '')}“ ungültig: nur Kleinbuchstaben, Ziffern, Bindestrich, Unterstrich und / (ohne Leerzeichen, Umlaute, ? oder #)`);
  return s;
}
const metaLen = (label: string, v: string | undefined) => { if (v && v.length > 255) throw new Error(`${label}: max. 255 Zeichen (${v.length})`); };
/** Shopware category types: only "page" (listing) shows a CMS layout. "folder" (structure element) has no page of its own, "link" redirects. */
const CATEGORY_TYPE_LABEL: Record<string, string> = { folder: 'Strukturelement (ohne eigene Seite)', link: 'Link (leitet weiter)' };
/** Throws if a category cannot show a layout; missing type = listing (older data) */
export function assertLayoutCategory(c: SwEntity) {
  const type = c.type as string | null | undefined;
  if (!type || type === 'page') return;
  throw new Error(`Kategorie „${String(c.translated?.name ?? c.name ?? c.id)}“ ist vom Typ ${CATEGORY_TYPE_LABEL[type] ?? type} und zeigt kein Layout. Ein Layout lässt sich nur einer Listing-Kategorie zuweisen; Landingpage oder Kategorie vom Typ „Listing“ wählen.`);
}

export async function buildPublishChangeSet(ro: ShopReader, spec: PageSpec, a: PublishArgs): Promise<ChangeSet> {
  const blocks = spec.sections.reduce((n, s) => n + s.blocks.length, 0), items: ChangeItem[] = [], assets: ChangeAsset[] = [];
  metaLen('metaTitle', a.metaTitle ?? spec.seo?.metaTitle); metaLen('metaDescription', a.metaDescription ?? spec.seo?.metaDescription);
  for (const s of spec.sections) for (const b of s.blocks) for (const k of ['image', 'image2'] as const) {
    const im = b[k]; if (!im) continue; const o: ImageObj = typeof im === 'string' ? { url: im } : im;
    if (o.mediaId?.startsWith('staged:')) { const m = stagedMeta(o.mediaId.slice(7)); assets.push({ name: m?.name, url: `/staged/${m?.file}`, alt: o.alt ?? m?.alt ?? undefined, note: 'wird neu hochgeladen' }); }
    else if (!o.mediaId && o.url) assets.push({ name: o.url.split('/').pop(), url: o.url, alt: o.alt, note: 'wird importiert' });
  }
  const info = (label: string, fieldLabel: string, before: string, after: string) => items.push({ id: `i${items.length}`, entity: 'info', label, fieldLabel, before, after, warn: [] });
  info('Neues CMS-Layout', 'Anlegen', '–', `${spec.name} · ${spec.type} · ${blocks} Blöcke`);
  const layoutName = async (id: string | null | undefined) => (id ? (await ro.get('cms-page', id))?.name ?? id : 'kein eigenes Layout');
  const layoutNames = new Map<string, string>();
  const layoutOf = async (id: string | null | undefined) => { if (!id) return 'kein eigenes Layout'; if (!layoutNames.has(id)) layoutNames.set(id, await layoutName(id)); return layoutNames.get(id)!; };
  /** One row per target; with many targets a summary (how many replace their own layout) plus a sample */
  const rows = async (noun: string, nounPl: string, list: { name: string; cmsPageId?: string | null }[]) => {
    if (list.length <= BULK_ROWS) { for (const t of list) info(`${noun} „${t.name}“`, 'Layout', await layoutOf(t.cmsPageId), spec.name); return; }
    const own = list.filter(t => t.cmsPageId).length;
    info(`${list.length} ${nounPl}`, 'Layout', `${own} mit eigenem Layout (wird ersetzt), ${list.length - own} ohne`, spec.name);
    if (a.scopeLabel) info('Geltungsbereich', 'Auswahl', '–', a.scopeLabel);
    for (const t of list.slice(0, BULK_SAMPLE)) info(`${noun} „${t.name}“`, 'Layout', await layoutOf(t.cmsPageId), spec.name);
    info('Weitere', 'Layout', '–', `… und ${list.length - BULK_SAMPLE} weitere ${nounPl} mit demselben Layout`);
  };
  let targets: { measureTargets?: MeasureTarget[] } = {};
  const fetchAll = async (entity: string, ids: string[]) => { const out: SwEntity[] = []; for (let i = 0; i < ids.length; i += 100) out.push(...(await ro.search(entity, { ids: ids.slice(i, i + 100), limit: 100 })).data); return out; };
  if (a.target === 'category') {
    const ids = publishCategoryIds(a);
    if (spec.type === 'landingpage' && a.allCategories) throw new Error('Ein Landingpage-Layout gilt nur für gezielt gewählte Kategorien (z. B. die Startseite), nicht für alle Kategorien.');
    if (ids.length > 1 && (a.metaTitle ?? spec.seo?.metaTitle ?? a.metaDescription ?? spec.seo?.metaDescription)) throw new Error('Meta-Title/-Description gelten nur für eine einzelne Kategorie. Bei mehreren Kategorien weglassen (danach je Kategorie mit propose_category_changes).');
    const cats = await fetchAll('category', ids), missing = ids.filter(id => !cats.some(c => c.id === id));
    if (missing.length) throw new Error(missing.length === 1 ? `Kategorie ${missing[0]} nicht gefunden` : `Kategorien nicht gefunden: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
    for (const c of cats) assertLayoutCategory(c); // structure element/link show no layout: reject before approval, not only when writing
    const nameOf = (c: SwEntity) => c.translated?.name ?? c.name;
    await rows('Kategorie', 'Kategorien', cats.map(c => ({ name: nameOf(c), cmsPageId: c.cmsPageId })));
    targets = measureTargets('category', cats.map(c => ({ id: c.id, label: nameOf(c) })));
    if (cats.length === 1) {
      const c = cats[0], name = nameOf(c);
      if (a.metaTitle ?? spec.seo?.metaTitle) info(`Kategorie „${name}“`, 'Meta-Title', cut(c.translated?.metaTitle), cut(a.metaTitle ?? spec.seo?.metaTitle));
      if (a.metaDescription ?? spec.seo?.metaDescription) info(`Kategorie „${name}“`, 'Meta-Description', cut(c.translated?.metaDescription), cut(a.metaDescription ?? spec.seo?.metaDescription));
    }
  } else if (a.target === 'product') {
    const ps = await fetchAll('product', a.productIds!), missing = a.productIds!.filter(id => !ps.some(p => p.id === id));
    if (missing.length) throw new Error(`Produkt nicht gefunden: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
    await rows('Produkt', 'Produkte', ps.map(p => ({ name: p.translated?.name ?? p.name, cmsPageId: p.cmsPageId })));
    targets = measureTargets('product', ps.map(p => ({ id: p.id, label: p.translated?.name ?? p.name ?? p.productNumber })));
  } else {
    const slug = landingSlug(a.url), sc = (await ro.salesChannels()).find(s => s.id === a.salesChannelId);
    if (!sc) throw new Error(`Verkaufskanal ${a.salesChannelId} nicht gefunden (list_sales_channels)`);
    const dup = (await ro.search('landing-page', { limit: 1, filter: [{ type: 'equals', field: 'url', value: slug }, { type: 'equals', field: 'salesChannels.id', value: sc.id }] })).data[0];
    if (dup) throw new Error(`Unter /${slug} gibt es im Verkaufskanal „${sc.translated?.name ?? sc.name}“ schon die Landingpage „${dup.translated?.name ?? dup.name}“ (${dup.id}). Andere URL wählen.`);
    a.url = slug;
    info('Neue Landingpage', 'URL', '–', `/${slug}`);
  }
  return { id: newId(), kind: 'page', title: `Seite veröffentlichen: ${spec.name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec), ...targets };
}

// ================= EXECUTOR (the only writing code) =================
export { pool } from './util';

const fieldSet = () => singleton('fieldSet', () => ({ ok: false }));
export async function ensureFieldSet(swW: Shopware) { // one-time: custom field set "aicb_content" (JSON field aicb_blocks) on the product
  if (fieldSet().ok) return;
  const ex = (await swW.search('custom-field-set', { filter: [{ type: 'equals', field: 'name', value: 'aicb_content' }], limit: 1 })).data[0];
  if (!ex) await swW.create('custom-field-set', { id: newId(), name: 'aicb_content', config: { label: { 'de-DE': 'AI Content Builder', 'en-GB': 'AI Content Builder' } }, relations: [{ id: newId(), entityName: 'product' }],
    customFields: [{ name: 'aicb_blocks', type: 'json', config: { label: { 'de-DE': 'AI-Inhalte (FAQ …)', 'en-GB': 'AI content (FAQ …)' }, customFieldPosition: 1 } }] });
  fieldSet().ok = true;
}

/** Fresh value of a field in state cur (price fields from the effective, possibly inherited price entry cp) */
const freshValue = (cur: SwEntity, cp: SwEntity, field: string) =>
  field === 'price' ? cp.gross ?? null : field === 'listPrice' ? cp.listPrice?.gross ?? null : field === 'faq' ? cur.customFields?.aicb_blocks?.faq ?? null : cur[field] ?? cur.translated?.[field] ?? null;

/** Writes an entity's items in one PATCH. Fields changed in the meantime (stale) are not written, the others are. */
async function applyEntity(swW: Shopware, entity: string, entityId: string, items: ChangeItem[]): Promise<{ undo: UndoOp | null; stale: Map<string, string> }> {
  const cur = await swW.get(entity, entityId, entity === 'product' ? { associations: { tax: {} } } : {});
  if (!cur) throw new Error('Datensatz nicht mehr vorhanden');
  const hasPrice = items.some(i => i.field === 'price' || i.field === 'listPrice');
  // Variant without its own price/tax rate: parent product's values as the basis (undo restores the inheritance)
  const parent = hasPrice && entity === 'product' && cur.parentId && (!cur.price || !cur.tax) ? await swW.get('product', cur.parentId, { associations: { tax: {} } }) : null;
  const prices: SwEntity[] = cur.price ?? parent?.price ?? [], cp = prices[0] ?? {};
  const stale = new Map<string, string>(), live: ChangeItem[] = [];
  for (const it of items) { try { assertFresh(it.fieldLabel, freshValue(cur, cp, it.field ?? ''), it.beforeRaw); live.push(it); } catch (e) { stale.set(it.id, errMsg(e)); } }
  if (!live.length) return { undo: null, stale };
  const data: Record<string, unknown> = {}, undo: Record<string, unknown> = {};
  for (const it of live) if (it.field && it.field !== 'price' && it.field !== 'listPrice' && it.field !== 'faq') { data[it.field] = it.afterRaw; undo[it.field] = cur[it.field] ?? null; }
  const fi = live.find(i => i.field === 'faq');
  if (fi) {
    await ensureFieldSet(swW);
    const faq = fi.afterRaw as Faq;
    const blocks = { ...(cur.customFields?.aicb_blocks ?? {}), faq: faq.items, faq_html: faqHtml(faq) };
    data.customFields = { aicb_blocks: blocks }; undo.customFields = { aicb_blocks: cur.customFields?.aicb_blocks ?? null };
  }
  const pi = live.find(i => i.field === 'price'), li = live.find(i => i.field === 'listPrice');
  if (pi || li) {
    const rate = (cur.tax ?? parent?.tax)?.taxRate ?? 19, currencyId = cp.currencyId ?? DEFAULT_CURRENCY;
    if (pi && pi.afterRaw === null) { if (!cur.parentId) throw new Error('Preis kann nur bei Varianten entfernt werden'); data.price = null; }
    else {
      const gross = (pi ? pi.afterRaw : cp.gross) as number | null | undefined; if (gross == null) throw new Error('Kein Preis vorhanden');
      const entry: Record<string, unknown> = { currencyId, gross, net: net(gross, rate), linked: true };
      const lp = (li ? li.afterRaw : cp.listPrice?.gross) as number | null | undefined;
      if (lp != null) entry.listPrice = { currencyId, gross: lp, net: net(lp, rate), linked: true };
      const reg = cp.regulationPrice as SwEntity | undefined;
      if (reg?.gross != null) entry.regulationPrice = { currencyId: reg.currencyId, gross: reg.gross, net: reg.net, linked: reg.linked ?? true };
      data.price = [entry, ...prices.slice(1)];
    }
    undo.price = cur.price ?? null;
  }
  await swW.update(entity, entityId, data);
  return { undo: { op: 'patch', entity, id: entityId, data: undo, wrote: data }, stale };
}

/** counts: totals when results is truncated (bulk edit: groups + sample + errors instead of thousands of rows) */
export interface ApplyResult { results: { itemId: string; ok: boolean; error?: string }[]; undo: UndoOp[]; published?: PublishedInfo; error?: string; counts?: { applied: number; failed: number } }
async function applyPublish(swW: Shopware, cs: ChangeSet, payload: PublishPayload, ctx?: ApplyCtx): Promise<ApplyResult> {
  const { spec, args: a } = payload, undo = trackedUndo(ctx, cs.items.length);
  const resolve = async (im: ImageObj): Promise<string | null> => im.mediaId?.startsWith('staged:') ? uploadStaged(swW, im.mediaId.slice(7)) : im.mediaId ? im.mediaId : (await importFromUrl(swW, im.url!, { alt: im.alt })).mediaId;
  const page = await compile(spec, resolve);
  await swW.create('cms-page', page); undo.push({ op: 'delete', entity: 'cms-page', id: page.id });
  try {
    const sc = await swW.salesChannels(), domain = (a.salesChannelId ? sc.find(s => s.id === a.salesChannelId) : sc.find(s => s.domains?.length))?.domains?.[0]?.url ?? swW.base;
    const out: PublishedInfo = { cmsPageId: page.id, adminUrl: `${swW.base}/admin#/sw/cms/detail/${page.id}`, name: spec.name };
    const mt = a.metaTitle ?? spec.seo?.metaTitle, md = a.metaDescription ?? spec.seo?.metaDescription;
    // Several targets gently in parallel; after the first error no further one starts, then everything is rolled back (atomic)
    const eachAtomic = async <T,>(list: T[], fn: (x: T) => Promise<void>) => {
      let i = 0, failed: { e: unknown } | null = null;
      await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, list.length) }, async () => {
        while (!failed && i < list.length) { const x = list[i++]; try { await fn(x); } catch (e) { failed = { e }; } }
      }));
      if (failed) throw (failed as { e: unknown }).e;
    };
    if (a.target === 'category') {
      const ids = publishCategoryIds(a), single = ids.length === 1;
      await eachAtomic(ids, async categoryId => {
        const cur = await swW.get('category', categoryId);
        if (!cur) throw new Error(single ? 'Kategorie nicht mehr vorhanden' : `Kategorie ${categoryId} nicht mehr vorhanden`);
        assertLayoutCategory(cur); // type may have changed since the approval
        const withMeta = single;
        await swW.update('category', categoryId, { cmsPageId: page.id, ...(withMeta && mt ? { metaTitle: mt } : {}), ...(withMeta && md ? { metaDescription: md } : {}) });
        undo.push({ op: 'patch', entity: 'category', id: categoryId, data: { cmsPageId: cur.cmsPageId ?? null, ...(withMeta && mt ? { metaTitle: cur.metaTitle ?? null } : {}), ...(withMeta && md ? { metaDescription: cur.metaDescription ?? null } : {}) } });
      });
      const links = ids.slice(0, 10).map(id => `${domain}/navigation/${id}`);
      out.storefront = single ? links[0] : links;
    } else if (a.target === 'product') {
      await eachAtomic(a.productIds!, async id => {
        const cur = await swW.get('product', id); if (!cur) throw new Error(`Produkt ${id} nicht mehr vorhanden`);
        await swW.update('product', id, { cmsPageId: page.id }); undo.push({ op: 'patch', entity: 'product', id, data: { cmsPageId: cur.cmsPageId ?? null } });
      });
      out.storefront = a.productIds!.slice(0, 10).map(id => `${domain}/detail/${id}`);
    } else {
      const slug = landingSlug(a.url), lpId = newId();
      await swW.create('landing-page', { id: lpId, name: spec.name, active: true, url: slug, cmsPageId: page.id, salesChannels: [{ id: a.salesChannelId }], metaTitle: mt ?? spec.name, metaDescription: md ?? '' });
      undo.push({ op: 'delete', entity: 'landing-page', id: lpId }); out.storefront = `${domain}/${slug}`;
    }
    return { results: cs.items.map(i => ({ itemId: i.id, ok: true })), undo, published: out };
  } catch (e) {
    // atomic: if a later step fails, the already created layout (and assignments) is rolled back immediately, otherwise it would remain in the shop without an undo step
    const error = errMsg(e), back = await undoOps(swW, undo), rest = undo.filter((_, i) => !back[undo.length - 1 - i].ok);
    return { results: cs.items.map(i => ({ itemId: i.id, ok: false, error })), undo: rest, error: rest.length ? `${error} (Rückabwicklung unvollständig: ${back.find(b => !b.ok)?.error})` : `${error} (nichts geändert, Layout wieder entfernt)` };
  }
}

// ---- Extensible: feature modules (src/server/features) register their executors here (Shopware; other platforms: platform/appliers.ts) ----
/** Intermediate state while applying (results so far + undo steps): the session saves it in the DB so a crash midway loses no undo */
export interface ApplyPartial { results: ApplyResult['results']; undo: UndoOp[] }
/** progress: report progress of large sets to the UI (done/total records); pass partial after each item/chunk */
export interface ApplyCtx { progress?: (done: number, total: number, partial?: ApplyPartial) => void }
export type Applier = (swW: Shopware, cs: ChangeSet, payload: unknown, selected: Set<string>, ctx?: ApplyCtx) => Promise<ApplyResult>;
const APPLIERS = singleton('appliers', () => new Map<string, Applier>());
export const registerApplier = (kind: string, fn: Applier) => { APPLIERS.set(kind, fn); };
/** For appliers with their own loop: tick() after each record (also on error) reports the state so far; done = number of results */
export const partialTicker = (ctx: ApplyCtx | undefined, total: number, partial: ApplyPartial) => () => ctx?.progress?.(partial.results.length, total, partial);
/** Undo list that reports each new step immediately as intermediate state: for appliers with several write steps per record
 * (promotion, publication, variants) where results only appear at the end; results = results so far, if any */
export function trackedUndo(ctx: ApplyCtx | undefined, total: number, results: ApplyResult['results'] = []): UndoOp[] {
  const undo: UndoOp[] = [];
  if (!ctx?.progress) return undo;
  const push = undo.push.bind(undo);
  undo.push = (...ops) => { const n = push(...ops); ctx.progress!(results.length, total, { results, undo }); return n; };
  return undo;
}

/** Default executor: each selected item individually (gently in parallel); fn returns the undo steps. */
export async function applyEach(cs: ChangeSet, selected: Set<string>, fn: (it: ChangeItem) => Promise<UndoOp | UndoOp[]>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info');
  let done = 0;
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...[await fn(it)].flat()); results.push({ itemId: it.id, ok: true }); }
    catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { ctx?.progress?.(++done, list.length, { results, undo }); }
  });
  return { results, undo };
}

export async function applyChangeSet(swW: Shopware, cs: ChangeSet, payload: unknown, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const custom = APPLIERS.get(cs.kind);
  if (custom) return custom(swW, cs, payload, selected, ctx);
  if (cs.kind === 'page') return applyPublish(swW, cs, payload as PublishPayload, ctx);
  if (cs.kind === 'new-products') {
    const results: ApplyResult['results'] = [], undo: UndoOp[] = [], list = cs.items.filter(i => selected.has(i.id));
    let done = 0;
    await pool(list, WRITE_CONCURRENCY, async it => {
      try { undo.push(await createProduct(swW, it.afterRaw as NewProductPayload)); results.push({ itemId: it.id, ok: true }); }
      catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
      finally { ctx?.progress?.(++done, list.length, { results, undo }); }
    });
    return { results, undo };
  }
  const items = cs.items.filter(i => selected.has(i.id)), groups: Record<string, ChangeItem[]> = {};
  for (const it of items) (groups[it.entityId ?? ''] ||= []).push(it);
  const results: ApplyResult['results'] = [], undo: UndoOp[] = [], entries = Object.entries(groups);
  let done = 0;
  await pool(entries, WRITE_CONCURRENCY, async ([id, its]) => {
    try {
      const r = await applyEntity(swW, cs.entity!, id, its); if (r.undo) undo.push(r.undo);
      its.forEach(i => results.push(r.stale.has(i.id) ? { itemId: i.id, ok: false, error: r.stale.get(i.id) } : { itemId: i.id, ok: true }));
    } catch (e) { its.forEach(i => results.push({ itemId: i.id, ok: false, error: errMsg(e) })); }
    finally { ctx?.progress?.(++done, entries.length, { results, undo }); }
  });
  return { results, undo };
}

// Shopware does not delete SEO URLs of deleted products/categories/landing pages, it only marks them (isDeleted).
// What Lotse created and undoes should vanish without a trace, otherwise orphaned URL rows pile up.
const SEO_ROUTED = new Set(['product', 'category', 'landing-page']);
async function dropSeoUrls(swW: Shopware, foreignKey: string) {
  try {
    const rows = (await swW.search('seo-url', { limit: 500, filter: [{ type: 'equals', field: 'foreignKey', value: foreignKey }] })).data;
    for (const row of rows) await swW.req('DELETE', `/seo-url/${row.id}`).catch(() => {});
  } catch { /* cleanup only; the actual undo has already happened */ }
}

const isDelete = (op: UndoOp) => op.op === 'delete' || (op.op === 'req' && (op.method ?? 'DELETE') === 'DELETE');

const MOVED = 'Feld inzwischen geändert, Rückgängig übersprungen';
async function patchMoved(swW: Shopware, op: UndoOp): Promise<boolean> {
  if (!op.wrote) return false;
  const cur = await swW.get(op.entity, op.id).catch(() => null);
  if (!cur) return false;
  return Object.keys(op.wrote).some(k => {
    const live = cur[k] ?? null;
    return normValue(live) !== normValue(op.wrote?.[k]) && normValue(live) !== normValue(op.data?.[k]);
  });
}

export async function undoOps(swW: Shopware, undo: UndoOp[]) {
  const r: { ok: boolean; error?: string }[] = [];
  for (const op of [...undo].reverse()) {
    try {
      if (op.op === 'patch' && await patchMoved(swW, op)) { r.push({ ok: false, error: MOVED }); continue; }
      if (op.op === 'patch') await swW.update(op.entity, op.id, op.data);
      else if (op.op === 'create') await swW.create(op.entity, { id: op.id, ...op.data });
      else if (op.op === 'req') await swW.req(op.method ?? 'DELETE', op.path!, op.body);
      else { await swW.req('DELETE', `/${op.entity}/${op.id}`); if (SEO_ROUTED.has(op.entity)) await dropSeoUrls(swW, op.id); }
      r.push({ ok: true });
    }
    // Deleting is idempotent: already gone (e.g. by cascade with a previously undone stream) = goal reached
    catch (e) { r.push(isDelete(op) && (e as { status?: number }).status === 404 ? { ok: true } : { ok: false, error: errMsg(e) }); }
  }
  return r;
}

// ---- After applying: observers (e.g. Search Console remembers the baseline values of changed metas) ----
/** items = successfully applied items; errors in an observer never disrupt the flow. */
/** ro = Shopware read client (Shopware only); lookup = platform-neutral read functions (missing only in legacy calls/tests → from ro) */
export interface AppliedCtx { ro: ShopReader; lookup?: ShopLookup; platform?: PlatformKind; chatId: string }
export type AppliedHook = (cs: ChangeSet, items: ChangeItem[], ctx: AppliedCtx) => void | Promise<void>;
const APPLIED = singleton('applied-hooks', () => new Map<string, AppliedHook>());
export const onApplied = (key: string, fn: AppliedHook) => { APPLIED.set(key, fn); };
export function notifyApplied(cs: ChangeSet, res: Pick<ApplyResult, 'results'>, ctx: AppliedCtx): Promise<void> {
  const okIds = new Set(res.results.filter(r => r.ok).map(r => r.itemId)), items = cs.items.filter(i => okIds.has(i.id));
  if (!items.length) return Promise.resolve();
  return Promise.all([...APPLIED.values()].map(fn => Promise.resolve().then(() => fn(cs, items, ctx)).catch(() => {}))).then(() => {});
}

export const auditLog = (entry: Record<string, unknown>) => auditAdd(entry);
export { errMsg } from './util';
