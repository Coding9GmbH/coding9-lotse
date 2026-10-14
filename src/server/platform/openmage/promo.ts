import 'server-only';
// OpenMage: promotions = shopping cart price rules (salesrules) with a fixed coupon code. Reads only rules and counts (never customers or orders).
// The module sets customer groups and websites itself on creation (all); the AI reads no customer groups.
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { applyEach, errMsg, MAX_ITEMS, newIdSafe, trackedUndo } from './kit';
import type { OmClient } from './client';
import { deDay, isoDay, money, type OmRecord } from './map';
import type { OmReader } from './reader';
import { reg, reqOp } from './write';

const ACTION: Record<string, string> = { percentage: 'by_percent', absolute: 'by_fixed', cart_fixed: 'cart_fixed', buy_x_get_y: 'buy_x_get_y' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMBINE = 'salesrule/rule_condition_combine', FOUND = 'salesrule/rule_condition_product_found', PRODUCT = 'salesrule/rule_condition_product', ADDRESS = 'salesrule/rule_condition_address', PRODUCT_COMBINE = 'salesrule/rule_condition_product_combine';
/** The API's coupon_type: 1 no coupon, 2 fixed code, 3 automatic */
const NO_COUPON = 1, FIXED = 2;

export type PromoStatus = 'läuft' | 'geplant' | 'abgelaufen' | 'inaktiv';
export function promoStatus(r: OmRecord, today = isoDay()): PromoStatus {
  if (!r.is_active) return 'inaktiv';
  if (r.to_date && String(r.to_date).slice(0, 10) < today) return 'abgelaufen';
  if (r.from_date && String(r.from_date).slice(0, 10) > today) return 'geplant';
  return 'läuft';
}
const list = (v: unknown) => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);
/** Restriction from a condition tree (only categories/SKUs readable; anything else as a count) */
export function restriction(tree: OmRecord | null | undefined): { categoryIds: string[]; skus: string[]; other: number } {
  const out = { categoryIds: [] as string[], skus: [] as string[], other: 0 };
  const walk = (c: OmRecord | null | undefined) => { for (const x of (c?.conditions ?? []) as OmRecord[]) {
    if (Array.isArray(x.conditions) && x.conditions.length) walk(x);
    else if (x.attribute === 'category_ids' && ['()', '=='].includes(String(x.operator))) out.categoryIds.push(...list(x.value));
    else if (x.attribute === 'sku' && ['()', '=='].includes(String(x.operator))) out.skus.push(...list(x.value));
    else out.other++;
  } };
  walk(tree); return out;
}
const isMin = (c: OmRecord) => c.attribute === 'base_subtotal' && c.operator === '>=';
export const minSubtotal = (r: OmRecord): number | null => { const x = ((r.conditions?.conditions ?? []) as OmRecord[]).find(isMin); return x ? Number(x.value) : null; };
/** Further cart conditions besides minimum order value and item filter, only as a count */
const otherCartConds = (r: OmRecord) => ((r.conditions?.conditions ?? []) as OmRecord[]).filter(c => !isMin(c) && c.type !== FOUND).length;
async function targetText(ro: OmReader, r: OmRecord, cats = new Map<string, string>()) {
  const res = restriction(r.actions);
  const found = ((r.conditions?.conditions ?? []) as OmRecord[]).find(c => c.type === FOUND);
  const cart = found ? restriction(found) : { categoryIds: [], skus: [], other: 0 };
  const ids = [...new Set([...res.categoryIds, ...cart.categoryIds])];
  for (const id of ids.slice(0, 20)) if (!cats.has(id)) cats.set(id, String((await ro.category(id).catch(() => null))?.name ?? id));
  const txt = (x: typeof res) => [x.categoryIds.length ? `Kategorien ${x.categoryIds.map(i => cats.get(i) ?? i).join(', ')}` : '', x.skus.length ? `Artikel ${x.skus.join(', ')}` : '', x.other ? `${x.other} weitere Bedingung(en)` : ''].filter(Boolean).join(' + ');
  return { res, cart, cats, text: txt(res) || null, cartText: txt(cart) || null };
}
export function discountText(r: { simple_action?: string; discount_amount?: number; apply_to_shipping?: boolean; discount_step?: number; discount_qty?: number | null }, target?: string | null) {
  const v = Number(r.discount_amount ?? 0), a = r.simple_action;
  const base = a === 'by_percent' ? `${v.toLocaleString('de-DE')} %` : a === 'by_fixed' ? `${money(v)} je Artikel` : a === 'cart_fixed' ? `${money(v)} auf den Warenkorb` : a === 'buy_x_get_y' ? `Kaufe ${r.discount_step || '?'}, erhalte ${v} gratis` : `${a} ${v}`;
  return `${base}${target ? ` auf ${target}` : ''}${r.apply_to_shipping ? ' (inkl. Versand)' : ''}${r.discount_qty ? `, höchstens ${r.discount_qty} Artikel` : ''}`;
}
export const periodText = (r: OmRecord) => (r.from_date || r.to_date ? `${r.from_date ? deDay(String(r.from_date).slice(0, 10)) : 'offen'} bis ${r.to_date ? deDay(String(r.to_date).slice(0, 10)) : 'offen'}` : 'unbegrenzt');

