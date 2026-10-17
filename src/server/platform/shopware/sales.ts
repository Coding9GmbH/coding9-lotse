import 'server-only';
// Shopware: sales per product (PlatformAdapter.sales). Reads order line items with a FIXED query via the privileged client
// (the AI's read client has no access to orders): only productId, quantity, totalPrice and the order's ID and currency.
// Variants are added to their parent product. No customer, address or order number fields are requested.
import type { ShopReader } from '../../shopware';
import type { SalesRange, SalesReport, SalesRow } from '../types';

export const SALES_PAGE = 500, SALES_PAGES = 40; // at most 20,000 line items per period
const day = (d: string, end: boolean) => `${d}T${end ? '23:59:59.999' : '00:00:00.000'}+00:00`;

/** Fixed criteria per page: product line items of non-cancelled orders in the period, only the four needed fields */
export const salesCriteria = (r: SalesRange, page: number) => ({
  page, limit: SALES_PAGE,
  filter: [
    { type: 'equals', field: 'type', value: 'product' },
    { type: 'not', operator: 'and', queries: [{ type: 'equals', field: 'productId', value: null }] },
    { type: 'range', field: 'order.orderDateTime', parameters: { gte: day(r.from, false), lte: day(r.to, true) } },
    { type: 'not', operator: 'or', queries: [{ type: 'equals', field: 'order.stateMachineState.technicalName', value: 'cancelled' }] },
  ],
  sort: [{ field: 'id', order: 'ASC' }],
  associations: { order: {} },
  includes: { order_line_item: ['productId', 'quantity', 'totalPrice', 'orderId', 'order'], order: ['currencyId', 'taxStatus'] },
});

export async function shopwareSales(sw: ShopReader, r: SalesRange): Promise<SalesReport> {
  const per = new Map<string, { quantity: number; revenue: number; orders: Set<string> }>(), orders = new Set<string>(), currencies = new Set<string>();
  let net = false; // totalPrice is net for net orders (B2B), gross otherwise
  let capped = false;
  for (let page = 1; ; page++) {
    const res = await sw.search('order-line-item', salesCriteria(r, page));
    for (const li of res.data) {
      const id = String(li.productId ?? ''); if (!id) continue;
      const cur = per.get(id) ?? { quantity: 0, revenue: 0, orders: new Set<string>() };
      cur.quantity += Number(li.quantity) || 0; cur.revenue += Number(li.totalPrice) || 0;
      if (li.orderId) { cur.orders.add(String(li.orderId)); orders.add(String(li.orderId)); }
      if (li.order?.currencyId) currencies.add(String(li.order.currencyId));
      if (li.order?.taxStatus === 'net' || li.order?.taxStatus === 'tax-free') net = true;
      per.set(id, cur);
    }
    if (res.data.length < SALES_PAGE) break;
    if (page >= SALES_PAGES) { capped = true; break; }
  }
  // Variants → parent product (productId of a line item is the ordered variant)
  const ids = [...per.keys()], parent = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    for (const p of (await sw.search('product', { ids: chunk, limit: chunk.length, includes: { product: ['id', 'parentId'] } })).data) if (p.parentId) parent.set(p.id, p.parentId);
  }
  const by = new Map<string, { quantity: number; revenue: number; orders: Set<string> }>();
  for (const [id, v] of per) {
    const key = parent.get(id) ?? id, cur = by.get(key);
    if (cur) { cur.quantity += v.quantity; cur.revenue += v.revenue; for (const o of v.orders) cur.orders.add(o); } else by.set(key, { ...v, orders: new Set(v.orders) });
  }
  const rows: SalesRow[] = [...by].map(([productId, v]) => ({ productId, quantity: v.quantity, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders.size }));
  let currency: string | null = null;
  if (currencies.size === 1) currency = (await sw.search('currency', { ids: [...currencies], limit: 1, includes: { currency: ['isoCode'] } })).data[0]?.isoCode ?? null;
  const notes = [...(currencies.size > 1 ? ['Bestellungen in mehreren Währungen: Umsätze sind ohne Umrechnung addiert.'] : []), ...(net ? ['Einige Bestellungen haben Nettopreise (z. B. Geschäftskunden): Umsätze sind Positionssummen wie bestellt, brutto und netto gemischt.'] : [])];
  return { rows, orders: orders.size, currency, capped, ...(notes.length ? { notes } : {}) };
}
