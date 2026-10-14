import 'server-only';
// Magento tools for the AI: read only via the protected read client (session.reader), write only via change sets.
// Names and arguments as in Shopware where the meaning matches (shared prompts, shop check tasks, onboarding).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { viewedImages } from '../../features/product-images';
import type { Session } from '../../sessions';
import { fail, guard, lim, ok, type AnyTool } from '../../tool-kit';
import { MAX_ITEMS } from './kit';
import { likeTerm, type Filter } from './criteria';
import { attr, attrStr, basisWord, isActive, money, plain, priceState, VISIBILITY, type MCategory, type MProduct, type MRecord } from './map';
import { MagentoReader } from './reader';
import { buildCategoryChangeSet, buildCategoryProductsChangeSet, buildProductChangeSet, buildSeoUrlChangeSet, buildTranslationChangeSet, M_CATEGORY_FIELDS, M_PRODUCT_FIELDS, storeViewList, TRANSLATION_FIELDS } from './catalog';
import { ALT_MAX, buildAltTextChangeSet, buildNewProductsChangeSet, buildProductImagesChangeSet, imageRows } from './images';
import { buildPromotionChangeSet, buildPromotionStatusChangeSet, MAX_CODES, promoStatus, promoView } from './promo';
import { buildVariantsChangeSet, readVariants } from './variants';
import { BULK_MAX, bulkChangeSet, describeBulk, resolveBulk, scanHint, type BulkChange } from './bulk';
import { productCategoryIds } from './lookup';
import { seoAudit } from './audit';
import { buildCmsPageChangeSet, CMS_FIELDS, getCms, listCms } from './cms';
import { parseStorefront, assertShopUrl, fetchShopPage } from '../../storefront';

export const MAGENTO_TOOL_NAMES = [
  'list_store_views', 'search_categories', 'search_products', 'get_product', 'get_category', 'search_media', 'list_cms_pages', 'get_cms_page', 'read_page', 'list_products', 'list_product_attributes', 'get_seo_urls', 'seo_audit',
  'get_product_images', 'find_image_gaps', 'get_translations', 'get_variants', 'preview_bulk_filter', 'list_promotions', 'get_promotion',
  'propose_product_changes', 'propose_new_products', 'propose_category_changes', 'propose_category_products', 'propose_product_images', 'propose_alt_texts',
  'propose_translations', 'propose_seo_urls', 'propose_variants', 'propose_bulk_product_change', 'propose_promotion', 'propose_cms_page_changes', 'propose_promotion_status',
];

/** The session's read client (checked: only the Magento reader) */
export function magentoReader(session: Pick<Session, 'reader'>): MagentoReader {
  if (!(session.reader instanceof MagentoReader)) throw new Error('Dieses Werkzeug gibt es nur für Magento.');
  return session.reader;
}
const excerpt = (t: unknown, n = 200) => { const s = plain(t); return s.length > n ? `${s.slice(0, n)}…` : s; };

