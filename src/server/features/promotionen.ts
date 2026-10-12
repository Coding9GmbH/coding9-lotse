import 'server-only';
// Promotionen & Rabattcodes: lesen (ohne Kunden-/Bestellbezug, nur Zählwerte) und Anlegen/Ändern/Status als Änderungsset.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { applyEach, errMsg, MAX_ITEMS, registerApplier, trackedUndo, undoOps, type ApplyCtx, type ApplyResult } from '../changes';
import { newId, type Shopware, type ShopReader, type SwEntity } from '../shopware';
import { ok, fail, guard, type AnyTool } from '../tool-kit';
import type { Feature } from './types';

export const KIND = 'promotion', STATUS_KIND = 'promotion-status';
export const MAX_DISCOUNTS = 5, MAX_CODES = 5000;
const TZ = 'Europe/Berlin';
const NOUN = { one: 'Promotion', many: 'Promotionen' };

// ---------- Datum (Shop-Zeitzone Europe/Berlin, gespeichert als UTC) ----------
function tzOffsetMs(utcMs: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(utcMs)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
/** "2026-10-01" → Tagesbeginn (bzw. mit end Tagesende) in Berlin als UTC-ISO; volle ISO-Zeitpunkte bleiben, wie sie sind. */
export function parseDay(s: string, end = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (m) {
    const local = Date.UTC(+m[1], +m[2] - 1, +m[3], end ? 23 : 0, end ? 59 : 0, end ? 59 : 0);
    const check = new Date(local);
    if (check.getUTCMonth() !== +m[2] - 1 || check.getUTCDate() !== +m[3]) throw new Error(`Ungültiges Datum „${s}“`);
    let t = local - tzOffsetMs(local); t = local - tzOffsetMs(t);
    return new Date(t).toISOString();
  }
  const d = new Date(s);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s.trim()) || Number.isNaN(d.getTime())) throw new Error(`Ungültiges Datum „${s}“ – erwartet JJJJ-MM-TT`);
  return d.toISOString();
}
const dayFmt = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtDay = (iso: string | null | undefined) => (iso ? dayFmt.format(new Date(iso)) : '–');
export function fmtPeriod(from: string | null | undefined, until: string | null | undefined): string {
  if (!from && !until) return 'unbefristet';
  if (!from) return `bis ${fmtDay(until)}`;
  if (!until) return `ab ${fmtDay(from)}, ohne Enddatum`;
  const a = fmtDay(from), b = fmtDay(until);
  return a.slice(6) === b.slice(6) ? `${a.slice(0, 6)} bis ${b}` : `${a} bis ${b}`;
}
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : null);

