import 'server-only';
// Shopify: supplier import (CSV/Excel). Reading the file and saving the mapping work as in Shopware (features/import.ts); matching by SKU,
// otherwise barcode (EAN). Existing products: only mapped, changed fields (prices only with updatePrices); new products as drafts,
// variant families (parent product no. + variant axes) as one product with options. Collections are never created.
// Planning is pure (testable), the executor runs gently in parallel and in batches, every product with exact undo steps.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { WRITE_CONCURRENCY, errMsg, pool, type ApplyCtx, type ApplyResult } from '../../changes';
import { loadTable, mappingSchema, supplierFileTools } from '../../features/import';
import { checkMapping, type ImportMapping } from '../../features/import-mapping';
import { commonName, IMPORT_MAX, ITEM_LIMIT, readRecords, sectionRange, type Rec } from '../../features/import-plan';
import type { Table } from '../../features/import-parse';
import type { Feature } from '../../features/types';
import type { Session } from '../../sessions';
import { newId } from '../../shopware';
import { singleton } from '../../state';
import { guard, ok, type AnyTool } from '../../tool-kit';
import { shortId, toGid, type Json, type ShopifyClient } from './client';
import { applyImages } from './catalog';
import { fmtMoney, money, moneyRaw, qField, searchCollections, shopInfo, stripHtml, toNum, type Q } from './data';
import { deleteOp, M, reqOp, run, runCreating, runRecording, undoShopify } from './ops';
import { createProduct, normTags, onlineStorePublication, productIdsByTitle, type NewProductPayload } from './products';
import { qOf, readerOf } from './tools';

export const IMPORT_KIND_SHOPIFY = 'shopify-import';
const SAMPLE = 50;

export interface ShopifyImportOptions {
  mode?: 'both' | 'create' | 'update'; updateFields?: string[]; updatePrices?: boolean; active?: boolean;
  categoryMap?: Record<string, string>; defaultCategoryId?: string; offset?: number; limit?: number;
}
/** existing variant (matched by SKU/barcode) with its product */
export interface CatalogVariant { variantId: string; productId: string; sku: string | null; barcode: string | null; price: string | null; compareAtPrice: string | null; product: { title: string; descriptionHtml: string; vendor: string; tags: string[]; seo: { title: string | null; description: string | null }; collections: string[]; media: number; variants: number } }
export interface ShopifyImportCatalog { bySku: Map<string, CatalogVariant>; byBarcode: Map<string, CatalogVariant>; collections: { id: string; title: string; handle: string; manual: boolean }[]; taxesIncluded: boolean; currency: string; notes: string[] }

type Group = 'create' | 'create-warn' | 'update' | 'update-warn';
interface Base { key: string; line: number; group: Group; label: string }
export interface ShopifyCreatePlan extends Base { kind: 'create'; product: NewProductPayload; options?: { name: string; values: string[] }[]; variants?: { options: Record<string, string>; price: number; listPrice?: number | null; sku?: string; barcode?: string }[] }
export interface ShopifyUpdatePlan extends Base {
  kind: 'update'; productId: string;
  /** Product fields (title, descriptionHtml, vendor, seo, tags) and per variant price, compare-at price, barcode */
  product: Json; variants: { id: string; price?: number; compareAtPrice?: number | null; barcode?: string }[]; join: string[]; images: string[];
}
export type ShopifyImportPlan = ShopifyCreatePlan | ShopifyUpdatePlan;
export interface ShopifyImportPayload { plans: ShopifyImportPlan[] }
export interface ShopifyImportStats { rows: number; create: number; update: number; variantRows: number; skipped: number; unchanged: number; nextOffset: number | null; unknownCategories: string[]; ignored: string[]; notes: string[] }

/** Fields Shopify does not have or that Lotse does not write on Shopify (notice instead of silent loss) */
const IGNORED: Partial<Record<keyof ImportMapping, string>> = {
  stock: 'Bestand (in Lotse für Shopify nur lesbar; Lagerbestände je Standort im Shopify-Admin)', purchasePrice: 'Einkaufspreis', manufacturerNumber: 'Hersteller-Nr.',
  weight: 'Gewicht', width: 'Breite', height: 'Höhe', length: 'Länge', deliveryTime: 'Lieferzeit', properties: 'Eigenschaften (Shopify-Filter laufen über Optionen, Tags und Metafelder)',
};
const low = (s: string) => s.trim().toLocaleLowerCase('de-DE');
const https = (u: string) => /^https:\/\//i.test(u);

/** Price from the file → Shopify price (Shopify stores prices as the shop displays them: gross with "prices include tax") */
export function shopifyPrice(r: Pick<Rec, 'gross' | 'net' | 'taxRate'>, taxesIncluded: boolean, defaultTax = 19): { price?: number; converted?: string } {
  const rate = r.taxRate ?? defaultTax, round = (n: number) => Math.round(n * 100) / 100;
  if (taxesIncluded) return r.gross != null ? { price: r.gross } : r.net != null ? { price: round(r.net * (1 + rate / 100)), converted: `Preis aus Netto + ${rate} % berechnet` } : {};
  return r.net != null ? { price: r.net } : r.gross != null ? { price: round(r.gross / (1 + rate / 100)), converted: `Netto aus Brutto − ${rate} % berechnet (Shop-Preise ohne Steuer)` } : {};
}

