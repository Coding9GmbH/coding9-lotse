import 'server-only';
// Magento: promotions = cart price rules (salesRules) with coupon codes (coupons). Reads only rules and counts (never customers or orders).
// The executor sets customer groups (all groups) with the privileged client; the AI reads no customer groups.
import type { ChangeItem, ChangeSet } from '@/lib/protocol';
import { applyEach, errMsg, MAX_ITEMS, newIdSafe, trackedUndo } from './kit';
import type { MagentoClient } from './client';
import { deDay, isoDay, money, type MRecord } from './map';
import type { MagentoReader } from './reader';
import { reg, reqOp } from './write';

const COMBINE = 'Magento\\SalesRule\\Model\\Rule\\Condition\\Combine', PRODUCT_COMBINE = 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product\\Combine';
const PRODUCT_COND = 'Magento\\SalesRule\\Model\\Rule\\Condition\\Product', ADDRESS_COND = 'Magento\\SalesRule\\Model\\Rule\\Condition\\Address';
export const MAX_CODES = 1000;
const ACTION: Record<string, string> = { percentage: 'by_percent', absolute: 'by_fixed', cart_fixed: 'cart_fixed', buy_x_get_y: 'buy_x_get_y' };
const ACTION_BACK: Record<string, string> = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k]));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PromoStatus = 'läuft' | 'geplant' | 'abgelaufen' | 'inaktiv';
export function promoStatus(r: MRecord, today = isoDay()): PromoStatus {
  if (!r.is_active) return 'inaktiv';
  if (r.to_date && String(r.to_date).slice(0, 10) < today) return 'abgelaufen';
  if (r.from_date && String(r.from_date).slice(0, 10) > today) return 'geplant';
  return 'läuft';
}
/** Restriction from the action condition (only categories/SKUs readable; anything else as a count) */
export function restriction(r: MRecord): { categoryIds: string[]; skus: string[]; other: number } {
  const out = { categoryIds: [] as string[], skus: [] as string[], other: 0 };
  const walk = (c: MRecord | undefined) => { for (const x of (c?.conditions ?? []) as MRecord[]) {
    if (x.conditions) walk(x);
    else if (x.attribute_name === 'category_ids' && ['()', '=='].includes(x.operator)) out.categoryIds.push(...String(x.value).split(',').map(s => s.trim()).filter(Boolean));
    else if (x.attribute_name === 'sku' && ['()', '=='].includes(x.operator)) out.skus.push(...String(x.value).split(',').map(s => s.trim()).filter(Boolean));
    else out.other++;
  } };
  walk(r.action_condition); return out;
}
const isMin = (c: MRecord) => c.attribute_name === 'base_subtotal' && c.operator === '>=';
const minSubtotal = (r: MRecord): number | null => { const x = ((r.condition?.conditions ?? []) as MRecord[]).find(isMin); return x ? Number(x.value) : null; };
/** Further cart conditions besides the minimum order value (e.g. shipping country), only as a count */
const otherCartConds = (r: MRecord) => ((r.condition?.conditions ?? []) as MRecord[]).filter(c => !isMin(c)).length;
/** Default label in the cart (store 0) */
export const labelOf = (r: MRecord): string | null => ((r.store_labels ?? []) as MRecord[]).find(l => Number(l.store_id) === 0)?.store_label || null;
/** Readable discount target (categories with names, SKUs, other conditions); null = all items */
async function targetText(ro: MagentoReader, r: MRecord, cats = new Map<string, string>()) {
  const res = restriction(r);
  for (const id of res.categoryIds.slice(0, 20)) if (!cats.has(id)) cats.set(id, String((await ro.category(id).catch(() => null))?.name ?? id));
  return { res, cats, text: [res.categoryIds.length ? `Kategorien ${res.categoryIds.map(i => cats.get(i) ?? i).join(', ')}` : '', res.skus.length ? `Artikel ${res.skus.join(', ')}` : '', res.other ? `${res.other} weitere Bedingung(en)` : ''].filter(Boolean).join(' + ') || null };
}
export function discountText(r: { simple_action?: string; discount_amount?: number; apply_to_shipping?: boolean; discount_step?: number; discount_qty?: number | null }, target?: string | null) {
  const v = Number(r.discount_amount ?? 0), a = r.simple_action;
  const base = a === 'by_percent' ? `${v.toLocaleString('de-DE')} %` : a === 'by_fixed' ? `${money(v)} je Artikel` : a === 'cart_fixed' ? `${money(v)} auf den Warenkorb` : a === 'buy_x_get_y' ? `Kaufe ${r.discount_step || '?'}, erhalte ${v} gratis` : `${a} ${v}`;
  return `${base}${target ? ` auf ${target}` : ''}${r.apply_to_shipping ? ' (inkl. Versand)' : ''}${r.discount_qty ? `, höchstens ${r.discount_qty} Artikel` : ''}`;
}
export const periodText = (r: MRecord) => (r.from_date || r.to_date ? `${r.from_date ? deDay(String(r.from_date).slice(0, 10)) : 'offen'} bis ${r.to_date ? deDay(String(r.to_date).slice(0, 10)) : 'offen'}` : 'unbegrenzt');