// ---------- Texte ----------
const eur = (v: number) => `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (v: number) => `${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`;
export type Scope = 'cart' | 'delivery' | 'set';
export type DiscountType = 'percentage' | 'absolute' | 'fixed' | 'fixed_unit';
export interface DiscountView { scope: string; type: string; value: number; maxValue?: number | null; target?: string | null }
export function discountText(d: DiscountView): string {
  const scope = d.scope.startsWith('set') ? 'set' : d.scope;
  if (scope === 'delivery') {
    if (d.type === 'percentage' && d.value >= 100) return 'Versandkostenfrei';
    return d.type === 'percentage' ? `${pct(d.value)} auf die Versandkosten${d.maxValue ? ` (max. ${eur(d.maxValue)})` : ''}` : d.type === 'absolute' ? `${eur(d.value)} Rabatt auf die Versandkosten` : `Versand zum Festpreis ${eur(d.value)}`;
  }
  const on = scope === 'set' ? 'auf Set-Gruppen' : `auf ${d.target || 'den Warenkorb'}`;
  switch (d.type) {
    case 'percentage': return `${pct(d.value)} ${on}${d.maxValue ? ` (max. ${eur(d.maxValue)})` : ''}`;
    case 'absolute': return `${eur(d.value)} Rabatt ${on}`;
    case 'fixed': return `Festpreis ${eur(d.value)} ${on}`;
    case 'fixed_unit': return `Stückpreis ${eur(d.value)} ${on}`;
    default: return `${d.type} ${d.value} ${on}`;
  }
}
export type CodeSpec = { mode: 'none' } | { mode: 'fixed'; code: string; typed?: string } | { mode: 'individual'; pattern: string; count: number };
export function codeText(c: CodeSpec, example?: string): string {
  if (c.mode === 'none') return 'automatisch (ohne Code)';
  if (c.mode === 'fixed') return `Code ${c.code}`;
  return `${c.count} Einzelcodes nach Muster ${c.pattern}${example ? ` (z. B. ${example})` : ''}`;
}
/** Hinweis, wenn ein fester Code beim Normalisieren verändert wurde (klein → groß). */
export const codeNote = (c: CodeSpec) => (c.mode === 'fixed' && c.typed && c.typed !== c.code ? ` (eingegeben „${c.typed}“, wird in Großbuchstaben angelegt; beim Einlösen ist Groß-/Kleinschreibung egal)` : '');
export function limitText(global: number | null | undefined, perCustomer: number | null | undefined): string {
  const p = [perCustomer ? `max. ${perCustomer}× pro Kunde` : '', global ? `insgesamt max. ${global}×` : ''].filter(Boolean);
  return p.length ? p.join(', ') : 'ohne Einlöse-Limit';
}

// ---------- Individuelle Codes (%s = Buchstabe, %d = Ziffer, wie in Shopware) ----------
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function patternCapacity(pattern: string): number {
  const s = (pattern.match(/%s/g) ?? []).length, d = (pattern.match(/%d/g) ?? []).length;
  return s + d ? 26 ** s * 10 ** d : 0;
}
export function validatePattern(pattern: string, count: number) {
  if (!/^[A-Za-z0-9_\-%]+$/.test(pattern) || /%(?![sd])/.test(pattern)) throw new Error('Code-Muster: nur Buchstaben, Ziffern, - und _ sowie Platzhalter %s (Buchstabe) und %d (Ziffer)');
  if (pattern.replace(/%[sd]/g, 'X').length > 40) throw new Error('Code-Muster ist zu lang (max. 40 Zeichen)');
  if (!Number.isInteger(count) || count < 1 || count > MAX_CODES) throw new Error(`Anzahl Einzelcodes: 1–${MAX_CODES}`);
  const cap = patternCapacity(pattern);
  if (!cap) throw new Error('Code-Muster braucht Platzhalter, z. B. "HERBST-%s%s%d%d"');
  if (cap < count * 20) throw new Error(`Code-Muster „${pattern}“ reicht nicht für ${count} sichere Codes (nur ${cap} Kombinationen) – mehr Platzhalter verwenden`);
}
export function generateCodes(pattern: string, count: number, taken: Set<string> = new Set(), rand: () => number = Math.random): string[] {
  const out = new Set<string>(); let guardN = 0;
  while (out.size < count) {
    if (++guardN > count * 50) throw new Error('Nicht genug freie Codes für dieses Muster');
    const c = pattern.toUpperCase().replace(/%S/g, () => LETTERS[Math.floor(rand() * 26)]).replace(/%D/g, () => String(Math.floor(rand() * 10)));
    if (!taken.has(c)) out.add(c);
  }
  return [...out];
}

// ---------- Regeln (Einschränkung auf Produkte/Kategorien) ----------
export interface RulePlan { id: string; name: string; productIds: string[]; categoryIds: string[]; promotionId: string }
export const RULE_PREFIX = 'Lotse:';
/** Beschreibung mit Promotion-ID – damit findet das Rückgängig-Machen einer Anlage auch Regeln späterer Änderungen. */
export const ruleDescription = (promotionId: string) => `Von Lotse für Promotion ${promotionId} angelegt (Rabatt nur auf diese Produkte/Kategorien).`;
/** Rule-Entität im Aufbau des Admins: orContainer → je Bedingung ein andContainer (Produkte ODER Kategorien). */
export function ruleEntity(r: RulePlan, id: () => string = newId) {
  const conds = [
    ...(r.productIds.length ? [{ type: 'cartLineItem', value: { operator: '=', identifiers: r.productIds } }] : []),
    ...(r.categoryIds.length ? [{ type: 'cartLineItemInCategory', value: { operator: '=', categoryIds: r.categoryIds } }] : []),
  ];
  return {
    id: r.id, name: r.name, priority: 1, description: ruleDescription(r.promotionId),
    conditions: [{ id: id(), type: 'orContainer', position: 0, children: conds.map((c, i) => ({ id: id(), type: 'andContainer', position: i, children: [{ id: id(), position: 0, ...c }] })) }],
  };
}
/** Liest Produkt-/Kategorie-Einschränkungen aus Regelbedingungen; andere Bedingungen nur als Typ. */
export function ruleRestriction(rules: SwEntity[] | undefined) {
  const productIds: string[] = [], categoryIds: string[] = [], other: string[] = [];
  for (const r of rules ?? []) {
    let known = false;
    for (const c of r.conditions ?? []) {
      if (c.type === 'cartLineItem' && Array.isArray(c.value?.identifiers)) { productIds.push(...c.value.identifiers); known = true; }
      else if (c.type === 'cartLineItemInCategory' && Array.isArray(c.value?.categoryIds)) { categoryIds.push(...c.value.categoryIds); known = true; }
      else if (!/Container$/.test(c.type ?? '')) other.push(c.type);
    }
    if (!known || other.length) other.push(`Regel „${r.name}“`);
  }
  return { productIds: [...new Set(productIds)], categoryIds: [...new Set(categoryIds)], other: [...new Set(other)] };
}
/** Regel so sichern, dass „create“ sie mit denselben IDs wiederherstellt (flache Bedingungen → Baum). */
export function ruleSnapshot(r: SwEntity): Record<string, unknown> {
  const conds: SwEntity[] = r.conditions ?? [];
  const node = (c: SwEntity): Record<string, unknown> => ({ id: c.id, type: c.type, position: c.position ?? 0, ...(c.value != null ? { value: c.value } : {}), children: conds.filter(x => x.parentId === c.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map(node) });
  return { name: r.name, priority: r.priority ?? 1, description: r.description ?? null, customFields: r.customFields ?? null, conditions: conds.filter(c => !c.parentId).map(node) };
}

// ---------- Rabatte ----------
export interface DiscountInput { scope?: 'cart' | 'delivery'; type: DiscountType; value: number; maxValue?: number | null; productIds?: string[]; categoryIds?: string[] }
export interface DiscountPlan { id: string; scope: Scope; type: DiscountType; value: number; maxValue: number | null; ruleId: string | null }
export function validateDiscount(d: DiscountInput): string[] {
  const warn: string[] = [], scope = d.scope ?? 'cart';
  if (!['percentage', 'absolute', 'fixed', 'fixed_unit'].includes(d.type)) throw new Error(`Rabattart „${d.type}“ unbekannt`);
  if (!(typeof d.value === 'number' && Number.isFinite(d.value))) throw new Error('Rabattwert fehlt');
  if (d.type === 'percentage' && !(d.value > 0 && d.value <= 100)) throw new Error('Prozent-Rabatt: Wert über 0 und höchstens 100');
  if (d.type === 'absolute' && !(d.value > 0)) throw new Error('Betrags-Rabatt: Wert über 0 €');
  if ((d.type === 'fixed' || d.type === 'fixed_unit') && !(d.value >= 0)) throw new Error('Festpreis: Wert ab 0 €');
  if (d.maxValue != null && (d.type !== 'percentage' || !(d.maxValue > 0))) throw new Error('Höchstbetrag (maxValue) nur bei Prozent-Rabatt und über 0 €');
  if (scope === 'delivery' && (d.productIds?.length || d.categoryIds?.length)) throw new Error('Versand-Rabatt kann nicht auf Produkte/Kategorien eingeschränkt werden');
  if (scope === 'delivery' && d.type === 'fixed_unit') throw new Error('Stückpreis (fixed_unit) gibt es nur für den Warenkorb');
  if (d.type === 'percentage' && d.value > 50 && !(scope === 'delivery')) warn.push(`Rabatt über 50 % (${pct(d.value)})`);
  if (d.type === 'percentage' && scope === 'cart' && !d.maxValue && d.value >= 30) warn.push('Ohne Höchstbetrag');
  return warn;
}
export function discountEntity(d: DiscountPlan, promotionId?: string) {
  return {
    id: d.id, ...(promotionId ? { promotionId } : {}), scope: d.scope, type: d.type, value: d.value, maxValue: d.maxValue, considerAdvancedRules: !!d.ruleId,
    // Shopware braucht diese Schlüssel, sobald Regeln greifen (sonst Fehler im Warenkorb) – Werte wie im Admin
    sorterKey: 'PRICE_ASC', applierKey: 'ALL', usageKey: 'ALL', discountRules: d.ruleId ? [{ id: d.ruleId }] : [],
  };
}
/** Bestehenden Rabatt so sichern, dass „create“ ihn exakt wiederherstellt (inkl. Regeln und Währungspreisen). */
export function discountSnapshot(d: SwEntity): Record<string, unknown> {
  return {
    promotionId: d.promotionId, scope: d.scope, type: d.type, value: d.value, maxValue: d.maxValue ?? null, considerAdvancedRules: !!d.considerAdvancedRules,
    sorterKey: d.sorterKey ?? null, applierKey: d.applierKey ?? null, usageKey: d.usageKey ?? null, pickerKey: d.pickerKey ?? null,
    discountRules: (d.discountRules ?? []).map((r: SwEntity) => ({ id: r.id })),
    promotionDiscountPrices: (d.promotionDiscountPrices ?? []).map((p: SwEntity) => ({ id: p.id, currencyId: p.currencyId, price: p.price })),
  };
}

// ---------- Vorschlag: Anlegen / Ändern ----------
export interface PromotionArgs {
  id?: string; reason?: string; name?: string; active?: boolean; validFrom?: string | null; validUntil?: string | null; salesChannelIds?: string[];
  code?: { mode: 'none' | 'fixed' | 'individual'; code?: string; pattern?: string; count?: number };
  discounts?: DiscountInput[]; priority?: number; exclusive?: boolean; maxUsesGlobal?: number | null; maxUsesPerCustomer?: number | null;
}
export interface PromotionCore {
  id: string; name: string; active: boolean; validFrom: string | null; validUntil: string | null; priority: number; exclusive: boolean;
  maxRedemptionsGlobal: number | null; maxRedemptionsPerCustomer: number | null; useCodes: boolean; code: string | null; useIndividualCodes: boolean; individualCodePattern: string | null;
}
export interface CreatePayload { mode: 'create'; promotion: PromotionCore; salesChannelIds: string[]; discounts: DiscountPlan[]; rules: RulePlan[]; codeCount: number }
/** afterRaw eines Änderungs-Items (Update): nur die gewählten Teile werden geschrieben */
export interface UpdatePart { patch?: Record<string, unknown>; discounts?: DiscountPlan[]; rules?: RulePlan[]; salesChannelIds?: string[]; codeCount?: number; codePattern?: string }

/** Promotion samt Kanälen und Rabatten – Einzelcodes legt der Applier danach in Blöcken an. */
export function promotionEntity(p: CreatePayload, id: () => string = newId) {
  return {
    ...p.promotion, preventCombination: p.promotion.exclusive, useSetGroups: false,
    salesChannels: p.salesChannelIds.map(s => ({ id: id(), salesChannelId: s, priority: 1 })),
    discounts: p.discounts.map(d => discountEntity(d)),
  };
}

function normCode(c: PromotionArgs['code']): CodeSpec | undefined {
  if (!c) return undefined;
  if (c.mode === 'none') return { mode: 'none' };
  if (c.mode === 'fixed') {
    const typed = String(c.code ?? '').trim(), code = typed.toUpperCase();
    if (!/^[A-Z0-9_\-]{3,40}$/.test(code)) throw new Error('Code: 3–40 Zeichen, nur Buchstaben, Ziffern, - und _');
    return { mode: 'fixed', code, typed };
  }
  const pattern = String(c.pattern ?? '').trim().toUpperCase().replace(/%S/g, '%s').replace(/%D/g, '%d'), count = c.count ?? 0;
  validatePattern(pattern, count);
  return { mode: 'individual', pattern, count };
}
const intOrNull = (v: number | null | undefined, label: string) => {
  if (v == null || v === 0) return null;
  if (!Number.isInteger(v) || v < 0) throw new Error(`${label}: ganze Zahl ≥ 1 (oder null = unbegrenzt)`);
  return v;
};
const nameOf = (e: SwEntity | undefined) => e?.translated?.name ?? e?.name ?? e?.productNumber ?? e?.id;
const listNames = (ids: string[], by: Record<string, string>, max = 4) => { const n = ids.map(i => by[i] ?? i); return n.length > max ? `${n.slice(0, max).join(', ')} +${n.length - max}` : n.join(', '); };

export function promotionStatus(p: { active?: boolean; validFrom?: string | null; validUntil?: string | null; maxRedemptionsGlobal?: number | null; orderCount?: number | null }, now = Date.now()): 'inaktiv' | 'geplant' | 'abgelaufen' | 'ausgeschöpft' | 'läuft' {
  if (!p.active) return 'inaktiv';
  if (p.validFrom && ms(p.validFrom)! > now) return 'geplant';
  if (p.validUntil && ms(p.validUntil)! < now) return 'abgelaufen';
  if (p.maxRedemptionsGlobal && (p.orderCount ?? 0) >= p.maxRedemptionsGlobal) return 'ausgeschöpft';
  return 'läuft';
}
/** Filter für den Status – nur Felder der Promotion (keine Kunden-/Bestellbezüge). */
export function statusFilter(status: 'running' | 'scheduled' | 'expired' | 'inactive' | 'all' | undefined, now: string): Record<string, unknown>[] {
  const open = (field: string, op: 'lte' | 'gte') => ({ type: 'multi', operator: 'or', queries: [{ type: 'equals', field, value: null }, { type: 'range', field, parameters: { [op]: now } }] });
  switch (status) {
    case 'running': return [{ type: 'equals', field: 'active', value: true }, open('validFrom', 'lte'), open('validUntil', 'gte')];
    case 'scheduled': return [{ type: 'equals', field: 'active', value: true }, { type: 'range', field: 'validFrom', parameters: { gt: now } }];
    case 'expired': return [{ type: 'range', field: 'validUntil', parameters: { lt: now } }];
    case 'inactive': return [{ type: 'equals', field: 'active', value: false }];
    default: return [];
  }
}
/** Shopware wendet nur aktive Promotionen im Zeitraum an – ein inaktiver Entwurf startet nie von selbst. */
export function draftWarning(active: boolean, from: string | null, until: string | null, now: number): string[] {
  if (active || (!from && !until) || (until && ms(until)! < now)) return [];
  if (from && ms(from)! > now) return [`Inaktiv: startet am ${fmtDay(from)} NICHT automatisch; für einen geplanten Start aktiv anlegen`];
  return ['Inaktiv: läuft im Zeitraum NICHT automatisch; zum Start aktiv setzen'];
}
export function activeText(active: boolean, from: string | null, now: number): string {
  if (!active) return 'inaktiv (Entwurf)';
  return from && ms(from)! > now ? `aktiv, geplant: startet automatisch am ${fmtDay(from)}` : 'sofort aktiv';
}
const overlaps = (a: [number | null, number | null], b: [number | null, number | null]) => (a[0] ?? -Infinity) <= (b[1] ?? Infinity) && (b[0] ?? -Infinity) <= (a[1] ?? Infinity);

/** Alle aktiven, nicht abgelaufenen Promotionen (seitenweise, mit Kanälen). */
async function activePromotions(ro: ShopReader, now: string): Promise<SwEntity[]> {
  const out: SwEntity[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ro.search('promotion', { limit: 100, page, 'total-count-mode': 1, filter: [{ type: 'equals', field: 'active', value: true }, { type: 'multi', operator: 'or', queries: [{ type: 'equals', field: 'validUntil', value: null }, { type: 'range', field: 'validUntil', parameters: { gte: now } }] }], associations: { salesChannels: {} } });
    out.push(...r.data);
    if (r.data.length < 100 || out.length >= (r.total ?? 0)) break;
  }
  return out;
}
/** Überschneidung in Zeitraum und Verkaufskanal (Hinweis, keine Sperre); draft = Promotion bleibt vorerst inaktiv. */
export function overlapText(pool: SwEntity[], selfId: string | null, period: [string | null, string | null], channels: string[], draft = false): string[] {
  const hits = pool.filter(p => p.id !== selfId && overlaps([ms(p.validFrom), ms(p.validUntil)], [ms(period[0]), ms(period[1])]) && (p.salesChannels ?? []).some((s: SwEntity) => channels.includes(s.salesChannelId)));
  if (!hits.length) return [];
  const t = hits.slice(0, 3).map(p => `„${nameOf(p)}“ (${p.useCodes ? 'mit Code' : 'automatisch'})`).join(', ');
  return [`${draft ? 'Bei Aktivierung: ' : ''}Überschneidung mit ${hits.length} aktiven Promotion(en): ${t}${hits.length > 3 ? ' …' : ''}`];
}
const overlapWarnings = async (ro: ShopReader, selfId: string | null, period: [string | null, string | null], channels: string[], now: string, draft = false) => overlapText(await activePromotions(ro, now), selfId, period, channels, draft);

interface Ctx { channels: Record<string, string>; products: Record<string, string>; categories: Record<string, string> }
async function loadCtx(ro: ShopReader, productIds: string[], categoryIds: string[]): Promise<Ctx> {
  const sc = await ro.salesChannels();
  const prods = productIds.length ? (await ro.search('product', { ids: productIds, limit: productIds.length })).data : [];
  const cats = categoryIds.length ? (await ro.search('category', { ids: categoryIds, limit: categoryIds.length })).data : [];
  return {
    channels: Object.fromEntries(sc.map(s => [s.id, nameOf(s)])),
    products: Object.fromEntries(prods.map(p => [p.id, `${nameOf(p)}${p.productNumber ? ` (${p.productNumber})` : ''}`])),
    categories: Object.fromEntries(cats.map(c => [c.id, nameOf(c)])),
  };
}
const targetOf = (productIds: string[], categoryIds: string[], ctx: Ctx) => [categoryIds.length ? listNames(categoryIds, ctx.categories) : '', productIds.length ? listNames(productIds, ctx.products) : ''].filter(Boolean).join(' + ') || null;

/** Rabatte prüfen und planen (je eingeschränktem Rabatt eine neue Regel „Lotse: …“). */
function planDiscounts(list: DiscountInput[], promoName: string, promotionId: string, ctx: Ctx, id: () => string) {
  if (!list.length) throw new Error('Mindestens ein Rabatt nötig');
  if (list.length > MAX_DISCOUNTS) throw new Error(`Höchstens ${MAX_DISCOUNTS} Rabatte pro Promotion`);
  const plans: DiscountPlan[] = [], rules: RulePlan[] = [], texts: string[] = [], warn: string[] = [];
  for (const d of list) {
    warn.push(...validateDiscount(d));
    const productIds = [...new Set(d.productIds ?? [])], categoryIds = [...new Set(d.categoryIds ?? [])];
    const missing = [...productIds.filter(p => !ctx.products[p]), ...categoryIds.filter(c => !ctx.categories[c])];
    if (missing.length) throw new Error(`Produkt/Kategorie nicht gefunden: ${missing.join(', ')}`);
    if (productIds.length + categoryIds.length > 500) throw new Error('Höchstens 500 Produkte/Kategorien je Rabatt');
    const target = targetOf(productIds, categoryIds, ctx);
    let ruleId: string | null = null;
    if (target) { ruleId = id(); rules.push({ id: ruleId, name: `${RULE_PREFIX} ${promoName}, ${target}`.slice(0, 255), productIds, categoryIds, promotionId }); }
    const plan: DiscountPlan = { id: id(), scope: d.scope ?? 'cart', type: d.type, value: d.value, maxValue: d.maxValue ?? null, ruleId };
    plans.push(plan); texts.push(discountText({ ...plan, target }));
  }
  return { plans, rules, texts, warn: [...new Set(warn)] };
}

async function assertCodeFree(ro: ShopReader, code: string, selfId: string | null) {
  const a = (await ro.search('promotion', { limit: 5, filter: [{ type: 'equals', field: 'code', value: code }] })).data.filter(p => p.id !== selfId);
  if (a.length) throw new Error(`Code ${code} ist schon bei Promotion „${nameOf(a[0])}“ vergeben`);
  const b = (await ro.search('promotion-individual-code', { limit: 1, filter: [{ type: 'equals', field: 'code', value: code }] })).data;
  if (b.length) throw new Error(`Code ${code} existiert schon als Einzelcode einer anderen Promotion`);
}
/** Shopware lehnt ein doppeltes Einzelcode-Muster ab (PROMOTION_DUPLICATE_PATTERN_VIOLATION) – vorab prüfen. */
async function assertPatternFree(ro: ShopReader, pattern: string, selfId: string | null) {
  const a = (await ro.search('promotion', { limit: 5, filter: [{ type: 'equals', field: 'individualCodePattern', value: pattern }] })).data.filter(p => p.id !== selfId);
  if (a.length) throw new Error(`Code-Muster ${pattern} wird schon von Promotion „${nameOf(a[0])}“ verwendet – anderes Muster wählen`);
}

export async function buildPromotionChangeSet(ro: ShopReader, a: PromotionArgs, opts: { now?: Date; id?: () => string } = {}): Promise<{ cs: ChangeSet; payload: CreatePayload | { mode: 'update'; promotionId: string } }> {
  const now = (opts.now ?? new Date()), nowIso = now.toISOString(), id = opts.id ?? newId;
  const code = normCode(a.code);
  const validFrom = a.validFrom === undefined ? undefined : a.validFrom === null || a.validFrom === '' ? null : parseDay(a.validFrom);
  const validUntil = a.validUntil === undefined ? undefined : a.validUntil === null || a.validUntil === '' ? null : parseDay(a.validUntil, true);
  // Bestehende Promotion (beim Ändern) – ihre Einschränkungen werden für den Vorher-Text mit benannt
  const cur = a.id ? await ro.get('promotion', a.id, { associations: { salesChannels: {}, discounts: { associations: { discountRules: { associations: { conditions: {} } } } } } }) : null;
  if (a.id && !cur) throw new Error('Promotion nicht gefunden');
  const curRestr = ((cur?.discounts ?? []) as SwEntity[]).map(d => ruleRestriction(d.discountRules));
  const productIds = [...new Set([...(a.discounts ?? []).flatMap(d => d.productIds ?? []), ...curRestr.flatMap(r => r.productIds)])];
  const categoryIds = [...new Set([...(a.discounts ?? []).flatMap(d => d.categoryIds ?? []), ...curRestr.flatMap(r => r.categoryIds)])];
  const ctx = await loadCtx(ro, productIds, categoryIds);
  const unknownSc = (a.salesChannelIds ?? []).filter(s => !ctx.channels[s]);
  if (unknownSc.length) throw new Error(`Verkaufskanal nicht gefunden: ${unknownSc.join(', ')}`);
  const priority = a.priority ?? undefined;
  if (priority != null && (!Number.isInteger(priority) || priority < 0)) throw new Error('Priorität: ganze Zahl ≥ 0');
  const maxG = a.maxUsesGlobal === undefined ? undefined : intOrNull(a.maxUsesGlobal, 'Max. Einlösungen gesamt');
  const maxC = a.maxUsesPerCustomer === undefined ? undefined : intOrNull(a.maxUsesPerCustomer, 'Max. Einlösungen pro Kunde');

  if (!cur) {
    // ---- Anlegen ----
    const name = String(a.name ?? '').trim();
    if (!name || name.length > 255) throw new Error('Name fehlt (max. 255 Zeichen)');
    if (!a.discounts?.length) throw new Error('discounts fehlt – Rabatt (Art, Wert, Umfang) per ask_user klären');
    if (!code) throw new Error('code fehlt – Modus none/fixed/individual angeben');
    const from = validFrom ?? null, until = validUntil ?? null;
    if (from && until && ms(until)! <= ms(from)!) throw new Error('Enddatum liegt vor dem Startdatum');
    if (until && ms(until)! < now.getTime()) throw new Error('Enddatum liegt in der Vergangenheit');
    const salesChannelIds = a.salesChannelIds?.length ? [...new Set(a.salesChannelIds)] : (await ro.salesChannels()).filter(s => s.domains?.length && s.active !== false).map(s => s.id);
    if (!salesChannelIds.length) throw new Error('Kein Verkaufskanal gefunden');
    if (code.mode === 'fixed') await assertCodeFree(ro, code.code, null);
    if (code.mode === 'individual') await assertPatternFree(ro, code.pattern, null);
    const promotionId = id();
    const dp = planDiscounts(a.discounts, name, promotionId, ctx, id);
    if (a.active == null) throw new Error('active fehlt – per ask_user klären: aktiv (sofort bzw. geplant ab Startdatum) oder inaktiver Entwurf');
    const active = a.active, exclusive = a.exclusive ?? false;
    const warn = [...dp.warn, ...draftWarning(active, from, until, now.getTime())];
    if (!until) warn.push('Kein Enddatum');
    if (active && code.mode === 'none' && !dp.rules.length) warn.push('Gilt automatisch für jeden Warenkorb');
    warn.push(...await overlapWarnings(ro, null, [from, until], salesChannelIds, nowIso, !active));
    const example = code.mode === 'individual' ? generateCodes(code.pattern, 1)[0] : undefined;
    const summary = [dp.texts.join(' + '), codeText(code, example), fmtPeriod(from, until), limitText(maxG, maxC)].join(', ');
    const promotion: PromotionCore = {
      id: promotionId, name, active, validFrom: from, validUntil: until, priority: priority ?? 1, exclusive, maxRedemptionsGlobal: maxG ?? null, maxRedemptionsPerCustomer: maxC ?? null,
      useCodes: code.mode !== 'none', code: code.mode === 'fixed' ? code.code : null, useIndividualCodes: code.mode === 'individual', individualCodePattern: code.mode === 'individual' ? code.pattern : null,
    };
    const items: ChangeItem[] = [];
    const info = (fieldLabel: string, after: string, w: string[] = []): ChangeItem => ({ id: `i${items.length}`, entity: 'info', entityId: promotionId, label: name, fieldLabel, before: '–', after, warn: w });
    items.push(info('Zusammenfassung', summary, warn));
    dp.texts.forEach((t, i) => items.push(info(dp.texts.length > 1 ? `Rabatt ${i + 1}` : 'Rabatt', t)));
    for (const r of dp.rules) items.push(info('Neue Regel', `„${r.name}“ (${[r.categoryIds.length ? `${r.categoryIds.length} Kategorie(n)` : '', r.productIds.length ? `${r.productIds.length} Produkt(e)` : ''].filter(Boolean).join(', ')})`));
    items.push(info('Zeitraum', fmtPeriod(from, until)));
    items.push(info('Code', codeText(code, example) + codeNote(code)));
    items.push(info('Verkaufskanäle', listNames(salesChannelIds, ctx.channels)));
    items.push(info('Limits', limitText(maxG, maxC)));
    items.push(info('Status & Kombination', `${activeText(active, from, now.getTime())} · Priorität ${promotion.priority} · ${exclusive ? 'nicht mit anderen Promotionen kombinierbar' : 'kombinierbar'}`));
    const payload: CreatePayload = { mode: 'create', promotion, salesChannelIds, discounts: dp.plans, rules: dp.rules, codeCount: code.mode === 'individual' ? code.count : 0 };
    return { cs: { id: id(), kind: KIND, entity: 'promotion', noun: NOUN, applyLabel: 'Promotion anlegen', title: `Neue Promotion: ${name}`, reason: a.reason ?? null, items, skipped: [], atomic: true }, payload };
  }

  // ---- Ändern ----
  const label = nameOf(cur) as string, promotionId = cur.id as string, items: ChangeItem[] = [];
  const add = (field: string, fieldLabel: string, before: string, after: string, afterRaw: UpdatePart, warn: string[] = []) => items.push({ id: `${promotionId}:${field}`, entity: 'promotion', entityId: promotionId, label, field, fieldLabel, before, after, afterRaw, warn });
  const curDiscText = ((cur.discounts ?? []) as SwEntity[]).map((d, i) => discountText({ scope: d.scope, type: d.type, value: d.value, maxValue: d.maxValue, target: [targetOf(curRestr[i].productIds, curRestr[i].categoryIds, ctx), ...curRestr[i].other].filter(Boolean).join(' + ') || null })).join(' + ') || 'kein Rabatt';
  const finalFrom = validFrom === undefined ? cur.validFrom ?? null : validFrom, finalUntil = validUntil === undefined ? cur.validUntil ?? null : validUntil;
  const finalSc: string[] = a.salesChannelIds?.length ? [...new Set(a.salesChannelIds)] : (cur.salesChannels ?? []).map((s: SwEntity) => s.salesChannelId);
  const finalActive = a.active ?? !!cur.active;

  if (a.name != null && a.name.trim() && a.name.trim() !== cur.name) add('name', 'Name', cur.name, a.name.trim(), { patch: { name: a.name.trim() } });
  if (a.active != null && a.active !== !!cur.active) add('active', 'Aktiv', cur.active ? 'ja' : 'nein', a.active ? 'ja' : 'nein', { patch: { active: a.active } }, a.active ? [] : ['Wird deaktiviert']);
  const fromChanged = validFrom !== undefined && ms(validFrom) !== ms(cur.validFrom), untilChanged = validUntil !== undefined && ms(validUntil) !== ms(cur.validUntil);
  if (fromChanged || untilChanged) {
    if (finalFrom && finalUntil && ms(finalUntil)! <= ms(finalFrom)!) throw new Error('Enddatum liegt vor dem Startdatum');
    const w = [...(!finalUntil ? ['Kein Enddatum'] : []), ...(finalUntil && ms(finalUntil)! < now.getTime() ? ['Enddatum in der Vergangenheit: Promotion endet damit'] : [])];
    add('period', 'Zeitraum', fmtPeriod(cur.validFrom, cur.validUntil), fmtPeriod(finalFrom, finalUntil), { patch: { ...(fromChanged ? { validFrom } : {}), ...(untilChanged ? { validUntil } : {}) } }, w);
  }
  if (code) {
    const curCode: CodeSpec = !cur.useCodes ? { mode: 'none' } : cur.useIndividualCodes ? { mode: 'individual', pattern: cur.individualCodePattern ?? '?', count: 0 } : { mode: 'fixed', code: cur.code ?? '' };
    const before = curCode.mode === 'individual' ? `Einzelcodes nach Muster ${curCode.pattern}` : codeText(curCode);
    const same = code.mode !== 'individual' && code.mode === curCode.mode && (code.mode === 'none' || code.code === (curCode as { code: string }).code);
    if (!same) {
      if (code.mode === 'fixed') await assertCodeFree(ro, code.code, promotionId);
      if (code.mode === 'individual') await assertPatternFree(ro, code.pattern, promotionId);
      const w: string[] = [];
      const keepsOld = code.mode === 'individual' && curCode.mode === 'individual' && code.pattern !== curCode.pattern;
      if (cur.orderCount > 0 && code.mode !== 'individual') w.push(`Bisheriger Code wurde schon ${cur.orderCount}× eingelöst, er gilt danach nicht mehr`);
      if (code.mode === 'none' && finalActive) w.push('Gilt danach automatisch ohne Code');
      const patch = { useCodes: code.mode !== 'none', useIndividualCodes: code.mode === 'individual', ...(code.mode === 'fixed' ? { code: code.code } : {}), ...(code.mode === 'individual' ? { individualCodePattern: code.pattern } : {}) };
      const example = code.mode === 'individual' ? generateCodes(code.pattern, 1)[0] : undefined;
      add('code', 'Code', before, code.mode === 'individual' ? `+ ${code.count} neue Einzelcodes nach Muster ${code.pattern} (z. B. ${example})${keepsOld ? '; die bisherigen Einzelcodes bleiben gültig' : ''}` : codeText(code) + codeNote(code), { patch, ...(code.mode === 'individual' ? { codeCount: code.count, codePattern: code.pattern } : {}) }, w);
    }
  }
  if (a.discounts) {
    const dp = planDiscounts(a.discounts, a.name?.trim() || label, promotionId, ctx, id);
    add('discounts', 'Rabatte', curDiscText, dp.texts.join(' + '), { discounts: dp.plans, rules: dp.rules }, [...dp.warn, ...(cur.orderCount > 0 ? [`Schon ${cur.orderCount}× eingelöst, gilt nur für künftige Bestellungen`] : [])]);
  }
  if (a.salesChannelIds?.length) {
    const before = (cur.salesChannels ?? []).map((s: SwEntity) => s.salesChannelId);
    if (before.length !== finalSc.length || finalSc.some(s => !before.includes(s))) add('salesChannels', 'Verkaufskanäle', listNames(before, ctx.channels) || '–', listNames(finalSc, ctx.channels), { salesChannelIds: finalSc });
  }
  const limitPatch: Record<string, unknown> = {};
  if (maxG !== undefined && maxG !== (cur.maxRedemptionsGlobal ?? null)) limitPatch.maxRedemptionsGlobal = maxG;
  if (maxC !== undefined && maxC !== (cur.maxRedemptionsPerCustomer ?? null)) limitPatch.maxRedemptionsPerCustomer = maxC;
  if (Object.keys(limitPatch).length) add('limits', 'Limits', limitText(cur.maxRedemptionsGlobal, cur.maxRedemptionsPerCustomer), limitText(maxG === undefined ? cur.maxRedemptionsGlobal : maxG, maxC === undefined ? cur.maxRedemptionsPerCustomer : maxC), { patch: limitPatch });
  if (priority != null && priority !== cur.priority) add('priority', 'Priorität', String(cur.priority), String(priority), { patch: { priority } });
  const curExcl = !!(cur.preventCombination || cur.exclusive);
  if (a.exclusive != null && a.exclusive !== curExcl) add('exclusive', 'Kombinierbar', curExcl ? 'nein (exklusiv)' : 'ja', a.exclusive ? 'nein (exklusiv)' : 'ja', { patch: { exclusive: a.exclusive, preventCombination: a.exclusive } });
  if (!items.length) throw new Error('Keine Änderung nötig – alle Angaben entsprechen dem aktuellen Stand');
  if (items.some(i => ['active', 'period', 'salesChannels'].includes(i.field!))) {
    const w = [...draftWarning(finalActive, finalFrom, finalUntil, now.getTime()), ...await overlapWarnings(ro, promotionId, [finalFrom, finalUntil], finalSc, nowIso, !finalActive)];
    if (w.length) items[0].warn.push(...w);
  }
  return { cs: { id: id(), kind: KIND, entity: 'promotion', noun: NOUN, applyLabel: `${items.length} ${items.length === 1 ? 'Änderung' : 'Änderungen'} übernehmen`, title: `Promotion ändern: ${label}`, reason: a.reason ?? null, items, skipped: [], atomic: false }, payload: { mode: 'update', promotionId } };
}

// ---------- Status (Massenaktion) ----------
export type StatusAction = 'activate' | 'deactivate' | 'end';
export async function buildStatusChangeSet(ro: ShopReader, a: { ids: string[]; action: StatusAction; reason?: string }, now = new Date()): Promise<ChangeSet> {
  const ids = [...new Set(a.ids ?? [])];
  if (!ids.length) throw new Error('ids ist leer');
  if (ids.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} Promotionen pro Änderungsset – bitte aufteilen.`);
  const rows = (await ro.search('promotion', { ids, limit: ids.length, associations: { salesChannels: {} } })).data, by = Object.fromEntries(rows.map(r => [r.id, r]));
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = []; let unchanged = 0;
  const t = now.getTime(), nowIso = now.toISOString();
  // Beim Aktivieren gegen alle aktiven und die mit aktivierten Promotionen prüfen
  const pool = a.action === 'activate' ? [...await activePromotions(ro, nowIso), ...rows.filter(r => !r.active).map(r => ({ ...r, active: true }))] : [];
  for (const id of ids) {
    const p = by[id]; if (!p) { skipped.push({ id, reason: 'nicht gefunden' }); continue; }
    const st = promotionStatus(p, t), before = `${st}${p.validUntil ? ` · bis ${fmtDay(p.validUntil)}` : ''}`, warn: string[] = [];
    let patch: Record<string, unknown>, after: string;
    if (a.action === 'activate') {
      if (p.active) { unchanged++; continue; }
      patch = { active: true }; after = promotionStatus({ ...p, active: true }, t);
      if (after === 'abgelaufen') warn.push('Zeitraum ist abgelaufen: wirkt erst mit neuem Enddatum');
      if (!p.validUntil) warn.push('Kein Enddatum');
      if (!p.useCodes) warn.push('Gilt automatisch ohne Code');
      warn.push(...overlapText(pool, p.id, [p.validFrom ?? null, p.validUntil ?? null], (p.salesChannels ?? []).map((s: SwEntity) => s.salesChannelId)));
    } else if (a.action === 'deactivate') {
      if (!p.active) { unchanged++; continue; }
      patch = { active: false }; after = 'inaktiv';
      if (p.useCodes && st === 'läuft') warn.push('Ausgegebene Codes funktionieren dann nicht mehr');
    } else {
      if (!p.active && p.validUntil && ms(p.validUntil)! <= t) { unchanged++; continue; }
      patch = { active: false, validUntil: nowIso }; after = `beendet · bis ${fmtDay(nowIso)}`;
      if (st === 'läuft' && p.useCodes) warn.push('Ausgegebene Codes funktionieren dann nicht mehr');
    }
    items.push({ id, entity: 'promotion', entityId: id, label: nameOf(p), field: 'status', fieldLabel: 'Status', before, after, afterRaw: patch, warn });
  }
  if (!items.length) throw new Error(`Keine Änderung nötig (${unchanged} schon im Zielzustand, ${skipped.length} nicht gefunden)`);
  const verb = { activate: 'aktivieren', deactivate: 'deaktivieren', end: 'beenden' }[a.action];
  return { id: newId(), kind: STATUS_KIND, entity: 'promotion', noun: NOUN, applyLabel: `${items.length} ${items.length === 1 ? 'Promotion' : 'Promotionen'} ${verb}`, title: `Promotionen ${verb}`, reason: a.reason ?? null, items, skipped, unchanged, atomic: false };
}

