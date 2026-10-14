import 'server-only';
// Magento shop check: register checks (SEO, images, stock, prices, links in descriptions and CMS pages, translations).
// A fresh read client per run (shopcheck.ts); data is read once per read client (memo) and shared by all checks.
// Large catalogs: at most SCAN_MAX active, visible products (finding then reads "at least").
import type { NeutralProduct, NeutralScan } from '@/lib/custom-checks';
import type { CheckFinding } from '@/lib/protocol';
import { registerPlatformCheck } from '../../checks';
import { makeFinding, type Hit } from '../../features/shopcheck-rules';
import { extractLinks } from '../../seo-links';
import { checkMagentoLinks, type LinkCache } from './links';
import { attr, attrStr, plain, priceState, type MRecord } from './map';
import { categoryHits, M_DEFS, productHits, productLabel, untranslated } from './checks-rules';
import { readableHtml } from './pagebuilder';
import type { MagentoReader } from './reader';

export const SCAN_MAX = 2500, SCAN_PAGE = 250;
const memos = new WeakMap<MagentoReader, Map<string, Promise<unknown>>>();
function memo<T>(ro: MagentoReader, key: string, fn: () => Promise<T>): Promise<T> {
  let m = memos.get(ro); if (!m) memos.set(ro, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as Promise<T>;
}
const ACTIVE = [[{ field: 'status', value: 1 }], [{ field: 'visibility', value: [2, 3, 4], condition_type: 'in' as const }]];

/** Active, individually visible products, paged (store: store view, 'all' = global values) */
async function scan(ro: MagentoReader, store?: string): Promise<{ rows: MRecord[]; total: number; capped: boolean }> {
  return memo(ro, `scan:${store ?? ''}`, async () => {
    const rows: MRecord[] = []; let total = 0;
    for (let page = 1; rows.length < SCAN_MAX; page++) {
      const r = await ro.products({ filters: ACTIVE, pageSize: SCAN_PAGE, currentPage: page, sort: [{ field: 'entity_id', direction: 'ASC' }], ...(store ? { store } : {}) });
      if (page === 1) total = r.total_count;
      rows.push(...r.items);
      if (r.items.length < SCAN_PAGE) break;
    }
    return { rows, total, capped: rows.length < total };
  });
}
const hitsOf = (ro: MagentoReader) => memo(ro, 'hits', async () => {
  const s = await scan(ro);
  // Stock only readable with Magento Inventory (MSI); sum over all sources, "in stock" if any source reports it
  const stock = await memo(ro, 'stock', async () => {
    if (!(await ro.sources().catch(() => null))) return undefined;
    const m = new Map<string, { qty: number; inStock: boolean }>();
    for (const x of await ro.sourceItems(s.rows.map(p => p.sku))) { const cur = m.get(x.sku) ?? { qty: 0, inStock: false }; m.set(x.sku, { qty: cur.qty + Number(x.quantity ?? 0), inStock: cur.inStock || Number(x.status) === 1 }); }
    return m;
  });
  return { s, h: productHits(s.rows, stock), stock };
});
/** Neutral product rows for custom checks (stock only readable with Magento Inventory, otherwise unknown) */
export async function neutralScan(ro: MagentoReader): Promise<NeutralScan> {
  const { s, stock } = await hitsOf(ro);
  return {
    total: s.total, capped: s.capped,
    rows: s.rows.map((p): NeutralProduct => {
      const pr = priceState(p), name = plain(p.name) || String(p.sku), q = stock?.get(p.sku);
      return {
        id: String(p.id), name, label: `${name} (${p.sku})`, description: String(attr(p, 'description') ?? ''), metaTitle: plain(attrStr(p, 'meta_title')), metaDescription: plain(attrStr(p, 'meta_description')),
        price: pr.selling, listPrice: pr.list, stock: q ? q.qty : null,
        hasImage: (p.media_gallery_entries ?? []).some((e: MRecord) => !e.disabled),
      };
    }),
  };
}
type Key = keyof ReturnType<typeof productHits>;
const fromScan = (k: Key, def: (typeof M_DEFS)[keyof typeof M_DEFS]) => async (ro: MagentoReader) => {
  const { s, h } = await hitsOf(ro), v = h[k], list = Array.isArray(v) ? { count: v.length, sample: v } : v;
  return makeFinding(def, list.count, s.total, list.sample, { atLeast: s.capped });
};

const reg = (id: string, area: string, scopes: ('products' | 'categories' | 'cms' | 'media' | 'shop')[], run: (ro: MagentoReader) => Promise<CheckFinding | CheckFinding[] | null>) =>
  registerPlatformCheck<MagentoReader>('magento', { id, area, scopes, run });

reg('magento.meta-description', 'SEO', ['products'], fromScan('metaDescMissing', M_DEFS.metaDescMissing));
reg('magento.meta-title', 'SEO', ['products'], fromScan('metaTitleMissing', M_DEFS.metaTitleMissing));
reg('magento.meta-title-long', 'SEO', ['products'], fromScan('metaTitleLong', M_DEFS.metaTitleLong));
reg('magento.meta-title-duplicate', 'SEO', ['products'], fromScan('metaTitleDup', M_DEFS.metaTitleDup));
reg('magento.description-thin', 'SEO', ['products'], fromScan('thin', M_DEFS.thin));
reg('magento.no-image', 'Bilder', ['products'], fromScan('noImage', M_DEFS.noImage));
reg('magento.alt-missing', 'Bilder', ['products', 'media'], fromScan('altMissing', M_DEFS.altMissing));
reg('magento.stock-zero', 'Daten', ['products'], fromScan('stockZero', M_DEFS.stockZero));
reg('magento.price-zero', 'Preise', ['products'], fromScan('priceZero', M_DEFS.priceZero));
reg('magento.special-not-below', 'Preise', ['products'], fromScan('specialNotBelow', M_DEFS.specialNotBelow));

// ---- Links in product descriptions ----
/** One link cache per run: the same path (service pages, categories) is resolved only once across all products and pages */
const linkCache = (ro: MagentoReader) => memo(ro, 'linkcache', async (): Promise<LinkCache> => new Map());
reg('magento.description-links', 'Links', ['products', 'shop'], async ro => {
  const s = await scan(ro), hits: Hit[] = [], cache = await linkCache(ro);
  const withLinks = s.rows.map(p => ({ p, links: extractLinks(readableHtml(String(attr(p, 'description') ?? ''))) })).filter(x => x.links.length);
  for (const x of withLinks) {
    const r = await checkMagentoLinks(ro, x.links, cache);
    const bad = r.report.findings.find(f => f.level === 'wichtig');
    if (bad) hits.push({ id: String(x.p.id), label: `${productLabel(x.p)}: ${bad.problem}` });
  }
  return makeFinding(M_DEFS.descLinks, hits.length, s.total, hits, { atLeast: s.capped });
});

// ---- Categories ----
const categoryRows = (ro: MagentoReader) => memo(ro, 'categories', async () => {
  const rows: MRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await ro.categories({ filters: [[{ field: 'level', value: 2, condition_type: 'gteq' }], [{ field: 'is_active', value: 1 }]], pageSize: 500, currentPage: page });
    rows.push(...r.items);
    if (r.items.length < 500) break;
  }
  return rows;
});
reg('magento.category-meta', 'SEO', ['categories'], async ro => { const rows = await categoryRows(ro), h = categoryHits(rows); return makeFinding(M_DEFS.catMeta, h.meta.length, rows.length, h.meta); });
reg('magento.category-description', 'SEO', ['categories'], async ro => { const rows = await categoryRows(ro), h = categoryHits(rows); return makeFinding(M_DEFS.catDesc, h.desc.length, rows.length, h.desc); });