async function couponInfo(ro: MagentoReader, r: MRecord) {
  if (r.coupon_type === 'NO_COUPON') return { mode: 'none' as const };
  const all = await ro.coupons({ filters: [[{ field: 'rule_id', value: r.rule_id }]], pageSize: 5 });
  if (!r.use_auto_generation) return { mode: 'fixed' as const, code: all.items.find(c => c.is_primary)?.code ?? all.items[0]?.code ?? null, timesUsed: all.items.find(c => c.is_primary)?.times_used ?? 0 };
  const used = await ro.coupons({ filters: [[{ field: 'rule_id', value: r.rule_id }], [{ field: 'times_used', value: 0, condition_type: 'gt' }]], pageSize: 1 });
  return { mode: 'individual' as const, generated: all.total_count, redeemed: used.total_count, examples: all.items.filter(c => !c.times_used).slice(0, 3).map(c => c.code) };
}
export async function promoView(ro: MagentoReader, r: MRecord, detail = false) {
  const { res, cats, text: target } = await targetText(ro, r);
  const sub = minSubtotal(r);
  return {
    id: String(r.rule_id), name: r.name, status: promoStatus(r), active: !!r.is_active, period: periodText(r), validFrom: r.from_date ?? null, validUntil: r.to_date ?? null,
    discount: discountText(r, target), code: await couponInfo(ro, r), priority: r.sort_order ?? 0, exclusive: !!r.stop_rules_processing,
    maxUsesPerCustomer: r.uses_per_customer || null, maxUsesPerCoupon: r.uses_per_coupon || null, timesUsed: r.times_used ?? 0, ...(sub != null ? { minSubtotal: sub } : {}),
    ...(detail ? { description: r.description ?? null, label: labelOf(r), restriction: { categories: res.categoryIds.map(id => ({ id, name: cats.get(id) ?? id })), skus: res.skus, otherConditions: res.other }, websites: r.website_ids, freeShipping: r.simple_free_shipping ?? null, conditions: (r.condition?.conditions ?? []).length } : {}),
  };
}

// ================= Proposal: create / update =================
export interface PromoDiscount { type: 'percentage' | 'absolute' | 'cart_fixed' | 'buy_x_get_y'; value: number; step?: number; maxQty?: number | null; applyToShipping?: boolean; categoryIds?: string[]; productIds?: string[] }
export interface PromoArgs {
  id?: string; reason: string; name?: string; description?: string | null; label?: string | null; active?: boolean; validFrom?: string | null; validUntil?: string | null;
  code?: { mode: 'none' | 'fixed' | 'individual'; code?: string; count?: number; length?: number; prefix?: string };
  discount?: PromoDiscount; discounts?: PromoDiscount[]; minSubtotal?: number | null; priority?: number; exclusive?: boolean; maxUsesPerCustomer?: number | null; maxUsesPerCoupon?: number | null;
}
export interface PromoPayload { ruleId: string | null; rule: MRecord; before: MRecord | null; code: PromoArgs['code'] | null; oldCoupon: MRecord | null }