export async function promoView(ro: OmReader, r: OmRecord, detail = false) {
  const full = detail && !r.conditions ? (await ro.salesRule(r.id)) ?? r : r;
  const { res, cart, cats, text: target, cartText } = await targetText(ro, full);
  const sub = minSubtotal(full), code = Number(full.coupon_type) === FIXED ? { mode: 'fixed' as const, code: full.coupon_code ?? full.primary_coupon?.code ?? null, timesUsed: full.primary_coupon?.times_used ?? 0 } : Number(full.coupon_type) === NO_COUPON ? { mode: 'none' as const } : { mode: 'auto' as const, generated: full.coupon_count ?? 0 };
  return {
    id: String(full.id), name: full.name, status: promoStatus(full), active: !!full.is_active, period: periodText(full), validFrom: full.from_date ?? null, validUntil: full.to_date ?? null,
    discount: discountText(full, target), code, priority: full.sort_order ?? 0, exclusive: !!full.stop_rules_processing,
    maxUsesPerCustomer: full.uses_per_customer || null, maxUsesPerCoupon: full.uses_per_coupon || null, timesUsed: full.times_used ?? 0, ...(sub != null ? { minSubtotal: sub } : {}),
    ...(detail ? { description: full.description ?? null, restriction: { categories: res.categoryIds.map(id => ({ id, name: cats.get(id) ?? id })), skus: res.skus, otherConditions: res.other }, cartCondition: cartText, cartRestriction: { categories: cart.categoryIds, skus: cart.skus }, websites: full.website_ids, freeShipping: full.simple_free_shipping ?? null, otherCartConditions: otherCartConds(full) } : {}),
  };
}

// ================= Proposal: create / change =================
export interface PromoDiscount { type: 'percentage' | 'absolute' | 'cart_fixed' | 'buy_x_get_y'; value: number; step?: number; maxQty?: number | null; applyToShipping?: boolean; categoryIds?: string[]; productIds?: string[] }
export interface PromoArgs {
  id?: string; reason: string; name?: string; description?: string | null; active?: boolean; validFrom?: string | null; validUntil?: string | null;
  code?: { mode: 'none' | 'fixed'; code?: string };
  discount?: PromoDiscount; minSubtotal?: number | null; priority?: number; exclusive?: boolean; maxUsesPerCustomer?: number | null; maxUsesPerCoupon?: number | null;
}
export interface PromoPayload { ruleId: string | null; rule: OmRecord; before: OmRecord | null }

const prodConds = (categoryIds: string[], skus: string[]): OmRecord[] => [
  ...(categoryIds.length ? [{ type: PRODUCT, attribute: 'category_ids', operator: '()', value: categoryIds.join(', ') }] : []),
  ...(skus.length ? [{ type: PRODUCT, attribute: 'sku', operator: '()', value: skus.join(', ') }] : []),
];
/** Cart condition: minimum order value + "item in cart from category/SKU" (both optional); other conditions remain if combined with "all" */
export function conditionTree(before: OmRecord | null, sub: number | null | undefined, filter: { categoryIds: string[]; skus: string[] } | undefined): { tree: OmRecord; dropped: number } {
  const bc = before?.conditions as OmRecord | undefined, prev = ((bc?.conditions ?? []) as OmRecord[]);
  const keep = prev.filter(c => !(sub !== undefined && isMin(c)) && !(filter && c.type === FOUND));
  const dropped = keep.length && (String(bc?.aggregator ?? 'all') !== 'all' || !bc?.value) ? keep.length : 0;
  const conds = [...(dropped ? [] : keep), ...(sub != null ? [{ type: ADDRESS, attribute: 'base_subtotal', operator: '>=', value: String(sub) }] : [])];
  const pc = filter ? prodConds(filter.categoryIds, filter.skus) : [];
  if (pc.length) conds.push({ type: FOUND, value: 1, aggregator: pc.length > 1 ? 'any' : 'all', conditions: pc });
  return { tree: { type: COMBINE, aggregator: 'all', value: 1, conditions: conds }, dropped };
}
const actionTree = (categoryIds: string[], skus: string[]): OmRecord => { const pc = prodConds(categoryIds, skus); return { type: PRODUCT_COMBINE, aggregator: pc.length > 1 ? 'any' : 'all', value: 1, conditions: pc }; };
const dateIn = (v: string | null | undefined, label: string) => { if (v === undefined) return undefined; if (v === null || v === '') return null; if (!DATE_RE.test(v)) throw new Error(`${label}: Datum JJJJ-MM-TT erwartet`); return v; };
const limit = (v: number | null | undefined, label: string) => { if (v === undefined) return undefined; if (v === null) return 0; if (!Number.isInteger(v) || v < 0) throw new Error(`${label}: ganze Zahl ≥ 0 oder null`); return v; };

