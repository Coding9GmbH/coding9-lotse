// Supplier import: planning (pure, no shop access → testable).
// Rows + mapping + resolved catalog → one plan per product (new / update / add variants) + readable change set.
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { eur, net } from '../changes';
import { sanitizeHtml } from '../html-sanitize';
import type { SwEntity } from '../shopware';
import { columnDecimal, parseNumber, type Table } from './import-parse';
import { FIELD_LABELS, type ImportMapping, type ScalarTarget } from './import-mapping';

export const IMPORT_KIND = 'supplier-import';
export const IMPORT_MAX = 2000;   // rows per change set (larger files in sections: offset/limit)
export const ITEM_LIMIT = 100;    // up to this, one row per product in the card; above, groups + sample
const SAMPLE = 50;

export interface ImportOptions {
  /** both = update existing + create new (default), create = new only, update = existing only */
  mode?: 'both' | 'create' | 'update';
  /** Target fields overwritten on existing products (default: all mapped ones except prices/stock/tax) */
  updateFields?: string[];
  /** Overwrite prices (price, list price, purchase price) of existing products, only after explicit confirmation */
  updatePrices?: boolean;
  /** Overwrite stock of existing products, only after explicit confirmation */
  updateStock?: boolean;
  /** new products active immediately (default false = draft) */
  active?: boolean;
  defaultTaxRate?: number;
  /** Category text from the file → categoryId ("" = no category) */
  categoryMap?: Record<string, string>;
  /** Category for new products without a (matching) category */
  defaultCategoryId?: string;
  /** create missing manufacturers or properties/options (default true) */
  createManufacturers?: boolean;
  createProperties?: boolean;
  offset?: number; limit?: number;
}

export interface ImportCatalog {
  /** existing products (incl. variants) whose number or EAN appears in the file */
  products: SwEntity[];
  categories: { id: string; path: string[] }[];
  manufacturers: SwEntity[];
  /** Property groups incl. options */
  groups: SwEntity[];
  taxes: SwEntity[];
  deliveryTimes: SwEntity[];
  currencyId: string;
  /** Notes from loading (e.g. category list truncated) */
  notes?: string[];
}

// ---- Plan (Payload) ----
export type Group = 'create' | 'create-warn' | 'update' | 'update-warn';
export interface ImageJob { productId: string; urls: string[]; alt: string; cover: boolean }
export interface NewEntity { id: string; entity: 'product-manufacturer' | 'property-group' | 'property-group-option'; data: Record<string, unknown>; label: string; needs?: string }
interface Base { key: string; line: number; group: Group; label: string; number: string; uses: string[]; images: ImageJob[] }
/** New product (possibly with variants): product is the finished record without images/visibility */
export interface CreatePlan extends Base { kind: 'create'; id: string; product: Record<string, unknown>; childIds: string[]; /** parent product without its own row (built from the variants) */ synthetic?: boolean }
/** Existing product: only mapped, changed fields; prices/stock only with the approval option */
export interface UpdatePlan extends Base {
  kind: 'update'; id: string;
  set: Record<string, unknown>;
  price?: { gross?: number; list?: number | null };
  stock?: number; purchase?: number; taxRate: number;
  addProperties: string[]; addCategories: string[];
}
/** New variants under an existing parent product */
export interface VariantPlan extends Base { kind: 'variants'; id: string; children: Record<string, unknown>[]; configurator: string[] }
export type ImportPlan = CreatePlan | UpdatePlan | VariantPlan;
export interface ImportPayload { plans: ImportPlan[]; creates: NewEntity[] }

// ---- Reading rows ----
export interface Rec {
  line: number; number?: string; ean?: string; name?: string; description?: string;
  gross?: number; net?: number; taxRate?: number; list?: number; purchase?: number; stock?: number;
  manufacturer?: string; manufacturerNumber?: string; category?: string; weight?: number; width?: number; height?: number; length?: number;
  images: string[]; parent?: string; deliveryTime?: string; metaTitle?: string; metaDescription?: string; keywords?: string;
  props: { group: string; value: string }[]; axes: { group: string; value: string }[]; problems: string[];
}
const URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Description: text → paragraphs; HTML through the allowlist sanitizer (formatting tags only, link targets only http(s), mailto, tel, relative) */
export function toHtml(s: string): string {
  const h = s.search(/<\/?[a-z]/i);
  if (h >= 0 && s.indexOf('>', h) >= 0) return sanitizeHtml(s).trim();
  return s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}
const clean = (s: string | undefined, max = 255) => { const v = String(s ?? '').replace(/\s+/g, ' ').trim(); return v ? v.slice(0, max) : undefined; };