function actionCondition(categoryIds: string[], skus: string[]): MRecord {
  const conds: MRecord[] = [];
  if (categoryIds.length) conds.push({ condition_type: PRODUCT_COND, attribute_name: 'category_ids', operator: '()', value: categoryIds.join(',') });
  if (skus.length) conds.push({ condition_type: PRODUCT_COND, attribute_name: 'sku', operator: '()', value: skus.join(',') });
  return { condition_type: PRODUCT_COMBINE, aggregator_type: conds.length > 1 ? 'any' : 'all', value: '1', conditions: conds };
}
const subCond = (sub: number) => ({ condition_type: ADDRESS_COND, attribute_name: 'base_subtotal', operator: '>=', value: String(sub) });
const condition = (sub: number | null): MRecord => ({ condition_type: COMBINE, aggregator_type: 'all', value: '1', conditions: sub != null ? [subCond(sub)] : [] });
/**
 * Cart condition with a new minimum order value. Other conditions (e.g. shipping country) remain if the rule combines them with
 * "all true"; otherwise the minimum order value replaces them (dropped = count, shown as a warning on the card).
 */
export function conditionWith(before: MRecord | null, sub: number | null): { cond: MRecord; dropped: number } {
  const bc = before?.condition as MRecord | undefined, others = ((bc?.conditions ?? []) as MRecord[]).filter(c => !isMin(c));
  if (!others.length) return { cond: condition(sub), dropped: 0 };
  if ((bc!.aggregator_type ?? 'all') === 'all' && String(bc!.value ?? '1') === '1') return { cond: { ...condition(null), conditions: [...others, ...(sub != null ? [subCond(sub)] : [])] }, dropped: 0 };
  return { cond: condition(sub), dropped: others.length };
}
const dateIn = (v: string | null | undefined, label: string) => { if (v === undefined) return undefined; if (v === null || v === '') return ''; if (!DATE_RE.test(v)) throw new Error(`${label}: Datum JJJJ-MM-TT erwartet`); return v; };
const limit = (v: number | null | undefined, label: string) => { if (v === undefined) return undefined; if (v === null) return 0; if (!Number.isInteger(v) || v < 0) throw new Error(`${label}: ganze Zahl ≥ 0 oder null`); return v; };

