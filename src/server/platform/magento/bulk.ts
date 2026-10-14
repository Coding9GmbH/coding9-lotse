import 'server-only';
// Magento bulk edit: ONE rule applied to all products of a filter (even thousands). Reading page by page via the guarded
// read client, card with groups + sample, writing in chunks with progress; undo exact per product.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { errMsg, newIdSafe, pool, resolvePrice, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult, type PriceSpec } from './kit';
import type { MagentoClient } from './client';
import { likeTerm, type Filter } from './criteria';
import { isActive, money, needBasis, planPrice, priceState, priceText, priceUndo, type MProduct, type PriceBasis, type PriceWrite } from './map';
import type { MagentoReader } from './reader';
import { assertPriceInView, assertPriceUnchanged, productLabel } from './catalog';
import { reg, writeScoped } from './write';

export const BULK_KIND = 'bulk-products';
export const BULK_MAX = 5_000;
export const BULK_SCAN = 10_000;
const PAGE = 200, CHUNK = 50, SAMPLE = 50;
/** Only the fields plan and preview need (no gallery, no extension_attributes) */
const BULK_FIELDS = 'items[id,sku,name,type_id,status,visibility,price,custom_attributes],total_count';
/** Card note when the filter matches more products than are read (BULK_SCAN) */
export const scanHint = (scanned: number, total: number) => scanned < total ? [`Nur die ersten ${scanned.toLocaleString('de-DE')} von ${total.toLocaleString('de-DE')} Produkten geprüft. Filter enger fassen.`] : [];

export interface BulkFilter { categoryId?: string; term?: string; minPrice?: number; maxPrice?: number; active?: boolean; typeId?: string; skus?: string[] }
export interface BulkChange { price?: PriceSpec; listPrice?: PriceSpec | 'currentPrice'; active?: boolean; specialFromDate?: string | null; specialToDate?: string | null }
interface Plan { id: string; sku: string; group: 'ok' | 'warn'; price?: { write: PriceWrite; expect: PriceWrite }; status?: number }

const filtersOf = (f: BulkFilter): Filter[][] => {
  const out: Filter[][] = [];
  if (f.categoryId) out.push([{ field: 'category_id', value: f.categoryId }]);
  if (f.term) out.push([{ field: 'name', value: likeTerm(f.term), condition_type: 'like' }, { field: 'sku', value: likeTerm(f.term), condition_type: 'like' }]);
  if (f.active != null) out.push([{ field: 'status', value: f.active ? 1 : 2 }]);
  if (f.typeId) out.push([{ field: 'type_id', value: f.typeId }]);
  if (f.skus?.length) out.push([{ field: 'sku', value: f.skus, condition_type: 'in' }]);
  return out;
};
/** All products of the filter (paged); price range on the selling price (special price taken into account) */
export async function resolveBulk(ro: MagentoReader, f: BulkFilter): Promise<{ rows: MProduct[]; scanned: number; total: number }> {
  const filters = filtersOf(f), rows: MProduct[] = [];
  let page = 1, total = 0, scanned = 0;
  for (;;) {
    const r = await ro.products({ filters, pageSize: PAGE, currentPage: page, sort: [{ field: 'entity_id', direction: 'ASC' }], fields: BULK_FIELDS });
    total = r.total_count; scanned += r.items.length; rows.push(...r.items);
    if (!r.items.length || scanned >= total || scanned >= BULK_SCAN) break;
    page++;
  }
  const inRange = rows.filter(p => { const s = priceState(p).selling; return (f.minPrice == null || (s != null && s >= f.minPrice)) && (f.maxPrice == null || (s != null && s <= f.maxPrice)); });
  return { rows: inRange, scanned, total };
}

export function describeBulk(c: BulkChange) {
  const rule = (r: PriceSpec | 'currentPrice' | undefined) => r === 'currentPrice' ? '= bisheriger Preis' : r === null ? 'entfernen' : typeof r === 'number' ? `= ${money(r)}` : r?.set != null ? `= ${money(r.set)}` : r?.percent != null ? `${r.percent > 0 ? '+' : ''}${r.percent} %` : r?.add != null ? `${r.add > 0 ? '+' : ''}${money(r.add)}` : '?';
  return [c.price !== undefined ? `Preis ${rule(c.price)}${typeof c.price === 'object' && c.price?.round ? `, gerundet auf ${c.price.round}` : ''}` : '', c.listPrice !== undefined ? `Streichpreis ${rule(c.listPrice)}` : '', c.specialToDate !== undefined ? `Sonderpreis bis ${c.specialToDate ?? 'offen'}` : '', c.active !== undefined ? (c.active ? 'aktivieren' : 'deaktivieren') : ''].filter(Boolean).join(' · ');
}

