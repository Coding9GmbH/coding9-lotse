import 'server-only';
// Magento: Import aus Lieferantendaten (CSV/Excel). Datei lesen, Spalten zuordnen und Zuordnung speichern wie bei allen Plattformen
// (features/import.ts); Abgleich per SKU mit dem Katalog, Planung und Schreiben hier: vorhandene Produkte nur zugeordnete, geänderte
// Felder (Preise/Bestand nur mit Freigabe-Option), neue als Entwurf (deaktiviert). Karte mit Gruppen + Stichprobe, Schreiben in
// Blöcken mit Fortschritt, Rückgängig je Produkt exakt (angelegte Produkte samt Lagerbestand löschen, Felder zurücksetzen).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { loadTable, mappingSchema, optionsSchema, supplierFileTools } from '../../features/import';
import { checkMapping, type ImportMapping } from '../../features/import-mapping';
import { IMPORT_MAX, readRecords, resolveCategories, sectionRange, type ImportOptions, type Rec } from '../../features/import-plan';
import type { Feature } from '../../features/types';
import type { Session } from '../../sessions';
import { guard, ok, type AnyTool } from '../../tool-kit';
import { errMsg, newIdSafe, pool, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult } from './kit';
import { skuPath, type MagentoClient } from './client';
import { attr, attrStr, basisWord, isoDay, money, plain, planPrice, priceState, priceUndo, sameValue, urlKey, type MCategory, type MProduct, type MRecord, type PriceBasis, type PriceWrite } from './map';
import type { MagentoReader } from './reader';
import { assertPriceInView, assertPriceUnchanged, stockSource } from './catalog';
import { applyImages, createProduct, type NewProductPlan } from './images';
import { reg, reqOp, writeScoped } from './write';

export const M_IMPORT_KIND = 'supplier-import';
const CHUNK = 50, SAMPLE = 50;

// ================= Katalog (nur lesend, geschützter Lese-Client) =================
export interface AttrDef { code: string; label: string; input: string; options: { label: string; value: string }[] }
export interface MCatalog {
  products: MProduct[];
  categories: { id: string; path: string[] }[];
  /** eigene Attribute für Eigenschaften-Spalten (Code oder Bezeichnung) + Hersteller, EAN, Hersteller-Nr. falls vorhanden */
  attributes: AttrDef[];
  taxClasses: { label: string; value: string }[];
  attributeSetId: number | null; websiteIds: number[];
  /** MSI-Quelle für Bestand; reason = warum Bestand nicht geht */
  stock: { source: string } | { reason: string };
  /** Bestand vorhandener Produkte je SKU (nur mit Quelle) */
  stockBySku: Record<string, { quantity: number; status: number }>;
  basis: PriceBasis | null;
  takenUrlKeys: string[];
}
const low = (s: string) => s.trim().toLocaleLowerCase('de-DE');
const defOf = (a: MRecord | null | undefined): AttrDef | null => a ? { code: String(a.attribute_code), label: String(a.default_frontend_label ?? a.attribute_code), input: String(a.frontend_input ?? 'text'), options: ((a.options ?? []) as { label: string; value: string }[]).filter(o => o.value !== '') } : null;