export async function buildPromotionChangeSet(ro: MagentoReader, a: PromoArgs): Promise<{ cs: ChangeSet; payload: PromoPayload }> {
  const before = a.id ? await ro.salesRule(a.id) : null;
  if (a.id && !before) throw new Error(`Promotion ${a.id} nicht gefunden`);
  const d = a.discount ?? (a.discounts?.length === 1 ? a.discounts[0] : undefined);
  if (a.discounts && a.discounts.length > 1) throw new Error('Magento-Warenkorb-Preisregeln haben genau einen Rabatt. Für mehrere Rabatte mehrere Promotionen anlegen');
  if (!before) {
    if (!a.name?.trim()) throw new Error('name fehlt');
    if (!d) throw new Error('discount fehlt (type + value)');
    if (!a.code) throw new Error('code fehlt (mode none, fixed oder individual)');
    if (a.active === undefined) throw new Error('active fehlt (true = aktiv bzw. geplant ab validFrom, false = Entwurf)');
  }
  const rule: MRecord = {}, warn: string[] = [], items: ChangeItem[] = [];
  if (a.name !== undefined) rule.name = a.name.trim();
  if (a.description !== undefined) rule.description = a.description ?? '';
  // Magento ignores store_labels [] or null: removing the label = empty text for store 0
  if (a.label !== undefined && (a.label || before)) rule.store_labels = [{ store_id: 0, store_label: a.label?.trim() ?? '' }];
  if (a.active !== undefined) rule.is_active = a.active;
  const from = dateIn(a.validFrom, 'validFrom'), to = dateIn(a.validUntil, 'validUntil');
  if (from !== undefined) rule.from_date = from; if (to !== undefined) rule.to_date = to;
  const f = from ?? (before?.from_date ? String(before.from_date).slice(0, 10) : ''), t = to ?? (before?.to_date ? String(before.to_date).slice(0, 10) : '');
  if (f && t && t < f) throw new Error('validUntil liegt vor validFrom');
  if (t && t < isoDay()) warn.push('Enddatum liegt in der Vergangenheit');
  if (!t) warn.push('Kein Enddatum');
  if (d) {
    if (!ACTION[d.type]) throw new Error('discount.type: percentage, absolute, cart_fixed oder buy_x_get_y');
    if (!(typeof d.value === 'number' && d.value > 0)) throw new Error('discount.value > 0 erwartet');
    if (d.type === 'percentage' && d.value > 100) throw new Error('Prozent-Rabatt höchstens 100');
    if (d.type === 'percentage' && d.value > 50) warn.push(`Hoher Rabatt (${d.value} %)`);
    const prods = d.productIds?.length ? await ro.productsByIds(d.productIds).then(async ps => [...ps, ...await ro.productsBySkus(d.productIds!.filter(x => !ps.some(p => String(p.id) === x)))]) : [];
    const missing = (d.productIds ?? []).filter(x => !prods.some(p => String(p.id) === x || p.sku === x)); if (missing.length) throw new Error(`Produkte nicht gefunden: ${missing.join(', ')}`);
    for (const cid of d.categoryIds ?? []) if (!await ro.category(cid)) throw new Error(`Kategorie ${cid} nicht gefunden`);
    // For existing rules write only the given discount fields: restriction, shipping, step and max quantity stay otherwise
    Object.assign(rule, { simple_action: ACTION[d.type], discount_amount: d.value });
    if (!before || d.step !== undefined) rule.discount_step = d.step ?? 0;
    if (d.maxQty !== undefined) rule.discount_qty = d.maxQty ?? 0;
    if (!before || d.applyToShipping !== undefined) rule.apply_to_shipping = !!d.applyToShipping;
    if (!before || d.categoryIds !== undefined || d.productIds !== undefined) {
      const prev = before ? restriction(before) : null;
      rule.action_condition = actionCondition(d.categoryIds ?? prev?.categoryIds ?? [], d.productIds !== undefined ? prods.map(p => p.sku) : prev?.skus ?? []);
      if (prev?.other) warn.push(`${prev.other} weitere Artikel-Bedingung(en) der Regel entfallen`);
    }
  }
  if (a.minSubtotal !== undefined) {
    if (a.minSubtotal != null && !(a.minSubtotal >= 0)) throw new Error('minSubtotal ≥ 0');
    const { cond, dropped } = conditionWith(before, a.minSubtotal); rule.condition = cond;
    if (dropped) warn.push(`Mindestbestellwert ersetzt ${dropped} weitere Warenkorb-Bedingung(en) der Regel (z. B. Lieferland)`);
  }
  if (a.priority !== undefined) rule.sort_order = a.priority;
  if (a.exclusive !== undefined) rule.stop_rules_processing = a.exclusive;
  const upc = limit(a.maxUsesPerCustomer, 'maxUsesPerCustomer'), upco = limit(a.maxUsesPerCoupon, 'maxUsesPerCoupon');
  if (upc !== undefined) rule.uses_per_customer = upc; if (upco !== undefined) rule.uses_per_coupon = upco;
  let oldCoupon: MRecord | null = null;
  if (a.code) {
    const m = a.code.mode;
    if (m === 'fixed') {
      const code = String(a.code.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) throw new Error('code.code: 3 bis 32 Zeichen A-Z, 0-9, - oder _');
      const used = await ro.coupons({ filters: [[{ field: 'code', value: code }]], pageSize: 1 });
      if (used.items.length && String(used.items[0].rule_id) !== String(a.id ?? '')) throw new Error(`Code ${code} ist schon vergeben`);
      if (before && before.use_auto_generation) throw new Error('Diese Promotion nutzt Einzelcodes, fester Code nur bei neuen Promotionen');
      if (before && before.coupon_type === 'SPECIFIC_COUPON') oldCoupon = (await ro.coupons({ filters: [[{ field: 'rule_id', value: before.rule_id }]], pageSize: 5 })).items.find(c => c.is_primary) ?? null;
      if (oldCoupon?.code === code) a.code = undefined;
      else { a.code = { mode: 'fixed', code }; if (!before || before.coupon_type !== 'SPECIFIC_COUPON') Object.assign(rule, { coupon_type: 'SPECIFIC_COUPON', use_auto_generation: false }); if (oldCoupon?.times_used) warn.push(`Bisheriger Code ${oldCoupon.code} wurde schon ${oldCoupon.times_used}× eingelöst`); }
    } else if (m === 'individual') {
      const n = a.code.count ?? 0;
      if (!Number.isInteger(n) || n < 1 || n > MAX_CODES) throw new Error(`code.count: 1 bis ${MAX_CODES}`);
      if (before && before.coupon_type === 'SPECIFIC_COUPON' && !before.use_auto_generation) throw new Error('Diese Promotion hat einen festen Code, Einzelcodes nur bei neuen Promotionen oder Einzelcode-Promotionen');
      if (before?.coupon_type === 'NO_COUPON') throw new Error('Promotion ohne Code: Einzelcodes nur bei neuen Promotionen');
      if (a.code.prefix && !/^[A-Za-z0-9_-]{0,12}$/.test(a.code.prefix)) throw new Error('code.prefix: bis 12 Zeichen A-Z, 0-9, - oder _');
      if (!before) Object.assign(rule, { coupon_type: 'SPECIFIC_COUPON', use_auto_generation: true });
    } else if (m === 'none') {
      if (before && before.coupon_type !== 'NO_COUPON') throw new Error('Code entfernen geht nicht exakt umkehrbar. Promotion beenden (propose_promotion_status) und neu ohne Code anlegen');
      if (!before) Object.assign(rule, { coupon_type: 'NO_COUPON', use_auto_generation: false });
      a.code = undefined;
    } else throw new Error('code.mode: none, fixed oder individual');
  }
  if (rule.is_active === true && f && f > isoDay()) warn.push(`Geplant: startet am ${deDay(f)}`);
  // Overlap with running rules without a code (they apply together automatically)
  const running = (await ro.salesRules({ filters: [[{ field: 'is_active', value: 1 }]], pageSize: 100 })).items.filter(r => String(r.rule_id) !== String(a.id ?? '') && promoStatus(r) !== 'abgelaufen');
  if (running.length && (rule.coupon_type ?? before?.coupon_type) === 'NO_COUPON') warn.push(`Weitere aktive Regeln: ${running.slice(0, 3).map(r => r.name).join(', ')}${running.length > 3 ? ' …' : ''}`);
  const merged = { ...(before ?? {}), ...rule };
  const cats = new Map<string, string>(), mergedLabel = rule.store_labels ? (rule.store_labels[0].store_label || null) : before ? labelOf(before) : null;
  const view = async (r: MRecord, label: string | null) => {
    const sub = minSubtotal(r), other = otherCartConds(r);
    return [discountText(r, (await targetText(ro, r, cats)).text), sub != null ? `ab ${money(sub)} Warenkorb` : '', other ? `${other} weitere Warenkorb-Bedingung(en)` : '', label ? `Bezeichnung „${label}“` : '', periodText(r), r.is_active ? 'aktiv' : 'inaktiv'].filter(Boolean).join(' · ');
  };
  const codeText = a.code?.mode === 'fixed' ? `Code ${a.code.code}` : a.code?.mode === 'individual' ? `${a.code.count} Einzelcodes${a.code.prefix ? ` (${a.code.prefix}…)` : ''}` : (rule.coupon_type ?? before?.coupon_type) === 'NO_COUPON' ? 'ohne Code' : '';
  if (!before) items.push({ id: 'promo', entity: 'promotion', label: String(rule.name), field: 'create', fieldLabel: 'Neue Promotion', before: '–', after: [await view(merged, mergedLabel), codeText, upc ? `max. ${upc}× pro Kunde` : ''].filter(Boolean).join(' · '), afterRaw: null, warn });
  else {
    const keys = Object.keys(rule);
    if (!keys.length && !a.code) throw new Error('Keine Änderung angegeben');
    items.push({ id: 'promo', entity: 'promotion', entityId: String(before.rule_id), label: String(before.name), field: 'update', fieldLabel: 'Promotion ändern', before: await view(before, labelOf(before)), after: [await view(merged, mergedLabel), codeText].filter(Boolean).join(' · '), afterRaw: null, warn });
  }
  items.push({ id: 'info:gruppen', entity: 'info', label: 'Kundengruppen', fieldLabel: '', before: '', after: before ? 'bleiben unverändert' : 'alle Kundengruppen, alle Websites', warn: [] });
  return { cs: { id: newIdSafe(), kind: 'promotion', entity: 'promotion', noun: { one: 'Promotion', many: 'Promotionen' }, title: before ? `Promotion ändern: ${before.name}` : `Neue Promotion: ${rule.name}`, reason: a.reason, items, skipped: [], atomic: true }, payload: { ruleId: before ? String(before.rule_id) : null, rule, before, code: a.code ?? null, oldCoupon } };
}