export function readRecords(t: Table, m: ImportMapping): Rec[] {
  const idx = (c?: string) => (c ? t.headers.indexOf(c) : -1);
  const dec: Record<string, ',' | '.'> = {};
  for (const k of ['priceGross', 'priceNet', 'taxRate', 'listPrice', 'purchasePrice', 'stock', 'weight', 'width', 'height', 'length'] as const) {
    const i = idx(m[k]); if (i >= 0) dec[k] = columnDecimal(t.rows.slice(0, 500).map(r => r[i] ?? ''), t.delimiter);
  }
  const dim = m.units?.dimensions === 'cm' ? 10 : m.units?.dimensions === 'm' ? 1000 : 1, wf = m.units?.weight === 'g' ? 0.001 : 1;
  return t.rows.map((r, n) => {
    const get = (k: ScalarTarget) => { const i = idx(m[k]); return i >= 0 ? (r[i] ?? '').trim() : ''; };
    const rec: Rec = { line: t.headerRow + 1 + n, images: [], props: [], axes: [], problems: [] };
    const num = (k: keyof typeof dec, label: string) => {
      const raw = get(k as ScalarTarget); if (!raw) return undefined;
      const v = parseNumber(raw, dec[k]); if (v == null || v < 0) { rec.problems.push(`${label} „${raw}“ ist keine gültige Zahl`); return undefined; }
      return v;
    };
    rec.number = clean(get('productNumber'), 64); rec.ean = clean(get('ean'), 64)?.replace(/\.0+$/, ''); rec.name = clean(get('name'));
    const d = get('description'); if (d) rec.description = toHtml(d);
    rec.gross = num('priceGross', 'Preis brutto'); rec.net = num('priceNet', 'Preis netto'); rec.list = num('listPrice', 'Streichpreis'); rec.purchase = num('purchasePrice', 'Einkaufspreis');
    const tr = num('taxRate', 'Steuersatz'); if (tr != null) rec.taxRate = tr > 0 && tr < 1 ? Math.round(tr * 10000) / 100 : tr;
    const st = num('stock', 'Bestand'); if (st != null) rec.stock = Math.round(st);
    const w = num('weight', 'Gewicht'); if (w != null) rec.weight = Math.round(w * wf * 1000) / 1000;
    for (const k of ['width', 'height', 'length'] as const) { const v = num(k, FIELD_LABELS[k]); if (v != null) rec[k] = Math.round(v * dim * 100) / 100; }
    rec.manufacturer = clean(get('manufacturer')); rec.manufacturerNumber = clean(get('manufacturerNumber')); rec.category = clean(get('category'), 1000);
    rec.parent = clean(get('parentNumber'), 64); rec.deliveryTime = clean(get('deliveryTime'));
    rec.metaTitle = clean(get('metaTitle')); rec.metaDescription = clean(get('metaDescription'), 1000); rec.keywords = clean(get('keywords'), 1000);
    for (const c of m.images ?? []) for (const u of (r[idx(c)] ?? '').split(/[\s,;|]+/).filter(Boolean)) {
      if (URL_RE.test(u)) { if (!rec.images.includes(u)) rec.images.push(u); } else rec.problems.push(`Bild „${u.slice(0, 60)}“ ist keine http(s)-URL`);
    }
    for (const p of m.properties ?? []) for (const v of (r[idx(p.column)] ?? '').split(/\s*[,;|]\s*/).map(x => x.trim()).filter(Boolean)) rec.props.push({ group: p.group.trim(), value: v.slice(0, 255) });
    for (const p of m.variantOptions ?? []) { const v = clean(r[idx(p.column)]); if (v) rec.axes.push({ group: p.group.trim(), value: v }); }
    return rec;
  });
}

// ---- Categories ----
const low = (s: string) => s.trim().toLocaleLowerCase('de-DE');
const SEP = /\s*(?:>|»|\/|\\)\s*/;
/** Category text ("Wohnen > Vasen", several separated by |) → ids; ambiguous/unknown paths as errors */
export function resolveCategories(text: string, cats: ImportCatalog['categories'], map: Record<string, string> = {}): { ids: string[]; missing: string[]; raw: string[] } {
  const ids: string[] = [], missing: string[] = [], raw: string[] = [];
  for (const t of text.split(/\s*[|;\n]\s*/).filter(Boolean)) {
    if (t in map) { if (map[t]) ids.push(map[t]); continue; }
    const parts = t.split(SEP).map(low).filter(Boolean);
    const hits = cats.filter(c => { const p = c.path.map(low); return p.length >= parts.length && parts.every((x, i) => p[p.length - parts.length + i] === x); });
    const exact = hits.filter(c => c.path.length === parts.length || c.path.length === parts.length + 1);
    const pick = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : null;
    if (pick) { if (!ids.includes(pick.id)) ids.push(pick.id); } else { missing.push(hits.length ? `${t} (mehrdeutig)` : t); raw.push(t); }
  }
  return { ids, missing, raw };
}

// ---- New entities (manufacturers, properties) ----
class Registry {
  list: NewEntity[] = [];
  constructor(private cat: ImportCatalog, private genId: () => string, private opts: ImportOptions) {}
  manufacturer(name: string): string {
    const ex = this.cat.manufacturers.find(m => low(String(m.translated?.name ?? m.name ?? '')) === low(name));
    if (ex) return ex.id;
    const n = this.list.find(e => e.entity === 'product-manufacturer' && low(String(e.data.name)) === low(name));
    if (n) return n.id;
    if (this.opts.createManufacturers === false) throw new Error(`Hersteller „${name}“ gibt es nicht`);
    const id = this.genId(); this.list.push({ id, entity: 'product-manufacturer', data: { name }, label: `Hersteller „${name}“` }); return id;
  }
  option(group: string, value: string): string {
    const g = this.cat.groups.find(x => low(String(x.translated?.name ?? x.name ?? '')) === low(group));
    const ng = g ? null : this.list.find(e => e.entity === 'property-group' && low(String(e.data.name)) === low(group));
    const groupId = g?.id ?? ng?.id;
    const o = g ? (g.options ?? []).find((x: SwEntity) => low(String(x.translated?.name ?? x.name ?? '')) === low(value)) : null;
    if (o) return o.id;
    const no = this.list.find(e => e.entity === 'property-group-option' && e.data.groupId === groupId && low(String(e.data.name)) === low(value));
    if (no && groupId) return no.id;
    if (this.opts.createProperties === false) throw new Error(`Eigenschaft „${group}: ${value}“ gibt es nicht`);
    let gid = groupId;
    if (!gid) { gid = this.genId(); this.list.push({ id: gid, entity: 'property-group', data: { name: group, displayType: 'text', sortingType: 'alphanumeric' }, label: `Eigenschaft „${group}“` }); }
    const id = this.genId(), pos = (g?.options?.length ?? 0) + this.list.filter(e => e.entity === 'property-group-option' && e.data.groupId === gid).length + 1;
    this.list.push({ id, entity: 'property-group-option', data: { groupId: gid, name: value, position: pos }, label: `Ausprägung „${group}: ${value}“`, needs: gid });
    return id;
  }
}