export async function buildPromotionChangeSet(ro: OmReader, a: PromoArgs): Promise<{ cs: ChangeSet; payload: PromoPayload }> {
  const before = a.id ? await ro.salesRule(a.id) : null;
  if (a.id && !before) throw new Error(`Promotion ${a.id} nicht gefunden`);
  const d = a.discount;
  if (!before) {
    if (!a.name?.trim()) throw new Error('name fehlt');
    if (!d) throw new Error('discount fehlt (type + value)');
    if (!a.code) throw new Error('code fehlt (mode none oder fixed)');
    if (a.active === undefined) throw new Error('active fehlt (true = aktiv bzw. geplant ab validFrom, false = Entwurf)');
  }
  const rule: OmRecord = {}, warn: string[] = [], items: ChangeItem[] = [];
  if (a.name !== undefined) rule.name = a.name.trim();
  if (a.description !== undefined) rule.description = a.description ?? '';
  if (a.active !== undefined) rule.is_active = a.active;
  const from = dateIn(a.validFrom, 'validFrom'), to = dateIn(a.validUntil, 'validUntil');
  if (from !== undefined) rule.from_date = from; if (to !== undefined) rule.to_date = to;
  const f = from !== undefined ? from ?? '' : before?.from_date ? String(before.from_date).slice(0, 10) : '', t = to !== undefined ? to ?? '' : before?.to_date ? String(before.to_date).slice(0, 10) : '';
  if (f && t && t < f) throw new Error('validUntil liegt vor validFrom');
  if (t && t < isoDay()) warn.push('Enddatum liegt in der Vergangenheit');
  if (!t) warn.push('Kein Enddatum');
  let filter: { categoryIds: string[]; skus: string[] } | undefined;
  if (d) {
    if (!ACTION[d.type]) throw new Error('discount.type: percentage, absolute, cart_fixed oder buy_x_get_y');
    if (!(typeof d.value === 'number' && d.value > 0)) throw new Error('discount.value > 0 erwartet');
    if (d.type === 'percentage' && d.value > 100) throw new Error('Prozent-Rabatt höchstens 100');
    if (d.type === 'percentage' && d.value > 50) warn.push(`Hoher Rabatt (${d.value} %)`);
    const skus: string[] = [];
    for (const ref of d.productIds ?? []) { const p = await ro.productByRef(ref); if (!p) throw new Error(`Produkt nicht gefunden: ${ref}`); skus.push(p.sku); }
    for (const cid of d.categoryIds ?? []) if (!await ro.category(cid)) throw new Error(`Kategorie ${cid} nicht gefunden`);
    Object.assign(rule, { simple_action: ACTION[d.type], discount_amount: d.value });
    if (!before || d.step !== undefined) rule.discount_step = d.step ?? 0;
    if (d.maxQty !== undefined) rule.discount_qty = d.maxQty ?? null;
    if (!before || d.applyToShipping !== undefined) rule.apply_to_shipping = !!d.applyToShipping;
    if (!before || d.categoryIds !== undefined || d.productIds !== undefined) {
      const prev = before ? restriction(before.actions) : null;
      filter = { categoryIds: d.categoryIds ?? prev?.categoryIds ?? [], skus: d.productIds !== undefined ? skus : prev?.skus ?? [] };
      rule.actions = actionTree(filter.categoryIds, filter.skus);
      if (prev?.other) warn.push(`${prev.other} weitere Artikel-Bedingung(en) der Regel entfallen`);
    }
  }
  if (a.minSubtotal !== undefined && a.minSubtotal != null && !(a.minSubtotal >= 0)) throw new Error('minSubtotal ≥ 0');
  if (a.minSubtotal !== undefined || filter || !before) {
    const { tree, dropped } = conditionTree(before, a.minSubtotal, filter);
    rule.conditions = tree;
    if (dropped) warn.push(`${dropped} weitere Warenkorb-Bedingung(en) der Regel entfallen (z. B. Lieferland)`);
  }
  if (a.priority !== undefined) rule.sort_order = a.priority;
  if (a.exclusive !== undefined) rule.stop_rules_processing = a.exclusive;
  const upc = limit(a.maxUsesPerCustomer, 'maxUsesPerCustomer'), upco = limit(a.maxUsesPerCoupon, 'maxUsesPerCoupon');
  if (upc !== undefined) rule.uses_per_customer = upc; if (upco !== undefined) rule.uses_per_coupon = upco === 0 ? null : upco;
  if (a.code) {
    if (a.code.mode === 'fixed') {
      const code = String(a.code.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) throw new Error('code.code: 3–32 Zeichen A–Z, 0–9, - oder _');
      const used = (await ro.salesRules({ coupon_code: code, limit: 5 })).items.filter(r => String(r.coupon_code ?? '').toUpperCase() === code && String(r.id) !== String(a.id ?? ''));
      if (used.length) throw new Error(`Code ${code} ist schon vergeben (Promotion „${used[0].name}“)`);
      if (before && Number(before.coupon_type) === 3) throw new Error('Diese Promotion nutzt automatische Codes, fester Code nur bei neuen Promotionen');
      if (String(before?.coupon_code ?? '').toUpperCase() !== code) { rule.coupon_type = FIXED; rule.coupon_code = code; if (before?.coupon_code && before.times_used) warn.push(`Bisheriger Code ${before.coupon_code} wurde schon ${before.times_used}× eingelöst`); }
    } else if (a.code.mode === 'none') {
      if (before && Number(before.coupon_type) !== NO_COUPON) throw new Error('Code entfernen geht nicht exakt umkehrbar. Promotion beenden (propose_promotion_status) und neu ohne Code anlegen');
      if (!before) rule.coupon_type = NO_COUPON;
    } else throw new Error('code.mode: none oder fixed (OpenMage: keine automatisch erzeugten Einzelcodes über Lotse)');
  }
  if (rule.is_active === true && f && f > isoDay()) warn.push(`Geplant: startet am ${deDay(f)}`);
  const running = (await ro.salesRules({ is_active: 1, limit: 100 })).items.filter(r => String(r.id) !== String(a.id ?? '') && promoStatus(r) !== 'abgelaufen');
  if (running.length && Number(rule.coupon_type ?? before?.coupon_type ?? NO_COUPON) === NO_COUPON) warn.push(`Weitere aktive Regeln: ${running.slice(0, 3).map(r => r.name).join(', ')}${running.length > 3 ? ' …' : ''}`);
  const merged = { ...(before ?? {}), ...rule }, cats = new Map<string, string>();
  const view = async (r: OmRecord) => {
    const { text, cartText } = await targetText(ro, r, cats), sub = minSubtotal(r), other = otherCartConds(r);
    return [discountText(r, text), cartText ? `nur mit ${cartText} im Warenkorb` : '', sub != null ? `ab ${money(sub)} Warenkorb` : '', other ? `${other} weitere Warenkorb-Bedingung(en)` : '', periodText(r), r.is_active ? 'aktiv' : 'inaktiv'].filter(Boolean).join(' · ');
  };
  const codeText = rule.coupon_code ? `Code ${rule.coupon_code}` : Number(rule.coupon_type ?? before?.coupon_type) === NO_COUPON ? 'ohne Code' : before?.coupon_code ? `Code ${before.coupon_code}` : '';
  if (!before) items.push({ id: 'promo', entity: 'promotion', label: String(rule.name), field: 'create', fieldLabel: 'Neue Promotion', before: '–', after: [await view(merged), codeText, upc ? `max. ${upc}× pro Kunde` : ''].filter(Boolean).join(' · '), afterRaw: null, warn });
  else {
    if (!Object.keys(rule).length) throw new Error('Keine Änderung angegeben');
    items.push({ id: 'promo', entity: 'promotion', entityId: String(before.id), label: String(before.name), field: 'update', fieldLabel: 'Promotion ändern', before: await view(before), after: [await view(merged), codeText].filter(Boolean).join(' · '), afterRaw: null, warn });
  }
  items.push({ id: 'info:gruppen', entity: 'info', label: 'Kundengruppen', fieldLabel: '', before: '', after: before ? 'bleiben unverändert' : 'alle Kundengruppen, alle Websites', warn: [] });
  return { cs: { id: newIdSafe(), kind: 'promotion', entity: 'promotion', noun: { one: 'Promotion', many: 'Promotionen' }, title: before ? `Promotion ändern: ${before.name}` : `Neue Promotion: ${rule.name}`, reason: a.reason, items, skipped: [], atomic: true }, payload: { ruleId: before ? String(before.id) : null, rule, before } };
}