/** Empty values for undo: Magento ignores null, so per field the value that means "not set" */
const EMPTY: Record<string, unknown> = { from_date: '', to_date: '', description: '', discount_qty: 0, discount_step: 0, uses_per_customer: 0, uses_per_coupon: 0, sort_order: 0 };
/** Restore labels: previous texts, and empty text for every store view that had none before (Magento ignores []) */
export const undoLabels = (prev: MRecord[] = [], next: MRecord[] = []) => [...prev.map(l => ({ store_id: Number(l.store_id), store_label: l.store_label })), ...next.filter(n => !prev.some(l => Number(l.store_id) === Number(n.store_id))).map(n => ({ store_id: Number(n.store_id), store_label: '' }))];
/** Previous values of exactly the changed rule fields */
export const undoRule = (before: MRecord, keys: string[], set: MRecord = {}) => Object.fromEntries(keys.map(k => [k, k === 'store_labels' ? undoLabels(before.store_labels, set.store_labels) : before[k] ?? (k in EMPTY ? EMPTY[k] : null)]));

reg.register('promotion', async (c, cs, payload, selected, ctx) => {
  const p = payload as PromoPayload;
  if (!selected.has('promo')) return { results: [], undo: [] };
  const undo = trackedUndo(ctx, 1); // every step saved immediately (rule created, codes generated)
  try {
    let id = p.ruleId;
    if (!id) {
      const groups = ((await c.req('GET', '/V1/customerGroups/search', undefined, { store: 'all', query: 'searchCriteria[pageSize]=200' })) as { items: { id: number }[] }).items.map(g => g.id);
      const websites = ((await c.req('GET', '/V1/store/websites', undefined, { store: 'all' })) as { id: number }[]).map(w => w.id).filter(i => i > 0);
      const created = await c.req('POST', '/V1/salesRules', { rule: { website_ids: websites, customer_group_ids: groups, condition: condition(null), ...p.rule } }, { store: 'all' });
      id = String(created.rule_id); undo.push(reqOp('sales-rule', id, 'DELETE', `/all/V1/salesRules/${id}`));
    } else {
      const cur = await c.req('GET', `/V1/salesRules/${id}`, undefined, { store: 'all' });
      const keys = Object.keys(p.rule);
      if (keys.length) { await c.req('PUT', `/V1/salesRules/${id}`, { rule: { rule_id: Number(id), ...p.rule } }, { store: 'all' }); undo.push(reqOp('sales-rule', id, 'PUT', `/all/V1/salesRules/${id}`, { rule: { rule_id: Number(id), ...undoRule(cur, keys, p.rule) } })); }
    }
    if (p.code?.mode === 'fixed') {
      if (p.oldCoupon) {
        await c.req('PUT', `/V1/coupons/${p.oldCoupon.coupon_id}`, { coupon: { ...p.oldCoupon, code: p.code.code } }, { store: 'all' });
        undo.push(reqOp('coupon', String(p.oldCoupon.coupon_id), 'PUT', `/all/V1/coupons/${p.oldCoupon.coupon_id}`, { coupon: p.oldCoupon }));
      } else {
        const cp = await c.req('POST', '/V1/coupons', { coupon: { rule_id: Number(id), code: p.code.code, is_primary: true, usage_limit: p.rule.uses_per_coupon ?? 0, usage_per_customer: p.rule.uses_per_customer ?? 0, type: 0 } }, { store: 'all' });
        if (p.ruleId) undo.push(reqOp('coupon', String(cp.coupon_id), 'DELETE', `/all/V1/coupons/${cp.coupon_id}`));
      }
    } else if (p.code?.mode === 'individual') {
      const codes = await c.req('POST', '/V1/coupons/generate', { couponSpec: { rule_id: Number(id), quantity: p.code.count, length: p.code.length ?? 8, format: 'alphanum', ...(p.code.prefix ? { prefix: p.code.prefix } : {}) } }, { store: 'all' }) as string[];
      if (p.ruleId) undo.push(reqOp('coupon', id!, 'POST', '/all/V1/coupons/deleteByCodes', { codes, ignoreInvalidCoupons: true }));
    }
    return { results: [{ itemId: 'promo', ok: true }], undo, published: { promotionId: id } };
  } catch (e) { return { results: [{ itemId: 'promo', ok: false, error: errMsg(e) }], undo }; }
});