/** Collection(s) from category text: title or handle (last path segment), categoryMap takes precedence; manual collections only */
export function resolveCollections(text: string | undefined, cat: ShopifyImportCatalog, map: Record<string, string> = {}): { ids: string[]; missing: string[]; smart: string[] } {
  const ids: string[] = [], missing: string[] = [], smart: string[] = [];
  for (const t of String(text ?? '').split(/\s*[|;\n]\s*/).filter(Boolean)) {
    if (t in map) { if (map[t]) ids.push(shortId(toGid('Collection', map[t]))); continue; }
    const last = low(t.split(/\s*(?:>|»|\/|\\)\s*/).filter(Boolean).pop() ?? t);
    const hit = cat.collections.filter(c => low(c.title) === last || c.handle === last);
    if (hit.length !== 1) { missing.push(hit.length ? `${t} (mehrdeutig)` : t); continue; }
    if (!hit[0].manual) { smart.push(hit[0].title); continue; }
    if (!ids.includes(hit[0].id)) ids.push(hit[0].id);
  }
  return { ids, missing, smart };
}

const DEFAULT_UPDATE = ['name', 'description', 'manufacturer', 'metaTitle', 'metaDescription', 'keywords', 'ean', 'category', 'images'];

export function planShopifyImport(t: Table, m: ImportMapping, cat: ShopifyImportCatalog, opts: ShopifyImportOptions, meta: { title: string; reason: string; fileName: string }): { cs: ChangeSet; payload: ShopifyImportPayload; stats: ShopifyImportStats } {
  const all = readRecords(t, m), { offset, end } = sectionRange(all, opts), recs = all.slice(offset, end);
  if (!recs.length) throw new Error(`Keine Zeilen ab Zeile ${offset + 1} (Datei hat ${all.length} Datenzeilen)`);
  const mode = opts.mode ?? 'both', upd = new Set(opts.updateFields ?? DEFAULT_UPDATE), cur = cat.currency;
  const out: { plan: ShopifyImportPlan; diffs: { label: string; before: string; after: string }[]; warn: string[] }[] = [];
  const skipped: { id: string; reason: string }[] = [], missingCats = new Set<string>(); let unchanged = 0;
  const skip = (r: Rec, reason: string) => skipped.push({ id: `z${r.line}`, reason: `Zeile ${r.line}${r.number ? ` (${r.number})` : ''}: ${reason}` });
  const ignored = (Object.keys(IGNORED) as (keyof ImportMapping)[]).filter(k => { const v = m[k]; return Array.isArray(v) ? v.length : !!v; }).map(k => IGNORED[k]!);
  const match = (r: Rec) => (r.number && cat.bySku.get(r.number)) || (r.ean && cat.byBarcode.get(r.ean)) || null;
  const cols = (r: Rec, warn: string[]) => {
    const c = resolveCollections(r.category, cat, opts.categoryMap);
    c.missing.forEach(x => missingCats.add(x));
    if (c.missing.length) warn.push(`Kollektion nicht gefunden: ${c.missing.join(', ')}`);
    if (c.smart.length) warn.push(`Automatische Kollektion ${c.smart.join(', ')}: Zuordnung über Regeln (z. B. Tags), nicht manuell`);
    const ids = c.ids.length ? c.ids : opts.defaultCategoryId ? [shortId(toGid('Collection', opts.defaultCategoryId))] : [];
    return ids;
  };
  const tagsOf = (r: Rec) => normTags((r.keywords ?? '').split(/[,;|]/));

  // ---- duplicate product numbers in the file: first row wins ----
  const firstLine = new Map<string, number>(), rows: Rec[] = [];
  for (const r of recs) {
    if (r.number && firstLine.has(r.number)) { skip(r, `Artikelnummer doppelt in der Datei (gilt Zeile ${firstLine.get(r.number)})`); continue; }
    if (r.number) firstLine.set(r.number, r.line);
    rows.push(r);
  }

  // ---- variant families (parent product no.): new families as one product; existing variants are updated, new ones via propose_variants ----
  const parentNos = new Set(rows.filter(r => r.parent && r.parent !== r.number).map(r => r.parent!));
  const families = new Map<string, Rec[]>();
  for (const r of rows) if (r.parent && parentNos.has(r.parent) && r.parent !== r.number) families.set(r.parent, [...(families.get(r.parent) ?? []), r]);

  const createSimple = (r: Rec) => {
    const warn = [...r.problems], { price, converted } = shopifyPrice(r, cat.taxesIncluded);
    if (!r.name) return skip(r, 'Name fehlt');
    if (price == null) return skip(r, 'Preis fehlt (Preise werden nie geschätzt)');
    if (converted) warn.push(converted);
    const images = r.images.filter(https); if (images.length < r.images.length) warn.push(`${r.images.length - images.length} Bild(er) ohne https übersprungen`);
    if (!images.length) warn.push('Ohne Bild');
    const product: NewProductPayload = { name: r.name, description: r.description ?? '', price, listPrice: r.list ?? null, sku: r.number, barcode: r.ean, vendor: r.manufacturer, tags: tagsOf(r), metaTitle: r.metaTitle, metaDescription: r.metaDescription, collectionIds: cols(r, warn), images, active: opts.active === true, currency: cur };
    if (r.list != null && r.list <= price) warn.push('Streichpreis ≤ Preis');
    out.push({ plan: { kind: 'create', key: `n${r.line}`, line: r.line, group: warn.length ? 'create-warn' : 'create', label: `${r.name}${r.number ? ` (${r.number})` : ''}`, product }, diffs: [], warn });
  };

  /** Rows for existing variants (grouped per product) and parent rows of existing families (source of the product fields) */
  const existing: Rec[] = [], heads = new Map<string, Rec>();
  for (const r of rows) {
    if (r.parent && families.has(r.parent) && r.parent !== r.number) continue; // variant: handled via the family
    if (r.number && families.has(r.number)) continue; // parent row of a family
    const c = match(r);
    if (!c) { if (mode === 'update') skip(r, 'nicht im Shop (Modus „nur aktualisieren“)'); else createSimple(r); continue; }
    if (mode === 'create') { skip(r, 'schon im Shop (Modus „nur neu anlegen“)'); continue; }
    existing.push(r);
  }

  for (const [parentNo, kids] of families) {
    const head = rows.find(r => r.number === parentNo), first = kids[0], headHit = head ? match(head) : null, hits = kids.filter(k => match(k));
    if (hits.length || headHit) {
      // existing product: update matching variants, new variants only via propose_variants (the user reviews options/values there)
      kids.filter(k => !match(k)).forEach(k => skip(k, `neue Variante: Produkt ${parentNo} ist schon im Shop. Neue Varianten an vorhandenen Produkten über propose_variants`));
      const mine = [...hits, ...(headHit ? [head!] : [])];
      if (mode === 'create') { mine.forEach(k => skip(k, 'schon im Shop (Modus „nur neu anlegen“)')); continue; }
      existing.push(...mine);
      const pids = new Set(mine.map(k => match(k)!.productId));
      if (head && pids.size === 1) heads.set([...pids][0], head);
      continue;
    }
    if (mode === 'update') { kids.forEach(k => skip(k, 'neue Variante (Modus „nur aktualisieren“)')); continue; }
    const axes = [...new Set(kids.flatMap(k => k.axes.map(a => a.group)))];
    if (!axes.length) { kids.forEach(k => skip(k, `Familie ${parentNo}: Varianten-Achsen (variantOptions) fehlen`)); continue; }
    if (axes.length > 3) { kids.forEach(k => skip(k, `Familie ${parentNo}: Shopify erlaubt höchstens 3 Optionen (${axes.join(', ')})`)); continue; }
    const warn: string[] = [], variants: NonNullable<ShopifyCreatePlan['variants']> = [], seen = new Set<string>();
    for (const k of kids) {
      const { price, converted } = shopifyPrice(k.gross != null || k.net != null ? k : { ...k, gross: head?.gross, net: head?.net }, cat.taxesIncluded); // own price (even 0) before that of the parent row
      const opt = Object.fromEntries(axes.map(a => [a, k.axes.find(x => x.group === a)?.value ?? '']));
      if (Object.values(opt).some(v => !v)) { skip(k, `Wert für ${axes.filter(a => !opt[a]).join(', ')} fehlt`); continue; }
      const sig = JSON.stringify(opt); if (seen.has(sig)) { skip(k, `Kombination ${Object.values(opt).join(' / ')} doppelt`); continue; }
      if (price == null) { skip(k, 'Preis fehlt (Preise werden nie geschätzt)'); continue; }
      if (converted && !warn.includes(converted)) warn.push(converted);
      seen.add(sig); variants.push({ options: opt, price, listPrice: k.list ?? head?.list ?? null, sku: k.number, barcode: k.ean });
    }
    if (!variants.length) continue;
    if (variants.length > 100) { kids.forEach(k => skip(k, `Familie ${parentNo}: mehr als 100 Varianten`)); continue; }
    const name = head?.name ?? commonName(kids.map(k => k.name ?? '').filter(Boolean), kids.flatMap(k => k.axes.map(a => a.value)));
    if (!name) { kids.forEach(k => skip(k, `Familie ${parentNo}: Name fehlt`)); continue; }
    const src = head ?? first, images = [...new Set([...(head?.images ?? []), ...kids.flatMap(k => k.images)])].filter(https);
    if (!images.length) warn.push('Ohne Bild');
    const product: NewProductPayload = { name, description: src.description ?? kids.find(k => k.description)?.description ?? '', price: variants[0].price, listPrice: variants[0].listPrice ?? null, vendor: src.manufacturer, tags: tagsOf(src), metaTitle: src.metaTitle, metaDescription: src.metaDescription, collectionIds: cols(src, warn), images, active: opts.active === true, currency: cur };
    const options = axes.map(a => ({ name: a, values: [...new Set(variants.map(v => v.options[a]))] }));
    out.push({ plan: { kind: 'create', key: `f${first.line}`, line: first.line, group: warn.length ? 'create-warn' : 'create', label: `${name} (${parentNo})`, product, options, variants }, diffs: [], warn });
  }

  // ---- existing products: ONE update per product (no parallel writes to the same product), only mapped, changed fields ----
  const byProduct = new Map<string, Rec[]>();
  for (const r of existing) { const pid = match(r)!.productId; byProduct.set(pid, [...(byProduct.get(pid) ?? []), r]); }
  for (const [pid, all] of byProduct) {
    const seenV = new Map<string, number>(), group: Rec[] = [];
    for (const r of all.sort((a, b) => a.line - b.line)) { const v = match(r)!.variantId; if (seenV.has(v)) { skip(r, `gleiche Variante wie Zeile ${seenV.get(v)}`); continue; } seenV.set(v, r.line); group.push(r); }
    const c0 = match(group[0])!, p = c0.product, multi = p.variants > 1, head = heads.get(pid);
    const warn = [...new Set(group.flatMap(r => r.problems))], diffs: { label: string; before: string; after: string }[] = [], prod: Json = {}, variants: ShopifyUpdatePlan['variants'] = [];
    const set = (key: string, label: string, before: unknown, after: unknown, apply: () => void, show = (v: unknown) => String(v ?? '–')) => {
      if (!upd.has(key) || after == null || after === '' || JSON.stringify(before ?? null) === JSON.stringify(after)) return;
      diffs.push({ label, before: show(before).slice(0, 120), after: show(after).slice(0, 120) }); apply();
    };
    /**
     * Product field from the file: the family's parent row, otherwise the common value of all rows. If the product has several variants, a
     * title without a parent row only counts if at least two rows agree (a single variant row usually carries the variant name).
     */
    const pick = <T>(key: string, label: string, get: (r: Rec) => T | undefined): T | undefined => {
      if (!upd.has(key)) return undefined;
      const h = head ? get(head) : undefined;
      if (h != null && h !== '') return h;
      const vals = group.map(get).filter(v => v != null && v !== ''), uniq = [...new Set(vals.map(v => JSON.stringify(v)))];
      if (uniq.length > 1) { warn.push(`${label} je Zeile verschieden (${group.length} Varianten eines Produkts): nicht übernommen`); return undefined; }
      if (multi && key === 'name' && vals.length && group.length < 2) { warn.push(`Titel nicht übernommen: Zeile betrifft nur eine von ${p.variants} Varianten (ohne Hauptzeile)`); return undefined; }
      return vals[0];
    };
    const name = pick('name', 'Titel', r => r.name), desc = pick('description', 'Beschreibung', r => r.description), vendor = pick('manufacturer', 'Hersteller', r => r.manufacturer);
    const metaTitle = pick('metaTitle', 'Meta-Title', r => r.metaTitle), metaDescription = pick('metaDescription', 'Meta-Description', r => r.metaDescription);
    const src = head ? [head, ...group] : group;
    set('name', 'Titel', p.title, name, () => { prod.title = name; });
    set('description', 'Beschreibung', stripHtml(p.descriptionHtml), desc ? stripHtml(desc) : undefined, () => { prod.descriptionHtml = desc; });
    set('manufacturer', 'Hersteller (Vendor)', p.vendor, vendor, () => { prod.vendor = vendor; });
    set('metaTitle', 'Meta-Title', p.seo.title, metaTitle, () => { prod.seo = { ...(prod.seo ?? p.seo), title: metaTitle }; });
    set('metaDescription', 'Meta-Description', p.seo.description, metaDescription, () => { prod.seo = { ...(prod.seo ?? p.seo), description: metaDescription }; });
    const fileTags = normTags(src.flatMap(tagsOf)), tags = normTags([...p.tags, ...fileTags]);
    if (fileTags.length) set('keywords', 'Tags', p.tags.join(', '), tags.join(', '), () => { prod.tags = tags; });
    // per variant: barcode, price, compare-at price
    for (const r of group) {
      const c = match(r)!, v: ShopifyUpdatePlan['variants'][number] = { id: c.variantId }, tag = multi ? `${c.sku ?? c.barcode ?? shortId(c.variantId)}: ` : '';
      if (upd.has('ean') && r.ean && c.barcode !== r.ean) { diffs.push({ label: 'Barcode', before: `${tag}${c.barcode ?? '–'}`, after: `${tag}${r.ean}` }); v.barcode = r.ean; }
      if (opts.updatePrices) {
        const { price, converted } = shopifyPrice(r, cat.taxesIncluded), old = toNum(c.price);
        if (price != null && old !== price) {
          diffs.push({ label: 'Preis', before: `${tag}${fmtMoney(c.price, cur) ?? '–'}`, after: `${tag}${fmtMoney(price, cur)}` }); v.price = price;
          if (converted && !warn.includes(converted)) warn.push(converted);
          if (old && Math.abs(price - old) / old >= 0.3) warn.push(`${tag}Preisänderung ${price > old ? '+' : '−'}${Math.round(Math.abs(price - old) / old * 100)} %`);
        }
        if (m.listPrice && toNum(c.compareAtPrice) !== (r.list ?? null)) { diffs.push({ label: 'Vergleichspreis', before: `${tag}${fmtMoney(c.compareAtPrice, cur) ?? '–'}`, after: `${tag}${r.list != null ? fmtMoney(r.list, cur) : 'entfernen'}` }); v.compareAtPrice = r.list ?? null; }
      }
      if (Object.keys(v).length > 1) variants.push(v);
    }
    const join = upd.has('category') ? [...new Set(src.flatMap(r => cols(r, warn)))].filter(id => !p.collections.includes(id)) : [];
    if (join.length) diffs.push({ label: 'Kollektionen', before: `${p.collections.length}`, after: `+${join.length}` });
    const images = upd.has('images') && !p.media ? [...new Set(src.flatMap(r => r.images))].filter(https) : [];
    if (images.length) diffs.push({ label: 'Bilder', before: 'kein Bild', after: `${images.length} Bild(er)` });
    if (variants.length && multi && variants.length < p.variants) warn.push(`Produkt hat ${p.variants} Varianten: geändert ${variants.length === 1 ? 'wird nur die Variante' : `werden nur die ${variants.length} Varianten`} aus der Datei`);
    if (!diffs.length) { unchanged += group.length; continue; }
    const line = Math.min(...src.map(r => r.line));
    out.push({ plan: { kind: 'update', key: `u${line}`, line, group: warn.length ? 'update-warn' : 'update', label: `${p.title}${multi ? ` (${group.length} von ${p.variants} Varianten)` : c0.sku ? ` (${c0.sku})` : ''}`, productId: pid, product: prod, variants, join, images }, diffs, warn: [...new Set(warn)] });
  }

  if (!out.length) throw new Error(`Nichts zu importieren (${unchanged} unverändert, ${skipped.length} übersprungen${skipped.length ? `: ${skipped.slice(0, 4).map(s => s.reason).join('; ')}` : ''})`);
  out.sort((a, b) => a.plan.line - b.plan.line);
  const itemOf = ({ plan, diffs, warn }: (typeof out)[number]): ChangeItem => {
    const base = { id: `p:${plan.key}`, entity: 'product', label: plan.label, warn };
    if (plan.kind === 'update') return { ...base, entityId: shortId(plan.productId), field: 'update', fieldLabel: diffs.map(d => d.label).join(', '), before: diffs.map(d => d.before).join(' · '), after: diffs.map(d => d.after).join(' · ') };
    const p = plan.product, n = plan.variants?.length ?? 0, prices = (plan.variants ?? [{ price: p.price }]).map(v => v.price);
    const where = p.collectionIds.map(id => cat.collections.find(c => c.id === id)?.title).filter(Boolean).join(', ');
    return { ...base, field: 'create', fieldLabel: n ? `Neues Produkt mit ${n} Varianten` : 'Neues Produkt', before: '–',
      after: [Math.min(...prices) === Math.max(...prices) ? fmtMoney(prices[0], cur) : `${fmtMoney(Math.min(...prices), cur)} bis ${fmtMoney(Math.max(...prices), cur)}`, p.active ? 'aktiv' : 'Entwurf', where, p.images.length ? `${p.images.length} Bild(er)` : '', plan.options?.map(o => `${o.name}: ${o.values.join(', ')}`).join(' · ') ?? ''].filter(Boolean).join(' · '),
      html: { before: '', after: [`<h4>${stripHtml(p.name)}</h4>`, p.description, p.metaTitle ? `<p><b>Meta-Title:</b> ${stripHtml(p.metaTitle)}</p>` : ''].join('').slice(0, 6000) } };
  };
  const plans = out.map(o => o.plan);
  const stats: ShopifyImportStats = { rows: recs.length, create: plans.filter(p => p.kind === 'create').length, update: plans.filter(p => p.kind === 'update').length, variantRows: plans.reduce((n, p) => n + (p.kind === 'create' ? p.variants?.length ?? 0 : 0), 0),
    skipped: skipped.length, unchanged, nextOffset: end < all.length ? end : null, unknownCategories: [...missingCats], ignored, notes: cat.notes };
  const range = offset || stats.nextOffset ? ` · Zeilen ${offset + 1} bis ${end} von ${all.length}` : '';
  const base = { id: newId(), kind: IMPORT_KIND_SHOPIFY, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title: meta.title, reason: `${meta.reason}${range ? ` (${meta.fileName}${range})` : ''}`, skipped: skipped.slice(0, 200), unchanged, atomic: false, applyLabel: 'Import übernehmen' };
  const notes: ChangeItem[] = ignored.length ? [{ id: 'info:ignored', entity: 'info', label: 'Nicht übernommen', fieldLabel: 'Hinweis', before: '–', after: ignored.join('; '), warn: [] }] : [];
  if (out.length <= ITEM_LIMIT) return { cs: { ...base, items: [...out.map(itemOf), ...notes] }, payload: { plans }, stats };
  const GL: Record<Group, string> = { create: 'neu ohne Auffälligkeiten', 'create-warn': 'neu mit Warnungen', update: 'aktualisiert ohne Auffälligkeiten', 'update-warn': 'aktualisiert mit Warnungen' };
  const items: ChangeItem[] = [];
  for (const g of ['create', 'create-warn', 'update', 'update-warn'] as Group[]) {
    const xs = out.filter(o => o.plan.group === g); if (!xs.length) continue;
    const ws = Object.entries(xs.flatMap(x => x.warn).reduce<Record<string, number>>((acc, w) => ({ ...acc, [w]: (acc[w] ?? 0) + 1 }), {})).slice(0, 6).map(([w, n]) => `${n}× ${w}`);
    const fields = Object.entries(xs.flatMap(x => x.diffs.map(d => d.label)).reduce<Record<string, number>>((acc, l) => ({ ...acc, [l]: (acc[l] ?? 0) + 1 }), {})).map(([l, n]) => `${n}× ${l}`).join(', ');
    items.push({ id: `grp:${g}`, entity: 'product', label: `${xs.length.toLocaleString('de-DE')} ${xs.length === 1 ? 'Produkt' : 'Produkte'} ${GL[g]}`, field: 'group', fieldLabel: g.startsWith('create') ? (opts.active ? 'Neu anlegen (aktiv)' : 'Neu anlegen (Entwurf)') : 'Zugeordnete Felder aktualisieren', before: g.startsWith('create') ? '–' : 'bisherige Werte', after: fields || 'neu', afterRaw: { count: xs.length }, warn: ws });
  }
  const sample = [...out.slice(0, SAMPLE), ...out.slice(SAMPLE).filter(o => o.warn.length).slice(0, 10)].map(o => ({ ...itemOf(o), entity: 'info' }));
  return { cs: { ...base, items: [...items, ...notes], sample, total: out.length }, payload: { plans }, stats };
}
export const isSelectedPlan = (p: ShopifyImportPlan, selected: Set<string>) => selected.has(`p:${p.key}`) || selected.has(`grp:${p.group}`);

