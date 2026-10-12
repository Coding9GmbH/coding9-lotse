import 'server-only';
// OpenMage: Varianten = konfigurierbare Produkte mit Einzelprodukten je Ausprägung. Lesen: Achsen und Kinder (aus dem Produktdetail).
// Ändern: Preis, Bestand, Status der vorhandenen Einzelprodukte (das Modul verknüpft keine neuen Kinder an bestehende Configurables).
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { errMsg, newIdSafe, partialTicker, pool, resolvePrice, WRITE_CONCURRENCY, type ApplyResult, type PriceSpec } from './kit';
import type { OmClient } from './client';
import { basisWord, money, mrec, planPrice, priceOf, priceText, priceUndo, productLabel, type OmProduct, type PriceWrite } from './map';
import type { OmReader } from './reader';
import { assertPriceUnchanged, writeStock } from './catalog';
import { reg, writeScoped } from './write';

export async function readVariants(ro: OmReader, ref: string) {
  const p = await ro.productByRef(ref);
  if (!p) throw new Error('Produkt nicht gefunden');
  if (p.type_id !== 'configurable' || !p.configurable) return { id: String(p.id), sku: p.sku, name: p.name, type: p.type_id, note: 'Kein konfigurierbares Produkt (keine Varianten). Bei einem Einzelprodukt einer Variante die ID des Hauptprodukts verwenden (parent_ids in get_product).' };
  const axes = p.configurable.attributes, basis = await ro.priceBasis();
  const kids = await ro.productsBySkus(p.configurable.children.map(k => k.sku));
  const label = (code: string, v: unknown) => axes.find(a => a.code === code)?.options.find(o => String(o.value) === String(v))?.label ?? String(v ?? '–');
  return {
    id: String(p.id), sku: p.sku, name: p.name, status: Number(p.status) === 1 ? 'aktiv' : 'inaktiv', priceBasis: basisWord(basis),
    axes: axes.map(a => ({ code: a.code, label: a.label, values: [...new Set(p.configurable!.children.map(k => label(a.code, k.attributes?.[a.code])))], available: a.options.map(o => o.label).filter(l => !p.configurable!.children.some(k => label(a.code, k.attributes?.[a.code]) === l)) })),
    variants: p.configurable.children.map(k => { const full = kids.find(x => x.sku === k.sku), s = full ? priceOf(full) : null; return { id: String(k.id), sku: k.sku, name: full?.name ?? k.name, options: Object.fromEntries(axes.map(a => [a.label || a.code, label(a.code, k.attributes?.[a.code])])), price: s ? money(s.selling) : money(k.price), listPrice: s?.list ?? null, active: Number(k.status) === 1, stock: Number(k.qty ?? full?.qty ?? 0), inStock: !!k.is_in_stock }; }),
    hint: 'Neue Varianten legt der Nutzer im OpenMage-Admin an; vorhandene Einzelprodukte änderst du mit propose_variants (Preis, Bestand, Status) oder propose_product_changes.',
  };
}

export interface VariantArgs { title: string; reason: string; productId: string; changes: { sku?: string; id?: string; options?: Record<string, string>; price?: PriceSpec; listPrice?: PriceSpec; stock?: number; active?: boolean }[] }
interface VariantPlan { sku: string; price?: { write: PriceWrite; expect: PriceWrite }; stock?: number; status?: number }