// ================= EXECUTOR =================
const PROMO_KEYS = ['name', 'active', 'validFrom', 'validUntil', 'priority', 'exclusive', 'preventCombination', 'maxRedemptionsGlobal', 'maxRedemptionsPerCustomer', 'useCodes', 'code', 'useIndividualCodes', 'individualCodePattern'];
const chunks = <T,>(l: T[], n: number) => Array.from({ length: Math.ceil(l.length / n) }, (_, i) => l.slice(i * n, i * n + n));
/** Codes erzeugen, die im Shop noch nicht vorkommen (weder als Einzelcode noch als fester Code). */
async function freshCodes(swW: Shopware, pattern: string, count: number): Promise<string[]> {
  const taken = new Set<string>(); let codes = generateCodes(pattern, count, taken);
  for (let round = 0; round < 5; round++) {
    const clash: string[] = [];
    for (const part of chunks(codes, 500)) {
      for (const e of ['promotion-individual-code', 'promotion'] as const) clash.push(...(await swW.search(e, { limit: part.length, filter: [{ type: 'equalsAny', field: 'code', value: part }], includes: { [e.replace(/-/g, '_')]: ['code'] } })).data.map(x => x.code));
    }
    if (!clash.length) return codes;
    clash.forEach(c => taken.add(c));
    const keep = codes.filter(c => !taken.has(c)); keep.forEach(c => taken.add(c));
    codes = [...keep, ...generateCodes(pattern, count - keep.length, taken)];
  }
  throw new Error('Konnte keine freien Codes erzeugen – Muster mit mehr Platzhaltern wählen');
}
const syncDelete = (entity: string, ids: string[]): UndoOp => ({ op: 'req', entity, id: ids[0] ?? '', method: 'POST', path: '/_action/sync', body: [{ key: 'lotse-undo', action: 'delete', entity, payload: ids.map(id => ({ id })) }] });
/** Undo einer Anlage: alle Lotse-Regeln dieser Promotion löschen – auch die aus späteren Rabatt-Änderungen (per Kriterium statt fester IDs). */
export const promotionRulesDelete = (promotionId: string): UndoOp => ({ op: 'req', entity: 'rule', id: promotionId, method: 'POST', path: '/_action/sync', body: [{ key: 'lotse-undo-rules', action: 'delete', entity: 'rule', criteria: [{ type: 'prefix', field: 'name', value: RULE_PREFIX }, { type: 'contains', field: 'description', value: promotionId }] }] });
/** Einzelcodes in Blöcken per Sync anlegen (große Mengen nicht in einem Request). */
async function insertCodes(swW: Shopware, promotionId: string, pattern: string, count: number, undo: UndoOp[] = []) {
  const codes = await freshCodes(swW, pattern, count), rows = codes.map(code => ({ id: newId(), promotionId, code }));
  for (const part of chunks(rows, 1000)) {
    await swW.req('POST', '/_action/sync', [{ key: 'lotse-codes', action: 'upsert', entity: 'promotion_individual_code', payload: part }]);
    undo.push(syncDelete('promotion_individual_code', part.map(r => r.id)));
  }
  return undo;
}

