// Produkt-Stammdaten: Planung eines Änderungssets (rein, ohne Shop-Zugriff → testbar).
// Eingabe: aktueller Produktstand + aufgelöster Katalog (Eigenschaften, Hersteller, Tags …) + gewünschte Operationen.
import type { ChangeItem } from '@/lib/protocol';
import { HEX32, type SwEntity } from '../shopware';

export const KIND_STAMMDATEN = 'product-data';
export const VISIBILITY = { all: 30, search: 20, link: 10 } as const;
export type VisibilityLevel = keyof typeof VISIBILITY;
const VIS_LABEL: Record<number, string> = { 30: 'überall', 20: 'nur Suche', 10: 'nur Direktlink' };

// ---- Eingabe (KI) ----
export type PropIn = string | { group: string; option: string };
export interface CrossIn {
  action: 'create' | 'update' | 'delete';
  /** bestehendes Cross-Selling: id oder bisheriger Name (match) */
  id?: string; match?: string;
  name?: string; type?: 'productList' | 'productStream';
  productIds?: string[]; addProductIds?: string[]; removeProductIds?: string[];
  productStreamId?: string; position?: number; active?: boolean; limit?: number;
  sortBy?: 'name' | 'price' | 'releaseDate'; sortDirection?: 'ASC' | 'DESC';
}
export interface DataOps {
  properties?: { add?: PropIn[]; remove?: PropIn[] };
  categories?: { add?: string[]; remove?: string[] };
  manufacturer?: string | null;
  tags?: { add?: string[]; remove?: string[] };
  deliveryTime?: string | null;
  weight?: number | null; width?: number | null; height?: number | null; length?: number | null;
  taxRate?: number;
  visibility?: { add?: { salesChannel: string; visibility?: VisibilityLevel }[]; remove?: string[] };
  shippingFree?: boolean; markAsTopseller?: boolean;
  minPurchase?: number; purchaseSteps?: number; maxPurchase?: number | null;
  releaseDate?: string | null;
  crossSellings?: CrossIn[];
}
export interface ProductFilter {
  categoryId?: string; manufacturerId?: string; tagId?: string; propertyOptionId?: string; deliveryTimeId?: string; salesChannelId?: string;
  taxRate?: number; term?: string; active?: boolean; productNumbers?: string[]; includeVariants?: boolean;
  missing?: ('manufacturer' | 'deliveryTime' | 'weight' | 'dimensions' | 'properties' | 'categories' | 'tags' | 'visibility' | 'crossSelling')[];
}

/** Filter der KI → Shopware-Kriterien (DAL) */
export function productFilter(f: ProductFilter = {}): { filter: Record<string, unknown>[]; term?: string } {
  const eq = (field: string, value: unknown) => ({ type: 'equals', field, value });
  const filter: Record<string, unknown>[] = [];
  if (!f.includeVariants) filter.push(eq('parentId', null));
  if (f.categoryId) filter.push(eq('categoriesRo.id', f.categoryId));
  if (f.manufacturerId) filter.push(eq('manufacturerId', f.manufacturerId));
  if (f.tagId) filter.push(eq('tags.id', f.tagId));
  if (f.propertyOptionId) filter.push(eq('properties.id', f.propertyOptionId));
  if (f.deliveryTimeId) filter.push(eq('deliveryTimeId', f.deliveryTimeId));
  if (f.salesChannelId) filter.push(eq('visibilities.salesChannelId', f.salesChannelId));
  if (f.taxRate != null) filter.push(eq('tax.taxRate', f.taxRate));
  if (f.active != null) filter.push(eq('active', f.active));
  if (f.productNumbers?.length) filter.push({ type: 'equalsAny', field: 'productNumber', value: f.productNumbers });
  const MISSING: Record<string, Record<string, unknown>> = {
    manufacturer: eq('manufacturerId', null), deliveryTime: eq('deliveryTimeId', null), weight: eq('weight', null),
    dimensions: { type: 'multi', operator: 'OR', queries: [eq('width', null), eq('height', null), eq('length', null)] },
    properties: eq('properties.id', null), categories: eq('categories.id', null), tags: eq('tags.id', null),
    visibility: eq('visibilities.id', null), crossSelling: eq('crossSellings.id', null),
  };
  for (const m of f.missing ?? []) { if (!MISSING[m]) throw new Error(`Unbekannter Filter missing="${m}"`); filter.push(MISSING[m]); }
  return { filter, ...(f.term ? { term: f.term } : {}) };
}

