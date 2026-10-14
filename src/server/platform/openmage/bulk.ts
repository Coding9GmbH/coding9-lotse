import 'server-only';
// OpenMage bulk edit: ONE rule applied to all products of a filter (even thousands). Reading page by page via the guarded
// read client, card with groups + sample, writing in chunks with progress; undo exact per product.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { errMsg, newIdSafe, pool, resolvePrice, WRITE_CONCURRENCY, type ApplyCtx, type ApplyResult, type PriceSpec } from './kit';
import type { OmClient } from './client';
import { FROM_KIDS, isActive, money, mrec, planPrice, priceOf, priceText, priceUndo, productLabel, type OmProduct, type PriceBasis, type PriceWrite } from './map';
import type { OmReader, ProductQuery } from './reader';
import { assertPriceUnchanged } from './catalog';
import { reg, writeScoped } from './write';

export const BULK_KIND = 'bulk-products';
export const BULK_MAX = 5_000;
export const BULK_SCAN = 10_000;
const PAGE = 200, CHUNK = 50, SAMPLE = 50;

export interface BulkFilter { categoryId?: string; term?: string; minPrice?: number; maxPrice?: number; active?: boolean; typeId?: string; skus?: string[] }
export interface BulkChange { price?: PriceSpec; listPrice?: PriceSpec | 'currentPrice'; active?: boolean; specialFromDate?: string | null; specialToDate?: string | null }
interface Plan { id: string; sku: string; group: 'ok' | 'warn'; price?: { write: PriceWrite; expect: PriceWrite }; status?: number }

/** All products of the filter (paged); search term over name OR SKU (?term=, two queries with older modules), price range on the selling price */
export async function resolveBulk(ro: OmReader, f: BulkFilter): Promise<{ rows: OmProduct[]; scanned: number; total: number }> {
  const base: ProductQuery = { ...(f.categoryId ? { category_id: f.categoryId } : {}), ...(f.active != null ? { status: f.active ? 1 : 2 } : {}), ...(f.typeId ? { type: f.typeId } : {}), ...(f.skus?.length ? { skus: f.skus.slice(0, 200).join(',') } : {}), sort: 'entity_id', dir: 'asc', limit: PAGE };
  const queries: ProductQuery[] = !f.term ? [base] : await ro.hasTermFilter() ? [{ ...base, term: f.term }] : [{ ...base, name: f.term }, { ...base, sku: f.term }];
  const byId = new Map<number, OmProduct>();
  let total = 0, scanned = 0;
  for (const q of queries) {
    for (let page = 1; ; page++) {
      const r = await ro.products({ ...q, page });
      if (page === 1) total += r.meta.total;
      scanned += r.items.length; r.items.forEach(p => byId.set(p.id, p));
      if (!r.items.length || page >= r.meta.pages || scanned >= BULK_SCAN) break;
    }
  }
  const rows = [...byId.values()].filter(p => { const s = priceOf(p).selling; return (f.minPrice == null || (s != null && s >= f.minPrice)) && (f.maxPrice == null || (s != null && s <= f.maxPrice)); });
  return { rows, scanned, total: queries.length > 1 ? byId.size : total };
}

export function describeBulk(c: BulkChange) {
  const rule = (r: PriceSpec | 'currentPrice' | undefined) => r === 'currentPrice' ? '= bisheriger Preis' : r === null ? 'entfernen' : typeof r === 'number' ? `= ${money(r)}` : r?.set != null ? `= ${money(r.set)}` : r?.percent != null ? `${r.percent > 0 ? '+' : ''}${r.percent} %` : r?.add != null ? `${r.add > 0 ? '+' : ''}${money(r.add)}` : '?';
  return [c.price !== undefined ? `Preis ${rule(c.price)}${typeof c.price === 'object' && c.price?.round ? `, gerundet auf ${c.price.round}` : ''}` : '', c.listPrice !== undefined ? `Streichpreis ${rule(c.listPrice)}` : '', c.specialToDate !== undefined ? `Sonderpreis bis ${c.specialToDate ?? 'offen'}` : '', c.active !== undefined ? (c.active ? 'aktivieren' : 'deaktivieren') : ''].filter(Boolean).join(' · ');
}