export async function loadMagentoCatalog(ro: MagentoReader, recs: Rec[], m: ImportMapping): Promise<MCatalog> {
  const skus = [...new Set(recs.map(r => r.number).filter(Boolean) as string[])];
  const products: MProduct[] = [];
  for (let i = 0; i < skus.length; i += 100) products.push(...await ro.productsBySkus(skus.slice(i, i + 100)));
  const categories: MCatalog['categories'] = [];
  if (m.category) {
    const walk = (c: MCategory, path: string[]) => { const p = Number(c.level) >= 2 ? [...path, String(c.name ?? '')] : path; if (Number(c.level) >= 2) categories.push({ id: String(c.id), path: p }); for (const k of c.children_data ?? []) walk(k, p); };
    walk(await ro.categoryTree(), []);
  }
  const attributes: AttrDef[] = [];
  const want = [...(m.properties ?? []).map(p => p.group), ...(m.manufacturer ? ['manufacturer'] : []), ...(m.ean ? ['ean', 'gtin'] : []), ...(m.manufacturerNumber ? ['mpn'] : []), ...(m.purchasePrice ? ['cost'] : [])];
  if (want.length) {
    const user = (await ro.attributes({ filters: [[{ field: 'is_user_defined', value: 1 }]], pageSize: 500 })).items.map(defOf).filter(Boolean) as AttrDef[];
    for (const w of want) {
      const hit = user.find(a => low(a.code) === low(w) || low(a.label) === low(w)) ?? defOf(/^[a-z][a-z0-9_]*$/.test(w) ? await ro.attribute(w).catch(() => null) : null);
      if (hit && !attributes.some(a => a.code === hit.code)) attributes.push(hit);
    }
  }
  const [sets, websites, tax, stock] = await Promise.all([ro.attributeSets(), ro.websites(), ro.attribute('tax_class_id'), stockSource(ro)]);
  const set = sets.items.find(s => s.attribute_set_name === 'Default' && Number(s.entity_type_id) === 4) ?? sets.items.find(s => Number(s.entity_type_id) === 4);
  const stockBySku: MCatalog['stockBySku'] = {};
  if ('source' in stock && products.length) for (const x of await ro.sourceItems(products.map(p => p.sku))) if (x.source_code === stock.source) stockBySku[x.sku] = { quantity: Number(x.quantity ?? 0), status: Number(x.status ?? 0) };
  // URL-Schlüssel neuer Produkte dürfen nicht schon vergeben sein
  const keys = [...new Set(recs.filter(r => r.name && !products.some(p => p.sku === r.number)).map(r => urlKey(r.name!)))];
  const takenUrlKeys: string[] = [];
  for (let i = 0; i < keys.length; i += 100) takenUrlKeys.push(...(await ro.products({ filters: [[{ field: 'url_key', value: keys.slice(i, i + 100), condition_type: 'in' }]], pageSize: 100, fields: 'items[id,sku,custom_attributes],total_count' })).items.map(p => String(attrStr(p, 'url_key'))));
  return {
    products, categories, attributes, taxClasses: ((tax?.options ?? []) as { label: string; value: string }[]).filter(o => o.value !== '' && o.value !== '0'),
    attributeSetId: set ? Number(set.attribute_set_id) : null, websiteIds: websites.map(w => Number(w.id)).filter(i => i > 0), stock, stockBySku, basis: ro.priceBasis, takenUrlKeys,
  };
}

// ================= Planung (rein) =================
export type Group = 'create' | 'create-warn' | 'update' | 'update-warn';
export interface MCreatePlan { kind: 'create'; key: string; group: Group; label: string; sku: string; product: NewProductPlan; images: string[] }
export interface MUpdatePlan {
  kind: 'update'; key: string; group: Group; label: string; sku: string; id: string;
  /** Texte/Attribute (Store-View bzw. global, je nachdem woher der Wert kommt) und globale Werte (Preise, Gewicht, Einkaufspreis) */
  scoped: Record<string, unknown>; global: Record<string, unknown>;
  /** Preisfelder: Stand beim Vorschlag (Prüfung vor dem Schreiben) */
  expect?: PriceWrite;
  stock?: number; addCategories: string[]; images: string[];
}
export type MPlan = MCreatePlan | MUpdatePlan;
export interface MImportStats { rows: number; create: number; update: number; skipped: number; unchanged: number; nextOffset: number | null; unknownCategories: string[]; notes: string[] }

const SCOPED_TEXT: Partial<Record<keyof Rec, string>> = { name: 'name', description: 'description', metaTitle: 'meta_title', metaDescription: 'meta_description', keywords: 'meta_keyword' };
const LABEL: Record<string, string> = { name: 'Name', description: 'Beschreibung', meta_title: 'Meta-Title', meta_description: 'Meta-Description', meta_keyword: 'Meta-Keywords', weight: 'Gewicht', cost: 'Einkaufspreis', price: 'Preis', special_price: 'Sonderpreis', stock: 'Bestand', categories: 'Kategorien', images: 'Bilder' };
const short = (v: unknown, n = 40) => { const s = plain(v); return s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '–'; };
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const UPDATE_DEFAULT_OFF = new Set(['priceGross', 'priceNet', 'listPrice', 'purchasePrice', 'stock', 'taxRate']);

/** Preis der Datei in der Basis des Shops (brutto/netto); null = keine Angabe */
export function shopPrice(r: { gross?: number; net?: number; taxRate?: number }, basis: PriceBasis, defRate = 19, which: 'price' | 'list' = 'price', list?: number): number | null {
  const rate = (r.taxRate ?? defRate) / 100;
  if (which === 'list') return list == null ? null : basis === 'gross' ? list : r4(list / (1 + rate)); // Streichpreis/UVP in der Datei = brutto
  if (basis === 'gross') return r.gross != null ? r.gross : r.net != null ? Math.round(r.net * (1 + rate) * 100) / 100 : null;
  return r.net != null ? r.net : r.gross != null ? r4(r.gross / (1 + rate)) : null;
}