// ---- Planning ----
interface Ctx { cat: ImportCatalog; opts: ImportOptions; reg: Registry; genId: () => string; skipped: ChangeSet['skipped']; images: boolean; hasCategory: boolean; missingCats: Set<string> }
const priceEntry = (cur: string, gross: number, rate: number, list?: number | null) => ({ currencyId: cur, gross, net: net(gross, rate), linked: true, ...(list != null ? { listPrice: { currencyId: cur, gross: list, net: net(list, rate), linked: true } } : {}) });
const taxFor = (cat: ImportCatalog, rate: number) => cat.taxes.find(t => Number(t.taxRate) === rate);
/** Gross price: gross column or net × tax rate */
const grossOf = (r: Rec, rate: number) => (r.gross != null ? Math.round(r.gross * 100) / 100 : r.net != null ? Math.round(r.net * (1 + rate / 100) * 100) / 100 : undefined);
const cut = (s: unknown, n = 60) => { const v = String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return v ? (v.length > n ? v.slice(0, n) + '…' : v) : '–'; };
const nameOf = (e: SwEntity | null | undefined) => String(e?.translated?.name ?? e?.name ?? '');
const newOnly = (reg: Registry, ids: string[]) => ids.filter(id => reg.list.some(e => e.id === id));

function deliveryTimeId(ctx: Ctx, name?: string): string | undefined {
  if (!name) return undefined;
  const d = ctx.cat.deliveryTimes.find(x => x.id === name || low(nameOf(x)) === low(name));
  if (!d) throw new Error(`Lieferzeit „${name}“ gibt es nicht (vorhanden: ${ctx.cat.deliveryTimes.map(nameOf).join(', ')})`);
  return d.id;
}

/** Common fields of a new product / new variant from a row */
function baseData(r: Rec) {
  return {
    ...(r.ean ? { ean: r.ean } : {}), ...(r.manufacturerNumber ? { manufacturerNumber: r.manufacturerNumber } : {}),
    ...(r.weight != null ? { weight: r.weight } : {}), ...(r.width != null ? { width: r.width } : {}), ...(r.height != null ? { height: r.height } : {}), ...(r.length != null ? { length: r.length } : {}),
  };
}

function planCreate(ctx: Ctx, r: Rec, kids: Rec[], warn: string[]): CreatePlan {
  const { cat, opts, reg, genId } = ctx;
  if (!r.number) throw new Error('Produktnummer fehlt');
  if (!r.name) throw new Error('Name fehlt');
  const rate = r.taxRate ?? opts.defaultTaxRate ?? 19, tax = taxFor(cat, rate);
  if (!tax) throw new Error(`Steuersatz ${rate} % gibt es im Shop nicht`);
  const gross = grossOf(r, rate);
  if (gross == null) throw new Error('Preis fehlt (für neue Produkte Pflicht)');
  const id = genId(), uses: string[] = [];
  const manufacturerId = r.manufacturer ? reg.manufacturer(r.manufacturer) : undefined;
  if (manufacturerId) uses.push(manufacturerId);
  const props = r.props.map(p => reg.option(p.group, p.value)); uses.push(...props);
  let categoryIds: string[] = [];
  if (r.category) {
    const c = resolveCategories(r.category, cat.categories, opts.categoryMap);
    categoryIds = c.ids;
    c.raw.forEach(x => ctx.missingCats.add(x));
    if (c.missing.length) warn.push(`Kategorie ${c.missing.map(x => `„${x}“`).join(', ')} nicht gefunden (${categoryIds.length ? 'nur gefundene zugeordnet' : opts.defaultCategoryId ? 'Standardkategorie' : 'ohne Kategorie'})`);
  }
  if (!categoryIds.length && opts.defaultCategoryId) categoryIds = [opts.defaultCategoryId];
  if (!categoryIds.length && ctx.hasCategory && !r.category) warn.push('ohne Kategorie');
  if (gross === 0) warn.push('Preis 0 €');
  if (r.purchase != null && r.purchase > net(gross, rate)) warn.push(`unter Einkaufspreis (${eur(r.purchase)} netto)`);
  if (r.list != null && r.list <= gross) warn.push('Streichpreis ≤ Preis');
  const active = opts.active === true; if (active) warn.push('Wird sofort aktiv im Shop');
  const product: Record<string, unknown> = {
    id, productNumber: r.number, name: r.name, taxId: tax.id, stock: r.stock ?? 0, active,
    price: [priceEntry(cat.currencyId, gross, rate, r.list)],
    ...(r.purchase != null ? { purchasePrices: [{ currencyId: cat.currencyId, net: r.purchase, gross: Math.round(r.purchase * (1 + rate / 100) * 100) / 100, linked: true }] } : {}),
    ...(r.description ? { description: r.description } : {}), ...(r.metaTitle ? { metaTitle: r.metaTitle } : {}), ...(r.metaDescription ? { metaDescription: r.metaDescription } : {}), ...(r.keywords ? { keywords: r.keywords } : {}),
    ...baseData(r), ...(manufacturerId ? { manufacturerId } : {}), ...(props.length ? { properties: [...new Set(props)].map(x => ({ id: x })) } : {}),
    ...(categoryIds.length ? { categories: categoryIds.map(x => ({ id: x })) } : {}),
  };
  const dt = deliveryTimeId(ctx, r.deliveryTime); if (dt) product.deliveryTimeId = dt;
  const images: ImageJob[] = r.images.length ? [{ productId: id, urls: r.images, alt: r.name, cover: true }] : [];
  // Variants: own price only if it differs from the parent product (otherwise inherited)
  const childIds: string[] = [];
  if (kids.length) {
    const combos = new Set<string>();
    const children = kids.map(k => planChild(ctx, k, gross, rate, warn, images, combos)).filter((c): c is Record<string, unknown> => !!c);
    if (!children.length) throw new Error('keine gültige Variante');
    const optIds = [...new Set(children.flatMap(c => (c.options as { id: string }[]).map(o => o.id)))];
    product.children = children; product.configuratorSettings = optIds.map(optionId => ({ id: genId(), optionId }));
    uses.push(...optIds); childIds.push(...children.map(c => c.id as string));
  }
  if (ctx.images && !r.images.length && !kids.some(k => k.images.length)) warn.push('ohne Bild');
  return { kind: 'create', key: `n${r.line}`, line: r.line, group: 'create', label: `${r.name} (${r.number})`, number: r.number, id, product, childIds, images, uses: newOnly(reg, uses) };
}