// ---- Aufgelöster Katalog (vom Builder geladen) ----
export interface Catalog {
  groups: SwEntity[];                     // referenzierte Eigenschaftsgruppen inkl. options (nur die referenzierten)
  options: Record<string, SwEntity>;      // optionId → Option inkl. group
  manufacturers: SwEntity[]; tags: SwEntity[]; deliveryTimes: SwEntity[]; taxes: SwEntity[]; channels: SwEntity[];
  categories: Record<string, SwEntity>; products: Record<string, SwEntity>; streams: Record<string, SwEntity>;
}

/** Neu anzulegende Entität (nur, wenn ein ausgewähltes Item sie nutzt) */
export interface NewEntity { id: string; entity: 'property-group' | 'property-group-option' | 'product-manufacturer' | 'tag'; data: Record<string, unknown>; label: string; needs?: string }
export class NewRegistry {
  list: NewEntity[] = [];
  #by = new Map<string, NewEntity>();
  readonly #genId: () => string;
  constructor(genId: () => string) { this.#genId = genId; }
  get(key: string, make: () => Omit<NewEntity, 'id'>): NewEntity {
    let e = this.#by.get(key);
    if (!e) { e = { id: this.#genId(), ...make() }; this.#by.set(key, e); this.list.push(e); }
    return e;
  }
}

// ---- Payload je Item (afterRaw) für den Executor ----
export type ItemRaw =
  | { kind: 'assoc'; assoc: 'properties' | 'categories' | 'tags'; add: string[]; remove: string[]; uses: string[] }
  | { kind: 'scalar'; data: Record<string, unknown>; uses: string[] }
  | { kind: 'tax'; taxId: string; taxRate: number; uses: string[] }
  | { kind: 'visibility'; add: { salesChannelId: string; visibility: number }[]; remove: string[]; uses: string[] }
  | { kind: 'cross'; action: 'create'; id: string; data: Record<string, unknown>; productIds: string[]; uses: string[] }
  | { kind: 'cross'; action: 'update'; id: string; set: Record<string, unknown>; productIds: string[] | null; uses: string[] }
  | { kind: 'cross'; action: 'delete'; id: string; uses: string[] };

/** Ausschnitt des Produktstands, den ein Item ändert (Stale-Write-Guard: beim Vorschlag als beforeRaw gemerkt, beim Schreiben frisch verglichen) */
export function snapshot(cur: SwEntity, raw: ItemRaw): unknown {
  const ids = (xs: SwEntity[] | undefined) => (xs ?? []).map(x => String(x.id)).sort();
  switch (raw.kind) {
    case 'assoc': return ids(cur[raw.assoc]);
    case 'scalar': return Object.fromEntries(Object.keys(raw.data).map(k => [k, cur[k] ?? null]));
    case 'tax': return cur.taxId ?? null;
    case 'visibility': return ((cur.visibilities ?? []) as SwEntity[]).map(v => `${v.salesChannelId}:${v.visibility}`).sort();
    case 'cross': {
      if (raw.action === 'create') return undefined; // legt neu an, überschreibt nichts
      const c = ((cur.crossSellings ?? []) as SwEntity[]).find(x => x.id === raw.id); if (!c) return null;
      return { name: c.name ?? c.translated?.name ?? null, type: c.type, active: c.active, position: c.position, limit: c.limit, sortBy: c.sortBy, sortDirection: c.sortDirection, productStreamId: c.productStreamId ?? null,
        products: [...((c.assignedProducts ?? []) as SwEntity[])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(a => a.productId) };
    }
  }
}

// ---- Anzeige ----
const ci = (s: unknown) => String(s ?? '').trim().toLowerCase();
export const nameOf = (e: SwEntity | null | undefined) => (e ? String(e.translated?.name ?? e.name ?? e.id) : '–');
export const productLabel = (p: SwEntity) => `${p.translated?.name ?? p.name ?? p.productNumber}${p.productNumber ? ` (${p.productNumber})` : ''}`;
const num = (v: number, d = 3) => v.toLocaleString('de-DE', { maximumFractionDigits: d });
const eur = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const list = (xs: string[]) => (xs.length ? xs.join(', ') : '–');
const catName = (c: SwEntity) => (c.translated?.breadcrumb?.length > 1 ? c.translated.breadcrumb.slice(1).join(' › ') : nameOf(c));
export const netOf = (gross: number, rate: number) => Math.round((gross / (1 + rate / 100)) * 10000) / 10000;
const dateDe = (v: unknown) => { const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]}` : '–'; };
const yn = (v: unknown) => (v ? 'ja' : 'nein');

interface ScalarDef { label: string; show: (v: unknown) => string; check: (v: unknown) => unknown }
const nonNegOrNull = (unit: string, label: string) => (v: unknown) => { if (v === null) return null; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`${label}: Zahl ≥ 0 (${unit}) oder null erwartet`); return v; };
const intMin1 = (label: string, nullable = false) => (v: unknown) => { if (nullable && v === null) return null; if (!Number.isInteger(v) || (v as number) < 1) throw new Error(`${label}: ganze Zahl ≥ 1${nullable ? ' oder null' : ''} erwartet`); return v; };
const bool = (label: string) => (v: unknown) => { if (typeof v !== 'boolean') throw new Error(`${label}: true/false erwartet`); return v; };
export const SCALARS: Record<string, ScalarDef> = {
  weight: { label: 'Gewicht', show: v => (v == null ? '–' : `${num(v as number)} kg`), check: nonNegOrNull('kg', 'Gewicht') },
  width: { label: 'Breite', show: v => (v == null ? '–' : `${num(v as number)} mm`), check: nonNegOrNull('mm', 'Breite') },
  height: { label: 'Höhe', show: v => (v == null ? '–' : `${num(v as number)} mm`), check: nonNegOrNull('mm', 'Höhe') },
  length: { label: 'Länge', show: v => (v == null ? '–' : `${num(v as number)} mm`), check: nonNegOrNull('mm', 'Länge') },
  shippingFree: { label: 'Versandkostenfrei', show: yn, check: bool('Versandkostenfrei') },
  markAsTopseller: { label: 'Als Topseller hervorheben', show: yn, check: bool('Topseller') },
  minPurchase: { label: 'Mindestabnahme', show: v => String(v ?? 1), check: intMin1('Mindestabnahme') },
  purchaseSteps: { label: 'Staffelung', show: v => String(v ?? 1), check: intMin1('Staffelung') },
  maxPurchase: { label: 'Maximalabnahme', show: v => (v == null ? 'unbegrenzt' : String(v)), check: intMin1('Maximalabnahme', true) },
  releaseDate: {
    label: 'Erscheinungsdatum', show: dateDe,
    check: v => { if (v === null) return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Error('Erscheinungsdatum: JJJJ-MM-TT oder null erwartet'); return `${v}T00:00:00.000+00:00`; },
  },
};
const sameScalar = (k: string, a: unknown, b: unknown) => (k === 'releaseDate' ? String(a ?? '').slice(0, 10) === String(b ?? '').slice(0, 10) : typeof b === 'boolean' ? !!a === b : (a ?? null) === (b ?? null));

// ---- Planung je Produkt ----
export interface PlanResult { items: ChangeItem[]; skipped: { id: string; reason: string }[]; unchanged: number }

export function planProduct(cur: SwEntity, ops: DataOps, cat: Catalog, reg: NewRegistry, genId: () => string): PlanResult {
  const pid = cur.id as string, label = productLabel(cur), items: ChangeItem[] = [], skipped: PlanResult['skipped'] = [];
  let unchanged = 0;
  const push = (field: string, fieldLabel: string, before: string, after: string, afterRaw: ItemRaw, warn: string[] = []) =>
    items.push({ id: `${pid}:${field}`, entity: 'product', entityId: pid, label, field, fieldLabel, before, after, afterRaw, beforeRaw: snapshot(cur, afterRaw), warn });
  const step = (field: string, fn: () => void) => { try { fn(); } catch (e) { skipped.push({ id: pid, reason: `${label} · ${field}: ${e instanceof Error ? e.message : String(e)}` }); } };

  // Eigenschaften
  if (ops.properties) step('Eigenschaften', () => {
    const curOpts: SwEntity[] = cur.properties ?? [];
    type R = { id: string; name: string; groupId: string; groupName: string; isNew: boolean; uses: string[] };
    const findGroup = (ref: string) => cat.groups.find(g => g.id === ref || ci(nameOf(g)) === ci(ref) || ci(g.name) === ci(ref));
    const resolve = (ref: PropIn, create: boolean): R => {
      if (typeof ref === 'string') {
        if (HEX32.test(ref)) {
          const o = cat.options[ref] ?? curOpts.find(x => x.id === ref);
          if (!o) throw new Error(`Eigenschaftswert ${ref} nicht gefunden`);
          return { id: o.id, name: nameOf(o), groupId: o.groupId, groupName: nameOf(o.group), isNew: false, uses: [] };
        }
        const m = ref.match(/^([^:]+):\s*(.+)$/);
        if (!m) throw new Error(`„${ref}“: optionId oder {group, option} angeben`);
        ref = { group: m[1].trim(), option: m[2].trim() };
      }
      const gRef = String(ref.group ?? '').trim(), oRef = String(ref.option ?? '').trim();
      if (!gRef || !oRef) throw new Error('Eigenschaft: group und option angeben');
      let g = findGroup(gRef); const uses: string[] = [];
      if (!g) {
        if (HEX32.test(gRef)) throw new Error(`Eigenschaftsgruppe ${gRef} nicht gefunden`);
        if (!create) throw new Error(`Eigenschaftsgruppe „${gRef}“ gibt es nicht`);
        const ng = reg.get(`group:${ci(gRef)}`, () => ({ entity: 'property-group', data: { name: gRef, displayType: 'text', sortingType: 'alphanumeric', filterable: true }, label: `Eigenschaft „${gRef}“` }));
        g = { id: ng.id, name: ng.data.name, options: [], isNew: true }; uses.push(ng.id);
      }
      const o = (g.options ?? []).find((x: SwEntity) => x.id === oRef || ci(nameOf(x)) === ci(oRef) || ci(x.name) === ci(oRef))
        ?? curOpts.find(x => x.groupId === g!.id && (x.id === oRef || ci(nameOf(x)) === ci(oRef)));
      if (o) return { id: o.id, name: nameOf(o), groupId: g.id, groupName: nameOf(g), isNew: false, uses };
      if (HEX32.test(oRef)) throw new Error(`Eigenschaftswert ${oRef} nicht gefunden`);
      if (!create) throw new Error(`„${nameOf(g)}: ${oRef}“ ist nicht am Produkt`);
      const gid = g.id as string;
      const no = reg.get(`opt:${gid}:${ci(oRef)}`, () => ({ entity: 'property-group-option', data: { groupId: gid, name: oRef }, label: `${nameOf(g)}: ${oRef}`, needs: g!.isNew ? gid : undefined }));
      return { id: no.id, name: String(no.data.name), groupId: gid, groupName: nameOf(g), isNew: true, uses: [...uses, no.id] };
    };
    const add: R[] = [], remove: R[] = [];
    for (const r of ops.properties!.add ?? []) { try { const x = resolve(r, true); if (!curOpts.some(o => o.id === x.id) && !add.some(a => a.id === x.id)) add.push(x); } catch (e) { skipped.push({ id: pid, reason: `${label} · Eigenschaften: ${(e as Error).message}` }); } }
    for (const r of ops.properties!.remove ?? []) { try { const x = resolve(r, false); if (curOpts.some(o => o.id === x.id)) remove.push(x); } catch (e) { skipped.push({ id: pid, reason: `${label} · Eigenschaften: ${(e as Error).message}` }); } }
    if (!add.length && !remove.length) { unchanged++; return; }
    const groups = [...new Set([...add, ...remove].map(x => x.groupId))];
    const gName = (gid: string) => [...add, ...remove].find(x => x.groupId === gid)!.groupName;
    const curIn = (gid: string) => curOpts.filter(o => o.groupId === gid).map(nameOf).sort((a, b) => a.localeCompare(b, 'de'));
    const before = groups.map(g => `${gName(g)}: ${list(curIn(g))}`).join(' · ');
    const after = groups.map(g => {
      const keep = curOpts.filter(o => o.groupId === g && !remove.some(r => r.id === o.id)).map(nameOf);
      const vals = [...keep, ...add.filter(a => a.groupId === g).map(a => (a.isNew ? `${a.name} (neu)` : a.name))].sort((a, b) => a.localeCompare(b, 'de'));
      return `${gName(g)}: ${list(vals)}`;
    }).join(' · ');
    const warn = [...new Set(add.filter(a => a.isNew).map(a => `legt „${a.groupName}: ${a.name}“ neu an`))];
    push('properties', 'Eigenschaften', before, after, { kind: 'assoc', assoc: 'properties', add: add.map(a => a.id), remove: remove.map(r => r.id), uses: [...new Set(add.flatMap(a => a.uses))] }, warn);
  });

  // Kategorien
  if (ops.categories) step('Kategorien', () => {
    const curCats: SwEntity[] = cur.categories ?? [];
    const add: SwEntity[] = [], remove: SwEntity[] = [];
    for (const id of ops.categories!.add ?? []) { const c = cat.categories[id]; if (!c) { skipped.push({ id: pid, reason: `${label} · Kategorie ${id} nicht gefunden` }); continue; } if (!curCats.some(x => x.id === id) && !add.includes(c)) add.push(c); }
    for (const id of ops.categories!.remove ?? []) { const c = curCats.find(x => x.id === id); if (c) remove.push(c); }
    if (!add.length && !remove.length) { unchanged++; return; }
    const after = [...curCats.filter(c => !remove.includes(c)), ...add];
    const warn = [...(curCats.length && !after.length ? ['Produkt ist danach in keiner Kategorie'] : []), ...add.filter(c => c.type && c.type !== 'page').map(c => `„${nameOf(c)}“ ist keine normale Kategorie (${c.type})`)];
    push('categories', 'Kategorien', list(curCats.map(catName)), list(after.map(catName)), { kind: 'assoc', assoc: 'categories', add: add.map(c => c.id), remove: remove.map(c => c.id), uses: [] }, warn);
  });

  // Hersteller
  if (ops.manufacturer !== undefined) step('Hersteller', () => {
    const ref = ops.manufacturer; let id: string | null = null, name = '–', uses: string[] = [], warn: string[] = [];
    if (ref !== null) {
      const r = String(ref).trim(); if (!r) throw new Error('Hersteller leer');
      const m = cat.manufacturers.find(x => x.id === r || ci(nameOf(x)) === ci(r) || ci(x.name) === ci(r));
      if (m) { id = m.id; name = nameOf(m); }
      else if (HEX32.test(r)) throw new Error(`Hersteller ${r} nicht gefunden`);
      else { const n = reg.get(`manu:${ci(r)}`, () => ({ entity: 'product-manufacturer', data: { name: r }, label: `Hersteller „${r}“` })); id = n.id; name = `${n.data.name} (neu)`; uses = [n.id]; warn = [`legt Hersteller „${n.data.name}“ neu an`]; }
    }
    if ((cur.manufacturerId ?? null) === id) { unchanged++; return; }
    push('manufacturer', 'Hersteller', nameOf(cur.manufacturer), name, { kind: 'scalar', data: { manufacturerId: id }, uses }, warn);
  });

  // Tags
  if (ops.tags) step('Tags', () => {
    const curTags: SwEntity[] = cur.tags ?? [];
    const add: { id: string; name: string; isNew: boolean }[] = [], remove: SwEntity[] = [], uses: string[] = [];
    for (const raw of ops.tags!.add ?? []) {
      const r = String(raw).trim(); if (!r) continue;
      const t = cat.tags.find(x => x.id === r || ci(x.name) === ci(r)) ?? curTags.find(x => ci(x.name) === ci(r));
      if (t) { if (!curTags.some(x => x.id === t.id) && !add.some(a => a.id === t.id)) add.push({ id: t.id, name: t.name, isNew: false }); continue; }
      if (HEX32.test(r)) { skipped.push({ id: pid, reason: `${label} · Tag ${r} nicht gefunden` }); continue; }
      const n = reg.get(`tag:${ci(r)}`, () => ({ entity: 'tag', data: { name: r }, label: `Tag „${r}“` }));
      if (!add.some(a => a.id === n.id)) { add.push({ id: n.id, name: String(n.data.name), isNew: true }); uses.push(n.id); }
    }
    for (const raw of ops.tags!.remove ?? []) { const t = curTags.find(x => x.id === raw || ci(x.name) === ci(raw)); if (t) remove.push(t); }
    if (!add.length && !remove.length) { unchanged++; return; }
    const after = [...curTags.filter(t => !remove.includes(t)).map(t => t.name), ...add.map(a => (a.isNew ? `${a.name} (neu)` : a.name))];
    push('tags', 'Tags', list(curTags.map(t => t.name)), list(after), { kind: 'assoc', assoc: 'tags', add: add.map(a => a.id), remove: remove.map(t => t.id), uses }, add.filter(a => a.isNew).map(a => `legt Tag „${a.name}“ neu an`));
  });

  // Lieferzeit
  if (ops.deliveryTime !== undefined) step('Lieferzeit', () => {
    let d: SwEntity | null = null;
    if (ops.deliveryTime !== null) { const r = String(ops.deliveryTime).trim(); d = cat.deliveryTimes.find(x => x.id === r || ci(nameOf(x)) === ci(r) || ci(x.name) === ci(r)) ?? null; if (!d) throw new Error(`Lieferzeit „${r}“ nicht gefunden (list_delivery_times)`); }
    if ((cur.deliveryTimeId ?? null) === (d?.id ?? null)) { unchanged++; return; }
    push('deliveryTime', 'Lieferzeit', nameOf(cur.deliveryTime), d ? nameOf(d) : '–', { kind: 'scalar', data: { deliveryTimeId: d?.id ?? null }, uses: [] });
  });

  // Einfache Felder (Maße, Versand, Abnahme, Topseller, Erscheinungsdatum)
  for (const [k, def] of Object.entries(SCALARS)) {
    const v = (ops as Record<string, unknown>)[k];
    if (v === undefined) continue;
    step(def.label, () => {
      const val = def.check(v);
      if (sameScalar(k, cur[k], val)) { unchanged++; return; }
      const warn: string[] = [];
      if (k === 'maxPurchase' && val != null && (val as number) < ((ops.minPurchase ?? cur.minPurchase ?? 1) as number)) throw new Error('Maximalabnahme kleiner als Mindestabnahme');
      if (k === 'minPurchase' && cur.maxPurchase != null && ops.maxPurchase === undefined && (val as number) > cur.maxPurchase) throw new Error(`Mindestabnahme größer als Maximalabnahme (${cur.maxPurchase})`);
      if (k === 'releaseDate' && val && Date.parse(val as string) > Date.now()) warn.push('Datum liegt in der Zukunft (Produkt erscheint ggf. als „Vorbestellung“)');
      push(k, def.label, def.show(cur[k]), def.show(val), { kind: 'scalar', data: { [k]: val }, uses: [] }, warn);
    });
  }

  // Steuersatz (Bruttopreise bleiben, Netto wird neu berechnet)
  if (ops.taxRate !== undefined) step('Steuersatz', () => {
    const t = cat.taxes.find(x => Number(x.taxRate) === Number(ops.taxRate));
    if (!t) throw new Error(`Kein Steuersatz ${ops.taxRate} % im Shop (vorhanden: ${cat.taxes.map(x => `${x.taxRate} %`).join(', ')})`);
    if (cur.taxId === t.id) { unchanged++; return; }
    const p = cur.price?.[0], oldRate = cur.tax?.taxRate;
    const priceInfo = p?.gross != null ? ` · brutto bleibt ${eur(p.gross)}, netto ${eur(p.net)} → ${eur(netOf(p.gross, t.taxRate))}` : '';
    push('tax', 'Steuersatz', oldRate != null ? `${num(oldRate)} % (${nameOf(cur.tax)})` : '–', `${num(t.taxRate)} % (${nameOf(t)})${priceInfo}`, { kind: 'tax', taxId: t.id, taxRate: t.taxRate, uses: [] }, ['Nettopreise werden neu berechnet (auch erweiterte Preise und Varianten mit eigenem Preis)']);
  });

  // Sichtbarkeit in Verkaufskanälen
  if (ops.visibility) step('Sichtbarkeit', () => {
    const curVis: SwEntity[] = cur.visibilities ?? [];
    const ch = (ref: string) => cat.channels.find(c => c.id === ref || ci(nameOf(c)) === ci(ref) || ci(c.name) === ci(ref));
    const target = new Map<string, number>(curVis.map(v => [v.salesChannelId, v.visibility]));
    for (const a of ops.visibility!.add ?? []) {
      const c = ch(String(a.salesChannel ?? '')); if (!c) { skipped.push({ id: pid, reason: `${label} · Verkaufskanal „${a.salesChannel}“ nicht gefunden` }); continue; }
      const lvl = VISIBILITY[a.visibility ?? 'all']; if (!lvl) { skipped.push({ id: pid, reason: `${label} · Sichtbarkeit „${a.visibility}“ unbekannt (all|search|link)` }); continue; }
      target.set(c.id, lvl);
    }
    for (const r of ops.visibility!.remove ?? []) { const c = ch(String(r)); if (!c) { skipped.push({ id: pid, reason: `${label} · Verkaufskanal „${r}“ nicht gefunden` }); continue; } target.delete(c.id); }
    const add = [...target].filter(([id, lvl]) => curVis.find(v => v.salesChannelId === id)?.visibility !== lvl).map(([salesChannelId, visibility]) => ({ salesChannelId, visibility }));
    const remove = curVis.filter(v => !target.has(v.salesChannelId)).map(v => v.salesChannelId as string);
    if (!add.length && !remove.length) { unchanged++; return; }
    const show = (m: [string, number][]) => list(m.map(([id, lvl]) => `${nameOf(ch(id)) === '–' ? id : nameOf(ch(id))} (${VIS_LABEL[lvl] ?? lvl})`));
    const warn = curVis.length && !target.size ? ['Produkt ist danach in keinem Verkaufskanal sichtbar'] : [];
    push('visibility', 'Sichtbarkeit', show(curVis.map(v => [v.salesChannelId, v.visibility])), show([...target]), { kind: 'visibility', add, remove, uses: [] }, warn);
  });

  // Cross-Selling
  (ops.crossSellings ?? []).forEach((x, i) => step(`Cross-Selling ${i + 1}`, () => {
    const curCs: SwEntity[] = cur.crossSellings ?? [];
    const pName = (id: string) => (cat.products[id] ? nameOf(cat.products[id]) : id);
    const typeLabel = (t: unknown) => (t === 'productStream' ? 'Produktstream' : 'Produktliste');
    const show = (c: { name: unknown; type: unknown; active?: unknown; productIds?: string[]; productStreamId?: unknown }) =>
      `„${c.name}“ · ${typeLabel(c.type)}${c.type === 'productStream' ? `: ${cat.streams[String(c.productStreamId)] ? nameOf(cat.streams[String(c.productStreamId)]) : c.productStreamId}` : ` · ${c.productIds?.length ?? 0} ${c.productIds?.length === 1 ? 'Produkt' : 'Produkte'}: ${list((c.productIds ?? []).map(pName))}`}${c.active === false ? ' · inaktiv' : ''}`;
    const checkProducts = (ids: string[]) => { const own = ids.filter(id => id !== pid), bad = own.filter(id => !cat.products[id]); if (bad.length) throw new Error(`Produkt nicht gefunden: ${bad.join(', ')}`); return [...new Set(own)]; };
    const checkStream = (id: unknown) => { if (!id || !cat.streams[String(id)]) throw new Error(`Produktstream ${id ?? '(fehlt)'} nicht gefunden`); return String(id); };
    const field = `crossSelling${i + 1}`;
    if (x.action === 'create') {
      const name = String(x.name ?? '').trim(); if (!name) throw new Error('name fehlt');
      if (curCs.some(c => ci(nameOf(c)) === ci(name))) throw new Error(`Cross-Selling „${name}“ gibt es am Produkt schon (action "update")`);
      const type = x.type ?? 'productList';
      const productIds = type === 'productList' ? checkProducts(x.productIds ?? []) : [];
      if (type === 'productList' && !productIds.length) throw new Error('productIds fehlt (Produktliste)');
      const productStreamId = type === 'productStream' ? checkStream(x.productStreamId) : null;
      const data = { productId: pid, name, type, active: x.active ?? true, position: x.position ?? (curCs.length ? Math.max(...curCs.map(c => c.position ?? 0)) + 1 : 1), limit: x.limit ?? 24, sortBy: x.sortBy ?? 'name', sortDirection: x.sortDirection ?? 'ASC', productStreamId };
      push(field, 'Cross-Selling (neu)', '–', show({ ...data, productIds }), { kind: 'cross', action: 'create', id: genId(), data, productIds, uses: [] });
      return;
    }
    const ref = x.id ?? x.match ?? (x.action === 'delete' ? x.name : undefined);
    const c = curCs.find(c => c.id === ref || ci(nameOf(c)) === ci(ref) || ci(c.name) === ci(ref));
    if (!c) throw new Error(`Cross-Selling „${ref ?? '(id/match fehlt)'}“ ist nicht am Produkt`);
    const curIds = [...(c.assignedProducts ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(a => a.productId as string);
    const before = show({ name: nameOf(c), type: c.type, active: c.active, productIds: curIds, productStreamId: c.productStreamId });
    if (x.action === 'delete') { push(field, 'Cross-Selling', before, 'gelöscht', { kind: 'cross', action: 'delete', id: c.id, uses: [] }, ['Cross-Selling wird gelöscht']); return; }
    const set: Record<string, unknown> = {};
    if (x.name != null && String(x.name).trim() && String(x.name).trim() !== nameOf(c)) set.name = String(x.name).trim();
    for (const k of ['active', 'position', 'limit', 'sortBy', 'sortDirection'] as const) if (x[k] !== undefined && x[k] !== c[k]) set[k] = x[k];
    if (x.type && x.type !== c.type) set.type = x.type;
    const type = (set.type ?? c.type) as string;
    if (x.productStreamId !== undefined && x.productStreamId !== c.productStreamId) set.productStreamId = checkStream(x.productStreamId);
    if (type === 'productStream' && !(set.productStreamId ?? c.productStreamId)) throw new Error('productStreamId fehlt (Typ Produktstream)');
    let target = curIds; const full = x.productIds ? checkProducts(x.productIds) : null;
    const addIds = checkProducts(x.addProductIds ?? []), removeIds = x.removeProductIds ?? [];
    if (full) target = full;
    target = [...target.filter(id => !removeIds.includes(id)), ...addIds.filter(id => !target.includes(id))];
    const prodChanged = target.join() !== curIds.join();
    if (!Object.keys(set).length && !prodChanged) { unchanged++; return; }
    if (type === 'productList' && !target.length) throw new Error('Produktliste wäre leer, stattdessen action "delete"');
    const after = show({ name: set.name ?? nameOf(c), type, active: set.active ?? c.active, productIds: target, productStreamId: set.productStreamId ?? c.productStreamId });
    push(field, 'Cross-Selling', before, after, { kind: 'cross', action: 'update', id: c.id, set, productIds: prodChanged ? target : null, uses: [] });
  }));

  return { items, skipped, unchanged };
}

// ---- Preise beim Steuerwechsel: Brutto bleibt, Netto neu (rein) ----
type PriceEntry = { currencyId: string; gross: number; net: number; linked?: boolean; listPrice?: PriceEntry | null; regulationPrice?: PriceEntry | null };
const cleanOne = (e: PriceEntry | null | undefined, rate?: number): PriceEntry | null => (e ? { currencyId: e.currencyId, gross: e.gross, net: rate == null ? e.net : netOf(e.gross, rate), linked: e.linked ?? true } : null);
/** Preisliste in schreibbarer Form; mit rate: Netto aus Brutto neu berechnet */
export function cleanPrices(arr: PriceEntry[] | null | undefined, rate?: number): PriceEntry[] | null {
  if (!arr) return null;
  return arr.map(e => ({ ...cleanOne(e, rate)!, ...(e.listPrice ? { listPrice: cleanOne(e.listPrice, rate) } : {}), ...(e.regulationPrice ? { regulationPrice: cleanOne(e.regulationPrice, rate) } : {}) }));
}