async function applyCreate(swW: Shopware, cs: ChangeSet, p: CreatePayload, ctx?: ApplyCtx): Promise<ApplyResult> {
  const undo = trackedUndo(ctx, cs.items.length), id = p.promotion.id; // jeder Schritt sofort gesichert: ein Absturz mittendrin verliert kein Rückgängig
  try {
    for (const r of p.rules) { await swW.create('rule', ruleEntity(r)); undo.push({ op: 'delete', entity: 'rule', id: r.id }); }
    await swW.create('promotion', promotionEntity(p)); undo.push({ op: 'delete', entity: 'promotion', id });
    if (p.codeCount) await insertCodes(swW, id, p.promotion.individualCodePattern!, p.codeCount); // Codes hängen per Cascade an der Promotion
  } catch (e) { await undoOps(swW, undo); return { results: [], undo: [], error: errMsg(e) }; }
  // Rückwärts ausgeführt: erst Promotion (samt Rabatten, Codes, Kanälen), dann ihre Regeln
  return { results: cs.items.map(i => ({ itemId: i.id, ok: true })), undo: [promotionRulesDelete(id), { op: 'delete', entity: 'promotion', id }] };
}
/** Alte Lotse-Regeln nach dem Ersetzen der Rabatte entfernen – Shopware verweigert das Löschen, solange sie noch verwendet werden (dann bleiben sie). */
async function dropOrphanRules(swW: Shopware, ruleIds: string[], undo: UndoOp[]) {
  if (!ruleIds.length) return;
  const rules = (await swW.search('rule', { ids: ruleIds, limit: ruleIds.length, associations: { conditions: {} } })).data.filter(r => String(r.name ?? '').startsWith(RULE_PREFIX));
  for (const r of rules) {
    try { await swW.req('DELETE', `/rule/${r.id}`); } catch { continue; }
    undo.push({ op: 'create', entity: 'rule', id: r.id, data: ruleSnapshot(r) });
  }
}