const comboKey = (ids: string[]) => [...new Set(ids)].sort().join('|');
function planChild(ctx: Ctx, k: Rec, parentGross: number, rate: number, warn: string[], images: ImageJob[], combos: Set<string>): Record<string, unknown> | null {
  try {
    if (!k.number) throw new Error('Produktnummer fehlt');
    if (!k.axes.length) throw new Error('keine Varianten-Ausprägung (z. B. Farbe/Größe) angegeben');
    const options = k.axes.map(a => ({ id: ctx.reg.option(a.group, a.value) })), key = comboKey(options.map(o => o.id));
    if (combos.has(key)) throw new Error(`Variante ${k.axes.map(a => `${a.group}: ${a.value}`).join(', ')} gibt es schon`);
    combos.add(key);
    const id = ctx.genId();
    const g = grossOf(k, k.taxRate ?? rate);
    const own = g != null && g !== parentGross;
    if (own && g === 0) warn.push(`${k.number}: Preis 0 €`);
    if (k.images.length) images.push({ productId: id, urls: k.images, alt: `${k.name ?? ''} ${k.axes.map(a => a.value).join(' ')}`.trim(), cover: true });
    return { id, productNumber: k.number, stock: k.stock ?? 0, options, ...baseData(k), ...(own || k.list != null ? { price: [priceEntry(ctx.cat.currencyId, g ?? parentGross, rate, k.list)] } : {}) };
  } catch (e) { ctx.skipped.push({ id: `v${k.line}`, reason: `Zeile ${k.line} (${k.number ?? '?'}): ${e instanceof Error ? e.message : e}` }); return null; }
}

const PRICE_T = ['priceGross', 'priceNet', 'listPrice', 'purchasePrice'];
const DEFAULT_SKIP = new Set([...PRICE_T, 'stock', 'taxRate', 'productNumber', 'parentNumber']);
const SCALAR: [ScalarTarget, keyof Rec][] = [['name', 'name'], ['description', 'description'], ['metaTitle', 'metaTitle'], ['metaDescription', 'metaDescription'], ['keywords', 'keywords'], ['ean', 'ean'], ['manufacturerNumber', 'manufacturerNumber'], ['weight', 'weight'], ['width', 'width'], ['height', 'height'], ['length', 'length']];
export interface Diff { field: string; label: string; before: string; after: string; html?: { before: string; after: string } }