// ---- CMS pages with broken links ----
reg('magento.cms-links', 'Links', ['cms', 'shop'], async ro => {
  const hits: Hit[] = [], cache = await linkCache(ro); let total = 0;
  for (let page = 1; page <= 4; page++) {
    const r = await ro.cmsPages({ filters: [[{ field: 'is_active', value: 1 }]], pageSize: 50, currentPage: page }, 'all');
    total = r.total_count;
    for (const pg of r.items) {
      const links = extractLinks(readableHtml(String(pg.content ?? '')));
      if (!links.length) continue;
      const bad = (await checkMagentoLinks(ro, links, cache)).report.findings.find(f => f.level === 'wichtig');
      if (bad) hits.push({ id: String(pg.id), label: `${pg.title} (/${pg.identifier}): ${bad.problem}` });
    }
    if (r.items.length < 50) break;
  }
  return makeFinding(M_DEFS.cmsBroken, hits.length, total, hits, { atLeast: total > 200 });
});

// ---- Translations: only if further store views have a different language ----
reg('magento.translations', 'Sprachen', ['products', 'shop'], async ro => {
  const [views, configs] = await Promise.all([ro.storeViews(), ro.storeConfigs()]);
  const locale = (code: string) => String(configs.find(c => c.code === code)?.locale ?? '');
  const main = locale(ro.storeCode), others = views.filter(v => Number(v.id) > 0 && v.code !== ro.storeCode && v.is_active !== 0 && locale(String(v.code)) && locale(String(v.code)) !== main);
  if (!others.length) return null;
  const glob = await scan(ro, 'all'), out: CheckFinding[] = [];
  for (const v of others) {
    const s = await scan(ro, String(v.code)), hits = untranslated(glob.rows, s.rows);
    const f = makeFinding(M_DEFS.translation, hits.length, s.total, hits, { atLeast: s.capped, title: `Produkte ohne Übersetzung: ${v.name}`, idSuffix: String(v.code), fixExtra: ` Store-View: ${v.name} (${v.code}, ${locale(String(v.code))}).` });
    if (f) out.push(f);
  }
  return out;
});