/** Ändern als Einheit: entweder alle gewählten Teile oder (bei Fehler) nichts – bereits Geschriebenes wird zurückgerollt. */
async function applyUpdate(swW: Shopware, cs: ChangeSet, promotionId: string, selected: Set<string>, ctx?: ApplyCtx): Promise<ApplyResult> {
  const its = cs.items.filter(i => selected.has(i.id)), parts = its.map(i => i.afterRaw as UpdatePart), undo = trackedUndo(ctx, its.length);
  try {
    const cur = await swW.get('promotion', promotionId, { associations: { salesChannels: {}, discounts: { associations: { discountRules: {}, promotionDiscountPrices: {} } } } });
    if (!cur) throw new Error('Promotion nicht mehr vorhanden');
    const patch = Object.assign({}, ...parts.map(p => p.patch ?? {})) as Record<string, unknown>;
    if (Object.keys(patch).length) {
      await swW.update('promotion', promotionId, patch);
      undo.push({ op: 'patch', entity: 'promotion', id: promotionId, data: Object.fromEntries(Object.keys(patch).filter(k => PROMO_KEYS.includes(k)).map(k => [k, cur[k] ?? null])) });
    }
    const dPart = parts.find(p => p.discounts);
    if (dPart) {
      for (const r of dPart.rules ?? []) { await swW.create('rule', ruleEntity(r)); undo.push({ op: 'delete', entity: 'rule', id: r.id }); }
      for (const d of cur.discounts ?? []) { await swW.req('DELETE', `/promotion-discount/${d.id}`); undo.push({ op: 'create', entity: 'promotion-discount', id: d.id, data: discountSnapshot(d) }); }
      for (const d of dPart.discounts!) { await swW.create('promotion-discount', discountEntity(d, promotionId)); undo.push({ op: 'delete', entity: 'promotion-discount', id: d.id }); }
      const newRules = new Set((dPart.rules ?? []).map(r => r.id));
      await dropOrphanRules(swW, [...new Set<string>((cur.discounts ?? []).flatMap((d: SwEntity) => (d.discountRules ?? []).map((r: SwEntity) => r.id as string)))].filter(r => !newRules.has(r)), undo);
    }
    const sPart = parts.find(p => p.salesChannelIds);
    if (sPart) {
      const old: SwEntity[] = cur.salesChannels ?? [], keep = new Set(sPart.salesChannelIds);
      for (const s of old.filter(s => !keep.has(s.salesChannelId))) { await swW.req('DELETE', `/promotion-sales-channel/${s.id}`); undo.push({ op: 'create', entity: 'promotion-sales-channel', id: s.id, data: { promotionId, salesChannelId: s.salesChannelId, priority: s.priority ?? 1 } }); }
      for (const sc of sPart.salesChannelIds!.filter(sc => !old.some(s => s.salesChannelId === sc))) { const id = newId(); await swW.create('promotion-sales-channel', { id, promotionId, salesChannelId: sc, priority: 1 }); undo.push({ op: 'delete', entity: 'promotion-sales-channel', id }); }
    }
    const cPart = parts.find(p => p.codeCount);
    if (cPart) await insertCodes(swW, promotionId, cPart.codePattern!, cPart.codeCount!, undo);
  } catch (e) {
    const rb = await undoOps(swW, undo);
    return { results: its.map(i => ({ itemId: i.id, ok: false, error: errMsg(e) })), undo: [], error: `${errMsg(e)}${rb.every(r => r.ok) ? '; nichts geändert (zurückgerollt)' : '; Zurückrollen unvollständig, bitte prüfen'}` };
  }
  return { results: its.map(i => ({ itemId: i.id, ok: true })), undo };
}