export function bulkChangeSet(title: string, reason: string, c: BulkChange, rows: MProduct[], basis: PriceBasis | null, hints: string[] = []): { cs: ChangeSet; payload: { plans: Plan[] } } {
  if (![c.price, c.listPrice, c.active, c.specialFromDate, c.specialToDate].some(v => v !== undefined)) throw new Error('change ist leer');
  if ([c.price, c.listPrice, c.specialFromDate, c.specialToDate].some(v => v !== undefined)) needBasis(basis);
  const todo: { p: MProduct; plan: Plan; before: string; after: string; warn: string[] }[] = [], skipped: { id: string; reason: string }[] = [];
  let unchanged = 0;
  for (const p of rows) {
    const plan: Plan = { id: String(p.id), sku: p.sku, group: 'ok' }, warn: string[] = [], before: string[] = [], after: string[] = [];
    try {
      const priceTouched = c.price !== undefined || c.listPrice !== undefined || c.specialFromDate !== undefined || c.specialToDate !== undefined;
      if (priceTouched) {
        if (['configurable', 'bundle', 'grouped'].includes(String(p.type_id))) throw new Error(`${p.type_id}: Preis kommt aus den Einzelprodukten`);
        const s = priceState(p);
        const want: { price?: number; listPrice?: number | null; from?: string | null; to?: string | null } = {};
        if (c.price !== undefined) { const v = resolvePrice(s.selling, c.price); if (v == null) throw new Error('Preis kann nicht entfernt werden'); want.price = v; }
        if (c.listPrice !== undefined) want.listPrice = c.listPrice === 'currentPrice' ? s.selling : resolvePrice(s.list, c.listPrice);
        if (c.specialFromDate !== undefined) want.from = c.specialFromDate;
        if (c.specialToDate !== undefined) want.to = c.specialToDate;
        const { write } = planPrice(s, want);
        if (Object.keys(write).length) {
          plan.price = { write, expect: priceUndo(p, Object.keys(write) as (keyof PriceWrite)[]) };
          const next = { selling: want.price ?? s.selling, list: want.listPrice === undefined ? s.list : want.listPrice };
          before.push(priceText(s, basis)); after.push(priceText(next, basis));
          if (next.selling != null && next.selling < 0.01) warn.push('Preis unter 0,01 €');
          if (s.selling && next.selling != null && Math.abs((next.selling - s.selling) / s.selling) >= 0.3) warn.push(`Preisänderung ${next.selling > s.selling ? '+' : '−'}${Math.abs(((next.selling - s.selling) / s.selling) * 100).toFixed(0)} %`);
        }
      }
      if (c.active !== undefined && isActive(p) !== c.active) { plan.status = c.active ? 1 : 2; before.push(isActive(p) ? 'aktiv' : 'inaktiv'); after.push(c.active ? 'aktiv' : 'inaktiv'); }
    } catch (e) { skipped.push({ id: String(p.id), reason: `${productLabel(p)}: ${errMsg(e)}` }); continue; }
    if (!plan.price && plan.status === undefined) { unchanged++; continue; }
    plan.group = warn.length ? 'warn' : 'ok';
    todo.push({ p, plan, before: before.join(' · '), after: after.join(' · '), warn });
  }
  if (todo.length > BULK_MAX) throw new Error(`${todo.length.toLocaleString('de-DE')} Produkte, maximal ${BULK_MAX.toLocaleString('de-DE')} pro Änderungsset. Bitte enger filtern oder aufteilen.`);
  if (!todo.length) throw new Error(`Keine Änderung nötig bzw. nichts anwendbar (${rows.length} passende Produkte, ${unchanged} unverändert, ${skipped.length} übersprungen${skipped[0] ? `: ${skipped.slice(0, 3).map(s => s.reason).join('; ')}` : ''})`);
  const rule = describeBulk(c), items: ChangeItem[] = [];
  for (const g of ['ok', 'warn'] as const) {
    const xs = todo.filter(x => x.plan.group === g); if (!xs.length) continue;
    const warn = g === 'warn' ? Object.entries(xs.flatMap(x => x.warn.map(w => w.replace(/[+−]\d+ %$/, '').trim())).reduce<Record<string, number>>((m, w) => ({ ...m, [w]: (m[w] ?? 0) + 1 }), {})).map(([w, n]) => `${n}× ${w}`) : [];
    items.push({ id: `grp:${g}`, entity: 'product', label: `${xs.length.toLocaleString('de-DE')} ${xs.length === 1 ? 'Produkt' : 'Produkte'} ${g === 'ok' ? 'ohne Auffälligkeiten' : 'mit Warnungen'}`, field: 'bulk', fieldLabel: rule, before: '', after: '', afterRaw: { count: xs.length }, warn });
  }
  for (const h of hints) items.push({ id: `hint:${items.length}`, entity: 'info', label: 'Hinweis', fieldLabel: '', before: '', after: h, warn: [] });
  if (c.listPrice !== undefined) items.push({ id: 'hint:preis', entity: 'info', label: 'Hinweis Magento-Preise', fieldLabel: '', before: '', after: 'Streichpreis in Magento = regulärer Preis (price), Verkaufspreis = Sonderpreis (special_price).', warn: [] });
  const sample: ChangeItem[] = [...todo.slice(0, SAMPLE), ...todo.slice(SAMPLE).filter(x => x.warn.length).slice(0, 10)].map(({ p, plan, before, after, warn }) => ({ id: plan.id, entity: 'info', entityId: plan.id, label: productLabel(p), fieldLabel: rule, before, after, warn }));
  return { cs: { id: newIdSafe(), kind: BULK_KIND, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title, reason, items, sample, total: todo.length, skipped: skipped.slice(0, 100), unchanged, atomic: false, applyLabel: `${todo.length.toLocaleString('de-DE')} ${todo.length === 1 ? 'Produkt' : 'Produkte'} ändern` }, payload: { plans: todo.map(x => x.plan) } };
}