/** Eigenschaften und Hersteller → Attributwerte (Auswahlwerte per Bezeichnung); unbekannte Werte als Warnung */
function attrValues(r: Rec, m: ImportMapping, cat: MCatalog, warn: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (code: string, raw: string) => {
    const a = cat.attributes.find(x => x.code === code || low(x.label) === low(code));
    if (!a) { warn.push(`Attribut „${code}“ gibt es nicht`); return; }
    if (a.input === 'select' || a.input === 'multiselect') {
      const vals = raw.split(/\s*[,;|]\s*/).filter(Boolean), ids = vals.map(v => a.options.find(o => low(o.label) === low(v))?.value);
      const miss = vals.filter((_, i) => !ids[i]);
      if (miss.length) { warn.push(`${a.label}: Wert ${miss.map(x => `„${x}“`).join(', ')} gibt es nicht (Auswahlwerte in Magento anlegen)`); return; }
      out[a.code] = a.input === 'multiselect' ? ids.join(',') : ids[0];
    } else if (a.input === 'boolean') out[a.code] = /^(1|ja|yes|true|x)$/i.test(raw) ? '1' : '0';
    else out[a.code] = raw;
  };
  if (r.manufacturer) set('manufacturer', r.manufacturer);
  if (r.ean && m.ean) { const a = cat.attributes.find(x => x.code === 'ean' || x.code === 'gtin'); if (a) out[a.code] = r.ean; else warn.push('EAN: kein Attribut „ean“/„gtin“ im Shop'); }
  if (r.manufacturerNumber) { const a = cat.attributes.find(x => x.code === 'mpn'); if (a) out.mpn = r.manufacturerNumber; else warn.push('Hersteller-Nr.: kein Attribut „mpn“ im Shop'); }
  const byGroup = new Map<string, string[]>();
  for (const p of r.props) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p.value]);
  for (const [g, vals] of byGroup) set(g, vals.join(','));
  return out;
}

