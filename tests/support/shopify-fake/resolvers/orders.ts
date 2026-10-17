// Orders (only behind read_orders): just what Lotse's sales read queries. No customers, addresses or names.
import type { ResolveInfo } from '../graphql';
import { type ConnArgs, type Ctx, idOf, paginate, search } from '../context';
import type { SearchSpec } from '../search';
import { gid, type OrderRec } from '../state';

type LineRec = OrderRec['lineItems'][number] & { currencyCode: string };
const orderSearchSpec: SearchSpec<OrderRec> = {
  fields: {
    id: { kind: 'number', get: (o) => o.id },
    created_at: { kind: 'date', get: (o) => o.createdAt },
    test: { kind: 'boolean', get: (o) => o.test },
  },
  freeText: () => [],
};
const money = (amount: string, currencyCode: string) => ({ amount, currencyCode });

export const orderTypes = {
  Order: {
    id: (o: OrderRec) => gid('Order', o.id),
    totalPriceSet: (o: OrderRec) => { const t = o.lineItems.reduce((s, l) => s + Number(l.discountedTotal), 0).toFixed(2); return { shopMoney: money(t, o.currencyCode), presentmentMoney: money(t, o.currencyCode) }; },
    lineItems: (o: OrderRec, a: ConnArgs, ctx: Ctx) => paginate(o.lineItems.map((l): LineRec => ({ ...l, currencyCode: o.currencyCode })), a, ctx, (l) => l.id),
  },
  LineItem: {
    id: (l: LineRec) => gid('LineItem', l.id),
    product: (l: LineRec, _: unknown, ctx: Ctx) => (l.productId != null ? ctx.state.products.get(l.productId) ?? null : null),
    discountedTotalSet: (l: LineRec) => ({ shopMoney: money(l.discountedTotal, l.currencyCode), presentmentMoney: money(l.discountedTotal, l.currencyCode) }),
  },
};

export const orderQueries = {
  orders: (_: unknown, a: ConnArgs & { query?: string }, ctx: Ctx, info: ResolveInfo) =>
    paginate(search([...ctx.state.orders].sort((x, y) => x.id - y.id), a.query, orderSearchSpec, ctx, info), a, ctx, (o) => o.id),
  order: (_: unknown, a: { id: string }, ctx: Ctx) => { const id = idOf(a.id, 'Order'); return id !== null ? ctx.state.orders.find((o) => o.id === id) ?? null : null; },
};