function planUpdate(ctx: Ctx, r: Rec, cur: SwEntity, m: ImportMapping, warn: string[], parent?: SwEntity): { plan: UpdatePlan; diffs: Diff[] } {
  const { opts, reg } = ctx;
  const allowed = new Set(opts.updateFields ?? Object.keys(m).filter(k => !DEFAULT_SKIP.has(k)));
  if (opts.updatePrices) PRICE_T.forEach(k => allowed.add(k));
  if (opts.updateStock) allowed.add('stock');
  const on = (k: string) => allowed.has(k) && (k !== 'stock' || opts.updateStock) && (!PRICE_T.includes(k) || opts.updatePrices);
  const diffs: Diff[] = [], set: Record<string, unknown> = {}, uses: string[] = [];
  const plan: UpdatePlan = { kind: 'update', key: `u${r.line}`, line: r.line, group: 'update', label: `${nameOf(cur) || nameOf(parent)} (${cur.productNumber})`, number: cur.productNumber, id: cur.id, set, addProperties: [], addCategories: [], images: [], uses, taxRate: Number((cur.tax ?? parent?.tax)?.taxRate ?? 19) };
  for (const [t, k] of SCALAR) {
    const v = r[k]; if (v == null || v === '' || !on(t)) continue;
    const old = cur[t] ?? cur.translated?.[t] ?? null;
    if (old === v || (typeof v === 'number' && Number(old) === v)) continue;
    set[t] = v;
    const fmt = (x: unknown) => (typeof v === 'number' ? (x == null ? '–' : `${Number(x).toLocaleString('de-DE', { maximumFractionDigits: 3 })} ${t === 'weight' ? 'kg' : 'mm'}`) : cut(x));
    diffs.push({ field: t, label: FIELD_LABELS[t], before: fmt(old), after: fmt(v), ...(t === 'description' ? { html: { before: String(old ?? '').slice(0, 4000), after: String(v).slice(0, 4000) } } : {}) });
  }
  if (r.manufacturer && on('manufacturer')) {
    const mid = reg.manufacturer(r.manufacturer);
    if (mid !== cur.manufacturerId) { set.manufacturerId = mid; uses.push(mid); diffs.push({ field: 'manufacturer', label: 'Hersteller', before: cur.manufacturer ? nameOf(cur.manufacturer) : '–', after: `${r.manufacturer}${reg.list.some(e => e.id === mid) ? ' (neu)' : ''}` }); }
  }
  if (r.deliveryTime && on('deliveryTime')) {
    const dt = deliveryTimeId(ctx, r.deliveryTime);
    if (dt !== cur.deliveryTimeId) { set.deliveryTimeId = dt; diffs.push({ field: 'deliveryTime', label: 'Lieferzeit', before: cur.deliveryTime ? nameOf(cur.deliveryTime) : '–', after: r.deliveryTime }); }
  }
  if (r.props.length && on('properties')) {
    const have = new Set((cur.properties ?? []).map((p: SwEntity) => p.id));
    const add = [...new Set(r.props.map(p => reg.option(p.group, p.value)))].filter(id => !have.has(id));
    if (add.length) { plan.addProperties = add; uses.push(...add); diffs.push({ field: 'properties', label: 'Eigenschaften', before: have.size ? `${have.size} vorhanden` : 'keine', after: `+ ${r.props.filter(p => add.includes(reg.option(p.group, p.value))).map(p => `${p.group}: ${p.value}`).join(', ')}` }); }
  }
  if (r.category && on('category')) {
    const c = resolveCategories(r.category, ctx.cat.categories, opts.categoryMap), have = new Set((cur.categories ?? []).map((x: SwEntity) => x.id));
    c.raw.forEach(x => ctx.missingCats.add(x));
    if (c.missing.length) warn.push(`Kategorie ${c.missing.map(x => `„${x}“`).join(', ')} nicht gefunden`);
    const add = c.ids.filter(id => !have.has(id));
    if (add.length) { plan.addCategories = add; diffs.push({ field: 'category', label: 'Kategorie', before: have.size ? `${have.size} zugeordnet` : 'keine', after: `+ ${add.map(id => ctx.cat.categories.find(x => x.id === id)?.path.join(' > ') ?? id).join(', ')}` }); }
  }
  if (r.images.length && on('images')) {
    if ((cur.media ?? []).length) warn.push('hat schon Bilder (Bild-URLs nicht übernommen)');
    else { plan.images = [{ productId: cur.id, urls: r.images, alt: r.name ?? nameOf(cur), cover: true }]; diffs.push({ field: 'images', label: 'Bilder', before: 'keine', after: `${r.images.length} ${r.images.length === 1 ? 'Bild' : 'Bilder'} (Import beim Anwenden)` }); }
  }
  // Prices/stock only on explicit request (updatePrices/updateStock)
  const p0 = (cur.price ?? parent?.price)?.[0], inherited = !cur.price && !!cur.parentId;
  const gross = on('priceGross') || on('priceNet') ? grossOf(r, r.taxRate ?? plan.taxRate) : undefined;
  if (gross != null && gross !== p0?.gross) {
    plan.price = { gross }; diffs.push({ field: 'price', label: 'Preis (brutto)', before: `${eur(p0?.gross)}${inherited ? ' (geerbt)' : ''}`, after: eur(gross) });
    if (p0?.gross > 0 && Math.abs((gross - p0.gross) / p0.gross) >= 0.3) warn.push(`Preisänderung ${gross > p0.gross ? '+' : '−'}${Math.abs(((gross - p0.gross) / p0.gross) * 100).toFixed(0)} %`);
    if (gross === 0) warn.push('Preis 0 €');
  }
  if (r.list != null && on('listPrice') && r.list !== (p0?.listPrice?.gross ?? null)) {
    plan.price = { ...plan.price, list: r.list }; diffs.push({ field: 'listPrice', label: 'Streichpreis', before: eur(p0?.listPrice?.gross), after: eur(r.list) });
    if (r.list <= (plan.price.gross ?? p0?.gross ?? 0)) warn.push('Streichpreis ≤ Preis');
  }
  if (plan.price && inherited) warn.push('Variante bekommt eigenen Preis (bisher geerbt)');
  if (r.purchase != null && on('purchasePrice') && r.purchase !== (cur.purchasePrices?.[0]?.net ?? null)) { plan.purchase = r.purchase; diffs.push({ field: 'purchasePrice', label: 'Einkaufspreis (netto)', before: eur(cur.purchasePrices?.[0]?.net), after: eur(r.purchase) }); }
  if (r.stock != null && on('stock') && r.stock !== cur.stock) {
    plan.stock = r.stock; diffs.push({ field: 'stock', label: 'Bestand', before: String(cur.stock ?? '–'), after: String(r.stock) });
    if (cur.stock > 0 && r.stock === 0) warn.push('Bestand auf 0');
  }
  plan.uses = newOnly(reg, uses);
  return { plan, diffs };
}

function planVariants(ctx: Ctx, parent: SwEntity, kids: Rec[], warn: string[]): VariantPlan {
  const p0 = parent.price?.[0], rate = Number(parent.tax?.taxRate ?? 19), images: ImageJob[] = [];
  const combos = new Set<string>((parent.children ?? []).map((c: SwEntity) => comboKey((c.options ?? []).map((o: SwEntity) => o.id))).filter(Boolean));
  const children = kids.map(k => planChild(ctx, k, p0?.gross ?? NaN, rate, warn, images, combos)).filter((c): c is Record<string, unknown> => !!c);
  if (!children.length) throw new Error('keine gültige neue Variante');
  const have = new Set((parent.configuratorSettings ?? []).map((s: SwEntity) => s.optionId));
  const opts = [...new Set(children.flatMap(c => (c.options as { id: string }[]).map(o => o.id)))];
  const axisGroups = new Set((parent.children ?? []).flatMap((c: SwEntity) => (c.options ?? []).map((o: SwEntity) => low(nameOf(o.group)))));
  if (axisGroups.size && kids.some(k => k.axes.some(a => !axisGroups.has(low(a.group))))) warn.push(`Vorhandene Varianten nutzen andere Eigenschaften (${[...axisGroups].join(', ')})`);
  return { kind: 'variants', key: `v${kids[0].line}`, line: kids[0].line, group: 'create', label: `${nameOf(parent)} (${parent.productNumber})`, number: parent.productNumber, id: parent.id, children: children.map(c => ({ ...c, parentId: parent.id })), configurator: opts.filter(o => !have.has(o)), images, uses: newOnly(ctx.reg, opts) };
}