registerApplier(KIND, (swW, cs, payload, selected, ctx) => {
  const p = payload as CreatePayload | { mode: 'update'; promotionId: string };
  return p.mode === 'create' ? applyCreate(swW, cs, p, ctx) : applyUpdate(swW, cs, p.promotionId, selected, ctx);
});
registerApplier(STATUS_KIND, (swW, cs, _payload, selected, ctx) => applyEach(cs, selected, async it => {
  const cur = await swW.get('promotion', it.entityId!);
  if (!cur) throw new Error('Promotion nicht mehr vorhanden');
  const patch = it.afterRaw as Record<string, unknown>;
  await swW.update('promotion', it.entityId!, patch);
  return { op: 'patch', entity: 'promotion', id: it.entityId!, data: Object.fromEntries(Object.keys(patch).map(k => [k, cur[k] ?? null])) };
}, ctx));

// ================= LESEN =================
const REDEEMED = { type: 'not', operator: 'and', queries: [{ type: 'equals', field: 'payload', value: null }] };
/** Anzahl Einzelcodes je Promotion (erzeugt / eingelöst) – nur Zählwerte, nie Einlöser. */
async function codeCounts(sw: ShopReader, ids: string[]) {
  const out: Record<string, { generated: number; redeemed: number }> = {};
  if (!ids.length) return out;
  const agg = async (extra: unknown[]) => {
    const r = await sw.search('promotion-individual-code', { limit: 1, filter: [{ type: 'equalsAny', field: 'promotionId', value: ids }, ...extra], aggregations: [{ name: 'n', type: 'terms', field: 'promotionId', limit: ids.length }] }) as { aggregations?: { n?: { buckets?: { key: string; count: number }[] } } };
    return Object.fromEntries((r.aggregations?.n?.buckets ?? []).map(b => [b.key, b.count]));
  };
  const [gen, red] = await Promise.all([agg([]), agg([REDEEMED])]);
  for (const id of ids) out[id] = { generated: gen[id] ?? 0, redeemed: red[id] ?? 0 };
  return out;
}
const codeInfo = (p: SwEntity, c?: { generated: number; redeemed: number }) => (!p.useCodes ? { type: 'none' } : p.useIndividualCodes ? { type: 'individual', pattern: p.individualCodePattern, generated: c?.generated ?? 0, redeemed: c?.redeemed ?? 0 } : { type: 'fixed', code: p.code });

