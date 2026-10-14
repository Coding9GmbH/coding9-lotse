import 'server-only';
// Shopware: active parent products in neutral form (custom shop checks). Read once per read client, at most SCAN_MAX.
import type { NeutralProduct, NeutralScan } from '@/lib/custom-checks';
import { DEFAULT_CURRENCY } from '../../changes';
import type { ShopReader, SwEntity } from '../../shopware';

export const SCAN_MAX = 2500, SCAN_PAGE = 250;
const INCLUDES = { product: ['id', 'productNumber', 'name', 'translated', 'price', 'stock', 'coverId'] };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();

export function toNeutral(p: SwEntity): NeutralProduct {
  const price = (Array.isArray(p.price) ? (p.price as SwEntity[]) : []).find(x => x?.currencyId === DEFAULT_CURRENCY) ?? null;
  const name = clean(p.translated?.name ?? p.name) || String(p.productNumber ?? p.id);
  return {
    id: p.id, name, label: p.productNumber ? `${name} (${p.productNumber})` : name,
    description: String(p.translated?.description ?? p.description ?? ''), metaTitle: clean(p.translated?.metaTitle ?? p.metaTitle), metaDescription: clean(p.translated?.metaDescription ?? p.metaDescription),
    price: num(price?.gross), listPrice: num(price?.listPrice?.gross), stock: num(p.stock), hasImage: p.coverId != null,
  };
}

const memos = new WeakMap<ShopReader, Promise<NeutralScan>>();
export function scanNeutral(sw: ShopReader): Promise<NeutralScan> {
  let m = memos.get(sw);
  if (!m) {
    m = (async () => {
      const rows: NeutralProduct[] = []; let total = 0;
      const filter = [{ type: 'equals', field: 'active', value: true }, { type: 'equals', field: 'parentId', value: null }];
      for (let page = 1; rows.length < SCAN_MAX; page++) {
        const r = await sw.search('product', { limit: SCAN_PAGE, page, filter, sort: [{ field: 'productNumber', order: 'ASC' }], includes: INCLUDES, ...(page === 1 ? { 'total-count-mode': 1 } : {}) });
        if (page === 1) total = r.total ?? r.data.length;
        rows.push(...r.data.map(toNeutral));
        if (r.data.length < SCAN_PAGE) break;
      }
      return { rows, total: Math.max(total, rows.length), capped: rows.length < total };
    })();
    memos.set(sw, m);
  }
  return m;
}