/** Parent product name from variant rows: common leading words without options (e.g. "Sand") and trailing separators */
export function commonName(names: string[], values: string[] = []): string {
  if (!names.length) return '';
  const words = names.map(n => n.split(/\s+/)), drop = new Set(values.map(low));
  const out: string[] = [];
  for (let i = 0; words.every(w => w[i] != null && w[i] === words[0][i]); i++) out.push(words[0][i]);
  while (out.length && drop.has(low(out[out.length - 1].replace(/[,;:/–-]+$/, '')))) out.pop();
  return out.join(' ').replace(/[\s,;:–\-/]+$/, '') || names[0];
}

/** Section of a large file (offset/limit); variant families are not split */
export function sectionRange(all: Rec[], opts: ImportOptions): { offset: number; end: number } {
  const offset = Math.max(0, opts.offset ?? 0);
  let end = Math.min(all.length, offset + Math.min(opts.limit ?? IMPORT_MAX, IMPORT_MAX));
  while (end < all.length && all[end].parent && all[end].parent === all[end - 1]?.parent) end++;
  return { offset, end };
}

export interface PlanResult { cs: ChangeSet; payload: ImportPayload; stats: { rows: number; create: number; update: number; variants: number; variantRows: number; synthetic: number; skipped: number; unchanged: number; nextOffset: number | null; unknownCategories: string[]; notes: string[] } }