export function magentoTools(session: Session): AnyTool[] {
  const ro = () => magentoReader(session);
  const sf = async () => ({ base: await ro().storefrontBase().catch(() => ro().publicUrl), cfg: await ro().storefrontConfig().catch(() => ({ product_url_suffix: '.html', category_url_suffix: '.html' })) });
  const productUrl = async (p: MRecord) => { const k = attrStr(p, 'url_key'); if (!k || Number(p.visibility) === 1) return null; const s = await sf(); return `${s.base}/${k}${s.cfg.product_url_suffix ?? ''}`; };
  const categoryUrl = async (c: MRecord) => { const k = attrStr(c, 'url_path') ?? attrStr(c, 'url_key'); if (!k) return null; const s = await sf(); return `${s.base}/${k}${s.cfg.category_url_suffix ?? ''}`; };
  /** Category names + path from the tree (once per session) */
  const treeIndex = async () => {
    const idx = new Map<string, { name: string; parent: string | null; level: number; active: boolean; count: number }>();
    const walk = (c: MCategory, parent: string | null) => { idx.set(String(c.id), { name: String(c.name ?? ''), parent, level: Number(c.level ?? 0), active: !!c.is_active, count: Number(c.product_count ?? 0) }); for (const k of c.children_data ?? []) walk(k, String(c.id)); };
    walk(await ro().categoryTree(), null);
    return idx;
  };
  const crumb = (idx: Awaited<ReturnType<typeof treeIndex>>, id: string) => { const out: string[] = []; let cur: string | null = id; while (cur && idx.has(cur) && idx.get(cur)!.level > 1) { out.unshift(idx.get(cur)!.name); cur = idx.get(cur)!.parent; } return out.join(' > '); };
  const brief = async (p: MProduct) => {
    const s = priceState(p), cover = attrStr(p, 'small_image') ?? attrStr(p, 'image');
    const fromKids = ['configurable', 'bundle', 'grouped'].includes(String(p.type_id));
    return { id: String(p.id), name: p.name, number: p.sku, type: p.type_id, price: fromKids ? null : money(s.selling), ...(fromKids ? { priceNote: 'Preis aus den Einzelprodukten (get_variants)' } : {}), ...(s.list != null && !fromKids ? { listPrice: money(s.list) } : {}), active: isActive(p), visible: VISIBILITY[Number(p.visibility)] ?? null, image: ro().allowed('media') ? await ro().mediaUrl(cover) : undefined };
  };
  const productFilters = (a: { term?: string; categoryId?: string; active?: boolean; includeVariants?: boolean; minPrice?: number; maxPrice?: number }): Filter[][] => [
    ...(a.term ? [[{ field: 'name', value: likeTerm(a.term), condition_type: 'like' as const }, { field: 'sku', value: likeTerm(a.term), condition_type: 'like' as const }]] : []),
    ...(a.categoryId ? [[{ field: 'category_id', value: a.categoryId }]] : []),
    ...(a.active != null ? [[{ field: 'status', value: a.active ? 1 : 2 }]] : []),
    ...(!a.includeVariants ? [[{ field: 'visibility', value: [2, 3, 4], condition_type: 'in' as const }]] : []),
    // Pre-filter the price range server-side (superset: sale price ≤ regular price; max price: regular OR special price below it), checked exactly per page against the sale price
    ...(a.minPrice != null ? [[{ field: 'price', value: a.minPrice, condition_type: 'gteq' as const }]] : []),
    ...(a.maxPrice != null ? [[{ field: 'price', value: a.maxPrice, condition_type: 'lteq' as const }, { field: 'special_price', value: a.maxPrice, condition_type: 'lteq' as const }]] : []),
  ];
  const userAttrs = async (p: MProduct) => {
    const res: Record<string, string> = {}, defs = new Map((await ro().userAttributes().catch(() => [] as MRecord[])).map(d => [String(d.attribute_code), d]));
    for (const a of (p.custom_attributes ?? []).slice(0, 60)) {
      const def = defs.get(a.attribute_code);
      if (!def?.is_user_defined || a.value == null || a.value === '') continue;
      const opts = (def.options ?? []) as { label: string; value: string }[];
      res[def.default_frontend_label ?? a.attribute_code] = def.frontend_input === 'select' || def.frontend_input === 'multiselect' ? String(a.value).split(',').map(v => opts.find(o => o.value === v)?.label ?? v).join(', ') : def.frontend_input === 'boolean' ? (String(a.value) === '1' ? 'ja' : 'nein') : excerpt(a.value, 200);
    }
    return res;
  };

  return [
    tool('list_store_views', 'Store-Views (Sprachen/Märkte) des Shops: Code, Name, Locale, Website und welche Store-View Lotse standardmäßig liest und schreibt. Grundlage für Übersetzungen (propose_translations). Ändert nichts.', {},
      guard(async () => ok({ storeViews: await storeViewList(ro()), hint: 'Texte gelten global (alle Store-Views), solange eine Store-View keinen eigenen Wert hat. Übersetzungen sind eigene Werte je Store-View.' }))),

    tool('search_categories', 'Kategorien suchen (Name) oder ohne term die oberen Ebenen des Kategoriebaums listen. Liefert id, Name, Pfad, Ebene, aktiv, Produktanzahl, Kurzbeschreibung.',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        const idx = await treeIndex(), n = lim(limit, 20, 100);
        if (term) {
          const r = await ro().categories({ filters: [[{ field: 'name', value: likeTerm(term), condition_type: 'like' }]], pageSize: n });
          return ok(r.items.map(c => ({ id: String(c.id), name: c.name, path: crumb(idx, String(c.id)), level: c.level, active: !!c.is_active, productCount: idx.get(String(c.id))?.count, description: excerpt(attr(c, 'description')) })));
        }
        return ok([...idx].filter(([, v]) => v.level >= 2 && v.level <= 3).slice(0, n).map(([id, v]) => ({ id, name: v.name, path: crumb(idx, id), level: v.level, active: v.active, productCount: v.count })));
      })),

    tool('search_products', 'Produkte suchen (Name oder SKU) und/oder auf eine Kategorie einschränken. Einzelprodukte von Varianten (nicht einzeln sichtbar) sind ausgeblendet. Preis = Verkaufspreis (aktiver Sonderpreis berücksichtigt).',
      { term: z.string().optional(), categoryId: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, categoryId, limit }) => {
        const r = await ro().products({ filters: productFilters({ term, categoryId }), pageSize: lim(limit, 15, 50) });
        return ok({ total: r.total_count, priceBasis: basisWord(ro().priceBasis), products: await Promise.all(r.items.map(brief)) });
      })),

    tool('get_product', 'Produktdetails per id (oder SKU): Beschreibung, Kurzbeschreibung, SEO-Felder (Meta-Title, -Description, -Keywords, URL-Schlüssel), Preis (Verkaufspreis, Streichpreis, Sonderpreis mit Zeitraum), Status, Sichtbarkeit, Bestand, Kategorien, Bilder, eigene Attribute, Varianten-Achsen.',
      { id: z.string().describe('Produkt-ID oder SKU') }, guard(async ({ id }) => {
        const p = await ro().productByRef(id);
        if (!p) return fail('Produkt nicht gefunden');
        const full = p, s = priceState(full), idx = await treeIndex(); // productByRef already returns the full record
        const stock = ro().allowed('products') ? await ro().sourceItems([p.sku]).catch(() => []) : [];
        return ok({
          ...(await brief(full)), url: await productUrl(full), urlKey: attrStr(full, 'url_key'),
          description: attr(full, 'description') ?? null, shortDescription: attr(full, 'short_description') ?? null, metaTitle: attrStr(full, 'meta_title'), metaDescription: attrStr(full, 'meta_description'), keywords: attrStr(full, 'meta_keyword'),
          priceDetails: { basis: basisWord(ro().priceBasis), selling: s.selling, listPrice: s.list, regularPrice: s.regular, specialPrice: s.special, specialFrom: s.from, specialTo: s.to, specialActive: s.active },
          weight: full.weight ?? null, stock: stock.length ? stock.map(x => ({ source: x.source_code, quantity: x.quantity, inStock: Number(x.status) === 1 })) : null,
          categories: productCategoryIds(full).map(c => ({ id: c, name: idx.get(c)?.name, path: crumb(idx, c) })),
          images: ro().allowed('media') ? await imageRows(ro(), full) : undefined,
          attributes: await userAttrs(full),
          ...(full.type_id === 'configurable' ? { variants: 'konfigurierbares Produkt: Varianten mit get_variants' } : {}),
        });
      })),

    tool('get_category', 'Kategorie-Details: Name, Pfad, Beschreibung (HTML), Meta-Title, Meta-Description, Meta-Keywords, URL, aktiv, im Menü, Unterkategorien, Produktanzahl.',
      { id: z.string() }, guard(async ({ id }) => {
        const c = await ro().category(id);
        if (!c) return fail('Kategorie nicht gefunden');
        const idx = await treeIndex();
        return ok({ id: String(c.id), name: c.name, path: crumb(idx, String(c.id)), level: c.level, active: !!c.is_active, includeInMenu: !!c.include_in_menu, url: await categoryUrl(c), urlKey: attrStr(c, 'url_key'),
          description: attr(c, 'description') ?? null, metaTitle: attrStr(c, 'meta_title'), metaDescription: attrStr(c, 'meta_description'), keywords: attrStr(c, 'meta_keywords'), displayMode: attrStr(c, 'display_mode'),
          productCount: idx.get(String(c.id))?.count, children: [...idx].filter(([, v]) => v.parent === String(c.id)).map(([cid, v]) => ({ id: cid, name: v.name, active: v.active })) });
      })),

    tool('search_media', 'Produktbilder des Shops durchsuchen (Magento hat keine zentrale Medienbibliothek für Produktbilder): Bilder von Produkten, deren Name/SKU zum Suchbegriff passt. Liefert mediaId (für Seiten, view_image, propose_*), URL, Alt-Text und Produkt.',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        if (!ro().allowed('media')) return fail('ZUGRIFF VERWEIGERT: Medienbibliothek ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).');
        const n = lim(limit, 20, 50), r = await ro().products({ filters: productFilters({ term, includeVariants: true }), pageSize: 50 });
        const out: MRecord[] = [];
        for (const p of r.items) { if (out.length >= n) break; for (const im of await imageRows(ro(), p)) if (!im.hidden && out.length < n) out.push({ ...im, product: { id: String(p.id), name: p.name, number: p.sku } }); }
        return ok(out);
      })),

    tool('list_cms_pages', 'CMS-Seiten (Landingpages, Ratgeber, Service-Seiten) oder CMS-Blöcke des Shops LESEN: id, URL-Schlüssel (identifier), Titel, aktiv, URL, Metas, Page Builder ja/nein, Wortzahl, Textauszug. term sucht in Titel und identifier, Paginierung über offset. Ändert nichts.',
      { entity: z.enum(['page', 'block']).optional().describe('Standard page'), term: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
      guard(async a => ok(await listCms(ro(), { entity: a.entity ?? 'page', term: a.term, limit: a.limit, offset: a.offset })))),

    tool('get_cms_page', 'Liest eine CMS-Seite oder einen CMS-Block vollständig (per id oder identifier): Titel, Metas, Inhalt als lesbares HTML (Page-Builder-HTML-Elemente dekodiert), Text. Grundlage, um bestehende Inhalte einzubeziehen oder mit propose_cms_page_changes zu korrigieren. Ändert nichts.',
      { id: z.string(), entity: z.enum(['page', 'block']).optional() }, guard(async ({ id, entity }) => { const r = await getCms(ro(), entity ?? 'page', id); return r ? ok(r) : fail('Nicht gefunden'); })),

    tool('read_page', 'Liest eine Seite des EIGENEN Shops per Storefront-URL (Startseite, Kategorie, Produkt, CMS-Seite): Titel, Meta-Description, Überschriften, Text, Bilder, interne Links und welche Entität dahinter steht (Produkt, Kategorie, CMS-Seite). Nur URLs des Shops, kein freies Internet. Ändert nichts.',
      { url: z.string().url() }, guard(async ({ url }) => {
        const base = await ro().storefrontBase().catch(() => ro().publicUrl);
        const allowed = [base, ro().publicUrl, ro().base].filter(Boolean);
        const u = assertShopUrl(url, allowed);
        // Docker or similar: fetch the public address internally via the shop URL. Only path/query/fragment, check every redirect again.
        const r = await fetchShopPage(u.href, allowed, { publicUrl: ro().publicUrl, internalBase: ro().base, fetchImpl: (href, init) => (session.storefrontFetch ?? fetch)(href, init) });
        if (!r.ok) return fail(`Seite antwortet mit HTTP ${r.status}`);
        const page = parseStorefront((await r.text()).slice(0, 2_500_000), u.href);
        const path = u.pathname.replace(/^\/+/, '');
        const target = path ? await ro().resolveUrl(path).catch(() => null) : { type: 'HOME' };
        const { sections: _s, blockSequence: _b, ...rest } = page; void _s; void _b;
        return ok({ url: u.href, ...rest, target, hint: target?.type === 'CMS_PAGE' ? 'Inhalt der CMS-Seite: get_cms_page' : target?.type === 'PRODUCT' ? 'Daten: get_product' : target?.type === 'CATEGORY' ? 'Daten: get_category' : undefined });
      })),

    tool('list_products', 'Produkte in großer Zahl LESEN (Analysen, Massenänderungen): Verkaufspreis, Streichpreis, regulärer Preis, Sonderpreis, Bestand, aktiv, Sichtbarkeit, Typ, SEO-Status. Filter: Kategorie, Suchbegriff, Preisspanne (Verkaufspreis), aktiv, maxStock. Paginierung über offset (max. 100 je Aufruf; details=true max. 25 mit Beschreibung + Attributen). Preisspanne und maxStock werden je Seite genau geprüft: total zählt die Produkte des Serverfilters, returned die Treffer der Seite, darum mit nextOffset alle Seiten durchgehen. Einzelprodukte von Varianten nur mit includeVariants.',
      { categoryId: z.string().optional(), term: z.string().optional(), minPrice: z.number().optional(), maxPrice: z.number().optional(), active: z.boolean().optional(), maxStock: z.number().optional(), includeVariants: z.boolean().optional(), details: z.boolean().optional(), limit: z.number().optional(), offset: z.number().optional() },
      guard(async a => {
        const n = lim(a.limit, 50, a.details ? 25 : 100), page = Math.floor(Math.max(0, a.offset ?? 0) / n) + 1;
        const r = await ro().products({ filters: productFilters(a), pageSize: n, currentPage: page, sort: [{ field: 'entity_id', direction: 'ASC' }] });
        const stock = new Map<string, number>();
        if (r.items.length) for (const x of await ro().sourceItems(r.items.map(p => p.sku)).catch(() => [])) stock.set(x.sku, (stock.get(x.sku) ?? 0) + Number(x.quantity ?? 0));
        let rows = r.items;
        if (a.minPrice != null || a.maxPrice != null) rows = rows.filter(p => { const s = priceState(p).selling; return s != null && (a.minPrice == null || s >= a.minPrice) && (a.maxPrice == null || s <= a.maxPrice); });
        if (a.maxStock != null) rows = rows.filter(p => stock.has(p.sku) && stock.get(p.sku)! <= a.maxStock!);
        const products = await Promise.all(rows.map(async p => {
          const s = priceState(p), imgs = p.media_gallery_entries ?? [];
          return { id: String(p.id), number: p.sku, name: p.name, type: p.type_id, price: s.selling, listPrice: s.list, regularPrice: s.regular, specialPrice: s.special, specialTo: s.to, stock: stock.get(p.sku) ?? null, active: isActive(p), visibility: VISIBILITY[Number(p.visibility)],
            descriptionLength: plain(attr(p, 'description')).length, hasMetaTitle: !!attrStr(p, 'meta_title'), hasMetaDescription: !!attrStr(p, 'meta_description'), hasImage: imgs.some(e => !e.disabled), imagesWithoutAlt: imgs.filter(e => !e.disabled && !plain(e.label)).length,
            ...(a.details ? { description: excerpt(attr(p, 'description'), 500), shortDescription: excerpt(attr(p, 'short_description'), 300), attributes: await userAttrs(p) } : {}) };
        }));
        const perPage = a.minPrice != null || a.maxPrice != null || a.maxStock != null;
        return ok({ total: r.total_count, ...(perPage ? { note: 'Preis-/Bestandsfilter gelten je Seite: total zählt die Produkte des Serverfilters, returned die Treffer dieser Seite. Mit nextOffset alle Seiten durchgehen.' } : {}), priceBasis: basisWord(ro().priceBasis), offset: (page - 1) * n, returned: products.length, ...(page * n < r.total_count ? { nextOffset: page * n } : {}), products });
      })),

    tool('list_product_attributes', 'Eigene Produktattribute (z. B. Hersteller, Farbe, Material) mit Typ, Geltungsbereich und Auswahlwerten LESEN, Grundlage für propose_product_changes (fields.attributes) und Varianten. Ändert nichts.',
      { term: z.string().optional(), code: z.string().optional() }, guard(async ({ term, code }) => {
        const r = code ? { items: [await ro().attribute(code)].filter(Boolean) as MRecord[] } : await ro().attributes({ filters: [[{ field: 'is_user_defined', value: 1 }], ...(term ? [[{ field: 'attribute_code', value: likeTerm(term), condition_type: 'like' as const }]] : [])], pageSize: 200 });
        return ok(r.items.filter(x => code || x.is_user_defined).map(x => ({ code: x.attribute_code, label: x.default_frontend_label, input: x.frontend_input, scope: x.scope, userDefined: !!x.is_user_defined, values: ((x.options ?? []) as { label: string; value: string }[]).filter(o => o.value !== '').slice(0, 100).map(o => o.label) })));
      })),

    tool('get_seo_urls', 'Kanonische Storefront-URLs von Produkten oder Kategorien (URL-Schlüssel + Suffix der Store-View) für interne Links. Produkte, die nicht einzeln sichtbar sind, haben keine URL. Ändert nichts.',
      { entity: z.enum(['product', 'category']), ids: z.array(z.string()).max(50) }, guard(async ({ entity, ids }) => {
        const out: MRecord[] = [];
        for (const id of ids) {
          if (entity === 'product') { const p = await ro().productByRef(id); out.push(p ? { id: String(p.id), name: p.name, urlKey: attrStr(p, 'url_key'), url: await productUrl(p), active: isActive(p) } : { id, error: 'nicht gefunden' }); }
          else { const c = await ro().category(id); out.push(c ? { id: String(c.id), name: c.name, urlKey: attrStr(c, 'url_key'), url: await categoryUrl(c), active: !!c.is_active } : { id, error: 'nicht gefunden' }); }
        }
        return ok(out);
      })),

    tool('seo_audit', 'SEO-Bestandsaufnahme (nur lesen), seitenweise für große Kataloge: entity=product prüft aktive, einzeln sichtbare Produkte, entity=category aktive Kategorien auf Meta-Title (fehlt, über 60, unter 30, doppelt), Meta-Description (fehlt, außerhalb 120 bis 158, doppelt), dünne Beschreibung (unter 50 Wörtern) und bei Produkten Bilder (kein Bild, Bild ohne Alt-Text). Liefert Anzahl und IDs je Problem (wichtig zuerst) und die schwächsten Datensätze; nextOffset = nächste Seite. Ändert nichts: Korrekturen über propose_product_changes, propose_category_changes, propose_alt_texts.',
      { entity: z.enum(['product', 'category']), limit: z.number().optional().describe('Datensätze je Seite, Standard 200'), offset: z.number().optional() }, guard(async a => ok(await seoAudit(ro(), a)))),

    tool('get_product_images', 'Liest die Bilder eines oder vieler Produkte (max. 50): je Bild mediaId, Position, Titelbild (cover = Basisbild), Rollen (image/small_image/thumbnail), Datei, URL, Alt-Text (Magento-Label), hidden (ausgeblendet), altMissing. Ändert nichts.',
      { productIds: z.array(z.string()).optional(), productNumbers: z.array(z.string()).optional() }, guard(async ({ productIds, productNumbers }) => {
        if (!ro().allowed('media')) return fail('ZUGRIFF VERWEIGERT: Medienbibliothek ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).');
        const ids = productIds ?? [], nums = productNumbers ?? [];
        if (!ids.length && !nums.length) return fail('productIds oder productNumbers angeben');
        if (ids.length + nums.length > 50) return fail('Maximal 50 Produkte pro Aufruf');
        const ps = [...await ro().productsByIds(ids), ...await ro().productsBySkus([...nums, ...ids.filter(i => !/^\d+$/.test(i))])];
        return ok(await Promise.all(ps.map(async p => ({ id: String(p.id), number: p.sku, name: p.name, type: p.type_id, images: await imageRows(ro(), p) }))));
      })),

    tool('find_image_gaps', 'Findet Produkte mit Bildlücken (seitenweise, mit nextOffset): missing="images" = Produkte ohne sichtbares Bild, missing="alt" = Produkte mit Bildern ohne Alt-Text (liefert diese Bilder). Filter: Kategorie, aktiv, includeVariants. limit = geprüfte Produkte je Aufruf (Standard 100), alle Treffer der Seite werden geliefert. Ändert nichts.',
      { missing: z.enum(['images', 'alt']), categoryId: z.string().optional(), active: z.boolean().optional(), includeVariants: z.boolean().optional(), limit: z.number().optional(), offset: z.number().optional() },
      guard(async a => {
        if (!ro().allowed('media')) return fail('ZUGRIFF VERWEIGERT: Medienbibliothek ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).');
        // Page size = limit, return all hits of the page: this way no hit is lost between limit and page (Magento does not filter gallery gaps server-side)
        const n = lim(a.limit, 100, 100), page = Math.floor(Math.max(0, a.offset ?? 0) / n) + 1;
        const r = await ro().products({ filters: productFilters(a), pageSize: n, currentPage: page, sort: [{ field: 'entity_id', direction: 'ASC' }] });
        const hits: MRecord[] = [];
        for (const p of r.items) {
          const vis = (p.media_gallery_entries ?? []).filter(e => !e.disabled);
          if (a.missing === 'images' && !vis.length && p.type_id !== 'configurable') hits.push({ id: String(p.id), number: p.sku, name: p.name, active: isActive(p) });
          if (a.missing === 'alt' && vis.some(e => !plain(e.label))) hits.push({ id: String(p.id), number: p.sku, name: p.name, active: isActive(p), imagesWithoutAlt: (await imageRows(ro(), p)).filter(i => !i.hidden && i.altMissing) });
        }
        return ok({ missing: a.missing, scanned: r.items.length, ofProducts: r.total_count, offset: (page - 1) * n, found: hits.length, products: hits, ...(page * n < r.total_count ? { nextOffset: page * n } : {}), hint: `Je Aufruf werden ${n} Produkte geprüft und alle Treffer geliefert; mit nextOffset weiterblättern, bis keiner mehr kommt.` });
      })),

    tool('get_translations', 'Liest Name, Beschreibung, Kurzbeschreibung (Produkte), Meta-Title, Meta-Description, Meta-Keywords JE STORE-VIEW für Produkte oder Kategorien (max. 20). own=false heißt: die Store-View hat keinen eigenen Wert und zeigt den globalen Text. Ändert nichts.',
      { entity: z.enum(['product', 'category']), ids: z.array(z.string()).max(20), stores: z.array(z.string()).optional().describe('Store-View-Codes; ohne = alle'), full: z.boolean().optional() },
      guard(async a => {
        const views = (await storeViewList(ro())).filter(v => !a.stores?.length || a.stores.includes(v.code)), FIELDS = TRANSLATION_FIELDS[a.entity], out: MRecord[] = [];
        for (const id of a.ids) {
          const base = a.entity === 'product' ? await ro().productByRef(id) : await ro().category(id);
          if (!base) { out.push({ id, error: 'nicht gefunden' }); continue; }
          const ref = a.entity === 'product' ? String(base.sku) : String(base.id);
          const glob = a.entity === 'product' ? await ro().product(ref, 'all') : await ro().category(ref, 'all');
          const per: MRecord = {};
          for (const v of views) {
            const rec = a.entity === 'product' ? await ro().product(ref, v.code) : await ro().category(ref, v.code);
            per[v.code] = Object.fromEntries(Object.entries(FIELDS).map(([f, def]) => { const val = attr(rec, def.attr!), own = !!rec && !!glob && String(attr(rec, def.attr!) ?? '') !== String(attr(glob, def.attr!) ?? ''); return [f, { value: a.full ? val ?? null : excerpt(val, 300) || null, own }]; }));
          }
          out.push({ id: String(base.id), name: base.name, global: Object.fromEntries(Object.entries(FIELDS).map(([f, def]) => [f, a.full ? attr(glob, def.attr!) ?? null : excerpt(attr(glob, def.attr!), 300) || null])), storeViews: per });
        }
        return ok(out);
      })),

    tool('get_variants', 'Liest die Varianten eines konfigurierbaren Produkts: Achsen (z. B. Farbe) mit Ausprägungen und alle Einzelprodukte mit Ausprägung, SKU, Preis, Status, Bestand. Ändert nichts.',
      { id: z.string().describe('ID oder SKU des Hauptprodukts') }, guard(async ({ id }) => ok(await readVariants(ro(), id)))),

    tool('preview_bulk_filter', 'Zählt, welche Produkte ein Stapel-Filter trifft (alle Seiten), und zeigt 10 Beispiele, um den Umfang VOR propose_bulk_product_change abzustimmen. Ändert nichts.',
      bulkFilterShape(), guard(async f => {
        const { rows, scanned, total } = await resolveBulk(ro(), f);
        return ok({ matched: rows.length, scanned, total, max: BULK_MAX, examples: await Promise.all(rows.slice(0, 10).map(brief)) });
      })),

    tool('list_promotions', 'LIEST Promotionen = Warenkorb-Preisregeln (max. 100 je Aufruf): Name, Status (läuft/geplant/abgelaufen/inaktiv), Zeitraum, Rabatt als Text, Code-Art (ohne Code / fester Code / Einzelcodes mit Anzahl erzeugt/eingelöst), Priorität, Limits und Anzahl Einlösungen (nur Zählwerte, nie Kunden oder Bestellungen). Ändert nichts.',
      { status: z.enum(['running', 'scheduled', 'expired', 'inactive', 'all']).optional(), term: z.string().optional(), withCode: z.boolean().optional(), limit: z.number().optional(), page: z.number().optional() },
      guard(async a => {
        const n = lim(a.limit, 50, 100), page = Math.max(1, Math.floor(a.page ?? 1));
        const r = await ro().salesRules({ filters: [...(a.term ? [[{ field: 'name', value: likeTerm(a.term), condition_type: 'like' as const }]] : []), ...(a.withCode != null ? [[{ field: 'coupon_type', value: a.withCode ? ['SPECIFIC_COUPON', 'AUTO'] : ['NO_COUPON'], condition_type: 'in' as const }]] : [])], pageSize: n, currentPage: page, sort: [{ field: 'sort_order', direction: 'ASC' }] });
        const want: Record<string, string> = { running: 'läuft', scheduled: 'geplant', expired: 'abgelaufen', inactive: 'inaktiv' };
        const rows = r.items.filter(x => !a.status || a.status === 'all' || promoStatus(x) === want[a.status]);
        return ok({ total: r.total_count, page, returned: rows.length, hasMore: page * n < r.total_count, promotions: await Promise.all(rows.map(x => promoView(ro(), x))) });
      })),

    tool('get_promotion', 'LIEST eine Promotion (Warenkorb-Preisregel) im Detail: Rabatt, Einschränkung auf Kategorien/Artikel, Mindestbestellwert, Code(s) mit Zählwerten, Limits, Bezeichnung im Warenkorb. Keine Kunden- oder Bestelldaten. Ändert nichts.',
      { id: z.string() }, guard(async ({ id }) => { const r = await ro().salesRule(id); return r ? ok(await promoView(ro(), r, true)) : fail('Promotion nicht gefunden'); })),

    tool('propose_product_changes', `SCHLÄGT Änderungen an einem oder vielen Produkten vor (max. ${MAX_ITEMS}). Es wird NICHTS geschrieben: Der Nutzer sieht Alt → Neu, wählt aus und gibt frei; erst dann schreibt der Server. Der Aufruf wartet auf die Entscheidung. Felder: ${Object.keys(M_PRODUCT_FIELDS).join(', ')}, attributes. Preise als Zahl ODER Regel (der Server rechnet): {percent:-10, round:".99"} | {add:2.5} | {set:19.99}. price = Verkaufspreis, listPrice = Streichpreis (null entfernt ihn; in Magento wird daraus regulärer Preis + Sonderpreis), specialFromDate/specialToDate = Zeitraum des Sonderpreises (JJJJ-MM-TT). stock = ganze Zahl (nur mit genau einer Lagerquelle), active = true/false, visibility = none|catalog|search|both, description/shortDescription = HTML, attributes = {code: Wert} für eigene Attribute (Auswahlwerte per Label, siehe list_product_attributes). Texte gelten für die Store-View aus den Einstellungen bzw. global, wenn sie keinen eigenen Wert hat.`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('Produkt-ID oder SKU'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildProductChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_new_products', 'SCHLÄGT NEUE PRODUKTE vor (z. B. aus hochgeladenen Fotos: erst view_image, dann Name, Beschreibung, SEO aus dem Bild ableiten). Es wird NICHTS geschrieben: Der Nutzer sieht die Produkte samt Bildern und gibt frei. Standard: inaktiv (Entwurf), Bestand 0, sichtbar in Katalog und Suche, alle Websites. Preis NIE schätzen: fehlt er, per ask_user erfragen. Keine erfundenen Fakten.',
      { title: z.string(), reason: z.string(), products: z.array(z.object({
        name: z.string(), description: z.string().describe('HTML'), price: z.number(), sku: z.string().optional(), stock: z.number().optional(), active: z.boolean().optional(), shortDescription: z.string().optional(),
        metaTitle: z.string().optional(), metaDescription: z.string().optional(), keywords: z.string().optional(), weight: z.number().optional(), categoryIds: z.array(z.string()).optional(),
        images: z.array(z.string()).optional().describe('staged:… (Anhang/import_image), mediaId (mg-…) oder https-URL; erstes = Titelbild'), taxClass: z.string().optional().describe('Steuerklasse (Label), Standard „Taxable Goods“'),
      })) },
      guard(async a => { const { cs } = await buildNewProductsChangeSet(ro(), a); return ok(await session.requestChange(cs)); })),

    tool('propose_category_changes', `SCHLÄGT Änderungen an Kategorien vor (Freigabe-Workflow wie bei Produkten). Felder: ${Object.keys(M_CATEGORY_FIELDS).join(', ')} (description = HTML). URL-Schlüssel über propose_seo_urls, Produktzuordnung über propose_category_products.`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string(), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildCategoryChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_category_products', 'SCHLÄGT vor, Produkte einer Kategorie zuzuordnen (add, optional mit Position) oder aus ihr zu entfernen (remove). Es wird NICHTS geschrieben, bis der Nutzer freigibt; Rückgängig stellt die Zuordnung mit Position wieder her.',
      { title: z.string(), reason: z.string(), categoryId: z.string(), add: z.array(z.object({ productId: z.string(), position: z.number().optional() })).optional(), remove: z.array(z.string()).optional() },
      guard(async a => { const { cs, payload } = await buildCategoryProductsChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_product_images', `SCHLÄGT Bildänderungen an Produkten vor (max. ${MAX_ITEMS}): Bilder hinzufügen, ausblenden (remove), umsortieren, Titelbild setzen. add.image: staged:… (Anhang, import_image, generate_image), mediaId (mg-…, vorhandenes Shop-Bild) oder https-URL. remove/order/cover: mediaId aus get_product_images (bzw. das image eines neuen Bildes). Entfernen blendet das Bild aus (bleibt in Magento gespeichert). Es wird NICHTS geschrieben, bis der Nutzer freigibt. Alt-Texte vorhandener Bilder: propose_alt_texts.`,
      { title: z.string(), reason: z.string(), products: z.array(z.object({ productId: z.string(), add: z.array(z.object({ image: z.string(), position: z.number().optional().describe('0 = vorne'), cover: z.boolean().optional(), alt: z.string().optional() })).optional(), remove: z.array(z.string()).optional(), order: z.array(z.string()).optional(), cover: z.string().optional() })) },
      guard(async a => { const { cs, payload } = await buildProductImagesChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_alt_texts', `SCHLÄGT Alt-Texte (Magento: Bild-Label) für Produktbilder vor (max. ${MAX_ITEMS}). Jedes Bild MUSS vorher mit view_image angesehen worden sein, sonst wird es übersprungen. Konkret beschreiben, was zu sehen ist, ≤ ${ALT_MAX} Zeichen, ohne „Bild von“. Gilt für die Store-View aus den Einstellungen bzw. global. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), images: z.array(z.object({ mediaId: z.string(), alt: z.string() })) },
      guard(async a => { const { cs, payload } = await buildAltTextChangeSet(ro(), a, viewedImages(session.events)); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_translations', `SCHLÄGT Übersetzungen für Produkte oder Kategorien vor: eigene Werte je Store-View (max. ${MAX_ITEMS} Einträge). Felder: name, description, shortDescription (nur Produkte), metaTitle, metaDescription, keywords. null entfernt den eigenen Wert (Store-View zeigt wieder den globalen Text). Es wird NICHTS geschrieben, bis der Nutzer freigibt. Übersetzt NICHT selbst, du lieferst die fertigen Texte.`,
      { title: z.string(), reason: z.string(), entity: z.enum(['product', 'category']), changes: z.array(z.object({ id: z.string(), store: z.string().describe('Store-View-Code (list_store_views) oder Locale'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildTranslationChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_seo_urls', 'SCHLÄGT neue URL-Schlüssel für Produkte oder Kategorien vor. Der Server normalisiert (klein, ä→ae, Bindestriche) und prüft, ob der Schlüssel frei ist. Nach Freigabe legt Magento eine 301-Weiterleitung von der alten URL an. Nur ändern, wenn der Nutzer es will oder die URL unsprechend ist.',
      { title: z.string(), reason: z.string(), entity: z.enum(['product', 'category']), changes: z.array(z.object({ id: z.string(), urlKey: z.string().describe('z. B. "vase-kiesel-steinzeug" (ohne .html, ohne Pfad)') })) },
      guard(async a => { const { cs, payload } = await buildSeoUrlChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_variants', 'SCHLÄGT neue Varianten für EIN konfigurierbares Produkt vor: je Variante die Ausprägungen aller Achsen (options, z. B. {"color": "Salbei"}; nur vorhandene Ausprägungen, siehe get_variants), Preis (Pflicht, außer alle Varianten haben denselben Preis), Bestand, aktiv. Legt je Variante ein Einzelprodukt an und verknüpft es; Rückgängig löscht es wieder. Bestehende Varianten änderst du mit propose_product_changes (deren id).',
      { title: z.string(), reason: z.string(), productId: z.string(), add: z.array(z.object({ options: z.record(z.string(), z.string()), sku: z.string().optional(), price: z.number().optional(), stock: z.number().optional(), active: z.boolean().optional(), weight: z.number().optional() })) },
      guard(async a => { const { cs } = await buildVariantsChangeSet(ro(), a); return ok(await session.requestChange(cs)); })),

    tool('propose_bulk_product_change', `STAPELVERARBEITUNG: SCHLÄGT EINE Regel für ALLE Produkte eines Filters vor (bis ${BULK_MAX.toLocaleString('de-DE')}), ohne sie aufzuzählen. Der Server liest alle passenden Produkte seitenweise, rechnet selbst und zeigt Gruppen (ohne/mit Warnungen, abwählbar) und eine Stichprobe. Nach Freigabe schreibt er in Blöcken mit Fortschritt; Rückgängig stellt alle alten Werte wieder her. change: price {percent|add|set, round?}, listPrice {…} | null (entfernen) | "currentPrice" (Streichpreis = bisheriger Preis), specialFromDate/specialToDate (JJJJ-MM-TT|null), active.`,
      { title: z.string(), reason: z.string(), filter: z.object(bulkFilterShape()), change: z.object({ price: priceRule().optional(), listPrice: z.union([priceRule(), z.null(), z.literal('currentPrice')]).optional(), specialFromDate: z.string().nullable().optional(), specialToDate: z.string().nullable().optional(), active: z.boolean().optional() }) },
      guard(async ({ title, reason, filter, change }) => {
        const c = change as BulkChange;
        for (const k of ['specialFromDate', 'specialToDate'] as const) if (c[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(c[k]))) return fail(`${k}: JJJJ-MM-TT oder null`);
        const { rows, scanned, total } = await resolveBulk(ro(), filter);
        const { cs, payload } = bulkChangeSet(title, reason || describeBulk(c), c, rows, ro().priceBasis, scanHint(scanned, total));
        return ok(await session.requestChange(cs, { ...payload, store: ro().storeCode })); // the proposal's store view, not the one at execution time
      })),

    tool('propose_promotion', `SCHLÄGT eine neue Promotion (Warenkorb-Preisregel, ohne id) oder die Änderung einer bestehenden (mit id) vor. Es wird NICHTS geschrieben, bis der Nutzer freigibt. Neu: name, discount, code und active sind Pflicht (active=true mit künftigem validFrom = geplant). discount: type percentage | absolute (€ je Artikel) | cart_fixed (€ auf den Warenkorb) | buy_x_get_y, value, optional step (bei buy_x_get_y: X), maxQty, applyToShipping, categoryIds/productIds (Rabatt nur auf diese Artikel). code: none | fixed (code) | individual (count bis ${MAX_CODES}, length, prefix). minSubtotal = Mindestbestellwert. Datum JJJJ-MM-TT, null entfernt. Gilt für alle Kundengruppen und Websites.`,
      { id: z.string().optional(), reason: z.string(), name: z.string().optional(), description: z.string().nullable().optional(), label: z.string().nullable().optional().describe('Bezeichnung im Warenkorb'), active: z.boolean().optional(), validFrom: z.string().nullable().optional(), validUntil: z.string().nullable().optional(),
        code: z.object({ mode: z.enum(['none', 'fixed', 'individual']), code: z.string().optional(), count: z.number().optional(), length: z.number().optional(), prefix: z.string().optional() }).optional(),
        discount: z.object({ type: z.enum(['percentage', 'absolute', 'cart_fixed', 'buy_x_get_y']), value: z.number(), step: z.number().optional(), maxQty: z.number().nullable().optional(), applyToShipping: z.boolean().optional(), categoryIds: z.array(z.string()).optional(), productIds: z.array(z.string()).optional() }).optional(),
        minSubtotal: z.number().nullable().optional(), priority: z.number().optional(), exclusive: z.boolean().optional().describe('true = weitere Regeln danach nicht anwenden'), maxUsesPerCustomer: z.number().nullable().optional(), maxUsesPerCoupon: z.number().nullable().optional() },
      guard(async a => { const { cs, payload } = await buildPromotionChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_cms_page_changes', `SCHLÄGT Änderungen an vorhandenen CMS-Seiten vor (max. 50): Felder ${CMS_FIELDS.join(', ')} (content = vollständiges HTML der Seite; bei Page-Builder-Seiten wird es als HTML-Element eingebettet). Vorher get_cms_page lesen und nur ändern, was nötig ist (z. B. kaputte Links, Metas). Systemseiten (404, Cookies) sind ausgeschlossen. Es wird NICHTS geschrieben, bis der Nutzer freigibt; Rückgängig stellt die alten Werte exakt wieder her. Neue Seiten: draft_page + publish_page.`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('Seiten-id oder identifier'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildCmsPageChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_promotion_status', `SCHLÄGT vor, eine oder viele Promotionen (max. ${MAX_ITEMS}) zu aktivieren, zu deaktivieren oder zu beenden (end = Enddatum heute + inaktiv). Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { ids: z.array(z.string()), action: z.enum(['activate', 'deactivate', 'end']), reason: z.string().optional() },
      guard(async a => ok(await session.requestChange(await buildPromotionStatusChangeSet(ro(), a))))),
  ] as AnyTool[];
}

function priceRule() { return z.object({ percent: z.number().optional(), add: z.number().optional(), set: z.number().optional(), round: z.string().optional().describe('".99", ".95", ".00" oder "none"') }); }
function bulkFilterShape() {
  return { categoryId: z.string().optional(), term: z.string().optional(), minPrice: z.number().optional(), maxPrice: z.number().optional(), active: z.boolean().optional(), typeId: z.enum(['simple', 'configurable', 'virtual', 'bundle', 'grouped', 'downloadable']).optional(), skus: z.array(z.string()).max(1000).optional() };
}