// ================= Status (activate, deactivate, end) =================
export async function buildPromotionStatusChangeSet(ro: MagentoReader, a: { ids: string[]; action: 'activate' | 'deactivate' | 'end'; reason?: string }): Promise<ChangeSet> {
  if (!a.ids?.length) throw new Error('ids ist leer');
  if (a.ids.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Promotionen.`);
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], today = isoDay();
  for (const id of a.ids) {
    const r = await ro.salesRule(id);
    if (!r) { skipped.push({ id, reason: 'nicht gefunden' }); continue; }
    const st = promoStatus(r);
    const set: MRecord = a.action === 'activate' ? { is_active: true } : a.action === 'deactivate' ? { is_active: false } : { is_active: false, to_date: today };
    if (a.action === 'activate' && r.is_active) { skipped.push({ id, reason: 'schon aktiv' }); continue; }
    if (a.action === 'deactivate' && !r.is_active) { skipped.push({ id, reason: 'schon inaktiv' }); continue; }
    if (a.action === 'end' && !r.is_active && st !== 'läuft' && r.to_date && String(r.to_date).slice(0, 10) <= today) { skipped.push({ id, reason: 'schon beendet' }); continue; }
    const warn: string[] = [];
    if (a.action === 'activate' && st === 'abgelaufen') warn.push('Enddatum liegt in der Vergangenheit, wirkt nicht');
    if (a.action !== 'activate' && r.coupon_type !== 'NO_COUPON') warn.push('Ausgegebene Codes funktionieren danach nicht mehr');
    items.push({ id: String(r.rule_id), entity: 'promotion', entityId: String(r.rule_id), label: String(r.name), field: 'status', fieldLabel: a.action === 'end' ? 'Beenden' : 'Status', before: `${st} · ${periodText(r)}`, after: a.action === 'end' ? `beendet (Ende ${deDay(today)})` : a.action === 'activate' ? 'aktiv' : 'inaktiv', afterRaw: set, warn });
  }
  if (!items.length) throw new Error(`Nichts zu ändern: ${skipped.map(s => `${s.id}: ${s.reason}`).join('; ')}`);
  return { id: newIdSafe(), kind: 'promotion-status', entity: 'promotion', noun: { one: 'Promotion', many: 'Promotionen' }, title: `Promotionen ${a.action === 'activate' ? 'aktivieren' : a.action === 'deactivate' ? 'deaktivieren' : 'beenden'}`, reason: a.reason ?? null, items, skipped, atomic: false };
}
reg.register('promotion-status', (c: MagentoClient, cs, _p, selected, ctx) => applyEach(cs, selected, async it => {
  const set = it.afterRaw as MRecord, cur = await c.req('GET', `/V1/salesRules/${it.entityId}`, undefined, { store: 'all' });
  await c.req('PUT', `/V1/salesRules/${it.entityId}`, { rule: { rule_id: Number(it.entityId), ...set } }, { store: 'all' });
  return reqOp('sales-rule', it.entityId!, 'PUT', `/all/V1/salesRules/${it.entityId}`, { rule: { rule_id: Number(it.entityId), ...undoRule(cur, Object.keys(set)) } });
}, ctx));
export const ACTION_NAMES = ACTION_BACK;
