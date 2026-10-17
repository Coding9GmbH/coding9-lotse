// Sales without personal data: pure evaluation (no network). Periods, top sellers, slow movers, top sellers with weak content.
import type { NeutralProduct } from '@/lib/custom-checks';
import { htmlToText } from '@/lib/text';
import type { SalesRange, SalesReport, SalesRow } from '../platform/types';

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;
/** Description below this many words counts as thin (same order of magnitude as the shop check rules) */
export const THIN_WORDS = 100;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** Last `days` full days up to yesterday (UTC): today is still incomplete */
export function salesRange(days = DEFAULT_DAYS, now = new Date()): SalesRange & { days: number } {
  const n = Math.min(Math.max(Math.round(days) || DEFAULT_DAYS, 1), MAX_DAYS);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const from = new Date(to.getTime() - (n - 1) * 86_400_000);
  return { from: isoDay(from), to: isoDay(to), days: n };
}

/** Add up rows of the same product (adapters may report variants or pages separately) */
export function mergeRows(rows: SalesRow[]): SalesRow[] {
  const by = new Map<string, SalesRow>();
  for (const r of rows) {
    const cur = by.get(r.productId);
    if (cur) { cur.quantity += r.quantity; cur.revenue += r.revenue; cur.orders += r.orders; }
    else by.set(r.productId, { ...r });
  }
  return [...by.values()].map(r => ({ ...r, revenue: Math.round(r.revenue * 100) / 100 }));
}

const words = (html: string) => (htmlToText(html).match(/[\p{L}\p{N}-]+/gu) ?? []).length;
export type SortBy = 'revenue' | 'quantity';

export interface TopSeller extends SalesRow { share: number; product: NeutralProduct | null }
/** Products by revenue (or quantity); share = part of the total revenue (quantity) of the period */
export function topSellers(rep: Pick<SalesReport, 'rows'>, products: NeutralProduct[], o: { sortBy?: SortBy; top?: number } = {}): TopSeller[] {
  const key = o.sortBy ?? 'revenue', by = new Map(products.map(p => [p.id, p]));
  const total = rep.rows.reduce((n, r) => n + r[key], 0);
  return [...rep.rows].sort((a, b) => b[key] - a[key] || b.orders - a.orders).slice(0, o.top ?? 20)
    .map(r => ({ ...r, share: total ? Math.round((r[key] / total) * 1000) / 1000 : 0, product: by.get(r.productId) ?? null }));
}

export interface SlowMover { product: NeutralProduct; /** stock × price: tied-up capital, estimate */ stockValue: number | null }
/** Active products with stock but not a single sale in the period, most tied-up capital first */
export function slowMovers(rep: Pick<SalesReport, 'rows'>, products: NeutralProduct[], top = 20): { items: SlowMover[]; total: number } {
  const sold = new Set(rep.rows.filter(r => r.quantity > 0).map(r => r.productId));
  const all = products.filter(p => !sold.has(p.id) && (p.stock ?? 0) > 0)
    .map(p => ({ product: p, stockValue: p.price != null && p.stock != null ? Math.round(p.price * p.stock * 100) / 100 : null }))
    .sort((a, b) => (b.stockValue ?? -1) - (a.stockValue ?? -1) || (b.product.stock ?? 0) - (a.product.stock ?? 0));
  return { items: all.slice(0, top), total: all.length };
}

export interface WeakSeller extends TopSeller { problems: ('thin-description' | 'no-meta-title' | 'no-meta-description' | 'no-image')[]; descriptionWords: number }
/** Top sellers (by revenue, the best `pool`) whose texts are thin or metas/image missing: improving them pays off most */
export function weakTopSellers(rep: Pick<SalesReport, 'rows'>, products: NeutralProduct[], o: { pool?: number; top?: number } = {}): { items: WeakSeller[]; total: number } {
  const out: WeakSeller[] = [];
  for (const t of topSellers(rep, products, { top: o.pool ?? 50 })) {
    if (!t.product) continue; // not active or not read: no statement
    const w = words(t.product.description), problems: WeakSeller['problems'] = [];
    if (w < THIN_WORDS) problems.push('thin-description');
    if (!t.product.metaTitle.trim()) problems.push('no-meta-title');
    if (!t.product.metaDescription.trim()) problems.push('no-meta-description');
    if (t.product.hasImage === false) problems.push('no-image');
    if (problems.length) out.push({ ...t, problems, descriptionWords: w });
  }
  return { items: out.slice(0, o.top ?? 20), total: out.length };
}

export const PROBLEM_TEXT: Record<WeakSeller['problems'][number], string> = { 'thin-description': `Beschreibung unter ${THIN_WORDS} Wörtern`, 'no-meta-title': 'kein Meta-Title', 'no-meta-description': 'keine Meta-Description', 'no-image': 'kein Bild' };
export const money = (n: number, currency: string | null) => `${n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
