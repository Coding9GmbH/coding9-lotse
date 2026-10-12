import 'server-only';
// OpenMage: Import aus Lieferantendaten (CSV/Excel). Datei lesen, Spalten zuordnen und Zuordnung speichern wie bei allen Plattformen
// (features/import.ts); Abgleich per SKU mit dem Katalog, Planung und Schreiben hier: vorhandene Produkte nur zugeordnete, geänderte
// Felder (Preise/Bestand nur mit Freigabe-Option), neue als Entwurf (deaktiviert). Karte mit Gruppen + Stichprobe, Schreiben in
// Blöcken mit Fortschritt, Rückgängig je Produkt exakt (angelegte Produkte löschen, Felder und Bestand zurücksetzen).
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
import { skuPath, type OmClient } from './client';
import { basisWord, FROM_KIDS, isoDay, money, mrec, omAttr, plain, planPrice, priceOf, priceState, priceUndo, same, urlKey, type OmProduct, type PriceBasis, type PriceWrite } from './map';
import { LIST_FIELDS, type OmReader } from './reader';
import { assertPriceUnchanged, writeStock } from './catalog';
import { applyImages, createProduct, newProductDefaults, type NewProductPlan } from './images';
import { reg, reqOp, writeScoped } from './write';

export const OM_IMPORT_KIND = 'supplier-import';
const CHUNK = 50, SAMPLE = 50;

// ================= Katalog (nur lesend, geschützter Lese-Client) =================
export interface AttrDef { code: string; label: string; input: string; scope: string; options: { label: string; value: string }[] }
export interface OmCatalog {
  products: OmProduct[];
  categories: { id: string; path: string[] }[];
  attributes: AttrDef[];
  taxClasses: { label: string; value: number }[];
  attributeSetId: number | null; websiteIds: number[];
  basis: PriceBasis;
}
const low = (s: string) => s.trim().toLocaleLowerCase('de-DE');
const defOf = (a: Record<string, unknown> | null | undefined): AttrDef | null => a ? { code: String(a.code), label: String(a.label ?? a.code), input: String(a.input ?? 'text'), scope: String(a.scope ?? 'store'), options: ((a.options ?? []) as { label: string; value: unknown }[]).filter(o => o.value !== '' && o.value != null).map(o => ({ label: o.label, value: String(o.value) })) } : null;

export async function loadOmCatalog(ro: OmReader, recs: Rec[], m: ImportMapping): Promise<OmCatalog> {
  const skus = [...new Set(recs.map(r => r.number).filter(Boolean) as string[])];
  const products = await ro.productsBySkus(skus, { fields: [...LIST_FIELDS, 'manufacturer'], images: true });
  const categories: OmCatalog['categories'] = [];
  if (m.category) {
    const byId = new Map((await ro.categoriesFlat('admin')).map(c => [String(c.id), c]));
    for (const c of byId.values()) { if (Number(c.level) < 2) continue; const path = String(c.path ?? '').split('/').filter(id => Number(byId.get(id)?.level) >= 2).map(id => String(byId.get(id)?.name ?? '')); categories.push({ id: String(c.id), path: path.length ? path : [String(c.name ?? '')] }); }
  }
  const attributes: AttrDef[] = [];
  const want = [...(m.properties ?? []).map(p => p.group), ...(m.manufacturer ? ['manufacturer'] : []), ...(m.ean ? ['ean', 'gtin'] : []), ...(m.manufacturerNumber ? ['mpn'] : []), ...(m.purchasePrice ? ['cost'] : [])];
  if (want.length) {
    const all = (await ro.attributes()).attributes.map(defOf).filter(Boolean) as AttrDef[];
    for (const w of want) { const hit = all.find(a => low(a.code) === low(w) || low(a.label) === low(w)); if (hit && !attributes.some(a => a.code === hit.code)) attributes.push(hit); }
  }
  const d = await newProductDefaults(ro);
  return { products, categories, attributes, taxClasses: d.taxOpts, attributeSetId: d.attributeSetId, websiteIds: d.websiteIds, basis: await ro.priceBasis() };
}