// ======================= Catalog (the AI's guarded reader) =======================
const VARIANT_SEL = 'id sku barcode price compareAtPrice product { id title descriptionHtml vendor tags seo { title description } mediaCount { count } variantsCount { count } collections(first: 20) { nodes { id } } }';
export async function loadShopifyCatalog(q: Q, recs: Rec[], needCollections: boolean): Promise<ShopifyImportCatalog> {
  const cat: ShopifyImportCatalog = { bySku: new Map(), byBarcode: new Map(), collections: [], taxesIncluded: true, currency: 'EUR', notes: [] };
  const s = await shopInfo(q); cat.taxesIncluded = s.taxesIncluded; cat.currency = s.currency;
  const add = (v: Json) => {
    const p = v.product, cv: CatalogVariant = { variantId: v.id, productId: p.id, sku: v.sku || null, barcode: v.barcode || null, price: moneyRaw(v.price), compareAtPrice: moneyRaw(v.compareAtPrice),
      product: { title: p.title, descriptionHtml: p.descriptionHtml ?? '', vendor: p.vendor ?? '', tags: p.tags ?? [], seo: { title: p.seo?.title ?? null, description: p.seo?.description ?? null }, collections: (p.collections?.nodes ?? []).map((c: Json) => shortId(c.id)), media: p.mediaCount?.count ?? 0, variants: p.variantsCount?.count ?? 1 } };
    if (cv.sku) cat.bySku.set(cv.sku, cv); if (cv.barcode) cat.byBarcode.set(cv.barcode, cv);
  };
  for (const [field, vals] of [['sku', [...new Set(recs.flatMap(r => [r.number, r.parent]).filter((x): x is string => !!x))]], ['barcode', [...new Set(recs.map(r => r.ean).filter((x): x is string => !!x))]]] as const) {
    // Query cost under 1000: 10 values per query, at most 25 hits (variant + product + 20 collections ≈ 30 points)
    for (let i = 0; i < vals.length; i += 10) {
      const chunk = vals.slice(i, i + 10);
      const r = await q<Json>(`query ImportMatch($first: Int!, $query: String) { productVariants(first: $first, query: $query) { nodes { ${VARIANT_SEL} } } }`, { first: 25, query: chunk.map(v => qField(field, v)).join(' OR ') });
      for (const v of r.productVariants.nodes) if ((field === 'sku' ? chunk.includes(v.sku) : chunk.includes(v.barcode))) add(v);
    }
  }
  if (needCollections) {
    let after: string | null = null;
    for (let i = 0; i < 20; i++) { const p = await searchCollections(q, undefined, 100, after); cat.collections.push(...p.nodes.map(c => ({ id: shortId(c.id), title: c.title, handle: c.handle, manual: !c.ruleSet }))); if (!p.pageInfo.hasNextPage) break; after = p.pageInfo.endCursor; if (i === 19) cat.notes.push('Nur die ersten 2.000 Kollektionen geladen'); }
  }
  return cat;
}

