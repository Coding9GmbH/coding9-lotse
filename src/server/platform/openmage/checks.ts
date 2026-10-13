import 'server-only';
// OpenMage-Shop-Check: Prüfungen registrieren (SEO, Bilder, Bestand, Preise, Links in Beschreibungen und CMS-Seiten, Übersetzungen).
// Je Durchlauf ein frischer Lese-Client; Daten werden je Lese-Client einmal gelesen (memo) und von allen Prüfungen geteilt.
// Die Produktliste liefert mit ?fields= und ?with=images alles Nötige; große Kataloge: höchstens SCAN_MAX Produkte (Befund „mindestens“).
import type { NeutralProduct, NeutralScan } from '@/lib/custom-checks';
import type { CheckFinding } from '@/lib/protocol';
import { registerPlatformCheck } from '../../checks';
import { makeFinding, type FindingDef, type Hit } from '../../features/shopcheck-rules';
import { extractLinks } from '../../seo-links';
import { attr, attrStr, plain, priceState } from '../magento/map';
import { categoryHits, M_DEFS, productHits, untranslated } from '../magento/checks-rules';
import { catRec } from './audit';
import { checkOmLinks, type OmLinkCache } from './links';
import { mrec, type OmRecord } from './map';
import { LIST_FIELDS, type OmReader } from './reader';

export const SCAN_MAX = 2500, SCAN_PAGE = 200;
/** Befund-Definitionen wie Magento 2, Texte für OpenMage; Bestand kommt aus dem Lagerposten (kein MSI) */
export const OM_DEFS: typeof M_DEFS = Object.fromEntries(Object.entries(M_DEFS).map(([k, d]) => [k, { ...d, hint: d.hint.replace(/Magento/g, 'OpenMage') }])) as typeof M_DEFS;
(OM_DEFS as Record<string, FindingDef>).stockZero = { ...M_DEFS.stockZero, hint: 'Der Lagerposten steht auf „auf Lager“, die Menge ist aber 0. Je nach Einstellung für Nachbestellungen können Kunden bestellen, obwohl nichts da ist.',
  fix: n => `Prüfe alle aktiven Produkte mit Bestand 0, die als „auf Lager“ markiert sind (betrifft ${n}; list_products active=true maxStock=0). Zeig sie mir und frag mich, ob ich Bestand nachtragen oder die Produkte deaktivieren will. Erst dann mit propose_product_changes (stock oder active) vorschlagen.` };

const memos = new WeakMap<OmReader, Map<string, Promise<unknown>>>();
function memo<T>(ro: OmReader, key: string, fn: () => Promise<T>): Promise<T> {
  let m = memos.get(ro); if (!m) memos.set(ro, (m = new Map()));
  if (!m.has(key)) m.set(key, fn());
  return m.get(key) as Promise<T>;
}
/** Link-Auflösungen je Lese-Client teilen: /versand.html oder Kategorie-Links stehen in vielen Beschreibungen und Seiten */
const linkCache = (ro: OmReader) => memo(ro, 'links', async (): Promise<OmLinkCache> => new Map());

/** Aktive, einzeln sichtbare Produkte seitenweise mit Inhalts-/SEO-Feldern und Galerie (store: Store-View, 'admin' = globale Werte) */
async function scan(ro: OmReader, store?: string): Promise<{ rows: OmRecord[]; raw: OmRecord[]; total: number; capped: boolean }> {
  return memo(ro, `scan:${store ?? ''}`, async () => {
    const raw: OmRecord[] = []; let total = 0;
    for (let page = 1; raw.length < SCAN_MAX; page++) {
      const r = await ro.products({ status: 1, visibility: '2,3,4', limit: SCAN_PAGE, page, sort: 'entity_id', dir: 'asc', fields: LIST_FIELDS.join(','), with: 'images', ...(store ? { store } : {}) });
      if (page === 1) total = r.meta.total;
      raw.push(...r.items);
      if (r.items.length < SCAN_PAGE) break;
    }
    return { rows: raw.map(mrec), raw, total, capped: raw.length < total };
  });
}
const hitsOf = (ro: OmReader) => memo(ro, 'hits', async () => {
  const s = await scan(ro);
  const stock = new Map<string, { qty: number; inStock: boolean }>();
  for (const p of s.raw) if (p.qty != null) stock.set(String(p.sku), { qty: Number(p.qty), inStock: !!p.is_in_stock });
  return { s, h: productHits(s.rows, stock), stock };
});
/** Neutrale Produktzeilen für eigene Prüfungen (Bestand aus dem Lagerposten) */
export async function neutralScan(ro: OmReader): Promise<NeutralScan> {
  const { s, stock } = await hitsOf(ro);
  return {
    total: s.total, capped: s.capped,
    rows: s.rows.map((p): NeutralProduct => {
      const pr = priceState(p), name = plain(p.name) || String(p.sku), q = stock.get(String(p.sku));
      return {
        id: String(p.id), name, label: `${name} (${p.sku})`, description: String(attr(p, 'description') ?? ''), metaTitle: plain(attrStr(p, 'meta_title')), metaDescription: plain(attrStr(p, 'meta_description')),
        price: pr.selling, listPrice: pr.list, stock: q ? q.qty : null,
        hasImage: (p.media_gallery_entries ?? []).some((e: OmRecord) => !e.disabled),
      };
    }),
  };
}
type Key = keyof ReturnType<typeof productHits>;
const fromScan = (k: Key, def: FindingDef) => async (ro: OmReader) => {
  const { s, h } = await hitsOf(ro), v = h[k], list = Array.isArray(v) ? { count: v.length, sample: v } : v;
  return makeFinding(def, list.count, s.total, list.sample, { atLeast: s.capped });
};