// ================= Planung (rein) =================
export type Group = 'create' | 'create-warn' | 'update' | 'update-warn';
export interface OmCreatePlan { kind: 'create'; key: string; group: Group; label: string; sku: string; product: NewProductPlan }
export interface OmUpdatePlan { kind: 'update'; key: string; group: Group; label: string; sku: string; id: string; scoped: Record<string, unknown>; global: Record<string, unknown>; expect?: PriceWrite; stock?: number; addCategories: string[]; images: string[] }
export type OmPlan = OmCreatePlan | OmUpdatePlan;
export interface OmImportStats { rows: number; create: number; update: number; skipped: number; unchanged: number; nextOffset: number | null; unknownCategories: string[]; notes: string[] }

const SCOPED_TEXT: Partial<Record<keyof Rec, string>> = { name: 'name', description: 'description', metaTitle: 'meta_title', metaDescription: 'meta_description', keywords: 'meta_keyword' };
const LABEL: Record<string, string> = { name: 'Name', description: 'Beschreibung', meta_title: 'Meta-Title', meta_description: 'Meta-Description', meta_keyword: 'Meta-Keywords', weight: 'Gewicht', cost: 'Einkaufspreis', price: 'Preis', special_price: 'Sonderpreis' };
const short = (v: unknown, n = 40) => { const s = plain(v); return s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '–'; };
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const UPDATE_DEFAULT_OFF = new Set(['priceGross', 'priceNet', 'listPrice', 'purchasePrice', 'stock', 'taxRate']);

/** Preis der Datei in der Basis des Shops (brutto/netto); null = keine Angabe */
export function shopPrice(r: { gross?: number; net?: number; taxRate?: number }, basis: PriceBasis, defRate = 19, which: 'price' | 'list' = 'price', list?: number): number | null {
  const rate = (r.taxRate ?? defRate) / 100;
  if (which === 'list') return list == null ? null : basis === 'gross' ? list : r4(list / (1 + rate));
  if (basis === 'gross') return r.gross != null ? r.gross : r.net != null ? Math.round(r.net * (1 + rate) * 100) / 100 : null;
  return r.net != null ? r.net : r.gross != null ? r4(r.gross / (1 + rate)) : null;
}

/** Eigenschaften und Hersteller → Attributwerte (Auswahlwerte per Bezeichnung); unbekannte Werte als Warnung */
function attrValues(r: Rec, m: ImportMapping, cat: OmCatalog, warn: string[]): { scoped: Record<string, unknown>; global: Record<string, unknown> } {
  const scoped: Record<string, unknown> = {}, global: Record<string, unknown> = {};
  const set = (code: string, raw: string) => {
    const a = cat.attributes.find(x => x.code === code || low(x.label) === low(code));
    if (!a) { warn.push(`Attribut „${code}“ gibt es nicht`); return; }
    const where = a.scope === 'global' || a.scope === 'website' ? global : scoped;
    if (a.input === 'select' || a.input === 'multiselect') {
      const vals = raw.split(/\s*[,;|]\s*/).filter(Boolean), ids = vals.map(v => a.options.find(o => low(o.label) === low(v))?.value);
      const miss = vals.filter((_, i) => !ids[i]);
      if (miss.length) { warn.push(`${a.label}: Wert ${miss.map(x => `„${x}“`).join(', ')} gibt es nicht (Auswahlwerte in OpenMage anlegen)`); return; }
      where[a.code] = a.input === 'multiselect' ? ids : ids[0];
    } else if (a.input === 'boolean') where[a.code] = /^(1|ja|yes|true|x)$/i.test(raw) ? 1 : 0;
    else where[a.code] = raw;
  };
  if (r.manufacturer) set('manufacturer', r.manufacturer);
  if (r.ean && m.ean) { const a = cat.attributes.find(x => x.code === 'ean' || x.code === 'gtin'); if (a) scoped[a.code] = r.ean; else warn.push('EAN: kein Attribut „ean“/„gtin“ im Shop'); }
  if (r.manufacturerNumber) { if (cat.attributes.some(x => x.code === 'mpn')) scoped.mpn = r.manufacturerNumber; else warn.push('Hersteller-Nr.: kein Attribut „mpn“ im Shop'); }
  const byGroup = new Map<string, string[]>();
  for (const p of r.props) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p.value]);
  for (const [g, vals] of byGroup) set(g, vals.join(','));
  return { scoped, global };
}