export function bulkChangeSet(title: string, reason: string, c: BulkChange, rows: OmProduct[], basis: PriceBasis, store: string, hints: string[] = []): { cs: ChangeSet; payload: { plans: Plan[]; store: string } } {
  if (![c.price, c.listPrice, c.active, c.specialFromDate, c.specialToDate].some(v => v !== undefined)) throw new Error('change ist leer');
  const todo: { p: OmProduct; plan: Plan; before: string; after: string; warn: string[] }[] = [], skipped: { id: string; reason: string }[] = [];
  let unchanged = 0;
  for (const p of rows) {
    const plan: Plan = { id: String(p.id), sku: p.sku, group: 'ok' }, warn: string[] = [], before: string[] = [], after: string[] = [];
    try {
      if (c.price !== undefined || c.listPrice !== undefined || c.specialFromDate !== undefined || c.specialToDate !== undefined) {
        if (FROM_KIDS.has(String(p.type_id))) throw new Error(`${p.type_id}: Preis kommt aus den Einzelprodukten`);
        const s = priceOf(p), want: { price?: number; listPrice?: number | null; from?: string | null; to?: string | null } = {};
        if (c.price !== undefined) { const v = resolvePrice(s.selling, c.price); if (v == null) throw new Error('Preis kann nicht entfernt werden'); want.price = v; }
        if (c.listPrice !== undefined) want.listPrice = c.listPrice === 'currentPrice' ? s.selling : resolvePrice(s.list, c.listPrice);
        if (c.specialFromDate !== undefined) want.from = c.specialFromDate;
        if (c.specialToDate !== undefined) want.to = c.specialToDate;
        const { write } = planPrice(s, want);
        if (Object.keys(write).length) {
          plan.price = { write, expect: priceUndo(mrec(p), Object.keys(write) as (keyof PriceWrite)[]) };
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
  if (c.listPrice !== undefined) items.push({ id: 'hint:preis', entity: 'info', label: 'Hinweis OpenMage-Preise', fieldLabel: '', before: '', after: 'Streichpreis in OpenMage = regulärer Preis (price), Verkaufspreis = Sonderpreis (special_price).', warn: [] });
  const sample: ChangeItem[] = [...todo.slice(0, SAMPLE), ...todo.slice(SAMPLE).filter(x => x.warn.length).slice(0, 10)].map(({ p, plan, before, after, warn }) => ({ id: plan.id, entity: 'info', entityId: plan.id, label: productLabel(p), fieldLabel: rule, before, after, warn }));
  return { cs: { id: newIdSafe(), kind: BULK_KIND, entity: 'product', noun: { one: 'Produkt', many: 'Produkte' }, title, reason, items, sample, total: todo.length, skipped: skipped.slice(0, 100), unchanged, atomic: false, applyLabel: `${todo.length.toLocaleString('de-DE')} ${todo.length === 1 ? 'Produkt' : 'Produkte'} ändern` }, payload: { plans: todo.map(x => x.plan), store } };
}

async function applyPlan(c: OmClient, store: string, pl: Plan): Promise<UndoOp[]> {
  let global: Record<string, unknown> = {};
  if (pl.price) { await assertPriceUnchanged(c, pl.sku, store, pl.price.expect); global = { ...pl.price.write }; }
  return writeScoped(c, 'product', pl.sku, store, pl.status !== undefined ? { status: pl.status } : {}, global);
}

reg.register(BULK_KIND, async (c, cs, payload, selected, ctx?: ApplyCtx): Promise<ApplyResult> => {
  const { plans: all0, store } = payload as { plans: Plan[]; store: string }, plans = all0.filter(p => selected.has(`grp:${p.group}`));
  const all: ApplyResult['results'] = [], undo: UndoOp[] = [];
  let done = 0; ctx?.progress?.(0, plans.length);
  for (let i = 0; i < plans.length; i += CHUNK) {
    const chunk = plans.slice(i, i + CHUNK);
    await pool(chunk, WRITE_CONCURRENCY, async pl => {
      try { undo.push(...await applyPlan(c, store, pl)); all.push({ itemId: pl.id, ok: true }); }
      catch (e) { all.push({ itemId: pl.id, ok: false, error: errMsg(e) }); }
    });
    done += chunk.length; ctx?.progress?.(done, plans.length, { results: all, undo });
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
