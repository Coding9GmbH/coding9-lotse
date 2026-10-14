import 'server-only';
// Shopify-Werkzeuge der KI: lesen NUR über den geschützten Reader (session.reader), schreiben NUR über Änderungssets (session.requestChange).
// Namen und Argumente wie bei Shopware, wo die Bedeutung passt (gemeinsame Prompts, Shop-Check-Aufträge); Shopify-eigene nur, wo nötig.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { MAX_ITEMS } from '../../changes';
import { viewedImages } from '../../features/product-images';
import type { Session } from '../../sessions';
import { fail, guard, ok, type AnyTool } from '../../tool-kit';
import { shortId, toGid, type Json } from './client';
import { buildAltTextChangeSet, buildCollectionChangeSet, buildCollectionProductsChangeSet, buildHandlesChangeSet, buildImagesChangeSet, buildNewCollectionsChangeSet, COLLECTION_FIELDS, RULE_COLUMNS, RULE_RELATIONS, checkRules, ruleText, rulesQuery } from './catalog';
import { buildPromotionChangeSet, buildPromotionStatusChangeSet, buildTranslationChangeSet, discountsByIds, discountView, listDiscounts, readTranslations, shopLocales, TR_KEYS, TR_TYPE, type TrEntity } from './content';
import { allVariants, collectionBrief, collectionsByIds, countProducts, cursorAt, mediaRow, pagesByIds, PRODUCT_DETAIL, PRODUCT_LIST, productBrief, productQuery, productsByIds, qField, searchCollections, searchProducts, shopInfo, stripHtml, toNum, variantRow, type ProductFilter, type Q } from './data';
import { BULK_MAX, buildNewProductsChangeSet, buildProductChangeSet, buildVariantsChangeSet, bulkChangeSet, describeBulk, PRODUCT_FIELDS, scanProducts, validateBulk, type BulkChange } from './products';
import { ShopifyReader } from './reader';

export const SHOPIFY_TOOL_NAMES = [
  'search_categories', 'search_products', 'get_product', 'get_category', 'search_media', 'list_products',
  'get_product_images', 'find_image_gaps', 'get_variants', 'list_languages', 'get_translations', 'list_promotions', 'get_promotion', 'get_seo_urls', 'seo_audit',
  'preview_collection_rules', 'preview_bulk_filter',
  'propose_product_changes', 'propose_new_products', 'propose_category_changes', 'propose_collection', 'propose_collection_products',
  'propose_product_images', 'propose_alt_texts', 'propose_variants', 'propose_translations', 'propose_promotion', 'propose_promotion_status', 'propose_seo_urls', 'propose_bulk_product_change',
];

const priceRule = z.object({ percent: z.number().optional(), add: z.number().optional(), set: z.number().optional(), round: z.string().optional().describe('z. B. ".99", ".95", ".00" oder "none"') });
const filterShape = {
  collectionId: z.string().optional().describe('Kollektion (Kategorie)'), term: z.string().optional(), vendor: z.string().optional().describe('Hersteller (Vendor), exakt'),
  productType: z.string().optional(), tag: z.string().optional(), status: z.enum(['active', 'draft', 'archived']).optional(), active: z.boolean().optional(),
  minPrice: z.number().optional(), maxPrice: z.number().optional(), minStock: z.number().optional(), maxStock: z.number().optional(), priceReduced: z.boolean().optional().describe('nur Produkte mit Streichpreis'),
};

export function readerOf(session: Pick<Session, 'reader'>): ShopifyReader {
  if (!(session.reader instanceof ShopifyReader)) throw new Error('Dieses Werkzeug gibt es nur für Shopify.');
  return session.reader;
}
export const qOf = (r: ShopifyReader): Q => (d, v) => r.query(d, v);
export const shopOf = (r: ShopifyReader) => r.memo('shop', () => shopInfo(qOf(r)));