// ======================= Executor =======================
export interface ShopifyImportReport { created: { id: string; name: string; line: number; variants: number }[]; updated: { id: string; line: number }[]; failed: { line: number; label: string; error: string }[] }
const REPORTS = singleton('shopify-import-reports', () => new Map<string, ShopifyImportReport>());
export const takeShopifyReport = (csId: string) => { const r = REPORTS.get(csId) ?? null; REPORTS.delete(csId); return r; };

async function applyUpdate(client: ShopifyClient, p: ShopifyUpdatePlan, undo: UndoOp[]) {
  const r = await client.gql<Json>('query ImportFresh($id: ID!, $vs: [ID!]!) { product(id: $id) { id title descriptionHtml vendor tags seo { title description } } nodes(ids: $vs) { ... on ProductVariant { id price compareAtPrice barcode product { id } } } }', { id: p.productId, vs: p.variants.map(v => v.id) });
  const cur = r.product, fresh = new Map<string, Json>((r.nodes ?? []).filter((n: Json) => n?.id && n.product?.id === p.productId).map((n: Json) => [n.id, n]));
  if (!cur || p.variants.some(v => !fresh.has(v.id))) throw new Error('Produkt oder Variante nicht mehr vorhanden');
  const prod: Json = { id: p.productId }, back: Json = { id: p.productId };
  for (const [k, val] of Object.entries(p.product)) { prod[k] = val; back[k] = k === 'seo' ? { title: cur.seo?.title ?? null, description: cur.seo?.description ?? null } : cur[k] ?? (k === 'tags' ? [] : ''); }
  if (p.join.length) { prod.collectionsToJoin = p.join.map(c => toGid('Collection', c)); back.collectionsToLeave = prod.collectionsToJoin; }
  if (Object.keys(prod).length > 1) await runRecording(client, M.productUpdate, { product: prod }, undo, reqOp('product', p.productId, M.productUpdate, { product: back }));
  const vIns: Json[] = [], vBacks: Json[] = [];
  for (const x of p.variants) {
    const v = fresh.get(x.id)!, vIn: Json = { id: x.id }, vBack: Json = { id: x.id };
    if (x.price != null) { vIn.price = money(x.price); vBack.price = moneyRaw(v.price); }
    if (x.compareAtPrice !== undefined) { vIn.compareAtPrice = x.compareAtPrice == null ? null : money(x.compareAtPrice); vBack.compareAtPrice = moneyRaw(v.compareAtPrice); }
    if (x.barcode) { vIn.barcode = x.barcode; vBack.barcode = v.barcode ?? null; }
    if (Object.keys(vIn).length > 1) { vIns.push(vIn); vBacks.push(vBack); }
  }
  // all variants of a product in one call (productVariantsBulkUpdate, up to 250 variants)
  if (vIns.length) await runRecording(client, M.variantsUpdate, { productId: p.productId, variants: vIns }, undo, reqOp('variants', p.productId, M.variantsUpdate, { productId: p.productId, variants: vBacks }));
  if (p.images.length) await applyImages(client, { productId: p.productId, add: p.images.map(image => ({ image, alt: cur.title })), remove: [], order: p.images }, undo);
}