export function planMagentoImport(recs: Rec[], m: ImportMapping, cat: MCatalog, opts: ImportOptions, meta: { title: string; reason: string; fileName: string; nextOffset: number | null }): { cs: ChangeSet; payload: { plans: MPlan[] }; stats: MImportStats } {
  const skipped: ChangeSet['skipped'] = [], plans: MPlan[] = [], rows: { plan: MPlan; before: string; after: string; warn: string[] }[] = [], notes: string[] = [], unknown = new Set<string>();
  const mode = opts.mode ?? 'both', bySku = new Map(cat.products.map(p => [p.sku, p])), taken = new Set(cat.takenUrlKeys);
  const updatable = (k: keyof ImportMapping) => !!m[k] && (opts.updateFields ? opts.updateFields.includes(k) : !UPDATE_DEFAULT_OFF.has(k));
  const skip = (r: Rec, reason: string) => skipped.push({ id: `z${r.line}`, reason: `Zeile ${r.line}${r.number ? ` (${r.number})` : ''}: ${reason}` });
  if (m.ean && !m.productNumber) throw new Error('Magento gleicht per SKU ab: Spalte für die Produktnummer (SKU) zuordnen');
  for (const k of ['width', 'height', 'length', 'deliveryTime'] as const) if (m[k]) notes.push(`${k === 'deliveryTime' ? 'Lieferzeit' : 'Maße'}: gibt es in Magento nicht als Standardfeld, Spalte wird nicht übernommen`);
  if ((m.variantOptions?.length || m.parentNumber) && recs.some(r => r.parent && r.parent !== r.number)) notes.push('Varianten-Zeilen werden übersprungen: Varianten in Magento mit propose_variants anlegen');
  const priceMapped = !!(m.priceGross || m.priceNet || m.listPrice);
  if (priceMapped && !cat.basis) notes.push('Preisbasis (brutto/netto) in den Einstellungen nicht festgelegt: Preise werden nicht übernommen, neue Produkte nicht angelegt');
  const seen = new Set<string>();
  let unchanged = 0;
  for (const r of recs) {
    if (r.parent && r.parent !== r.number) { skip(r, 'Variante (in Magento mit propose_variants anlegen)'); continue; }
    if (!r.number) { skip(r, 'SKU fehlt'); continue; }
    if (seen.has(r.number)) { skip(r, 'doppelt in der Datei (nur die erste Zeile zählt)'); continue; }
    seen.add(r.number);
    if (r.problems.length) { skip(r, r.problems.join('; ')); continue; }
    const warn: string[] = [], cur = bySku.get(r.number);
    const cats = r.category ? resolveCategories(r.category, cat.categories, opts.categoryMap) : { ids: [] as string[], missing: [] as string[], raw: [] as string[] };
    for (const x of cats.raw) unknown.add(x);
    if (cats.missing.length) warn.push(`Kategorie unbekannt: ${cats.missing.join(', ')}`);
    try {
      if (!cur) {
        if (mode === 'update') { skip(r, 'nicht im Shop (mode=update)'); continue; }
        if (!r.name) throw new Error('Name fehlt');
        if (!cat.basis) throw new Error('Preisbasis unbekannt (Einstellungen → Shop verbinden)');
        if (!cat.attributeSetId) throw new Error('Kein Attributset für Produkte gefunden');
        const sell = shopPrice(r, cat.basis, opts.defaultTaxRate);
        if (sell == null) throw new Error('Preis fehlt (für neue Produkte Pflicht)');
        const list = shopPrice(r, cat.basis, opts.defaultTaxRate, 'list', r.list);
        const extra: Record<string, unknown> = attrValues(r, m, cat, warn);
        let price = sell;
        if (list != null) { if (list > sell) { price = list; extra.special_price = sell; } else warn.push(`Streichpreis ${money(list)} nicht über dem Preis: ignoriert`); }
        if (r.purchase != null) { if (cat.attributes.some(a => a.code === 'cost')) extra.cost = r.purchase; }
        let key = urlKey(r.name);
        if (taken.has(key)) key = urlKey(`${r.name}-${r.number}`);
        taken.add(key);
        const tax = cat.taxClasses.find(o => o.value === '2') ?? cat.taxClasses[0];
        if (!tax) throw new Error('Keine Steuerklasse im Shop');
        const active = opts.active === true, stock = r.stock ?? 0, ids = cats.ids.length ? cats.ids : opts.defaultCategoryId ? [opts.defaultCategoryId] : [];
        if ('reason' in cat.stock && r.stock) warn.push(`Bestand nicht gesetzt: ${cat.stock.reason}`);
        if (active) warn.push('Wird sofort aktiv im Shop');
        if (!r.images.length) warn.push('Ohne Bild');
        if (r.images.some(u => !/^https:\/\//.test(u))) warn.push('Bilder ohne https werden nicht geladen');
        const product: NewProductPlan = { name: r.name, description: r.description ?? '', price, sku: r.number, urlKey: key, attributeSetId: cat.attributeSetId, websiteIds: cat.websiteIds, taxClassId: tax.value, images: [], categoryIds: ids, stock, active, source: 'source' in cat.stock ? cat.stock.source : null,
          ...(r.metaTitle ? { metaTitle: r.metaTitle } : {}), ...(r.metaDescription ? { metaDescription: r.metaDescription } : {}), ...(r.keywords ? { keywords: r.keywords } : {}), ...(r.weight != null ? { weight: r.weight } : {}), extra };
        const plan: MCreatePlan = { kind: 'create', key: `n:${r.number}`, group: warn.length ? 'create-warn' : 'create', label: `${r.name} (${r.number})`, sku: r.number, product, images: r.images.filter(u => /^https:\/\//.test(u)) };
        plans.push(plan);
        rows.push({ plan, before: '–', after: `neu · ${money(sell)} ${basisWord(cat.basis)}${extra.special_price != null ? ` (statt ${money(price)})` : ''} · ${active ? 'aktiv' : 'inaktiv (Entwurf)'} · Bestand ${stock}${r.images.length ? ` · ${r.images.length} Bild(er)` : ''}`, warn });
        continue;
      }
      if (mode === 'create') { skip(r, 'schon im Shop (mode=create)'); continue; }
      // ---- vorhandenes Produkt: nur zugeordnete, geänderte Felder ----
      const scoped: Record<string, unknown> = {}, global: Record<string, unknown> = {}, before: string[] = [], after: string[] = [];
      const change = (code: string, v: unknown, where: Record<string, unknown>) => { const old = attr(cur, code); if (v == null || v === '' || sameValue(old, v)) return; where[code] = v; before.push(`${LABEL[code] ?? code}: ${short(old)}`); after.push(`${LABEL[code] ?? code}: ${short(v)}`); };
      for (const [k, code] of Object.entries(SCOPED_TEXT) as [keyof Rec, string][]) {
        if (updatable(k as keyof ImportMapping)) change(code, r[k] as unknown, scoped);
      }
      if (updatable('weight') && r.weight != null) change('weight', r.weight, global);
      const av = attrValues(r, m, cat, warn);
      for (const [code, v] of Object.entries(av)) { const mk = code === 'manufacturer' ? 'manufacturer' : code === 'ean' || code === 'gtin' ? 'ean' : code === 'mpn' ? 'manufacturerNumber' : 'properties'; if (updatable(mk as keyof ImportMapping)) change(code, v, scoped); }
      if (opts.updatePrices && r.purchase != null && cat.attributes.some(a => a.code === 'cost')) change('cost', r.purchase, global);
      let expect: PriceWrite | undefined;
      if (opts.updatePrices && priceMapped) {
        if (!cat.basis) warn.push('Preis nicht übernommen: Preisbasis unbekannt');
        else if (['configurable', 'bundle', 'grouped'].includes(String(cur.type_id))) warn.push('Preis kommt aus den Einzelprodukten: nicht übernommen');
        else {
          // Ziel wie bei propose_product_changes über planPrice: fehlender Streichpreis (undefined) lässt einen aktiven Sonderpreis als Streichpreis-Paar stehen
          const s = priceState(cur), sell = shopPrice(r, cat.basis, opts.defaultTaxRate) ?? s.selling;
          let listPrice: number | null | undefined = r.list != null ? shopPrice(r, cat.basis, opts.defaultTaxRate, 'list', r.list) ?? undefined : undefined;
          if (sell != null && listPrice != null && !(listPrice > sell)) { warn.push(`Streichpreis ${money(listPrice)} nicht über dem Preis: ignoriert`); listPrice = null; }
          else if (sell != null && listPrice === undefined && s.list != null && !(s.list > sell)) listPrice = null; // Preis erreicht den bisherigen Streichpreis: Sonderpreis entfällt
          const w: PriceWrite = sell != null ? planPrice(s, { price: sell, listPrice }).write : {};
          if (Object.keys(w).length) {
            Object.assign(global, w); expect = priceUndo(cur, Object.keys(w) as (keyof PriceWrite)[]);
            // Vorher/Nachher aus dem tatsächlich geschriebenen Zustand
            const nv = (k: keyof PriceWrite, old: unknown) => (k in w ? w[k] : old);
            const next = priceState({ price: nv('price', s.regular), custom_attributes: [{ attribute_code: 'special_price', value: nv('special_price', s.special) }, { attribute_code: 'special_from_date', value: nv('special_from_date', s.from) }, { attribute_code: 'special_to_date', value: nv('special_to_date', s.to) }] });
            before.push(`Preis: ${money(s.selling)}${s.list != null ? ` statt ${money(s.list)}` : ''}`); after.push(`Preis: ${money(next.selling)}${next.list != null ? ` statt ${money(next.list)}` : ''}`);
            if (next.special != null && next.from != null && next.from > isoDay() && next.special < (next.regular ?? 0)) warn.push('Geplanter Sonderpreis bleibt bestehen');
            if (s.selling && sell && Math.abs(sell - s.selling) / s.selling >= 0.3) warn.push(`Preisänderung ${sell > s.selling ? '+' : '−'}${Math.round(Math.abs(sell - s.selling) / s.selling * 100)} %`);
          }
        }
      }
      let stock: number | undefined;
      if (opts.updateStock && r.stock != null) {
        if ('reason' in cat.stock) warn.push(`Bestand nicht übernommen: ${cat.stock.reason}`);
        else if (cat.stockBySku[cur.sku]?.quantity !== r.stock) { stock = r.stock; before.push(`Bestand: ${cat.stockBySku[cur.sku]?.quantity ?? '–'}`); after.push(`Bestand: ${r.stock}`); if (r.stock <= 0 && (cat.stockBySku[cur.sku]?.status ?? 0) === 1) warn.push('Bestand 0, Status bleibt „auf Lager“ (weiter bestellbar)'); }
      }
      const have = new Set(((cur.extension_attributes?.category_links ?? []) as { category_id: string }[]).map(l => String(l.category_id)));
      const addCategories = updatable('category') ? cats.ids.filter(id => !have.has(id)) : [];
      if (addCategories.length) after.push(`+${addCategories.length} Kategorie(n)`);
      const images = updatable('images') && !(cur.media_gallery_entries ?? []).length ? r.images.filter(u => /^https:\/\//.test(u)) : [];
      if (images.length) after.push(`+${images.length} Bild(er)`);
      if (!Object.keys(scoped).length && !Object.keys(global).length && stock === undefined && !addCategories.length && !images.length) { unchanged++; continue; }
      const plan: MUpdatePlan = { kind: 'update', key: `u:${cur.sku}`, group: warn.length ? 'update-warn' : 'update', label: `${cur.name ?? cur.sku} (${cur.sku})`, sku: cur.sku, id: String(cur.id), scoped, global, ...(expect ? { expect } : {}), ...(stock !== undefined ? { stock } : {}), addCategories, images };
      plans.push(plan); rows.push({ plan, before: before.join(' · ') || '–', after: after.join(' · '), warn });
    } catch (e) { skip(r, errMsg(e)); }
  }
  if (!plans.length) throw new Error(`Nichts zu importieren (${recs.length} Zeilen, ${unchanged} unverändert, ${skipped.length} übersprungen${skipped[0] ? `: ${skipped.slice(0, 3).map(s => s.reason).join('; ')}` : ''})`);
  const G: Record<Group, string> = { create: 'neu', 'create-warn': 'neu, mit Warnungen', update: 'aktualisieren', 'update-warn': 'aktualisieren, mit Warnungen' }, items: ChangeItem[] = [];
  for (const g of ['create', 'create-warn', 'update', 'update-warn'] as Group[]) {
    const xs = rows.filter(x => x.plan.group === g); if (!xs.length) continue;
    const warn = g.endsWith('warn') ? Object.entries(xs.flatMap(x => x.warn.map(w => w.replace(/[+−]\d+ %$/, 'Preisänderung über 30 %'))).reduce<Record<string, number>>((acc, w) => ({ ...acc, [w]: (acc[w] ?? 0) + 1 }), {})).slice(0, 12).map(([w, n]) => `${n}× ${w}`) : [];
    items.push({ id: `grp:${g}`, entity: 'product', label: `${xs.length.toLocaleString('de-DE')} ${xs.length === 1 ? 'Produkt' : 'Produkte'} ${G[g]}`, field: 'import', fieldLabel: g.startsWith('create') ? 'Anlegen (Entwurf)' : 'Aktualisieren', before: '', after: '', afterRaw: { count: xs.length }, warn });
  }
  for (const n of notes) items.push({ id: `hint:${items.length}`, entity: 'info', label: 'Hinweis', fieldLabel: '', before: '', after: n, warn: [] });
  const sample: ChangeItem[] = [...rows.slice(0, SAMPLE), ...rows.slice(SAMPLE).filter(x => x.warn.length).slice(0, 10)].map(({ plan, before, after, warn }) => ({ id: plan.key, entity: 'info', label: plan.label, fieldLabel: plan.kind === 'create' ? 'Neu' : 'Ändern', before, after, warn }));
  const nCreate = plans.filter(p => p.kind === 'create').length, nUpdate = plans.length - nCreate;
  return {
    cs: { id: newIdSafe(), kind: M_IMPORT_KIND, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title: meta.title, reason: meta.reason || `Import aus ${meta.fileName}`, items, sample, total: plans.length, skipped: skipped.slice(0, 200), unchanged, atomic: false, applyLabel: `${plans.length.toLocaleString('de-DE')} ${plans.length === 1 ? 'Produkt' : 'Produkte'} importieren` },
    payload: { plans },
    stats: { rows: recs.length, create: nCreate, update: nUpdate, skipped: skipped.length, unchanged, nextOffset: meta.nextOffset, unknownCategories: [...unknown], notes },
  };
}

// ================= Executor =================
async function applyUpdate(c: MagentoClient, store: string, pl: MUpdatePlan): Promise<UndoOp[]> {
  const undo: UndoOp[] = [];
  try {
    if (pl.expect) await assertPriceUnchanged(c, pl.sku, store, pl.expect); // im Scope des Vorschlags (Website-Preise)
    if (Object.keys(pl.scoped).length || Object.keys(pl.global).length) undo.push(...await writeScoped(c, 'product', pl.sku, store, pl.scoped, pl.global));
    if (pl.expect) await assertPriceInView(c, pl.sku, store, pl.global as PriceWrite, undo);
    if (pl.stock !== undefined) {
      const src = (await c.req('GET', '/V1/inventory/sources', undefined, { store: 'all', query: 'searchCriteria[pageSize]=50' }) as { items: MRecord[] }).items.filter(s => s.enabled !== false);
      if (src.length !== 1) throw new Error('Bestand: nicht genau eine Lagerquelle');
      const code = String(src[0].source_code);
      const cur = (await c.search('/V1/inventory/source-items', { filters: [[{ field: 'sku', value: pl.sku }], [{ field: 'source_code', value: code }]], pageSize: 1 }, { store: 'all' })).items[0] as MRecord | undefined;
      await c.req('POST', '/V1/inventory/source-items', { sourceItems: [{ sku: pl.sku, source_code: code, quantity: pl.stock, status: pl.stock > 0 ? 1 : (cur ? Number(cur.status) : 0) }] }, { store: 'all' });
      undo.push(cur ? reqOp('source-item', pl.sku, 'POST', '/all/V1/inventory/source-items', { sourceItems: [{ sku: pl.sku, source_code: code, quantity: Number(cur.quantity), status: Number(cur.status) }] }) : reqOp('source-item', pl.sku, 'POST', '/all/V1/inventory/source-items-delete', { sourceItems: [{ sku: pl.sku, source_code: code }] }));
    }
    for (const cid of pl.addCategories) {
      await c.req('POST', `/V1/categories/${Number(cid)}/products`, { productLink: { sku: pl.sku, position: 0, category_id: String(cid) } }, { store: 'all' });
      undo.push(reqOp('category-product', pl.sku, 'DELETE', `/all/V1/categories/${Number(cid)}/products/${skuPath(pl.sku)}`));
    }
    if (pl.images.length) undo.push(...await applyImages(c, { sku: pl.sku, adds: pl.images.map((ref, i) => ({ ref, label: '', position: i + 1 })), entries: [], cover: 'new:0' }));
  } catch (e) { throw Object.assign(new Error(errMsg(e)), { undo: [...undo, ...((e as { undo?: UndoOp[] }).undo ?? [])] }); }
  return undo;
}
async function applyCreate(c: MagentoClient, pl: MCreatePlan): Promise<{ undo: UndoOp[]; imageError?: string }> {
  const undo = await createProduct(c, pl.product);
  // Bilder nach dem Anlegen: ein kaputtes Bild verhindert das Produkt nicht (Rückgängig löscht das Produkt samt Bildern)
  if (pl.images.length) { try { await applyImages(c, { sku: pl.sku, adds: pl.images.map((ref, i) => ({ ref, label: pl.product.name, position: i + 1 })), entries: [], cover: 'new:0' }); } catch (e) { return { undo, imageError: `${pl.sku}: ${errMsg(e)}` }; } }
  return { undo };
}

const reports = new Map<string, { created: string[]; updated: string[]; failed: { sku: string; error: string }[]; imageErrors: string[] }>();
export const takeMagentoReport = (csId: string) => { const r = reports.get(csId); reports.delete(csId); return r; };

reg.register(M_IMPORT_KIND, async (c, cs, payload, selected, ctx?: ApplyCtx): Promise<ApplyResult> => {
  const { plans: planned, store } = payload as { plans: MPlan[]; store?: string }, plans = planned.filter(p => selected.has(`grp:${p.group}`));
  const all: ApplyResult['results'] = [], undo: UndoOp[] = [], rep = { created: [] as string[], updated: [] as string[], failed: [] as { sku: string; error: string }[], imageErrors: [] as string[] };
  let done = 0; ctx?.progress?.(0, plans.length);
  for (let i = 0; i < plans.length; i += CHUNK) {
    const list = plans.slice(i, i + CHUNK);
    await pool(list, WRITE_CONCURRENCY, async pl => {
      try {
        if (pl.kind === 'create') { const r = await applyCreate(c, pl); undo.push(...r.undo); rep.created.push(pl.sku); if (r.imageError) rep.imageErrors.push(r.imageError); }
        else { undo.push(...await applyUpdate(c, store ?? c.storeCode, pl)); rep.updated.push(pl.sku); } // Store-View des Vorschlags (ältere Karten: Einstellung)
        all.push({ itemId: pl.key, ok: true });
      } catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); all.push({ itemId: pl.key, ok: false, error: errMsg(e) }); rep.failed.push({ sku: pl.sku, error: errMsg(e) }); }
    });
    done += list.length; ctx?.progress?.(done, plans.length, { results: all, undo });
  }
  reports.set(cs.id, rep);
  const bad = new Map(all.filter(r => !r.ok).map(r => [r.itemId, r])), sample = new Set((cs.sample ?? []).map(x => x.id)), results: ApplyResult['results'] = [];
  for (const g of ['create', 'create-warn', 'update', 'update-warn'] as Group[]) {
    const ids = plans.filter(p => p.group === g).map(p => p.key); if (!ids.length) continue;
    const f = ids.filter(id => bad.has(id)).length;
    results.push({ itemId: `grp:${g}`, ok: !f, ...(f ? { error: `${f} von ${ids.length} fehlgeschlagen` } : {}) });
  }
  results.push(...all.filter(r => sample.has(r.itemId)), ...[...bad.values()].filter(r => !sample.has(r.itemId)).slice(0, 100));
  return { results, undo, counts: { applied: all.length - bad.size, failed: bad.size } };
});

// ================= Werkzeuge =================
function tools(session: Session): AnyTool[] {
  const ro = () => { const r = session.reader as MagentoReader; if (!r || (r as { platform?: string }).platform !== 'magento') throw new Error('Dieses Werkzeug gibt es nur für Magento.'); return r; };
  async function prepare(fileId: string, sheet: string | undefined, mapping: ImportMapping, opts: ImportOptions, title: string, reason: string) {
    const { t, name } = await loadTable(fileId, sheet);
    const problems = checkMapping(mapping, t.headers); if (problems.length) throw new Error(`Zuordnung prüfen: ${problems.join('; ')}`);
    const all = readRecords(t, mapping), { offset, end } = sectionRange(all, opts), recs = all.slice(offset, end);
    if (!recs.length) throw new Error(`Keine Zeilen ab Zeile ${offset + 1} (Datei hat ${all.length} Datenzeilen)`);
    const cat = await loadMagentoCatalog(ro(), recs, mapping);
    const plan = planMagentoImport(recs, mapping, cat, opts, { title, reason, fileName: name, nextOffset: end < all.length ? end : null });
    return { ...plan, payload: { ...plan.payload, store: ro().storeCode } }; // Store-View des Vorschlags für den Executor
  }
  return [
    ...supplierFileTools(),
    tool('preview_import', 'PRÜFT einen Import ohne zu schreiben und ohne Freigabe-Karte (Probelauf mit denselben Argumenten wie propose_import): Anzahl neu/aktualisiert/übersprungen, unbekannte Kategorien (unknownCategories, für categoryMap), Warnungen und Beispiele vorher → nachher. Ändert nichts.',
      { fileId: z.string(), sheet: z.string().optional(), mapping: mappingSchema, options: optionsSchema.optional() },
      guard(async ({ fileId, sheet, mapping, options }) => {
        const { cs, stats } = await prepare(fileId, sheet, mapping, options ?? {}, 'Probelauf', '');
        const rows = cs.sample ?? [];
        const warns = Object.entries(rows.flatMap(i => i.warn).reduce<Record<string, number>>((acc, w) => ({ ...acc, [w]: (acc[w] ?? 0) + 1 }), {})).slice(0, 20).map(([w, n]) => `${n}× ${w}`);
        return ok({ stats, warnings: warns, skipped: cs.skipped.slice(0, 30).map(x => x.reason), ...(cs.skipped.length > 30 ? { skippedMore: cs.skipped.length - 30 } : {}), examples: rows.slice(0, 8).map(i => ({ product: i.label, change: i.fieldLabel, before: i.before, after: i.after, ...(i.warn.length ? { warn: i.warn } : {}) })) });
      })),
    tool('propose_import', `SCHLÄGT den Import einer Lieferantendatei nach Magento vor (Freigabe-Workflow; der Aufruf wartet auf die Entscheidung). Abgleich per SKU (Spalte productNumber):
- VORHANDENE Produkte: nur zugeordnete, geänderte Felder (Texte in der Store-View aus den Einstellungen bzw. global, Gewicht, Attribute). Preise und Einkaufspreis nur mit updatePrices, Bestand nur mit updateStock (eine Lagerquelle). Kategorien werden nur ergänzt, Bilder nur bei Produkten ohne Bild.
- NEUE Produkte: als Entwurf (deaktiviert, Bestand 0 ohne Spalte), Preis Pflicht und in der Preisbasis des Shops (brutto/netto, Einstellung), Streichpreis/UVP über dem Preis wird regulärer Preis + Sonderpreis, Steuerklasse „Taxable Goods“, alle Websites, sichtbar in Katalog und Suche.
- Eigenschaften und Hersteller: nur vorhandene Attribute und Auswahlwerte (Bezeichnung wie im Shop); fehlende werden gemeldet, nicht angelegt. Kategorien werden NIE angelegt (unbekannte vorher mit preview_import finden, nachfragen, categoryMap). Varianten-Zeilen werden übersprungen (propose_variants).
Bis ${IMPORT_MAX} Zeilen je Set (offset/limit, nextOffset im Ergebnis); die Karte zeigt Gruppen + Stichprobe, geschrieben wird in Blöcken mit Fortschritt. Rückgängig löscht angelegte Produkte samt Lagerbestand und stellt geänderte Felder exakt wieder her.`,
      { fileId: z.string(), sheet: z.string().optional(), title: z.string(), reason: z.string(), mapping: mappingSchema, options: optionsSchema.optional() },
      guard(async ({ fileId, sheet, title, reason, mapping, options }) => {
        const { cs, payload, stats } = await prepare(fileId, sheet, mapping, options ?? {}, title, reason);
        const out = await session.requestChange(cs, payload);
        const rep = takeMagentoReport(cs.id);
        return ok({ status: out.status, message: out.message, error: out.error, applied: out.applied, failedTotal: out.failedTotal ?? out.failed?.length ?? 0, stats, skipped: cs.skipped.slice(0, 30).map(s => s.reason),
          ...(rep ? { created: rep.created.slice(0, 300), updated: rep.updated.slice(0, 100), failed: rep.failed.slice(0, 100), imageErrors: rep.imageErrors.slice(0, 20) } : {}), nextOffset: stats.nextOffset });
      })),
  ] as AnyTool[];
}

export const magentoImport: Feature = { key: 'import-magento', platforms: ['magento'], toolNames: ['read_supplier_file', 'save_import_mapping', 'preview_import', 'propose_import'], tools };