export async function buildVariantsChangeSet(ro: OmReader, a: VariantArgs): Promise<{ cs: ChangeSet; payload: { plans: Record<string, VariantPlan>; store: string } }> {
  const p = await ro.productByRef(a.productId);
  if (!p) throw new Error('Produkt nicht gefunden');
  if (p.type_id !== 'configurable' || !p.configurable) throw new Error('Nur für konfigurierbare Produkte (Hauptprodukt mit Varianten)');
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > 100) throw new Error('Maximal 100 Varianten pro Änderungsset');
  const axes = p.configurable.attributes, basis = await ro.priceBasis();
  const kids = await ro.productsBySkus(p.configurable.children.map(k => k.sku));
  const label = (code: string, v: unknown) => axes.find(x => x.code === code)?.options.find(o => String(o.value) === String(v))?.label ?? String(v ?? '');
  const find = (ch: VariantArgs['changes'][number]): OmProduct | undefined => {
    if (ch.sku) return kids.find(k => k.sku === ch.sku);
    if (ch.id) return kids.find(k => String(k.id) === String(ch.id));
    if (ch.options) { const want = Object.entries(ch.options); const child = p.configurable!.children.find(k => want.every(([code, v]) => { const ax = axes.find(x => x.code.toLowerCase() === code.toLowerCase() || x.label.toLowerCase() === code.toLowerCase()); return ax && label(ax.code, k.attributes?.[ax.code]).toLowerCase() === String(v).trim().toLowerCase(); })); return child ? kids.find(k => k.sku === child.sku) : undefined; }
    return undefined;
  };
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], plans: Record<string, VariantPlan> = {};
  for (const [i, ch] of a.changes.entries()) {
    const key = ch.sku ?? ch.id ?? `var-${i + 1}`;
    try {
      const k = find(ch);
      if (!k) throw new Error('Variante nicht gefunden (sku, id oder options wie in get_variants angeben)');
      const id = String(k.id), lab = `${productLabel(k)} · ${axes.map(ax => label(ax.code, p.configurable!.children.find(c => c.sku === k.sku)?.attributes?.[ax.code])).join(' / ')}`;
      const plan: VariantPlan = { sku: k.sku }, before: string[] = [], after: string[] = [], warn: string[] = [];
      if (ch.price !== undefined || ch.listPrice !== undefined) {
        const s = priceOf(k), want: { price?: number; listPrice?: number | null } = {};
        if (ch.price !== undefined) { const v = resolvePrice(s.selling, ch.price); if (v == null || !(v >= 0)) throw new Error('Preis ungültig'); want.price = v; }
        if (ch.listPrice !== undefined) want.listPrice = resolvePrice(s.list, ch.listPrice);
        const { write, notes } = planPrice(s, want);
        if (Object.keys(write).length) { plan.price = { write, expect: priceUndo(mrec(k), Object.keys(write) as (keyof PriceWrite)[]) }; before.push(priceText(s, basis)); after.push(priceText({ selling: want.price ?? s.selling, list: want.listPrice === undefined ? s.list : want.listPrice }, basis)); warn.push(...notes); }
      }
      if (ch.stock !== undefined) { if (!Number.isInteger(ch.stock) || ch.stock < 0) throw new Error('Bestand: ganze Zahl ≥ 0'); const cur = Number(k.qty ?? 0); if (cur !== ch.stock) { plan.stock = ch.stock; before.push(`Bestand ${cur}`); after.push(`Bestand ${ch.stock}`); if (ch.stock === 0) warn.push('Bestand auf 0'); } }
      if (ch.active !== undefined) { const cur = Number(k.status) === 1; if (cur !== ch.active) { plan.status = ch.active ? 1 : 2; before.push(cur ? 'aktiv' : 'inaktiv'); after.push(ch.active ? 'aktiv' : 'inaktiv'); if (!ch.active) warn.push('Wird deaktiviert'); } }
      if (!before.length) { skipped.push({ id: key, reason: 'keine Änderung' }); continue; }
      plans[id] = plan;
      items.push({ id, entity: 'product', entityId: id, label: lab, field: 'variant', fieldLabel: 'Variante', before: before.join(' · '), after: after.join(' · '), afterRaw: id, warn });
    } catch (e) { skipped.push({ id: key, reason: errMsg(e) }); }
  }
  if (!items.length) throw new Error(`Nichts anwendbar: ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}`);
  return { cs: { id: newIdSafe(), kind: 'variants', entity: 'product', noun: { one: 'Variante', many: 'Varianten' }, title: a.title, reason: a.reason, items: [...items, { id: 'info:parent', entity: 'info', label: productLabel(p), fieldLabel: '', before: '', after: `Hauptprodukt (Achsen: ${axes.map(ax => ax.label || ax.code).join(', ')})`, warn: [] }], skipped, atomic: false }, payload: { plans, store: await ro.store() } };
}

async function applyVariant(c: OmClient, store: string, pl: VariantPlan): Promise<UndoOp[]> {
  const undo: UndoOp[] = [];
  let global: Record<string, unknown> = {};
  if (pl.price) { await assertPriceUnchanged(c, pl.sku, store, pl.price.expect, 'Variante'); global = { ...pl.price.write }; }
  if (Object.keys(global).length || pl.status !== undefined) undo.push(...await writeScoped(c, 'product', pl.sku, store, pl.status !== undefined ? { status: pl.status } : {}, global));
  if (pl.stock !== undefined) undo.push(await writeStock(c, pl.sku, pl.stock));
  return undo;
}
reg.register('variants', async (c, cs, payload, selected, ctx) => {
  const { plans, store } = payload as { plans: Record<string, VariantPlan>; store: string }, results: ApplyResult['results'] = [], undo: UndoOp[] = [];
  const list = cs.items.filter(i => selected.has(i.id) && i.entity !== 'info'), tick = partialTicker(ctx, list.length, { results, undo });
  await pool(list, WRITE_CONCURRENCY, async it => {
    try { undo.push(...await applyVariant(c, store, plans[it.entityId!])); results.push({ itemId: it.id, ok: true }); }
    catch (e) { results.push({ itemId: it.id, ok: false, error: errMsg(e) }); }
    finally { tick(); }
  });
  return { results, undo };
});