async function applyPlan(c: MagentoClient, store: string, pl: Plan): Promise<UndoOp[]> {
  if (pl.price) await assertPriceUnchanged(c, pl.sku, store, pl.price.expect);
  const undo = await writeScoped(c, 'product', pl.sku, store, pl.status !== undefined ? { status: pl.status } : {}, pl.price ? { ...pl.price.write } : {});
  if (pl.price) await assertPriceInView(c, pl.sku, store, pl.price.write, undo);
  return undo;
}

reg.register(BULK_KIND, async (c, cs, payload, selected, ctx?: ApplyCtx): Promise<ApplyResult> => {
  const { plans: planned, store } = payload as { plans: Plan[]; store?: string }, plans = planned.filter(p => selected.has(`grp:${p.group}`));
  const all: ApplyResult['results'] = [], undo: UndoOp[] = [];
  let done = 0; ctx?.progress?.(0, plans.length);
  const chunks = Array.from({ length: Math.ceil(plans.length / CHUNK) }, (_, i) => plans.slice(i * CHUNK, (i + 1) * CHUNK));
  for (const list of chunks) {
    await pool(list, WRITE_CONCURRENCY, async pl => {
      try { undo.push(...await applyPlan(c, store ?? c.storeCode, pl)); all.push({ itemId: pl.id, ok: true }); } // store view of the proposal (older cards: setting)
      catch (e) { undo.push(...((e as { undo?: UndoOp[] }).undo ?? [])); all.push({ itemId: pl.id, ok: false, error: errMsg(e) }); }
    });
    done += list.length; ctx?.progress?.(done, plans.length, { results: all, undo });
  }
  const bad = new Map(all.filter(r => !r.ok).map(r => [r.itemId, r])), sample = new Set((cs.sample ?? []).map(i => i.id)), results: ApplyResult['results'] = [];
  for (const g of ['ok', 'warn'] as const) {
    const ids = plans.filter(p => p.group === g).map(p => p.id); if (!ids.length) continue;
    const f = ids.filter(id => bad.has(id)).length;
    results.push({ itemId: `grp:${g}`, ok: !f, ...(f ? { error: `${f} von ${ids.length} fehlgeschlagen` } : {}) });
  }
  results.push(...all.filter(r => sample.has(r.itemId)), ...[...bad.values()].filter(r => !sample.has(r.itemId)).slice(0, 100));
  return { results, undo, counts: { applied: all.length - bad.size, failed: bad.size } };
});
