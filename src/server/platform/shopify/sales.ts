import 'server-only';
// Shopify: sales per product (PlatformAdapter.sales). FIXED queries via the privileged client, needs read_orders.
// Only the order ID, creation/cancel date, test flag and per line item quantity, product ID and discounted total are requested:
// no customer, email, address, name or order number. Quantity = as ordered (like the other platforms; refunds are not subtracted),
// revenue = discountedTotalSet in shop currency. Cancelled and test orders don't count.
import type { SalesRange, SalesReport, SalesRow } from '../types';
import { ShopifyError, shortId, type Json } from './client';
import type { Q } from './data';

/** Orders per page × line items per order stay below Shopify's query cost limit of 1000 */
export const SALES_ORDERS = 20, SALES_LINES = 10, SALES_PAGES = 250; // at most 5,000 orders per period
const LINES = `pageInfo { hasNextPage endCursor } nodes { quantity product { id } discountedTotalSet { shopMoney { amount currencyCode } } }`;
export const SALES_QUERY = `query Sales($q: String!, $after: String) { orders(first: ${SALES_ORDERS}, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { id cancelledAt test lineItems(first: ${SALES_LINES}) { ${LINES} } } } }`;
const MORE_LINES = `query SalesLines($id: ID!, $after: String) { order(id: $id) { lineItems(first: 100, after: $after) { ${LINES} } } }`;
export const NO_ORDERS = 'Shopify erlaubt Lotse keine Bestellungen zu lesen: Für den Abverkauf braucht die App die Berechtigung read_orders (Lotse liest daraus nur Summen je Produkt, keine Kundendaten).';
const DAYS_60 = 'Shopify liefert ohne die Berechtigung read_all_orders nur Bestellungen der letzten 60 Tage.';

/** Does the app have read_all_orders? (not readable = no) */
async function hasAllOrders(q: Q): Promise<boolean> {
  try { return ((await q<Json>('query Scopes { currentAppInstallation { accessScopes { handle } } }')).currentAppInstallation?.accessScopes ?? []).some((x: Json) => x.handle === 'read_all_orders'); }
  catch { return false; }
}

export async function shopifySales(q: Q, r: SalesRange, o: { pages?: number; now?: Date } = {}): Promise<SalesReport> {
  const per = new Map<string, { quantity: number; revenue: number; orders: Set<string> }>(), counted = new Set<string>(), currencies = new Set<string>();
  const add = (order: string, li: Json) => {
    const id = shortId(li.product?.id); if (!id) return; // custom items, deleted products
    const cur = per.get(id) ?? { quantity: 0, revenue: 0, orders: new Set<string>() };
    cur.quantity += Number(li.quantity) || 0; cur.revenue += Number(li.discountedTotalSet?.shopMoney?.amount) || 0; cur.orders.add(order);
    if (li.discountedTotalSet?.shopMoney?.currencyCode) currencies.add(li.discountedTotalSet.shopMoney.currencyCode);
    per.set(id, cur);
  };
  const query = `created_at:>=${r.from}T00:00:00Z created_at:<=${r.to}T23:59:59Z`, max = o.pages ?? SALES_PAGES;
  let after: string | null = null, capped = false;
  try {
    for (let page = 1; ; page++) {
      const d: Json = await q(SALES_QUERY, { q: query, after });
      for (const ord of d.orders.nodes as Json[]) {
        if (ord.cancelledAt || ord.test) continue;
        counted.add(ord.id);
        let lines: Json = ord.lineItems;
        for (const li of lines.nodes) add(ord.id, li);
        while (lines.pageInfo?.hasNextPage) { lines = (await q<Json>(MORE_LINES, { id: ord.id, after: lines.pageInfo.endCursor })).order.lineItems; for (const li of lines.nodes) add(ord.id, li); }
      }
      if (!d.orders.pageInfo.hasNextPage) break;
      if (page >= max) { capped = true; break; }
      after = d.orders.pageInfo.endCursor;
    }
  } catch (e) {
    if (e instanceof ShopifyError && e.code === 'ACCESS_DENIED') throw new ShopifyError(NO_ORDERS, e.status, e.code);
    throw e;
  }
  const rows: SalesRow[] = [...per].map(([productId, v]) => ({ productId, quantity: v.quantity, revenue: Math.round(v.revenue * 100) / 100, orders: v.orders.size }));
  // older than 60 days: only a limit without read_all_orders (permissions unreadable → mention it to be safe)
  const old = Date.parse(`${r.from}T00:00:00Z`) < (o.now ?? new Date()).getTime() - 60 * 86_400_000 && !(await hasAllOrders(q));
  const notes = [...(old ? [DAYS_60] : []), ...(currencies.size > 1 ? ['Bestellungen in mehreren Währungen: Umsätze sind ohne Umrechnung addiert.'] : [])];
  return { rows, orders: counted.size, currency: currencies.size === 1 ? [...currencies][0] : null, capped, ...(notes.length ? { notes } : {}) };
}