/** Previous values of exactly the changed rule fields (null clears date/limit) */
export const undoRule = (before: OmRecord, keys: string[]): OmRecord => Object.fromEntries(keys.map(k => [k, k === 'from_date' || k === 'to_date' ? (before[k] ? String(before[k]).slice(0, 10) : null) : k === 'description' ? before[k] ?? '' : k === 'coupon_code' ? before[k] ?? '' : before[k] ?? null]));

reg.register('promotion', async (c, cs, payload, selected, ctx) => {
  const p = payload as PromoPayload;
  if (!selected.has('promo')) return { results: [], undo: [] };
  const undo = trackedUndo(ctx, 1); // every step saved immediately (rule created, codes generated)
  try {
    let id = p.ruleId;
    if (!id) {
      const created = await c.req('POST', '/v1/salesrules', p.rule) as OmRecord;
      id = String(created.id); undo.push(reqOp('sales-rule', id, 'DELETE', `/v1/salesrules/${id}`));
    } else {
      const cur = await c.req('GET', `/v1/salesrules/${id}`) as OmRecord, keys = Object.keys(p.rule);
      await c.req('PATCH', `/v1/salesrules/${id}`, p.rule);
      undo.push(reqOp('sales-rule', id, 'PATCH', `/v1/salesrules/${id}`, undoRule(cur, keys)));
    }
    return { results: [{ itemId: 'promo', ok: true }], undo, published: { promotionId: id } };
  } catch (e) { return { results: [{ itemId: 'promo', ok: false, error: errMsg(e) }], undo }; }
});