/**
 * Create a new product. If a step after productCreate fails (variants, collection, publication), the half-created
 * product is removed right away; if that fails, it stays as a draft until undo (the message says so).
 */
async function applyCreate(client: ShopifyClient, p: ShopifyCreatePlan, undo: UndoOp[]): Promise<string> {
  const mine: UndoOp[] = [];
  try { const id = await createOne(client, p, mine); undo.push(...mine); return id; }
  catch (e) {
    if (!mine.length) throw e;
    const r = await undoShopify(client, mine), bad = r.filter(x => !x.ok);
    if (!bad.length) throw new Error(`${errMsg(e)} (angelegtes Produkt wieder entfernt)`);
    undo.push(...mine);
    throw new Error(`${errMsg(e)} (halb angelegtes Produkt bleibt als Entwurf, bis „Rückgängig“: ${bad.map(x => x.error).join('; ')})`);
  }
}
async function createOne(client: ShopifyClient, p: ShopifyCreatePlan, undo: UndoOp[]): Promise<string> {
  if (!p.options?.length) { const mine: UndoOp[] = []; try { await createProduct(client, p.product, mine); } finally { undo.push(...mine); } return shortId((mine.find(o => o.op === 'delete' && o.entity === 'product'))?.id ?? ''); }
  // Variant family: create product with options, then all variants (the automatically created single variant is replaced)
  const x = p.product, media = x.images.map(u => ({ originalSource: u, mediaContentType: 'IMAGE', alt: x.name }));
  const r = await runCreating<Json>(client, M.productCreate, {
    product: { title: x.name, descriptionHtml: x.description, status: x.active ? 'ACTIVE' : 'DRAFT', ...(x.vendor ? { vendor: x.vendor } : {}), ...(x.tags.length ? { tags: x.tags } : {}),
      ...(x.metaTitle || x.metaDescription ? { seo: { title: x.metaTitle ?? null, description: x.metaDescription ?? null } } : {}),
      ...(x.collectionIds.length ? { collectionsToJoin: x.collectionIds.map(c => toGid('Collection', c)) } : {}),
      productOptions: p.options.map(o => ({ name: o.name, values: o.values.map(name => ({ name })) })) },
    media: media.length ? media : null,
  }, undo, 'product', () => productIdsByTitle(client, x.name));
  const gid = r.product.id; undo.push(deleteOp('product', gid));
  // With productOptions Shopify creates one variant with the first values: update it, create the rest.
  // (Per the Shopify docs everything could also go via REMOVE_STANDALONE_VARIANT; the local fake then reports "already exists". This way works for both.)
  const input = (v: NonNullable<ShopifyCreatePlan['variants']>[number]) => ({ price: money(v.price, x.currency), ...(v.listPrice ? { compareAtPrice: money(v.listPrice, x.currency) } : {}), ...(v.sku ? { inventoryItem: { sku: v.sku } } : {}), ...(v.barcode ? { barcode: v.barcode } : {}) });
  const optionValues = (v: NonNullable<ShopifyCreatePlan['variants']>[number]) => Object.entries(v.options).map(([optionName, name]) => ({ optionName, name }));
  const auto: Json[] = (await client.gql<Json>('query NewVariants($id: ID!) { product(id: $id) { variants(first: 5) { nodes { id selectedOptions { name value } } } } }', { id: gid })).product?.variants?.nodes ?? [];
  const same = (a: Json, v: NonNullable<ShopifyCreatePlan['variants']>[number]) => (a.selectedOptions as Json[]).every(o => v.options[o.name] === o.value);
  const first = auto.length === 1 ? p.variants!.find(v => same(auto[0], v)) : undefined;
  if (first) await run(client, M.variantsUpdate, { productId: gid, variants: [{ id: auto[0].id, ...input(first) }] });
  const rest = p.variants!.filter(v => v !== first);
  if (rest.length) await run(client, M.variantsCreateStrategy, { productId: gid, strategy: first ? 'DEFAULT' : 'REMOVE_STANDALONE_VARIANT', variants: rest.map(v => ({ optionValues: optionValues(v), ...input(v) })) });
  if (x.active) await run(client, M.publish, { id: gid, input: [{ publicationId: await onlineStorePublication(client) }] });
  return shortId(gid);
}