export function shopifyTools(session: Session): AnyTool[] {
  const r = () => readerOf(session), q: Q = (d, v) => r().query(d, v);
  const cur = async () => (await shopOf(r())).currency, taxIncl = async () => (await shopOf(r())).taxesIncluded;
  const propose = async (p: Promise<{ cs: Parameters<Session['requestChange']>[0]; payload?: unknown } | Parameters<Session['requestChange']>[0]>) => {
    const x = await p; return ok('cs' in x ? await session.requestChange(x.cs, x.payload) : await session.requestChange(x));
  };
  return [
    tool('search_categories', 'Kollektionen (in Lotse: Kategorien) suchen (Name) oder ohne term auflisten. type: manual = feste Produktliste, smart = automatisch per Regel (Shopify: Smart Collection). Liefert id, Name, Handle, Produktanzahl, Kurzbeschreibung, SEO.',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => ok((await searchCollections(q, term, Math.min(limit ?? 30, 100))).nodes.map(collectionBrief)))),

    tool('search_products', 'Produkte suchen (Freitext: Titel, Hersteller, Typ, Tags, SKU) und/oder auf eine Kollektion (categoryId) einschränken.',
      { term: z.string().optional(), categoryId: z.string().optional().describe('Kollektion'), limit: z.number().optional() }, guard(async ({ term, categoryId, limit }) => {
        const query = productQuery({ term, collectionId: categoryId }), c = await cur();
        const [res, total] = await Promise.all([searchProducts(q, query, { first: Math.min(limit ?? 15, 50), sortKey: term ? 'RELEVANCE' : 'TITLE' }), countProducts(q, query)]);
        return ok({ total: total.count, pricesIncludeTax: await taxIncl(), products: res.nodes.map(p => productBrief(p, c)) });
      })),

    tool('get_product', 'Produktdetails: Beschreibung (HTML), SEO (seo.title/description), Status, Hersteller, Produkttyp, Tags, Optionen und Varianten (Preis, Vergleichspreis = Streichpreis, SKU, Barcode, Bestand), Bilder (mediaId, URL, Alt-Text), Kollektionen, FAQ-Metafeld, Shop-URL.',
      { id: z.string() }, guard(async ({ id }) => {
        const [p] = await productsByIds(q, [id], PRODUCT_DETAIL, 1); if (!p) return fail('Produkt nicht gefunden');
        const c = await cur(); let faq: unknown = null; try { faq = p.faq?.value ? JSON.parse(p.faq.value) : null; } catch { /* kein JSON */ }
        return ok({
          ...productBrief({ ...p, featuredMedia: p.media?.nodes?.[0] }, c), description: p.descriptionHtml, metaTitle: p.seo?.title ?? null, metaDescription: p.seo?.description ?? null,
          productType: p.productType || null, tags: p.tags, url: p.onlineStoreUrl ?? null, publishedOnline: !!p.onlineStoreUrl, stock: p.tracksInventory ? p.totalInventory : null, stockTracked: !!p.tracksInventory,
          options: (p.options ?? []).filter((o: Json) => !(o.name === 'Title' && o.values?.[0] === 'Default Title')).map((o: Json) => ({ name: o.name, values: o.values })),
          variants: p.variants.nodes.map((v: Json) => variantRow(v, c)), moreVariants: !!p.variants.pageInfo?.hasNextPage,
          images: p.media.nodes.filter((m: Json) => m.image?.url).map((m: Json) => mediaRow(m)), categories: p.collections.nodes.map((x: Json) => ({ id: shortId(x.id), name: x.title })),
          faq: (faq as { items?: unknown })?.items ?? null, pricesIncludeTax: await taxIncl(),
        });
      })),

    tool('get_category', 'Kollektion im Detail: Beschreibung (HTML), SEO, Handle/URL, Art (manuell oder automatisch mit Regel), Sortierung, Produktanzahl und die ersten Produkte.',
      { id: z.string() }, guard(async ({ id }) => {
        const [c] = await collectionsByIds(q, [id], `id title handle descriptionHtml sortOrder onlineStoreUrl seo { title description } ruleSet { appliedDisjunctively rules { column relation condition } } productsCount { count } image { url altText } products(first: 12) { nodes { id title } }`);
        if (!c) return fail('Kollektion nicht gefunden');
        return ok({ id: shortId(c.id), name: c.title, handle: c.handle, url: c.onlineStoreUrl ?? null, publishedOnline: !!c.onlineStoreUrl, description: c.descriptionHtml, metaTitle: c.seo?.title ?? null, metaDescription: c.seo?.description ?? null,
          type: c.ruleSet ? 'smart' : 'manual', rule: c.ruleSet ? ruleText(c.ruleSet.rules, c.ruleSet.appliedDisjunctively) : null, rules: c.ruleSet?.rules ?? null, disjunctive: c.ruleSet?.appliedDisjunctively ?? null,
          sortOrder: c.sortOrder, products: c.productsCount?.count ?? null, sample: c.products.nodes.map((p: Json) => ({ id: shortId(p.id), name: p.title })), image: c.image?.url ?? null });
      })),

    tool('search_media', 'Dateien (Bilder) im Shopify-Admin unter Inhalte → Dateien durchsuchen (vorhandene Bilder wiederverwenden). Liefert mediaId, URL, Alt-Text; aiGenerated: true = KI-Bild (muss gekennzeichnet sein).',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        const t = term ? stripHtml(term).replace(/[^\p{L}\p{N} _.-]/gu, '').trim() : '';
        const res = await q<Json>('query Files($first: Int!, $query: String) { files(first: $first, query: $query) { nodes { id alt ... on MediaImage { image { url altText } } } } }', { first: Math.min(limit ?? 20, 50), query: ['media_type:IMAGE', t ? `filename:*${t.split(' ')[0]}*` : ''].filter(Boolean).join(' AND ') });
        return ok(res.files.nodes.filter((m: Json) => m.image?.url).map((m: Json) => ({ ...mediaRow(m), file: String(m.image.url).split('/').pop()?.split('?')[0] })));
      })),

    tool('list_products', 'Produkte in großer Zahl LESEN (für Preis-/Daten-Analysen und Massenänderungen): Preis (kleinster Variantenpreis als Zahl, bei Varianten mit Spanne), Streichpreis, Bestand, Status, Hersteller, Typ, Tags, Textlängen, SEO vorhanden. Filter: Kollektion, Suchbegriff, Hersteller, Typ, Tag, Status/aktiv, Preisspanne, Bestand. Paginierung: cursor = nextCursor der letzten Antwort (oder offset). Max. 50 je Aufruf (details: 25).',
      { categoryId: z.string().optional(), term: z.string().optional(), vendor: z.string().optional(), productType: z.string().optional(), tag: z.string().optional(), status: z.enum(['active', 'draft', 'archived']).optional(), active: z.boolean().optional(),
        minPrice: z.number().optional(), maxPrice: z.number().optional(), maxStock: z.number().optional(), priceReduced: z.boolean().optional(),
        details: z.boolean().optional().describe('true = zusätzlich Beschreibung als Text (gekürzt) + Optionen'), limit: z.number().optional(), cursor: z.string().optional(), offset: z.number().optional() },
      guard(async a => {
        const f: ProductFilter = { ...a, collectionId: a.categoryId }, query = productQuery(f), limit = Math.min(a.limit ?? 50, a.details ? 25 : 50), c = await cur();
        const after = a.cursor ?? (a.offset ? await cursorAt(q, query, a.offset, 'ID') : null);
        const [res, total] = await Promise.all([searchProducts(q, query, { first: limit, after, sortKey: 'ID', sel: `${PRODUCT_LIST}${a.details ? ' options { name values }' : ''}` }), countProducts(q, query)]);
        return ok({ total: total.count, totalExact: total.exact, returned: res.nodes.length, pricesIncludeTax: await taxIncl(), nextCursor: res.pageInfo.hasNextPage ? res.pageInfo.endCursor : null,
          products: res.nodes.map(p => ({ id: shortId(p.id), number: p.variants?.nodes?.[0]?.sku ?? null, name: p.title, price: toNum(p.priceRangeV2?.minVariantPrice?.amount), maxPrice: toNum(p.priceRangeV2?.maxVariantPrice?.amount), currency: c,
            listPrice: toNum(p.compareAtPriceRange?.maxVariantCompareAtPrice?.amount) || null, variants: p.variantsCount?.count ?? null, stock: p.tracksInventory ? p.totalInventory : null, status: p.status, active: p.status === 'ACTIVE',
            vendor: p.vendor || null, productType: p.productType || null, tags: p.tags, descriptionLength: stripHtml(p.descriptionHtml).length, hasMetaTitle: !!p.seo?.title, hasMetaDescription: !!p.seo?.description, hasImage: !!p.featuredMedia,
            ...(a.details ? { description: stripHtml(p.descriptionHtml).slice(0, 500), options: (p.options ?? []).filter((o: Json) => o.name !== 'Title').map((o: Json) => `${o.name}: ${o.values.join(', ')}`) } : {}) })) });
      })),

    tool('get_product_images', 'Liest die Bilder von 1 bis 50 Produkten: je Bild mediaId, Position (0 = Titelbild), URL, Alt-Text, altMissing, aiGenerated. Ändert nichts.',
      { productIds: z.array(z.string()) }, guard(async ({ productIds }) => {
        if (productIds.length > 50) return fail('Maximal 50 Produkte');
        const rows = await productsByIds(q, productIds, 'id title media(first: 100) { nodes { id alt status ... on MediaImage { image { url altText } } } }', 4);
        return ok(rows.map(p => ({ id: shortId(p.id), name: p.title, images: p.media.nodes.map((m: Json, i: number) => ({ ...mediaRow(m), position: i, cover: i === 0, altMissing: !(m.alt || m.image?.altText), status: m.status })) })));
      })),

    tool('find_image_gaps', 'Findet Produkte mit Bildlücken (seitenweise, mit cursor): missing="images" = ohne Bild; missing="alt" = mindestens ein Bild ohne Alt-Text (mit mediaId/URL). Filter: Kollektion, Status. Ändert nichts.',
      { missing: z.enum(['images', 'alt']), categoryId: z.string().optional(), active: z.boolean().optional(), cursor: z.string().optional() }, guard(async a => {
        const query = productQuery({ collectionId: a.categoryId, active: a.active }), out: Json[] = []; let after = a.cursor ?? null, scanned = 0, next: string | null = null;
        while (out.length < 50 && scanned < 500) {
          const res = await searchProducts(q, query, { first: 20, after, sortKey: 'ID', sel: 'id title status media(first: 20) { nodes { id alt ... on MediaImage { image { url altText } } } }' });
          scanned += res.nodes.length;
          for (const p of res.nodes) {
            const media: Json[] = p.media.nodes;
            if (a.missing === 'images' && !media.length) out.push({ id: shortId(p.id), name: p.title, status: p.status });
            if (a.missing === 'alt') { const gaps = media.filter(m => !(m.alt || m.image?.altText)); if (gaps.length) out.push({ id: shortId(p.id), name: p.title, images: gaps.map(mediaRow) }); }
          }
          next = res.pageInfo.hasNextPage ? res.pageInfo.endCursor : null; after = next; if (!next) break;
        }
        return ok({ found: out.length, scanned, nextCursor: next, products: out });
      })),

    tool('get_variants', 'Liest alle Varianten eines Produkts: Optionen (z. B. Farbe, Größe) mit Werten, je Variante id, Titel, Optionswerte, Preis, Vergleichspreis, SKU, Barcode, Bestand. Ändert nichts.',
      { productId: z.string() }, guard(async ({ productId }) => {
        const [p] = await productsByIds(q, [productId], undefined, 1); if (!p) return fail('Produkt nicht gefunden');
        const vs = await allVariants(q, p), c = await cur();
        return ok({ id: shortId(p.id), name: p.title, hasOnlyDefaultVariant: !!p.hasOnlyDefaultVariant, pricesIncludeTax: await taxIncl(), options: p.options.filter((o: Json) => !(o.name === 'Title' && o.values?.[0] === 'Default Title')).map((o: Json) => ({ name: o.name, values: o.values })), variants: vs.map(v => variantRow(v, c)) });
      })),

    tool('list_languages', 'Sprachen des Shops (Locales): Hauptsprache (primary) und weitere, ob veröffentlicht. Übersetzungen gibt es nur für die weiteren Sprachen. Ändert nichts.', {}, guard(async () => ok(await shopLocales(q)))),

    tool('get_translations', 'Liest Quelltexte (Hauptsprache) und Übersetzungen JE SPRACHE für Produkte, Kollektionen oder Seiten: name, description (HTML), metaTitle, metaDescription, handle (URL), productType. missing = fehlt in dieser Sprache, outdated = Quelltext seitdem geändert. full=true liefert ungekürzte Texte (Basis zum Übersetzen). Max. 50 ids.',
      { entity: z.enum(['product', 'category', 'page']), ids: z.array(z.string()), language: z.string().describe('Locale, z. B. "en"'), full: z.boolean().optional() }, guard(async a => {
        if (a.ids.length > 50) return fail('Maximal 50 ids');
        const res = await readTranslations(q, a.ids.map(i => toGid(TR_TYPE[a.entity as TrEntity], i)), a.language), back = Object.fromEntries(Object.entries(TR_KEYS).map(([k, v]) => [v, k]));
        const t = (s: unknown) => (a.full ? s : typeof s === 'string' && s.length > 400 ? s.slice(0, 400) + '…' : s);
        return ok([...res.values()].map(n => {
          const tr = new Map<string, Json>(n.translations.map((x: Json) => [x.key, x]));
          const fields = n.translatableContent.filter((x: Json) => back[x.key]).map((x: Json) => ({ field: back[x.key], source: t(x.value), translation: t(tr.get(x.key)?.value ?? null), missing: !tr.get(x.key)?.value, outdated: !!tr.get(x.key)?.outdated }));
          return { id: shortId(n.resourceId), language: a.language, fields };
        }));
      })),

    tool('list_promotions', 'LIEST Rabattcodes (Promotionen): Titel, Status (läuft/geplant/abgelaufen), Zeitraum, Codes, Wert, Geltungsbereich, Mindestbestellwert, Limits, Anzahl Einlösungen (nur Zählwerte, nie Kunden oder Bestellungen). Filter status/term, max. 25 je Aufruf, Paginierung per cursor.',
      { status: z.enum(['active', 'scheduled', 'expired', 'all']).optional(), term: z.string().optional(), limit: z.number().optional(), cursor: z.string().optional() }, guard(async a => {
        const res = await listDiscounts(q, { status: a.status, term: a.term, first: a.limit, after: a.cursor }), c = await cur();
        const tz = (await shopOf(r())).timezone;
        return ok({ returned: res.nodes.length, nextCursor: res.pageInfo.hasNextPage ? res.pageInfo.endCursor : null, promotions: res.nodes.map((n: Json) => discountView(n, c, tz)) });
      })),
    tool('get_promotion', 'LIEST einen Rabattcode im Detail (wie list_promotions, mit Produkten/Kollektionen des Geltungsbereichs und Kombinierbarkeit).', { id: z.string() }, guard(async ({ id }) => {
      const [n] = await discountsByIds(q, [id]), s = await shopOf(r()); return n ? ok(discountView(n, s.currency, s.timezone)) : fail('Rabatt nicht gefunden');
    })),

    tool('get_seo_urls', 'Liefert die Storefront-URLs (Handle) von Produkten, Kollektionen und Seiten als Pfad und absolute URL, dazu bestehende Weiterleitungen auf diese URL. Ändert nichts.',
      { productIds: z.array(z.string()).optional(), categoryIds: z.array(z.string()).optional(), pageIds: z.array(z.string()).optional() }, guard(async a => {
        const base = (await shopOf(r())).primaryUrl, out: Json[] = [];
        const add = (kind: string, prefix: string, rows: Json[]) => rows.forEach(x => out.push({ kind, id: shortId(x.id), name: x.title, handle: x.handle, path: `/${prefix}/${x.handle}`, url: `${base}/${prefix}/${x.handle}` }));
        if (a.productIds?.length) add('product', 'products', await productsByIds(q, a.productIds, 'id title handle', 50));
        if (a.categoryIds?.length) add('category', 'collections', await collectionsByIds(q, a.categoryIds, 'id title handle'));
        if (a.pageIds?.length) add('page', 'pages', await pagesByIds(q, a.pageIds));
        // Weiterleitungen auf diese Pfade: eine Abfrage je 50 Pfade, clientseitig zugeordnet
        const rows = out.slice(0, 50), hits = new Map<string, string[]>();
        for (let i = 0; i < rows.length; i += 50) {
          const chunk = rows.slice(i, i + 50);
          const res = await q<Json>('query Redirects($query: String) { urlRedirects(first: 250, query: $query) { nodes { path target } } }', { query: chunk.map(x => qField('target', x.path)).join(' OR ') });
          for (const y of res.urlRedirects.nodes as Json[]) hits.set(y.target, [...(hits.get(y.target) ?? []), y.path]);
        }
        for (const x of rows) x.redirectsHere = (hits.get(x.path) ?? []).slice(0, 10);
        return ok(out);
      })),

    tool('seo_audit', 'SEO-Check (nur lesen) seitenweise: entity=product|category prüft Meta-Title (fehlt, > 60, < 30, doppelt), Meta-Description (fehlt, außerhalb 120 bis 158), dünne Beschreibung (< 50 Wörter), Bild/Alt-Texte (Produkte). cursor = nextCursor.',
      { entity: z.enum(['product', 'category']), limit: z.number().optional().describe('Produkte max. 50, Kollektionen max. 100 je Seite'), cursor: z.string().optional(), includeInactive: z.boolean().optional() }, guard(async a => {
        const first = Math.min(a.limit ?? 50, a.entity === 'product' ? 50 : 100), words = (h: unknown) => stripHtml(h).split(/\s+/).filter(Boolean).length;
        const rows: Json[] = [], page = a.entity === 'product'
          ? await searchProducts(q, a.includeInactive ? '' : 'status:active', { first, after: a.cursor ?? null, sortKey: 'ID', sel: 'id title status descriptionHtml seo { title description } media(first: 5) { nodes { id alt ... on MediaImage { image { altText } } } }' })
          : await searchCollections(q, undefined, first, a.cursor ?? null);
        const titles = new Map<string, number>(); for (const x of page.nodes) if (x.seo?.title) titles.set(x.seo.title, (titles.get(x.seo.title) ?? 0) + 1);
        for (const x of page.nodes) {
          const issues: string[] = [], mt = x.seo?.title ?? '', md = x.seo?.description ?? '';
          if (!mt) issues.push('Meta-Title fehlt'); else { if (mt.length > 60) issues.push(`Meta-Title ${mt.length} Zeichen`); if (mt.length < 30) issues.push(`Meta-Title nur ${mt.length} Zeichen`); if ((titles.get(mt) ?? 0) > 1) issues.push('Meta-Title doppelt'); }
          if (!md) issues.push('Meta-Description fehlt'); else if (md.length < 120 || md.length > 158) issues.push(`Meta-Description ${md.length} Zeichen`);
          if (words(x.descriptionHtml) < 50) issues.push(`Beschreibung ${words(x.descriptionHtml)} Wörter`);
          if (a.entity === 'product') { const m: Json[] = x.media?.nodes ?? []; if (!m.length) issues.push('kein Bild'); const noAlt = m.filter(y => !(y.alt || y.image?.altText)).length; if (noAlt) issues.push(`${noAlt} Bild(er) ohne Alt-Text`); }
          if (issues.length) rows.push({ id: shortId(x.id), name: x.title, issues });
        }
        return ok({ checked: page.nodes.length, withIssues: rows.length, nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null, note: 'Hinweis: Shopify nutzt ohne eigenen Meta-Title den Produkt-/Kollektionsnamen, ohne Meta-Description den Anfang der Beschreibung.', items: rows });
      })),

    tool('preview_collection_rules', `PRÜFT eine Regel für eine automatische Kollektion, bevor sie vorgeschlagen wird: lesbare Regel, Trefferzahl und Beispielprodukte (soweit vorab prüfbar). columns: ${RULE_COLUMNS.join(', ')}; relations: ${RULE_RELATIONS.join(', ')}. Schreibt nichts.`,
      { rules: z.array(z.object({ column: z.string(), relation: z.string(), condition: z.string() })), disjunctive: z.boolean().optional().describe('true = ODER, Standard UND') }, guard(async a => {
        const rules = checkRules(a.rules), query = rulesQuery(rules, !!a.disjunctive), text = ruleText(rules, !!a.disjunctive);
        if (query == null) return ok({ rule: text, count: null, note: 'Diese Regelart lässt sich vorab nicht zählen; Shopify ermittelt die Produkte nach dem Anlegen.' });
        const [n, s] = await Promise.all([countProducts(q, query), searchProducts(q, query, { first: 8 })]);
        return ok({ rule: text, count: n.count, sample: s.nodes.map(p => ({ id: shortId(p.id), name: p.title, status: p.status })) });
      })),

    tool('preview_bulk_filter', 'Zählt, welche Produkte ein Stapel-Filter trifft, und zeigt 10 Beispiele, um den Umfang VOR propose_bulk_product_change mit dem Nutzer abzustimmen. Ändert nichts.',
      filterShape, guard(async (f: ProductFilter) => {
        const query = productQuery(f), [n, s] = await Promise.all([countProducts(q, query), searchProducts(q, query, { first: 10, sortKey: 'ID' })]), c = await cur();
        return ok({ count: n.count, exact: n.exact, query, sample: s.nodes.map(p => productBrief(p, c)) });
      })),

    // ---------------- Vorschläge (Änderungssets) ----------------
    tool('propose_product_changes', `SCHLÄGT Änderungen an einem oder vielen Produkten vor (max. ${MAX_ITEMS}). Es wird NICHTS geschrieben: Der Nutzer sieht Alt und Neu, wählt aus und gibt frei; erst dann schreibt der Server. Der Aufruf wartet auf die Entscheidung. Felder: ${Object.keys(PRODUCT_FIELDS).join(', ')}. Preise gelten bei Shopify je Variante: price/listPrice ändern ALLE Varianten des Produkts (einzelne Varianten: propose_variants). Preis als Zahl ODER Regel (der Server rechnet je Variante): {percent:-10, round:".99"} | {add:2.5} | {set:19.99}; listPrice = Vergleichspreis (Streichpreis), null entfernt ihn. active true/false = Status aktiv/Entwurf; status ACTIVE|DRAFT|ARCHIVED. tags = Liste (ersetzt) oder {add:[], remove:[]}. sku/barcode nur bei Produkten ohne Varianten. faq = {title?, items:[{q,a}]} (2 bis 10 Paare, Metafeld lotse.faq). Bestand ist nur lesbar.`,
      { title: z.string().describe('Kurzer Titel, z. B. "Sommerpreise Keramik −10 %"'), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('Produkt-ID'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => propose(cur().then(c => buildProductChangeSet(q, a, c))))),

    tool('propose_new_products', 'SCHLÄGT NEUE PRODUKTE vor (z. B. aus hochgeladenen Fotos: erst view_image, dann Name, Beschreibung, SEO aus dem Bild ableiten). Es wird NICHTS geschrieben, bis der Nutzer freigibt. Standard: Entwurf (DRAFT, nicht im Online Store). Preis NIE schätzen: fehlt er, per ask_user erfragen. Keine erfundenen Fakten. Bilder: mediaId (Datei/Anhang), "staged:…" oder https-URL; erstes = Titelbild. collectionIds nur manuelle Kollektionen.',
      { title: z.string(), reason: z.string(), products: z.array(z.object({
        name: z.string(), description: z.string().describe('HTML: 2 bis 4 kurze Absätze/Liste, konkret'), price: z.number(), listPrice: z.number().nullable().optional().describe('Vergleichspreis (Streichpreis)'),
        sku: z.string().optional(), barcode: z.string().optional(), vendor: z.string().optional(), productType: z.string().optional(), tags: z.array(z.string()).optional(),
        metaTitle: z.string().optional(), metaDescription: z.string().optional(), collectionIds: z.array(z.string()).optional(), images: z.array(z.string()).optional(), active: z.boolean().optional().describe('Standard false = Entwurf'),
      })) }, guard(async a => propose(cur().then(c => buildNewProductsChangeSet(q, a, c))))),

    tool('propose_category_changes', `SCHLÄGT Änderungen an Kollektionen vor (Freigabe-Workflow). Felder: ${Object.keys(COLLECTION_FIELDS).join(', ')} (description = HTML; active = im Online Store veröffentlicht; sortOrder = MANUAL, BEST_SELLING, ALPHA_ASC, ALPHA_DESC, PRICE_ASC, PRICE_DESC, CREATED, CREATED_DESC).`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('Kollektions-ID'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => propose(buildCollectionChangeSet(q, a)))),

    tool('propose_collection', `SCHLÄGT neue Kollektionen vor oder ändert Regel/Sortierung bestehender automatischer Kollektionen (mit id). Automatisch (Regel, Shopify: Smart Collection): rules [{column, relation, condition}] (column: ${RULE_COLUMNS.join(', ')}; relation: ${RULE_RELATIONS.join(', ')}), disjunctive=true = ODER. Manuell: productIds. Neue Kollektionen sind nicht im Online Store veröffentlicht, außer publish:true. Vorher preview_collection_rules. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), collections: z.array(z.object({ id: z.string().optional(), name: z.string().optional(), description: z.string().optional(), metaTitle: z.string().optional(), metaDescription: z.string().optional(), handle: z.string().optional(),
        rules: z.array(z.object({ column: z.string(), relation: z.string(), condition: z.string() })).optional(), disjunctive: z.boolean().optional(), productIds: z.array(z.string()).optional(), sortOrder: z.string().optional(), publish: z.boolean().optional() })).min(1) },
      guard(async a => propose(buildNewCollectionsChangeSet(q, a, async query => (await countProducts(q, query)).count)))),

    tool('propose_collection_products', 'SCHLÄGT vor, Produkte in eine MANUELLE Kollektion aufzunehmen (add) oder daraus zu entfernen (remove). Automatische Kollektionen füllen sich über ihre Regel. Es wird NICHTS geschrieben, bis der Nutzer freigibt.',
      { title: z.string(), reason: z.string(), collectionId: z.string(), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() },
      guard(async a => propose(buildCollectionProductsChangeSet(q, a)))),

    tool('propose_product_images', `SCHLÄGT Bildänderungen an Produkten vor (max. ${MAX_ITEMS} Produkte): add (image = mediaId einer Datei/eines Anhangs, "staged:…" oder https-URL; position 0 = vorne, sonst hinten), remove (mediaId; Datei bleibt unter Inhalte → Dateien), order (Reihenfolge), cover (Titelbild). Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), products: z.array(z.object({ productId: z.string(), add: z.array(z.object({ image: z.string(), position: z.number().optional(), alt: z.string().optional() })).optional(), remove: z.array(z.string()).optional(), order: z.array(z.string()).optional(), cover: z.string().optional() })) },
      guard(async a => propose(buildImagesChangeSet(q, a)))),

    tool('propose_alt_texts', `SCHLÄGT Alt-Texte für Bilder vor (max. ${MAX_ITEMS}). Jedes Bild MUSS vorher mit view_image angesehen worden sein, sonst wird es übersprungen. Konkret beschreiben, was zu sehen ist (Produkt, Farbe, Material, Szene), höchstens etwa 125 Zeichen, ohne "Bild von". Gilt überall, wo die Datei verwendet wird. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), images: z.array(z.object({ mediaId: z.string(), alt: z.string() })) },
      guard(async a => propose(buildAltTextChangeSet(q, a, viewedImages(session.events))))),

    tool('propose_variants', 'SCHLÄGT Varianten-Änderungen für EIN Produkt vor: update (je Variante price/listPrice als Zahl oder Regel {percent|add|set, round}, sku, barcode), updateAll (Preisregel für alle Varianten), create (neue Varianten mit Werten für ALLE vorhandenen Optionen, z. B. {options:{Farbe:"Salbei", Größe:"350 ml"}, price}). Neue Optionen (Achsen) legt der Nutzer im Shopify-Admin an. Bestand ist nur lesbar. Es wird NICHTS geschrieben, bis der Nutzer freigibt.',
      { title: z.string(), reason: z.string(), productId: z.string(),
        update: z.array(z.object({ id: z.string(), price: z.union([z.number(), priceRule]).optional(), listPrice: z.union([z.number(), priceRule]).nullable().optional(), sku: z.string().optional(), barcode: z.string().optional() })).optional(),
        updateAll: z.object({ price: z.union([z.number(), priceRule]).optional(), listPrice: z.union([z.number(), priceRule]).nullable().optional() }).optional(),
        create: z.array(z.object({ options: z.record(z.string(), z.string()), price: z.number().optional(), listPrice: z.number().nullable().optional(), sku: z.string().optional(), barcode: z.string().optional() })).optional() },
      guard(async a => propose(cur().then(c => buildVariantsChangeSet(q, a, c))))),

    tool('propose_translations', `SCHLÄGT Übersetzungen für Produkte, Kollektionen (category) oder Seiten (page) vor, je Datensatz und Sprache (Locale aus list_languages, nicht die Hauptsprache). Felder: ${Object.keys(TR_KEYS).join(', ')} (description = HTML, handle = URL-Pfad in der Sprache). Max. ${MAX_ITEMS} Einträge. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), entity: z.enum(['product', 'category', 'page']), changes: z.array(z.object({ id: z.string(), language: z.string(), fields: z.record(z.string(), z.any()) })) },
      guard(async a => propose(buildTranslationChangeSet(q, a)))),

    tool('propose_promotion', 'SCHLÄGT einen neuen Rabattcode vor (ohne id) oder ändert einen bestehenden (mit id: title, startsAt, endsAt, usageLimit, oncePerCustomer, value+type, combinesWith). Neu: title, code, type (percentage = %, amount = Betrag) und value sind Pflicht; Geltungsbereich alle Artikel oder productIds bzw. collectionIds; minimumSubtotal oder minimumQuantity; Datum JJJJ-MM-TT. Gilt für alle Kunden. Es wird NICHTS geschrieben, bis der Nutzer freigibt.',
      { id: z.string().optional(), reason: z.string(), title: z.string().optional(), code: z.string().optional(), type: z.enum(['percentage', 'amount']).optional(), value: z.number().optional(), appliesOnEachItem: z.boolean().optional(),
        productIds: z.array(z.string()).optional(), collectionIds: z.array(z.string()).optional(), minimumSubtotal: z.number().nullable().optional(), minimumQuantity: z.number().nullable().optional(),
        startsAt: z.string().optional(), endsAt: z.string().nullable().optional(), usageLimit: z.number().nullable().optional(), oncePerCustomer: z.boolean().optional(),
        combinesWith: z.object({ productDiscounts: z.boolean().optional(), orderDiscounts: z.boolean().optional(), shippingDiscounts: z.boolean().optional() }).optional() },
      guard(async a => propose(shopOf(r()).then(s => buildPromotionChangeSet(q, a, s))))),

    tool('propose_promotion_status', `SCHLÄGT vor, Rabattcodes (max. ${MAX_ITEMS}) zu aktivieren (läuft ab jetzt, ohne Enddatum) oder zu beenden (deactivate: Ende = jetzt). Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { ids: z.array(z.string()), action: z.enum(['activate', 'deactivate']), reason: z.string().optional() },
      guard(async a => propose(shopOf(r()).then(s => buildPromotionStatusChangeSet(q, a, s))))),

    tool('propose_seo_urls', 'SCHLÄGT neue URL-Handles (SEO-URLs) für Produkte, Kollektionen (category) oder Seiten (page) vor. Der Server normalisiert den Slug (klein, ä→ae ö→oe ü→ue ß→ss, Bindestriche) und prüft, ob er frei ist. Beim Anwenden legt Shopify eine Weiterleitung von der alten URL an. Es wird NICHTS geschrieben, bis der Nutzer freigibt.',
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ entity: z.enum(['product', 'category', 'page']), id: z.string(), slug: z.string() })) },
      guard(async a => propose(buildHandlesChangeSet(q, a)))),

    tool('propose_bulk_product_change', `STAPELVERARBEITUNG: SCHLÄGT EINE Regel für ALLE Produkte eines Filters vor, auch Tausende (bis ${BULK_MAX.toLocaleString('de-DE')}). Der Server liest alle passenden Produkte seitenweise, rechnet je Variante und zeigt Gruppen (ohne/mit Warnungen, abwählbar) und eine Stichprobe. Filter wie preview_bulk_filter. change: price {percent|add|set, round}, listPrice {…} | null (entfernen) | "currentPrice" (Streichpreis = bisheriger Preis), active, status, tags {add, remove}. Bestand ist nur lesbar. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), filter: z.object(filterShape), change: z.object({ price: priceRule.optional(), listPrice: z.union([priceRule, z.null(), z.literal('currentPrice')]).optional(), active: z.boolean().optional(), status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).optional(), tags: z.object({ add: z.array(z.string()).optional(), remove: z.array(z.string()).optional() }).optional() }) },
      guard(async ({ title, reason, filter, change }) => {
        validateBulk(change as BulkChange);
        if (!Object.values(filter).some(v => v !== undefined)) return fail('filter ist leer: für den ganzen Katalog bitte ausdrücklich bestätigen lassen und z. B. status:"active" setzen.');
        const c = await cur(), rows = await scanProducts(q, filter as ProductFilter);
        const { cs, payload } = bulkChangeSet(title, `${reason} (${describeBulk(change as BulkChange, c)})`, change as BulkChange, rows, c);
        return ok(await session.requestChange(cs, payload));
      })),
  ] as AnyTool[];
}