export const promotionen: Feature = {
  key: 'promotionen',
  platforms: ['shopware'],
  toolNames: ['list_promotions', 'get_promotion', 'propose_promotion', 'propose_promotion_status'],
  tools: session => {
    const sw = session.sw;
    // Namen für Kanäle/Produkte/Kategorien aller Rabatte einer Seite in einem Rutsch laden
    const ctxFor = (discounts: SwEntity[]) => {
      const rs = discounts.map(d => ruleRestriction(d.discountRules));
      return loadCtx(sw, [...new Set(rs.flatMap(r => r.productIds))], [...new Set(rs.flatMap(r => r.categoryIds))]);
    };
    const discountsView = (discounts: SwEntity[], ctx: Ctx) => {
      const rs = discounts.map(d => ruleRestriction(d.discountRules));
      return discounts.map((d, i) => {
        const target = [targetOf(rs[i].productIds, rs[i].categoryIds, ctx), ...rs[i].other].filter(Boolean).join(' + ') || null;
        return { id: d.id, text: discountText({ scope: d.scope, type: d.type, value: d.value, maxValue: d.maxValue, target }), scope: d.scope, type: d.type, value: d.value, maxValue: d.maxValue ?? null, restriction: target ? { products: rs[i].productIds.map(p => ({ id: p, name: ctx.products[p] ?? p })), categories: rs[i].categoryIds.map(c => ({ id: c, name: ctx.categories[c] ?? c })), otherConditions: rs[i].other, rules: (d.discountRules ?? []).map((r: SwEntity) => ({ id: r.id, name: r.name })) } : null };
      });
    };
    return [
      tool('list_promotions', 'LIEST Promotionen/Rabattaktionen (viele, mit Filter + Paginierung, max. 100 pro Aufruf): Name, Status (läuft/geplant/abgelaufen/inaktiv/ausgeschöpft), Zeitraum, Code-Art (ohne Code / fester Code / Einzelcodes mit Muster und Anzahl erzeugt/eingelöst), Verkaufskanäle, Rabatte als Kurztext, Priorität, Kombinierbarkeit, Limits und Anzahl Einlösungen (nur Zählwerte – nie Kunden oder Bestellungen). Ändert nichts.',
        { status: z.enum(['running', 'scheduled', 'expired', 'inactive', 'all']).optional().describe('running = aktiv und im Zeitraum; Standard all'), term: z.string().optional().describe('Teil des Namens'), salesChannelId: z.string().optional(), withCode: z.boolean().optional().describe('true = nur mit Code, false = nur automatische'), limit: z.number().optional().describe('Standard 50, max. 100'), page: z.number().optional().describe('Seite ab 1 (bei gleichem limit)') },
        guard(async a => {
          const limit = Math.min(Math.max(Math.floor(a.limit ?? 50), 1), 100), page = Math.max(Math.floor(a.page ?? 1), 1), now = new Date().toISOString();
          const filter = [...statusFilter(a.status, now), ...(a.term ? [{ type: 'contains', field: 'name', value: a.term }] : []), ...(a.salesChannelId ? [{ type: 'equals', field: 'salesChannels.salesChannelId', value: a.salesChannelId }] : []), ...(a.withCode != null ? [{ type: 'equals', field: 'useCodes', value: a.withCode }] : [])];
          const r = await sw.search('promotion', { limit, page, filter, 'total-count-mode': 1, sort: [{ field: 'priority', order: 'DESC' }, { field: 'name', order: 'ASC' }], associations: { salesChannels: {}, discounts: { associations: { discountRules: { associations: { conditions: {} } } } } } });
          const counts = await codeCounts(sw, r.data.filter(p => p.useIndividualCodes).map(p => p.id));
          const ctx = await ctxFor(r.data.flatMap(p => p.discounts ?? []));
          const out = r.data.map(p => ({
            id: p.id, name: nameOf(p), status: promotionStatus(p), active: p.active, period: fmtPeriod(p.validFrom, p.validUntil), validFrom: p.validFrom ?? null, validUntil: p.validUntil ?? null,
            code: codeInfo(p, counts[p.id]), salesChannels: (p.salesChannels ?? []).map((s: SwEntity) => ctx.channels[s.salesChannelId] ?? s.salesChannelId),
            discounts: discountsView(p.discounts ?? [], ctx).map(d => d.text), priority: p.priority, exclusive: !!(p.preventCombination || p.exclusive),
            maxUsesGlobal: p.maxRedemptionsGlobal ?? null, maxUsesPerCustomer: p.maxRedemptionsPerCustomer ?? null, timesUsed: p.orderCount ?? 0,
          }));
          return ok({ total: r.total, page, limit, returned: out.length, hasMore: page * limit < (r.total ?? 0), promotions: out });
        })),

      tool('get_promotion', 'LIEST eine Promotion im Detail: alle Felder wie list_promotions plus Rabatte mit Umfang (Warenkorb/Versand/Set), Art, Wert, Höchstbetrag und Einschränkung auf Produkte/Kategorien (aus den Rabatt-Regeln, mit Namen), Set-Gruppen, Zielgruppen-/Warenkorb-Regeln (nur Name), Einzelcodes (Anzahl erzeugt/eingelöst, einige freie Beispielcodes). Keine Kunden- oder Bestelldaten. Ändert nichts.',
        { id: z.string() },
        guard(async ({ id }) => {
          const p = await sw.get('promotion', id, { associations: { salesChannels: {}, setgroups: {}, cartRules: {}, personaRules: {}, discounts: { associations: { discountRules: { associations: { conditions: {} } } } } } });
          if (!p) return fail('Promotion nicht gefunden');
          const counts = p.useIndividualCodes ? await codeCounts(sw, [id]) : {};
          const sample = p.useIndividualCodes ? (await sw.search('promotion-individual-code', { limit: 5, filter: [{ type: 'equals', field: 'promotionId', value: id }, { type: 'equals', field: 'payload', value: null }] })).data.map(c => c.code) : [];
          const ctx = await ctxFor(p.discounts ?? []);
          return ok({
            id: p.id, name: nameOf(p), status: promotionStatus(p), active: p.active, period: fmtPeriod(p.validFrom, p.validUntil), validFrom: p.validFrom ?? null, validUntil: p.validUntil ?? null,
            code: { ...codeInfo(p, counts[id]), ...(sample.length ? { unusedExamples: sample } : {}) },
            salesChannels: (p.salesChannels ?? []).map((s: SwEntity) => ({ id: s.salesChannelId, name: ctx.channels[s.salesChannelId] ?? s.salesChannelId })),
            discounts: discountsView(p.discounts ?? [], ctx), setGroups: (p.setgroups ?? []).length,
            cartRules: (p.cartRules ?? []).map((r: SwEntity) => r.name), audienceRules: (p.personaRules ?? []).map((r: SwEntity) => r.name), customerRestriction: !!p.customerRestriction,
            priority: p.priority, exclusive: !!(p.preventCombination || p.exclusive), maxUsesGlobal: p.maxRedemptionsGlobal ?? null, maxUsesPerCustomer: p.maxRedemptionsPerCustomer ?? null, timesUsed: p.orderCount ?? 0,
          });
        })),

      tool('propose_promotion', `SCHLÄGT eine neue Promotion (ohne id) oder die Änderung einer bestehenden (mit id) vor. Es wird NICHTS geschrieben: Der Nutzer sieht eine Zusammenfassung (z. B. „20 % auf Wohnaccessoires, Code HERBST20, 01.10. bis 31.10.2026, max. 1× pro Kunde“) mit Warnungen und gibt frei; der Aufruf wartet auf die Entscheidung. Neu: name, discounts, code und active sind Pflicht – active=true mit künftigem validFrom = geplant (startet automatisch am Startdatum), active=false = Entwurf, der NIE von selbst startet; ohne salesChannelIds gilt sie in allen Storefront-Kanälen. Ändern: nur angegebene Felder ändern sich; discounts ersetzt ALLE Rabatte, salesChannelIds ersetzt die Kanäle, code.individual erzeugt count ZUSÄTZLICHE Codes. Rabatt-Einschränkung auf Produkte/Kategorien: der Server legt je Rabatt eine Regel „Lotse: …“ an. Datum als JJJJ-MM-TT (Start = Tagesbeginn, Ende = Tagesende, deutsche Zeit); null entfernt. Erzeugt KEINE Gutscheine für einzelne Kunden, ändert keine Preise.`,
        {
          id: z.string().optional().describe('Nur zum Ändern einer bestehenden Promotion'),
          reason: z.string().describe('Zweck in 1 Satz, z. B. „Herbstaktion Wohnaccessoires“'),
          name: z.string().optional().describe('Interner/angezeigter Name, z. B. „Herbst 2026 – 20 % Wohnaccessoires“'),
          active: z.boolean().optional().describe('Beim Anlegen Pflicht: true = aktiv (mit künftigem validFrom geplant, startet dann automatisch), false = Entwurf ohne automatischen Start'), validFrom: z.string().nullable().optional().describe('JJJJ-MM-TT'), validUntil: z.string().nullable().optional().describe('JJJJ-MM-TT – immer empfehlen'),
          salesChannelIds: z.array(z.string()).optional(),
          code: z.object({ mode: z.enum(['none', 'fixed', 'individual']).describe('none = automatisch ohne Code'), code: z.string().optional().describe('bei fixed, z. B. HERBST20'), pattern: z.string().optional().describe('bei individual, %s = Buchstabe, %d = Ziffer, z. B. HERBST-%s%s%d%d'), count: z.number().optional().describe(`bei individual: Anzahl (max. ${MAX_CODES})`) }).optional(),
          discounts: z.array(z.object({
            scope: z.enum(['cart', 'delivery']).optional().describe('cart (Standard) = Warenkorb/Positionen, delivery = Versandkosten'),
            type: z.enum(['percentage', 'absolute', 'fixed', 'fixed_unit']).describe('percentage = %, absolute = € Rabatt, fixed = Festpreis gesamt, fixed_unit = Festpreis je Stück'),
            value: z.number().describe('Prozent bzw. € brutto'), maxValue: z.number().nullable().optional().describe('Höchstbetrag in € (nur percentage)'),
            productIds: z.array(z.string()).optional(), categoryIds: z.array(z.string()).optional().describe('Rabatt gilt nur für Positionen dieser Produkte/Kategorien'),
          })).optional(),
          priority: z.number().optional(), exclusive: z.boolean().optional().describe('true = nicht mit anderen Promotionen kombinierbar'),
          maxUsesGlobal: z.number().nullable().optional().describe('max. Einlösungen insgesamt, null = unbegrenzt'), maxUsesPerCustomer: z.number().nullable().optional().describe('max. Einlösungen pro Kunde, null = unbegrenzt'),
        },
        guard(async a => { const { cs, payload } = await buildPromotionChangeSet(sw, a); return ok(await session.requestChange(cs, payload)); })),

      tool('propose_promotion_status', `SCHLÄGT vor, eine oder viele Promotionen (max. ${MAX_ITEMS}) zu aktivieren, zu deaktivieren oder zu beenden (end = Enddatum jetzt + inaktiv). Es wird NICHTS geschrieben, bis der Nutzer freigibt; Zeilen sind einzeln abwählbar. Ändert keine Rabatte oder Codes.`,
        { ids: z.array(z.string()).describe('Promotion-IDs aus list_promotions'), action: z.enum(['activate', 'deactivate', 'end']), reason: z.string().optional() },
        guard(async a => ok(await session.requestChange(await buildStatusChangeSet(sw, a))))),
    ] as AnyTool[];
  },
};