export async function applyShopifyImport(client: ShopifyClient, cs: ChangeSet, payload: ShopifyImportPayload, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const plans = payload.plans.filter(p => isSelectedPlan(p, selected)), report: ShopifyImportReport = { created: [], updated: [], failed: [] }, undo: UndoOp[] = [];
  const ok = new Map<string, number>(), fail = new Map<string, string>(), partial: ApplyResult['results'] = []; let done = 0;
  await pool(plans, WRITE_CONCURRENCY, async p => {
    const mine: UndoOp[] = [];
    try {
      if (p.kind === 'create') { const id = await applyCreate(client, p, mine); report.created.push({ id, name: p.product.name, line: p.line, variants: p.variants?.length ?? 0 }); }
      else { await applyUpdate(client, p, mine); report.updated.push({ id: shortId(p.productId), line: p.line }); }
      ok.set(p.key, 1);
    } catch (e) { fail.set(p.key, errMsg(e)); report.failed.push({ line: p.line, label: p.label, error: errMsg(e) }); }
    finally { undo.push(...mine); partial.push({ itemId: `p:${p.key}`, ok: !fail.has(p.key), ...(fail.has(p.key) ? { error: fail.get(p.key) } : {}) }); ctx?.progress?.(++done, plans.length, { results: partial, undo }); } // even on partial failures: created products remain undoable
  });
  REPORTS.set(cs.id, report);
  const results = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info').map(i => {
    const ps = i.id.startsWith('grp:') ? plans.filter(p => `grp:${p.group}` === i.id) : plans.filter(p => `p:${p.key}` === i.id);
    const errs = ps.filter(p => fail.has(p.key)).map(p => `Zeile ${p.line}: ${fail.get(p.key)}`);
    return { itemId: i.id, ok: !errs.length, ...(errs.length ? { error: errs.slice(0, 5).join('; ') + (errs.length > 5 ? ` (+${errs.length - 5})` : '') } : {}) };
  });
  return { results, undo, counts: { applied: ok.size, failed: fail.size } };
}