const reg = (id: string, area: string, scopes: ('products' | 'categories' | 'cms' | 'media' | 'shop')[], run: (ro: OmReader) => Promise<CheckFinding | CheckFinding[] | null>) =>
  registerPlatformCheck<OmReader>('openmage', { id, area, scopes, run });

reg('openmage.meta-description', 'SEO', ['products'], fromScan('metaDescMissing', OM_DEFS.metaDescMissing));
reg('openmage.meta-title', 'SEO', ['products'], fromScan('metaTitleMissing', OM_DEFS.metaTitleMissing));
reg('openmage.meta-title-long', 'SEO', ['products'], fromScan('metaTitleLong', OM_DEFS.metaTitleLong));
reg('openmage.meta-title-duplicate', 'SEO', ['products'], fromScan('metaTitleDup', OM_DEFS.metaTitleDup));
reg('openmage.description-thin', 'SEO', ['products'], fromScan('thin', OM_DEFS.thin));
reg('openmage.no-image', 'Bilder', ['products', 'media'], fromScan('noImage', OM_DEFS.noImage));
reg('openmage.alt-missing', 'Bilder', ['products', 'media'], fromScan('altMissing', OM_DEFS.altMissing));
reg('openmage.stock-zero', 'Daten', ['products'], fromScan('stockZero', OM_DEFS.stockZero));
reg('openmage.price-zero', 'Preise', ['products'], fromScan('priceZero', OM_DEFS.priceZero));
reg('openmage.special-not-below', 'Preise', ['products'], fromScan('specialNotBelow', OM_DEFS.specialNotBelow));

// ---- Links in Produktbeschreibungen ----
reg('openmage.description-links', 'Links', ['products', 'shop'], async ro => {
  const s = await scan(ro), hits: Hit[] = [];
  for (const p of s.raw) {
    const links = extractLinks(String(p.attributes?.description ?? ''));
    if (!links.length) continue;
    const bad = (await checkOmLinks(ro, links, await linkCache(ro))).report.findings.find(f => f.level === 'wichtig');
    if (bad) hits.push({ id: String(p.id), label: `${p.name ?? p.sku} (${p.sku}): ${bad.problem}` });
  }
  return makeFinding(OM_DEFS.descLinks, hits.length, s.total, hits, { atLeast: s.capped });
});

// ---- Kategorien (aktiv, ab Ebene 2; Details für Texte und Metas) ----
const categoryRows = (ro: OmReader) => memo(ro, 'categories', async () => {
  const flat = (await ro.categoriesFlat()).filter(c => Number(c.level) >= 2 && c.is_active).slice(0, 300), rows: OmRecord[] = [];
  for (const c of flat) { const d = await ro.category(c.id); if (d) rows.push(catRec(d)); }
  return rows;
});
reg('openmage.category-meta', 'SEO', ['categories'], async ro => { const rows = await categoryRows(ro), h = categoryHits(rows); return makeFinding(OM_DEFS.catMeta, h.meta.length, rows.length, h.meta); });
reg('openmage.category-description', 'SEO', ['categories'], async ro => { const rows = await categoryRows(ro), h = categoryHits(rows); return makeFinding(OM_DEFS.catDesc, h.desc.length, rows.length, h.desc); });

// ---- CMS-Seiten mit kaputten Links ----
reg('openmage.cms-links', 'Links', ['cms', 'shop'], async ro => {
  const hits: Hit[] = []; let total = 0;
  for (let page = 1; page <= 4; page++) {
    const r = await ro.cmsPages({ is_active: 1, limit: 50, page });
    total = r.meta.total;
    for (const row of r.items) {
      const pg = await ro.cmsPage(row.id); if (!pg) continue;
      const links = extractLinks(String(pg.content ?? ''));
      if (!links.length) continue;
      const bad = (await checkOmLinks(ro, links, await linkCache(ro))).report.findings.find(f => f.level === 'wichtig');
      if (bad) hits.push({ id: String(pg.id), label: `${pg.title} (/${pg.identifier}): ${bad.problem}` });
    }
    if (r.items.length < 50) break;
  }
  return makeFinding(OM_DEFS.cmsBroken, hits.length, total, hits, { atLeast: total > 200 });
});

// ---- Übersetzungen: nur wenn weitere Store-Views eine andere Sprache haben ----
reg('openmage.translations', 'Sprachen', ['products', 'shop'], async ro => {
  const views = await ro.storeViews(), main = await ro.store();
  const locale = (code: string) => String(views.find(v => v.code === code)?.locale ?? '');
  const others = views.filter(v => v.code !== main && v.is_active !== false && locale(v.code) && locale(v.code) !== locale(main));
  if (!others.length) return null;
  const glob = await scan(ro, 'admin'), out: CheckFinding[] = [];
  for (const v of others) {
    const s = await scan(ro, v.code), hits = untranslated(glob.rows, s.rows);
    const f = makeFinding(OM_DEFS.translation, hits.length, s.total, hits, { atLeast: s.capped, title: `Produkte ohne Übersetzung: ${v.name}`, idSuffix: v.code, fixExtra: ` Store-View: ${v.name} (${v.code}, ${locale(v.code)}).` });
    if (f) out.push(f);
  }
  return out;
});