export function planImport(t: Table, m: ImportMapping, cat: ImportCatalog, opts: ImportOptions, meta: { title: string; reason: string; fileName: string }, genId: () => string): PlanResult {
  const all = readRecords(t, m), { offset, end } = sectionRange(all, opts);
  const recs = all.slice(offset, end);
  if (!recs.length) throw new Error(`Keine Zeilen ab Zeile ${offset + 1} (Datei hat ${all.length} Datenzeilen)`);
  const skipped: ChangeSet['skipped'] = [], reg = new Registry(cat, genId, opts), ctx: Ctx = { cat, opts, reg, genId, skipped, images: !!m.images?.length, hasCategory: !!m.category, missingCats: new Set() };
  const mode = opts.mode ?? 'both';
  const byNumber = new Map(cat.products.map(p => [String(p.productNumber), p])), byId = new Map(cat.products.map(p => [p.id, p]));
  const byEan = new Map<string, SwEntity[]>(); for (const p of cat.products) if (p.ean) byEan.set(String(p.ean), [...(byEan.get(String(p.ean)) ?? []), p]);
  const lineOf = (s: { reason: string }) => parseInt(s.reason.match(/^Zeile (\d+)/)?.[1] ?? '0', 10);
  const skip = (r: Rec, reason: string) => skipped.push({ id: `z${r.line}`, reason: `Zeile ${r.line}${r.number ? ` (${r.number})` : ''}: ${reason}` });
  const match = (r: Rec, warn: string[]): SwEntity | null => {
    const n = r.number ? byNumber.get(r.number) : undefined, e = r.ean ? byEan.get(r.ean) : undefined;
    if (n) { if (e?.length && !e.some(x => x.id === n.id)) { warn.push(`EAN ${r.ean} gehört zu ${e[0].productNumber}`); delete r.ean; } return n; }
    if (e?.length === 1 && !(r.number && m.productNumber)) return e[0]; // EAN matching only without a product number
    if (e?.length) { warn.push(`EAN ${r.ean} gehört schon zu ${e[0].productNumber}`); delete r.ean; }
    return null;
  };

  const seen = new Set<string>(), valid: Rec[] = [];
  for (const r of recs) {
    if (!r.number && !r.ean) { skip(r, 'weder Produktnummer noch EAN'); continue; }
    const k = r.number ?? `ean:${r.ean}`;
    if (seen.has(k)) { skip(r, 'doppelt in der Datei (nur die erste Zeile zählt)'); continue; }
    seen.add(k); valid.push(r);
  }
  // Families: rows with parent product no. ≠ own number are variants
  const fam = new Map<string, Rec[]>();
  for (const r of valid) if (r.parent && r.parent !== r.number) fam.set(r.parent, [...(fam.get(r.parent) ?? []), r]);
  const isVariant = (r: Rec) => !!r.parent && r.parent !== r.number;
  const parentRow = new Map(valid.filter(r => r.number && fam.has(r.number)).map(r => [r.number!, r]));

  const out: { plan: ImportPlan; diffs?: Diff[]; warn: string[] }[] = []; let unchanged = 0;
  /** onFail: for families, skip all variant rows with a reason (except those already skipped individually) */
  const run = (r: Rec, fn: (warn: string[]) => { plan: ImportPlan; diffs?: Diff[] } | null, onFail?: (msg: string) => void) => {
    const warn = [...r.problems];
    try { const x = fn(warn); if (x) { if (warn.length) x.plan.group = x.plan.group === 'create' ? 'create-warn' : 'update-warn'; out.push({ ...x, warn }); } }
    catch (e) { const msg = e instanceof Error ? e.message : String(e); if (onFail) onFail(msg); else skip(r, msg); }
  };
  const failAll = (rows: Rec[], prefix: string) => {
    const mark = skipped.length;
    return (msg: string) => { const done = new Set(skipped.slice(mark).map(lineOf)); rows.forEach(k => { if (!done.has(k.line)) skip(k, `${prefix}: ${msg}`); }); };
  };
  // Variants without a parent product in the plan inherit tax/price from the parent product in the shop
  const update = (r: Rec, cur: SwEntity, parent: SwEntity | undefined = cur.parentId ? byId.get(cur.parentId) : undefined) => run(r, warn => {
    if (mode === 'create') throw new Error(`existiert bereits (${cur.productNumber}) – Modus „nur neue“`);
    const x = planUpdate(ctx, r, cur, m, warn, parent);
    if (!x.diffs.length) { unchanged++; return null; }
    return x;
  });
  for (const r of valid) {
    if (isVariant(r)) continue; // variants below, per family
    const kids = r.number ? fam.get(r.number) ?? [] : [];
    const cur = match(r, r.problems);
    if (cur) {
      update(r, cur);
      // Children of an existing family: update existing ones, add new ones as variants
      if (kids.length) famExisting(cur, kids);
      continue;
    }
    if (mode === 'update') { skip(r, 'nicht im Shop (Modus „nur aktualisieren“)'); kids.forEach(k => skip(k, 'Hauptprodukt nicht im Shop')); continue; }
    const fresh = kids.filter(k => { if (!match(k, k.problems)) return true; skip(k, `Produktnummer ${k.number} existiert bereits (Hauptprodukt ${r.number} ist neu)`); return false; });
    const famFail = fresh.length ? failAll(fresh, `Hauptprodukt ${r.number} konnte nicht angelegt werden`) : undefined;
    run(r, warn => ({ plan: planCreate(ctx, r, fresh, warn) }), famFail && (msg => { skip(r, msg); famFail(msg); }));
  }
  // Families without their own row for the parent product
  for (const [pn, kids] of fam) {
    const pr = parentRow.get(pn);
    if (pr && !isVariant(pr)) continue;
    if (pr) { kids.forEach(k => skip(k, `Hauptprodukt ${pn} ist selbst eine Variante`)); continue; }
    const cur = byNumber.get(pn);
    if (cur) { famExisting(cur, kids); continue; }
    if (mode === 'update') { kids.forEach(k => { const c = match(k, k.problems); if (c) update(k, c); else skip(k, 'nicht im Shop (Modus „nur aktualisieren“)'); }); continue; }
    const fresh = kids.filter(k => { const c = match(k, k.problems); if (c) { update(k, c); return false; } return true; });
    if (!fresh.length) continue;
    // Build the parent product from the variant rows: common name, most frequent price, data of the first row
    const first = fresh[0], rate = first.taxRate ?? opts.defaultTaxRate ?? 19;
    const prices = fresh.map(k => grossOf(k, k.taxRate ?? rate)).filter((x): x is number => x != null);
    const mode2 = prices.sort((a, b) => prices.filter(x => x === b).length - prices.filter(x => x === a).length)[0];
    const synth: Rec = { ...first, line: first.line, number: pn, ean: undefined, manufacturerNumber: undefined, name: commonName(fresh.filter(k => k.axes.length).map(k => k.name ?? '').filter(Boolean), fresh.flatMap(k => k.axes.map(a => a.value))) || first.name, gross: mode2, net: undefined, list: undefined, stock: 0, images: [], axes: [], problems: [] };
    run(first, warn => { warn.push('Hauptprodukt aus den Variantenzeilen gebildet'); return { plan: { ...planCreate(ctx, synth, fresh, warn), synthetic: true } }; }, failAll(fresh, `Hauptprodukt ${pn} konnte nicht angelegt werden`));
  }
  function famExisting(parent: SwEntity, kids: Rec[]) {
    const fresh: Rec[] = [];
    for (const k of kids) { const c = match(k, k.problems); if (c) { if (c.parentId && c.parentId !== parent.id) skip(k, `gehört zu einem anderen Hauptprodukt`); else update(k, c, parent); } else fresh.push(k); }
    if (!fresh.length) return;
    if (mode === 'update') { fresh.forEach(k => skip(k, 'neue Variante (Modus „nur aktualisieren“)')); return; }
    if (parent.parentId) { fresh.forEach(k => skip(k, `${parent.productNumber} ist selbst eine Variante`)); return; }
    run(fresh[0], warn => ({ plan: planVariants(ctx, parent, fresh, warn) }), failAll(fresh, `Varianten für ${parent.productNumber} nicht möglich`));
  }

  skipped.sort((a, b) => lineOf(a) - lineOf(b));
  if (!out.length) throw new Error(`Nichts zu importieren (${unchanged} unverändert, ${skipped.length} übersprungen${skipped.length ? `: ${skipped.slice(0, 4).map(s => s.reason).join('; ')}` : ''})`);
  out.sort((a, b) => a.plan.line - b.plan.line);
  // ---- Card ----
  const itemOf = ({ plan, diffs, warn }: (typeof out)[number]): ChangeItem => {
    const base = { id: `p:${plan.key}`, entity: 'product', entityId: plan.id, label: plan.label, warn };
    if (plan.kind === 'update') return { ...base, field: 'update', fieldLabel: diffs!.map(d => d.label).join(', '), before: diffs!.map(d => d.before).join(' · '), after: diffs!.map(d => d.after).join(' · '), ...(diffs!.find(d => d.html) ? { html: diffs!.find(d => d.html)!.html } : {}) };
    if (plan.kind === 'variants') return { ...base, field: 'variants', fieldLabel: `${plan.children.length} neue ${plan.children.length === 1 ? 'Variante' : 'Varianten'}`, before: '–', after: plan.children.map(c => c.productNumber).join(', ') };
    const p = plan.product, kids = (p.children as unknown[] | undefined)?.length ?? 0, price = (p.price as { gross: number }[])[0].gross;
    const cats = ((p.categories as { id: string }[] | undefined) ?? []).map(c => cat.categories.find(x => x.id === c.id)?.path.join(' > ')).filter(Boolean);
    const man = reg.list.find(e => e.id === p.manufacturerId);
    return { ...base, field: 'create', fieldLabel: kids ? `Neues Produkt mit ${kids} Varianten` : 'Neues Produkt',
      before: '–', after: [eur(price), p.active ? 'aktiv' : 'inaktiv (Entwurf)', `Bestand ${p.stock}`, ...cats, man ? `${man.data.name} (neu)` : '', plan.images.length ? `${plan.images.reduce((n, j) => n + j.urls.length, 0)} Bild(er)` : ''].filter(Boolean).join(' · '),
      html: { before: '', after: [`<h4>${esc(String(p.name))}</h4>`, String(p.description ?? ''), p.metaTitle ? `<p><b>Meta-Title:</b> ${esc(String(p.metaTitle))}</p>` : '', p.metaDescription ? `<p><b>Meta-Description:</b> ${esc(String(p.metaDescription))}</p>` : ''].join('').slice(0, 6000) } };
  };
  const plans = out.map(o => o.plan), creates = reg.list.filter(e => plans.some(p => p.uses.includes(e.id)) || reg.list.some(o => o.needs === e.id && plans.some(p => p.uses.includes(o.id))));
  const infos: ChangeItem[] = creates.map(e => ({ id: `new:${e.id}`, entity: 'info', label: e.label, fieldLabel: 'Neu', before: '–', after: 'wird angelegt (nur wenn ein ausgewähltes Produkt sie nutzt)', warn: [] }));
  const variantRows = plans.reduce((n, p) => n + (p.kind === 'create' ? p.childIds.length : p.kind === 'variants' ? p.children.length : 0), 0);
  const stats = { rows: recs.length, create: plans.filter(p => p.kind === 'create').length, variantRows, synthetic: plans.filter(p => p.kind === 'create' && p.synthetic).length, update: plans.filter(p => p.kind === 'update').length, variants: plans.filter(p => p.kind === 'variants').length, skipped: skipped.length, unchanged, nextOffset: end < all.length ? end : null, unknownCategories: [...ctx.missingCats], notes: cat.notes ?? [] };
  const range = offset || stats.nextOffset ? ` · Zeilen ${offset + 1}–${end} von ${all.length}` : '';
  const reason = `${meta.reason}${range ? ` (${meta.fileName}${range})` : ''}`;
  const base = { id: genId(), kind: IMPORT_KIND, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title: meta.title, reason, skipped: skipped.slice(0, 200), unchanged, atomic: false };
  if (out.length <= ITEM_LIMIT) {
    const cs: ChangeSet = { ...base, items: [...out.map(itemOf), ...infos], applyLabel: `Import übernehmen` };
    return { cs, payload: { plans, creates }, stats };
  }
  // Large files: groups (deselectable) + sample
  const GL: Record<Group, string> = { create: 'neu ohne Auffälligkeiten', 'create-warn': 'neu mit Warnungen', update: 'aktualisiert ohne Auffälligkeiten', 'update-warn': 'aktualisiert mit Warnungen' };
  // Group row: new = price range, updated = which fields how often
  const groupDiff = (xs: typeof out) => {
    if (xs[0].plan.kind !== 'update') {
      const prices = xs.flatMap(x => (x.plan.kind === 'create' ? [((x.plan.product.price as { gross: number }[])[0].gross)] : []));
      const kids = xs.reduce((n, x) => n + (x.plan.kind === 'create' ? x.plan.childIds.length : x.plan.kind === 'variants' ? x.plan.children.length : 0), 0);
      return { before: '–', after: [prices.length ? (Math.min(...prices) === Math.max(...prices) ? `Preis ${eur(prices[0])}` : `Preise ${eur(Math.min(...prices))} bis ${eur(Math.max(...prices))}`) : '', kids ? `${kids.toLocaleString('de-DE')} Varianten` : ''].filter(Boolean).join(' · ') || 'neu' };
    }
    const n = xs.flatMap(x => x.diffs ?? []).reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.label]: (acc[d.label] ?? 0) + 1 }), {});
    return { before: 'bisherige Werte', after: Object.entries(n).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${c.toLocaleString('de-DE')}× ${l}`).join(', ') };
  };
  const items: ChangeItem[] = [];
  for (const g of ['create', 'create-warn', 'update', 'update-warn'] as Group[]) {
    const xs = out.filter(o => o.plan.group === g); if (!xs.length) continue;
    const ws = Object.entries(xs.flatMap(x => x.warn.map(w => w.replace(/„[^“]*“/g, '…').replace(/\s*\(.*\)|[+−]\d+ %|^\S+: /g, '').trim())).reduce<Record<string, number>>((acc, w) => ({ ...acc, [w]: (acc[w] ?? 0) + 1 }), {})).slice(0, 6).map(([w, n]) => `${n}× ${w}`);
    items.push({ id: `grp:${g}`, entity: 'product', label: `${xs.length.toLocaleString('de-DE')} ${xs.length === 1 ? 'Produkt' : 'Produkte'} ${GL[g]}`, field: 'group', fieldLabel: g.startsWith('create') ? (opts.active ? 'Neu anlegen (aktiv)' : 'Neu anlegen (Entwurf)') : 'Zugeordnete Felder aktualisieren', ...groupDiff(xs), afterRaw: { count: xs.length }, warn: ws });
  }
  const sample = [...out.slice(0, SAMPLE), ...out.slice(SAMPLE).filter(o => o.warn.length).slice(0, 10)].map(o => ({ ...itemOf(o), entity: 'info' }));
  const cnt = (e: NewEntity['entity'], one: string, many: string) => { const n = creates.filter(c => c.entity === e).length; return n ? `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}` : ''; };
  const newSum: ChangeItem[] = creates.length ? [{ id: 'new:summary', entity: 'info', label: [cnt('product-manufacturer', 'Hersteller', 'Hersteller'), cnt('property-group', 'Eigenschaft', 'Eigenschaften'), cnt('property-group-option', 'Ausprägung', 'Ausprägungen')].filter(Boolean).join(', ') + ' neu', fieldLabel: 'Neu', before: '–', after: `z. B. ${creates.slice(0, 5).map(c => c.label.replace(/^\S+ /, '')).join(', ')}${creates.length > 5 ? ' …' : ''} (nur wenn ein ausgewähltes Produkt sie nutzt)`, warn: [] }] : [];
  const cs: ChangeSet = { ...base, items: [...items, ...newSum], sample, total: out.length };
  return { cs, payload: { plans, creates }, stats };
}

/** Is a plan selected? (single row p:<key> or group grp:<group>) */
export const isSelected = (p: ImportPlan, selected: Set<string>) => selected.has(`p:${p.key}`) || selected.has(`grp:${p.group}`);
