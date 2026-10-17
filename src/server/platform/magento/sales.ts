import 'server-only';
// Magento: sales per product (PlatformAdapter.sales). FIXED query GET /V1/orders via the privileged client (the AI's read
// client blocks /V1/orders): created_at in the period, without cancelled orders, and a field selection that returns only
// order ID, state, currencies and the line items' product_id, quantities and row totals. No customer, address or order number fields.
import type { SalesRange, SalesReport, SalesRow } from '../types';
import { MagentoError, type MagentoClient } from './client';
import type { Criteria } from './criteria';

export const SALES_PAGE = 100, SALES_PAGES = 50; // at most 5,000 orders per period
/** Field selection (Magento "fields" parameter): only what the sums need */
export const SALES_FIELDS = 'items[entity_id,state,base_currency_code,items[item_id,product_id,parent_item_id,qty_ordered,qty_canceled,base_row_total,base_row_total_incl_tax,base_discount_amount]],total_count';
const DENIED = 'Magento erlaubt Lotse keine Bestellungen zu lesen: Für den Abverkauf braucht die Integration Zugriff auf Vertrieb → Bestellungen (Lotse liest daraus nur Summen je Produkt, keine Kundendaten).';

export const salesCriteria = (r: SalesRange, currentPage: number): Criteria => ({
  filters: [
    [{ field: 'created_at', value: `${r.from} 00:00:00`, condition_type: 'gteq' }],
    [{ field: 'created_at', value: `${r.to} 23:59:59`, condition_type: 'lteq' }],
    [{ field: 'state', value: 'canceled', condition_type: 'neq' }],
  ],
  sort: [{ field: 'entity_id', direction: 'ASC' }],
  pageSize: SALES_PAGE, currentPage,
});

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

export async function magentoSales(c: MagentoClient, r: SalesRange): Promise<SalesReport> {
  const per = new Map<string, { quantity: number; revenue: number; orders: Set<string> }>(), orders = new Set<string>(), currencies = new Set<string>();
  let capped = false;
  for (let page = 1; ; page++) {
    let res: { items: Record<string, unknown>[]; total_count: number };
    try { res = await c.search('/V1/orders', salesCriteria(r, page), { store: 'all', fields: SALES_FIELDS }); }
    catch (e) { if (e instanceof MagentoError && (e.status === 401 || e.status === 403)) throw new Error(DENIED); throw e; }
    for (const o of res.items) {
      if (o.state === 'canceled') continue;
      const oid = String(o.entity_id ?? '');
      if (typeof o.base_currency_code === 'string' && o.base_currency_code) currencies.add(o.base_currency_code);
      orders.add(oid);
      // Quantity from the top-level row; revenue from ALL rows, credited to the top-level product: configurables and fixed-price
      // bundles carry the price on the parent (children 0), dynamic-price bundles on the children (parent 0)
      const items = (o.items as Record<string, unknown>[] | undefined) ?? [], byItem = new Map(items.map(it => [String(it.item_id ?? ''), it]));
      for (const it of items) {
        const child = it.parent_item_id != null && it.parent_item_id !== '', top = child ? byItem.get(String(it.parent_item_id)) : it;
        const id = top?.product_id == null ? '' : String(top.product_id); if (!id) continue;
        const ordered = num(it.qty_ordered) ?? 0, left = Math.max(0, ordered - (num(it.qty_canceled) ?? 0)); if (!left) continue;
        const row = (num(it.base_row_total_incl_tax) ?? num(it.base_row_total) ?? 0) - (num(it.base_discount_amount) ?? 0);
        const cur = per.get(id) ?? { quantity: 0, revenue: 0, orders: new Set<string>() };
        if (!child) cur.quantity += left;
        cur.revenue += ordered ? (row * left) / ordered : 0; cur.orders.add(oid);
        per.set(id, cur);
      }
    }
    if (res.items.length < SALES_PAGE || page * SALES_PAGE >= res.total_count) break;
    if (page >= SALES_PAGES) { capped = true; break; }
  }
  const rows: SalesRow[] = [...per].map(([productId, v]) => ({ productId, quantity: v.quantity, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders.size }));
  return { rows, orders: orders.size, currency: currencies.size === 1 ? [...currencies][0] : null, capped,
    ...(currencies.size > 1 ? { notes: ['Bestellungen in mehreren Basiswährungen: Umsätze sind ohne Umrechnung addiert.'] } : {}) };
}