// ================= Status (activate, deactivate, end) =================
export async function buildPromotionStatusChangeSet(ro: OmReader, a: { ids: string[]; action: 'activate' | 'deactivate' | 'end'; reason?: string }): Promise<ChangeSet> {
  if (!a.ids?.length) throw new Error('ids ist leer');
  if (a.ids.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Promotionen.`);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], today = isoDay();
  for (const id of a.ids) {
    const r = await ro.salesRule(id);
    if (!r) { skipped.push({ id, reason: 'nicht gefunden' }); continue; }
    const st = promoStatus(r);
    const set: OmRecord = a.action === 'activate' ? { is_active: true } : a.action === 'deactivate' ? { is_active: false } : { is_active: false, to_date: today };
    if (a.action === 'activate' && r.is_active) { skipped.push({ id, reason: 'schon aktiv' }); continue; }
    if (a.action === 'deactivate' && !r.is_active) { skipped.push({ id, reason: 'schon inaktiv' }); continue; }
    if (a.action === 'end' && !r.is_active && r.to_date && String(r.to_date).slice(0, 10) <= today) { skipped.push({ id, reason: 'schon beendet' }); continue; }
    const warn: string[] = [];
    if (a.action === 'activate' && st === 'abgelaufen') warn.push('Enddatum liegt in der Vergangenheit, wirkt nicht');
    if (a.action !== 'activate' && Number(r.coupon_type) !== NO_COUPON) warn.push('Ausgegebene Codes funktionieren danach nicht mehr');
    items.push({ id: String(r.id), entity: 'promotion', entityId: String(r.id), label: String(r.name), field: 'status', fieldLabel: a.action === 'end' ? 'Beenden' : 'Status', before: `${st} · ${periodText(r)}`, after: a.action === 'end' ? `beendet (Ende ${deDay(today)})` : a.action === 'activate' ? 'aktiv' : 'inaktiv', afterRaw: set, warn });
  }
  if (!items.length) throw new Error(`Nichts zu ändern: ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}`);
  return { id: newIdSafe(), kind: 'promotion-status', entity: 'promotion', noun: { one: 'Promotion', many: 'Promotionen' }, title: `Promotionen ${a.action === 'activate' ? 'aktivieren' : a.action === 'deactivate' ? 'deaktivieren' : 'beenden'}`, reason: a.reason ?? null, items, skipped, atomic: false };
}
reg.register('promotion-status', (c: OmClient, cs, _p, selected, ctx) => applyEach(cs, selected, async it => {
  const set = it.afterRaw as OmRecord, cur = await c.req('GET', `/v1/salesrules/${it.entityId}`) as OmRecord;
  await c.req('PATCH', `/v1/salesrules/${it.entityId}`, set);
  return reqOp('sales-rule', it.entityId!, 'PATCH', `/v1/salesrules/${it.entityId}`, undoRule(cur, Object.keys(set)));
}, ctx));