// ======================= Tools =======================
const optionsShape = z.object({
  mode: z.enum(['both', 'create', 'update']).optional().describe('both = vorhandene aktualisieren + neue anlegen (Standard), create = nur neue, update = nur vorhandene'),
  updateFields: z.array(z.string()).optional().describe(`Zielfelder, die bei VORHANDENEN Produkten überschrieben werden. Standard: ${DEFAULT_UPDATE.join(', ')}`),
  updatePrices: z.boolean().optional().describe('Preis und Vergleichspreis vorhandener Varianten überschreiben: NUR nach ausdrücklicher Bestätigung'),
  active: z.boolean().optional().describe('neue Produkte sofort aktiv und im Online Store (Standard false = Entwurf)'),
  categoryMap: z.record(z.string(), z.string()).optional().describe('Kategorie-Text aus der Datei → Kollektions-ID (nach Rückfrage); "" = ohne Kollektion'),
  defaultCategoryId: z.string().optional().describe('manuelle Kollektion für Produkte ohne passende Kollektion'),
  offset: z.number().int().optional(), limit: z.number().int().optional().describe(`Zeilen je Änderungsset (max. ${IMPORT_MAX})`),
});

function tools(session: Session): AnyTool[] {
  const prepare = async (fileId: string, sheet: string | undefined, mapping: ImportMapping, opts: ShopifyImportOptions, title: string, reason: string) => {
    const { t, name } = await loadTable(fileId, sheet);
    const problems = checkMapping(mapping, t.headers); if (problems.length) throw new Error(`Zuordnung prüfen: ${problems.join('; ')}`);
    const all = readRecords(t, mapping), { offset, end } = sectionRange(all, opts);
    const cat = await loadShopifyCatalog(qOf(readerOf(session)), all.slice(offset, end), !!mapping.category || !!opts.defaultCategoryId);
    return planShopifyImport(t, mapping, cat, opts, { title, reason, fileName: name });
  };
  return [
    ...supplierFileTools(),
    tool('preview_import', 'PRÜFT einen Import ohne zu schreiben (Probelauf mit denselben Argumenten wie propose_import): Anzahl neu/aktualisiert/übersprungen/unverändert, unbekannte Kollektionen (unknownCategories, für categoryMap), nicht übernommene Spalten (ignored), Warnungen und Beispiele vorher → nachher. Ändert nichts.',
      { fileId: z.string(), sheet: z.string().optional(), mapping: mappingSchema, options: optionsShape.optional() },
      guard(async ({ fileId, sheet, mapping, options }) => {
        const { cs, stats } = await prepare(fileId, sheet, mapping, options ?? {}, 'Probelauf', '');
        const rows = cs.total == null ? cs.items.filter(i => i.entity !== 'info') : cs.sample ?? [];
        const warns = Object.entries(rows.flatMap(i => i.warn).reduce<Record<string, number>>((m, w) => ({ ...m, [w]: (m[w] ?? 0) + 1 }), {})).slice(0, 20).map(([w, n]) => `${n}× ${w}`);
        return ok({ stats, warnings: warns, skipped: cs.skipped.slice(0, 30).map(x => x.reason), examples: rows.slice(0, 8).map(i => ({ product: i.label, change: i.fieldLabel, before: i.before, after: i.after, ...(i.warn.length ? { warn: i.warn } : {}) })) });
      })),
    tool('propose_import', `SCHLÄGT den Import einer Lieferantendatei in Shopify vor (Freigabe-Workflow; der Aufruf wartet auf die Entscheidung). Abgleich per SKU (Spalte productNumber), sonst Barcode (ean).
- VORHANDENE Produkte: nur zugeordnete, geänderte Felder (Titel, Beschreibung, Hersteller = Vendor, Meta-Title/-Description, keywords → Tags ergänzen, Barcode, Kollektionen ergänzen, Bilder nur bei Produkten ohne Bild). Preise nur mit updatePrices (je Variante mit dieser SKU). Mehrere Zeilen zum selben Produkt (Varianten) werden EIN Update: Preise/Barcodes je Variante, Produktfelder aus der Hauptzeile (parentNumber) bzw. nur, wenn alle Zeilen übereinstimmen (sonst Warnung). Neue Varianten an vorhandenen Produkten: propose_variants. Doppelte Artikelnummern: erste Zeile gilt.
- NEUE Produkte: als Entwurf (nicht im Online Store), Preis Pflicht (nie schätzen), Bilder nur per https-URL. Variantenfamilien: Zeilen mit gleicher Hauptartikel-Nr. (parentNumber) + variantOptions (höchstens 3 Optionen) werden EIN Produkt mit Varianten.
- Kollektionen werden NIE angelegt: Kategorie-Text = Titel oder Handle einer manuellen Kollektion; unbekannte vorher mit preview_import finden und als categoryMap übergeben. Bestand, Einkaufspreis, Gewicht/Maße, Lieferzeit und Eigenschaften übernimmt Lotse auf Shopify nicht (Hinweis in der Karte).
Bis ${IMPORT_MAX} Zeilen je Set (offset/limit, nextOffset im Ergebnis); ab ${ITEM_LIMIT} Produkten zeigt die Karte Gruppen + Stichprobe. Rückgängig löscht angelegte Produkte und stellt geänderte Felder, Preise und Kollektionen exakt wieder her.`,
      { fileId: z.string(), sheet: z.string().optional(), title: z.string(), reason: z.string(), mapping: mappingSchema, options: optionsShape.optional() },
      guard(async ({ fileId, sheet, title, reason, mapping, options }) => {
        const { cs, payload, stats } = await prepare(fileId, sheet, mapping, options ?? {}, title, reason);
        const out = await session.requestChange(cs, payload), rep = takeShopifyReport(cs.id);
        return ok({ status: out.status, message: out.message, error: out.error, applied: out.applied, stats, skipped: cs.skipped.slice(0, 30).map(s => s.reason),
          ...(rep ? { created: rep.created.slice(0, 300), updated: rep.updated.slice(0, 100).map(u => u.id), failed: rep.failed.slice(0, 100) } : {}), nextOffset: stats.nextOffset });
      })),
  ] as AnyTool[];
}

export const shopifyImportFeature: Feature = { key: 'shopify-import', platforms: ['shopify'], toolNames: ['read_supplier_file', 'save_import_mapping', 'preview_import', 'propose_import'], tools };