export function planOmImport(recs: Rec[], m: ImportMapping, cat: OmCatalog, opts: ImportOptions, meta: { title: string; reason: string; fileName: string; nextOffset: number | null }): { cs: ChangeSet; payload: { plans: OmPlan[] }; stats: OmImportStats } {
  const skipped: ChangeSet['skipped'] = [], plans: OmPlan[] = [], rows: { plan: OmPlan; before: string; after: string; warn: string[] }[] = [], notes: string[] = [], unknown = new Set<string>();
  const mode = opts.mode ?? 'both', bySku = new Map(cat.products.map(p => [p.sku, p]));
  const updatable = (k: keyof ImportMapping) => !!m[k] && (opts.updateFields ? opts.updateFields.includes(k) : !UPDATE_DEFAULT_OFF.has(k));
  const skip = (r: Rec, reason: string) => skipped.push({ id: `z${r.line}`, reason: `Zeile ${r.line}${r.number ? ` (${r.number})` : ''}: ${reason}` });
  if (m.ean && !m.productNumber) throw new Error('OpenMage gleicht per SKU ab: Spalte für die Produktnummer (SKU) zuordnen');
  for (const k of ['width', 'height', 'length', 'deliveryTime'] as const) if (m[k]) notes.push(`${k === 'deliveryTime' ? 'Lieferzeit' : 'Maße'}: gibt es in OpenMage nicht als Standardfeld, Spalte wird nicht übernommen`);
  if ((m.variantOptions?.length || m.parentNumber) && recs.some(r => r.parent && r.parent !== r.number)) notes.push('Varianten-Zeilen werden übersprungen: Varianten in OpenMage im Admin anlegen');
  const seen = new Set<string>();
  let unchanged = 0;
  for (const r of recs) {
    if (r.parent && r.parent !== r.number) { skip(r, 'Variante (in OpenMage im Admin anlegen)'); continue; }
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
        if (!cat.attributeSetId) throw new Error('Kein Attributset für Produkte gefunden');
        if (r.number.includes('/')) throw new Error('SKU mit „/“ ist über die Schnittstelle nicht adressierbar');
        const sell = shopPrice(r, cat.basis, opts.defaultTaxRate);
        if (sell == null) throw new Error('Preis fehlt (für neue Produkte Pflicht)');
        const list = shopPrice(r, cat.basis, opts.defaultTaxRate, 'list', r.list), av = attrValues(r, m, cat, warn), extra: Record<string, unknown> = { ...av.scoped, ...av.global };
        let price = sell;
        if (list != null) { if (list > sell) { price = list; extra.special_price = sell; } else warn.push(`Streichpreis ${money(list)} nicht über dem Preis: ignoriert`); }
        if (r.purchase != null && cat.attributes.some(a => a.code === 'cost')) extra.cost = r.purchase;
        const tax = cat.taxClasses.find(o => o.value === 2) ?? cat.taxClasses[0];
        const active = opts.active === true, stock = r.stock ?? 0, ids = cats.ids.length ? cats.ids : opts.defaultCategoryId ? [opts.defaultCategoryId] : [];
        if (active) warn.push('Wird sofort aktiv im Shop');
        if (!r.images.length) warn.push('Ohne Bild');
        if (r.images.some(u => !/^https:\/\//.test(u))) warn.push('Bilder ohne https werden nicht geladen');
        const product: NewProductPlan = { name: r.name, description: r.description ?? '', price, sku: r.number, urlKey: urlKey(r.name), attributeSetId: cat.attributeSetId, websiteIds: cat.websiteIds, taxClassId: tax?.value ?? null, images: r.images.filter(u => /^https:\/\//.test(u)), categoryIds: ids, stock, active,
          ...(r.metaTitle ? { metaTitle: r.metaTitle } : {}), ...(r.metaDescription ? { metaDescription: r.metaDescription } : {}), ...(r.keywords ? { keywords: r.keywords } : {}), ...(r.weight != null ? { weight: r.weight } : {}), extra };
        const plan: OmCreatePlan = { kind: 'create', key: `n:${r.number}`, group: warn.length ? 'create-warn' : 'create', label: `${r.name} (${r.number})`, sku: r.number, product };
        plans.push(plan);
        rows.push({ plan, before: '–', after: `neu · ${money(sell)} ${basisWord(cat.basis)}${extra.special_price != null ? ` (statt ${money(price)})` : ''} · ${active ? 'aktiv' : 'inaktiv (Entwurf)'} · Bestand ${stock}${r.images.length ? ` · ${r.images.length} Bild(er)` : ''}`, warn });
        continue;
      }
      if (mode === 'create') { skip(r, 'schon im Shop (mode=create)'); continue; }
      const scoped: Record<string, unknown> = {}, global: Record<string, unknown> = {}, before: string[] = [], after: string[] = [];
      const change = (code: string, v: unknown, where: Record<string, unknown>) => { const old = omAttr(cur, code); if (v == null || v === '' || same(old, v)) return; where[code] = v; before.push(`${LABEL[code] ?? code}: ${short(old)}`); after.push(`${LABEL[code] ?? code}: ${short(v)}`); };
      for (const [k, code] of Object.entries(SCOPED_TEXT) as [keyof Rec, string][]) if (updatable(k as keyof ImportMapping)) change(code, r[k] as unknown, scoped);
      if (updatable('weight') && r.weight != null) change('weight', r.weight, global);
      const av = attrValues(r, m, cat, warn);
      for (const [where, vals] of [[scoped, av.scoped], [global, av.global]] as const) for (const [code, v] of Object.entries(vals)) { const mk = code === 'manufacturer' ? 'manufacturer' : code === 'ean' || code === 'gtin' ? 'ean' : code === 'mpn' ? 'manufacturerNumber' : 'properties'; if (updatable(mk as keyof ImportMapping)) change(code, v, where); }
      if (opts.updatePrices && r.purchase != null && cat.attributes.some(a => a.code === 'cost')) change('cost', r.purchase, global);
      let expect: PriceWrite | undefined;
      if (opts.updatePrices && (m.priceGross || m.priceNet || m.listPrice)) {
        if (FROM_KIDS.has(String(cur.type_id))) warn.push('Preis kommt aus den Einzelprodukten: nicht übernommen');
        else {
          const s = priceOf(cur), sell = shopPrice(r, cat.basis, opts.defaultTaxRate) ?? s.selling;
          let listPrice: number | null | undefined = r.list != null ? shopPrice(r, cat.basis, opts.defaultTaxRate, 'list', r.list) ?? undefined : undefined;
          if (sell != null && listPrice != null && !(listPrice > sell)) { warn.push(`Streichpreis ${money(listPrice)} nicht über dem Preis: ignoriert`); listPrice = null; }
          else if (sell != null && listPrice === undefined && s.list != null && !(s.list > sell)) listPrice = null;
          const w: PriceWrite = sell != null ? planPrice(s, { price: sell, listPrice }).write : {};
          if (Object.keys(w).length) {
            Object.assign(global, w); expect = priceUndo(mrec(cur), Object.keys(w) as (keyof PriceWrite)[]);
            const nv = (k: keyof PriceWrite, old: unknown) => (k in w ? w[k] : old);
            const next = priceState({ price: nv('price', s.regular), custom_attributes: [{ attribute_code: 'special_price', value: nv('special_price', s.special) }, { attribute_code: 'special_from_date', value: nv('special_from_date', s.from) }, { attribute_code: 'special_to_date', value: nv('special_to_date', s.to) }] });
            before.push(`Preis: ${money(s.selling)}${s.list != null ? ` statt ${money(s.list)}` : ''}`); after.push(`Preis: ${money(next.selling)}${next.list != null ? ` statt ${money(next.list)}` : ''}`);
            if (next.special != null && next.from != null && next.from > isoDay() && next.special < (next.regular ?? 0)) warn.push('Geplanter Sonderpreis bleibt bestehen');
            if (s.selling && sell && Math.abs(sell - s.selling) / s.selling >= 0.3) warn.push(`Preisänderung ${sell > s.selling ? '+' : '−'}${Math.round(Math.abs(sell - s.selling) / s.selling * 100)} %`);
          }
        }
      }
      let stock: number | undefined;
      if (opts.updateStock && r.stock != null && cur.qty != null && Number(cur.qty) !== r.stock) { stock = r.stock; before.push(`Bestand: ${cur.qty}`); after.push(`Bestand: ${r.stock}`); if (r.stock <= 0 && cur.is_in_stock) warn.push('Bestand 0, Status bleibt „auf Lager“ (weiter bestellbar)'); }
      const have = new Set((cur.category_ids ?? []).map(String));
      const addCategories = updatable('category') ? cats.ids.filter(id => !have.has(id)) : [];
      if (addCategories.length) after.push(`+${addCategories.length} Kategorie(n)`);
      const images = updatable('images') && !(cur.images ?? []).length ? r.images.filter(u => /^https:\/\//.test(u)) : [];
      if (images.length) after.push(`+${images.length} Bild(er)`);
      if (!Object.keys(scoped).length && !Object.keys(global).length && stock === undefined && !addCategories.length && !images.length) { unchanged++; continue; }
      const plan: OmUpdatePlan = { kind: 'update', key: `u:${cur.sku}`, group: warn.length ? 'update-warn' : 'update', label: `${cur.name ?? cur.sku} (${cur.sku})`, sku: cur.sku, id: String(cur.id), scoped, global, ...(expect ? { expect } : {}), ...(stock !== undefined ? { stock } : {}), addCategories, images };
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
    cs: { id: newIdSafe(), kind: OM_IMPORT_KIND, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title: meta.title, reason: meta.reason || `Import aus ${meta.fileName}`, items, sample, total: plans.length, skipped: skipped.slice(0, 200), unchanged, atomic: false, applyLabel: `${plans.length.toLocaleString('de-DE')} ${plans.length === 1 ? 'Produkt' : 'Produkte'} importieren` },
    payload: { plans },
    stats: { rows: recs.length, create: nCreate, update: nUpdate, skipped: skipped.length, unchanged, nextOffset: meta.nextOffset, unknownCategories: [...unknown], notes },
  };
}

// ================= Executor =================
async function applyUpdate(c: OmClient, store: string, pl: OmUpdatePlan): Promise<UndoOp[]> {
  const undo: UndoOp[] = [];
  try {
    if (pl.expect) await assertPriceUnchanged(c, pl.sku, store, pl.expect);
    if (Object.keys(pl.scoped).length || Object.keys(pl.global).length) undo.push(...await writeScoped(c, 'product', pl.sku, store, pl.scoped, pl.global));
    if (pl.stock !== undefined) undo.push(await writeStock(c, pl.sku, pl.stock));
    if (pl.addCategories.length) {
      const path = `/v1/products/${skuPath(pl.sku)}/categories`;
      await c.req('PUT', path, { add: pl.addCategories.map(id => ({ id: Number(id), position: 0 })) });
      undo.push(reqOp('category-product', pl.sku, 'PUT', path, { remove: pl.addCategories.map(Number) }));
    }
    if (pl.images.length) undo.push(...await applyImages(c, { sku: pl.sku, adds: pl.images.map((ref, i) => ({ ref, label: '', position: i + 1 })), entries: [], cover: 'new:0' }));
  } catch (e) { throw Object.assign(new Error(errMsg(e)), { undo: [...undo, ...((e as { undo?: UndoOp[] }).undo ?? [])] }); }
  return undo;
}

const reports = new Map<string, { created: string[]; updated: string[]; failed: { sku: string; error: string }[] }>();
export const takeOmReport = (csId: string) => { const r = reports.get(csId); reports.delete(csId); return r; };

reg.register(OM_IMPORT_KIND, async (c, cs, payload, selected, ctx?: ApplyCtx): Promise<ApplyResult> => {
  const plans = (payload as { plans: OmPlan[] }).plans.filter(p => selected.has(`grp:${p.group}`)), store = await c.workStore();
  const all: ApplyResult['results'] = [], undo: UndoOp[] = [], rep = { created: [] as string[], updated: [] as string[], failed: [] as { sku: string; error: string }[] };
  let done = 0; ctx?.progress?.(0, plans.length);
  for (let i = 0; i < plans.length; i += CHUNK) {
    const list = plans.slice(i, i + CHUNK);
    await pool(list, WRITE_CONCURRENCY, async pl => {
      try {
        if (pl.kind === 'create') { undo.push(...await createProduct(c, pl.product)); rep.created.push(pl.sku); }
        else { undo.push(...await applyUpdate(c, store, pl)); rep.updated.push(pl.sku); }
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
  const ro = () => { const r = session.reader as OmReader; if (!r || (r as { platform?: string }).platform !== 'openmage') throw new Error('Dieses Werkzeug gibt es nur für OpenMage.'); return r; };
  async function prepare(fileId: string, sheet: string | undefined, mapping: ImportMapping, opts: ImportOptions, title: string, reason: string) {
    const { t, name } = await loadTable(fileId, sheet);
    const problems = checkMapping(mapping, t.headers); if (problems.length) throw new Error(`Zuordnung prüfen: ${problems.join('; ')}`);
    const all = readRecords(t, mapping), { offset, end } = sectionRange(all, opts), recs = all.slice(offset, end);
    if (!recs.length) throw new Error(`Keine Zeilen ab Zeile ${offset + 1} (Datei hat ${all.length} Datenzeilen)`);
    const cat = await loadOmCatalog(ro(), recs, mapping);
    return planOmImport(recs, mapping, cat, opts, { title, reason, fileName: name, nextOffset: end < all.length ? end : null });
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
    tool('propose_import', `SCHLÄGT den Import einer Lieferantendatei nach OpenMage vor (Freigabe-Workflow; der Aufruf wartet auf die Entscheidung). Abgleich per SKU (Spalte productNumber):
- VORHANDENE Produkte: nur zugeordnete, geänderte Felder (Texte in der Store-View aus den Einstellungen bzw. global, Gewicht, Attribute). Preise und Einkaufspreis nur mit updatePrices, Bestand nur mit updateStock. Kategorien werden nur ergänzt, Bilder nur bei Produkten ohne Bild.
- NEUE Produkte: als Entwurf (deaktiviert, Bestand 0 ohne Spalte), Preis Pflicht und in der Preisbasis des Shops (brutto/netto aus der Steuerkonfiguration), Streichpreis/UVP über dem Preis wird regulärer Preis + Sonderpreis, Steuerklasse „Taxable Goods“, alle Websites, sichtbar in Katalog und Suche.
- Eigenschaften und Hersteller: nur vorhandene Attribute und Auswahlwerte (Bezeichnung wie im Shop); fehlende werden gemeldet, nicht angelegt. Kategorien werden NIE angelegt (unbekannte vorher mit preview_import finden, nachfragen, categoryMap). Varianten-Zeilen werden übersprungen.
Bis ${IMPORT_MAX} Zeilen je Set (offset/limit, nextOffset im Ergebnis); die Karte zeigt Gruppen + Stichprobe, geschrieben wird in Blöcken mit Fortschritt. Rückgängig löscht angelegte Produkte und stellt geänderte Felder und Bestände exakt wieder her.`,
      { fileId: z.string(), sheet: z.string().optional(), title: z.string(), reason: z.string(), mapping: mappingSchema, options: optionsSchema.optional() },
      guard(async ({ fileId, sheet, title, reason, mapping, options }) => {
        const { cs, payload, stats } = await prepare(fileId, sheet, mapping, options ?? {}, title, reason);
        const out = await session.requestChange(cs, payload);
        const rep = takeOmReport(cs.id);
        return ok({ status: out.status, message: out.message, error: out.error, applied: out.applied, failedTotal: out.failedTotal ?? out.failed?.length ?? 0, stats, skipped: cs.skipped.slice(0, 30).map(s => s.reason),
          ...(rep ? { created: rep.created.slice(0, 300), updated: rep.updated.slice(0, 100), failed: rep.failed.slice(0, 100) } : {}), nextOffset: stats.nextOffset });
      })),
  ] as AnyTool[];
}

export const openmageImport: Feature = { key: 'import-openmage', platforms: ['openmage'], toolNames: ['read_supplier_file', 'save_import_mapping', 'preview_import', 'propose_import'], tools };
