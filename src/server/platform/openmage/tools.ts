import 'server-only';
// OpenMage-Werkzeuge der KI: lesen nur über den geschützten Lese-Client (session.reader), schreiben nur über Änderungssets.
// Namen und Argumente wie bei Shopware/Magento, wo die Bedeutung passt (gemeinsame Prompts, Shop-Check-Aufträge, Onboarding).
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { viewedImages } from '../../features/bilder';
import type { Session } from '../../sessions';
import { fail, guard, ok, type AnyTool } from '../../tool-kit';
import { assertShopUrl, fetchShopPage, parseStorefront } from '../../storefront';
import { MAX_ITEMS } from './kit';
import { basisWord, isActive, money, omAttr, omStr, plain, priceOf, FROM_KIDS, VISIBILITY, type OmCategory, type OmProduct, type OmRecord } from './map';
import { LIST_FIELDS, OmReader, type ProductQuery } from './reader';
import { buildCategoryChangeSet, buildCategoryProductsChangeSet, buildProductChangeSet, buildSeoUrlChangeSet, buildTranslationChangeSet, loadProducts, OM_CATEGORY_FIELDS, OM_PRODUCT_FIELDS, storeViewList, TRANSLATION_FIELDS } from './catalog';
import { ALT_MAX, buildAltTextChangeSet, buildNewProductsChangeSet, buildProductImagesChangeSet, imageRows } from './images';
import { buildPromotionChangeSet, buildPromotionStatusChangeSet, promoStatus, promoView } from './promo';
import { buildVariantsChangeSet, readVariants } from './variants';
import { BULK_MAX, bulkChangeSet, describeBulk, resolveBulk, type BulkChange } from './bulk';
import { seoAudit } from './audit';
import { buildCmsPageChangeSet, CMS_FIELDS, getCms, listCms } from './cms';

export const OPENMAGE_TOOL_NAMES = [
  'list_store_views', 'search_categories', 'search_products', 'get_product', 'get_category', 'search_media', 'list_cms_pages', 'get_cms_page', 'read_page', 'list_products', 'list_product_attributes', 'get_seo_urls', 'seo_audit',
  'get_product_images', 'find_image_gaps', 'get_translations', 'get_variants', 'preview_bulk_filter', 'list_promotions', 'get_promotion',
  'propose_product_changes', 'propose_new_products', 'propose_category_changes', 'propose_category_products', 'propose_product_images', 'propose_alt_texts',
  'propose_translations', 'propose_seo_urls', 'propose_variants', 'propose_bulk_product_change', 'propose_promotion', 'propose_cms_page_changes', 'propose_promotion_status',
];

/** Lese-Client der Session (geprüft: nur der OpenMage-Reader) */
export function openmageReader(session: Pick<Session, 'reader'>): OmReader {
  if (!(session.reader instanceof OmReader)) throw new Error('Dieses Werkzeug gibt es nur für OpenMage.');
  return session.reader;
}
const lim = (v: number | undefined, d: number, max: number) => Math.max(1, Math.min(Math.floor(v ?? d), max));
const excerpt = (t: unknown, n = 200) => { const s = plain(t); return s.length > n ? `${s.slice(0, n)}…` : s; };

export function openmageTools(session: Session): AnyTool[] {
  const ro = () => openmageReader(session);
  /** Kategorienamen + Pfad aus dem Baum (einmal je Session) */
  const treeIndex = async () => {
    const idx = new Map<string, { name: string; parent: string | null; level: number; active: boolean; count: number }>();
    const walk = (c: OmCategory, parent: string | null) => { idx.set(String(c.id), { name: String(c.name ?? ''), parent, level: Number(c.level ?? 0), active: !!c.is_active, count: Number(c.product_count ?? 0) }); for (const k of c.children ?? []) walk(k, String(c.id)); };
    for (const root of await ro().categoryTree()) walk(root, null);
    return idx;
  };
  const crumb = (idx: Awaited<ReturnType<typeof treeIndex>>, id: string) => { const out: string[] = []; let cur: string | null = id; while (cur && idx.has(cur) && idx.get(cur)!.level > 1) { out.unshift(idx.get(cur)!.name); cur = idx.get(cur)!.parent; } return out.join(' > '); };
  const brief = async (p: OmProduct) => {
    const s = priceOf(p), fromKids = FROM_KIDS.has(String(p.type_id));
    return { id: String(p.id), name: p.name, number: p.sku, type: p.type_id, price: fromKids ? null : money(s.selling), ...(fromKids ? { priceNote: 'Preis aus den Einzelprodukten (get_variants)' } : {}), ...(s.list != null && !fromKids ? { listPrice: money(s.list) } : {}), active: isActive(p), visible: VISIBILITY[Number(p.visibility)] ?? null, image: ro().allowed('media') ? await ro().mediaUrl(omStr(p, 'small_image') ?? p.image) : undefined };
  };
  /** Suche über Name ODER SKU: eine Abfrage mit ?term= (exakte Paginierung und Zählwerte); ältere Module ohne term: zwei Abfragen zusammengeführt (Schätzwerte) */
  const searchProducts = async (a: { term?: string; categoryId?: string; active?: boolean; includeVariants?: boolean; limit: number; page?: number; fields?: boolean }) => {
    const base: ProductQuery = { ...(a.categoryId ? { category_id: a.categoryId } : {}), ...(a.active != null ? { status: a.active ? 1 : 2 } : {}), ...(!a.includeVariants ? { visibility: '2,3,4' } : {}), limit: a.limit, page: a.page ?? 1, sort: 'entity_id', dir: 'asc', ...(a.fields ? { fields: LIST_FIELDS.join(','), with: 'images' } : {}) };
    if (!a.term || await ro().hasTermFilter()) { const r = await ro().products({ ...base, ...(a.term ? { term: a.term } : {}) }); return { items: r.items, total: r.meta.total, pages: r.meta.pages }; }
    const [n, s] = await Promise.all([ro().products({ ...base, name: a.term }), ro().products({ ...base, sku: a.term })]);
    const items = [...n.items]; for (const p of s.items) if (!items.some(x => x.id === p.id)) items.push(p);
    return { items: items.slice(0, a.limit), total: Math.max(n.meta.total, s.meta.total, items.length), pages: Math.max(n.meta.pages, s.meta.pages) };
  };
  const userAttrs = async (p: OmProduct) => {
    const res: Record<string, string> = {}, labels = (p.attribute_labels ?? {}) as Record<string, unknown>;
    for (const [code, v] of Object.entries(p.attributes ?? {}).slice(0, 80)) {
      const def = await ro().attribute(code).catch(() => null);
      if (!def?.is_user_defined || v == null || v === '') continue;
      res[String(def.label ?? code)] = labels[code] != null ? (Array.isArray(labels[code]) ? (labels[code] as string[]).join(', ') : String(labels[code])) : def.input === 'boolean' ? (Number(v) === 1 ? 'ja' : 'nein') : excerpt(v, 200);
    }
    return res;
  };

  return [
    tool('list_store_views', 'Store-Views (Sprachen/Märkte) des Shops: Code, Name, Locale, Währung, Website und welche Store-View Lotse standardmäßig liest und schreibt. Grundlage für Übersetzungen (propose_translations). Ändert nichts.', {},
      guard(async () => { const info = await ro().info(); return ok({ shop: info.shop_name, version: `OpenMage ${info.version} (Magento ${info.magento_version})`, module: info.module_version, priceBasis: basisWord(await ro().priceBasis()), storeViews: await storeViewList(ro()), hint: 'Texte gelten global (alle Store-Views), solange eine Store-View keinen eigenen Wert hat. Übersetzungen sind eigene Werte je Store-View.' }); })),

    tool('search_categories', 'Kategorien suchen (Name) oder ohne term die oberen Ebenen des Kategoriebaums listen. Liefert id, Name, Pfad, Ebene, aktiv, Produktanzahl, Anzeigemodus.',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        const idx = await treeIndex(), n = lim(limit, 20, 100), all = await ro().categoriesFlat();
        const rows = term ? all.filter(c => String(c.name ?? '').toLowerCase().includes(term.toLowerCase())) : all.filter(c => Number(c.level) >= 2 && Number(c.level) <= 3);
        return ok(rows.slice(0, n).map(c => ({ id: String(c.id), name: c.name, path: crumb(idx, String(c.id)), level: c.level, active: !!c.is_active, productCount: c.product_count, displayMode: c.display_mode ?? null, urlKey: c.url_key ?? null })));
      })),

    tool('search_products', 'Produkte suchen (Name oder SKU) und/oder auf eine Kategorie einschränken (categoryId = direkt zugeordnete Produkte; Unterkategorien einzeln angeben). Einzelprodukte von Varianten (nicht einzeln sichtbar) sind ausgeblendet. Preis = Verkaufspreis (aktiver Sonderpreis berücksichtigt).',
      { term: z.string().optional(), categoryId: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, categoryId, limit }) => {
        const r = await searchProducts({ term, categoryId, limit: lim(limit, 15, 50) });
        return ok({ total: r.total, priceBasis: basisWord(await ro().priceBasis()), products: await Promise.all(r.items.map(brief)) });
      })),

    tool('get_product', 'Produktdetails per id (oder SKU): Beschreibung, Kurzbeschreibung, SEO-Felder (Meta-Title, -Description, -Keywords, URL-Schlüssel), Preis (Verkaufspreis, Streichpreis, Sonderpreis mit Zeitraum), Status, Sichtbarkeit, Bestand, Kategorien, Bilder, eigene Attribute, Varianten-Achsen.',
      { id: z.string().describe('Produkt-ID oder SKU; bei numerischen SKUs eindeutig als "id:123" bzw. "sku:123"') }, guard(async ({ id }) => {
        const p = await ro().productByRef(id);
        if (!p) return fail('Produkt nicht gefunden');
        const s = priceOf(p), idx = await treeIndex();
        return ok({
          ...(await brief(p)), url: await ro().productUrl(p), urlKey: omStr(p, 'url_key'),
          description: omAttr(p, 'description') ?? null, shortDescription: omAttr(p, 'short_description') ?? null, metaTitle: omStr(p, 'meta_title'), metaDescription: omStr(p, 'meta_description'), keywords: omStr(p, 'meta_keyword'),
          priceDetails: { basis: basisWord(await ro().priceBasis()), selling: s.selling, listPrice: s.list, regularPrice: s.regular, specialPrice: s.special, specialFrom: s.from, specialTo: s.to, specialActive: s.active },
          weight: p.weight ?? null, stock: p.stock ? { quantity: p.stock.qty, inStock: !!p.stock.is_in_stock, manageStock: p.stock.manage_stock ?? null } : null,
          categories: (p.categories ?? []).map(c => ({ id: String(c.id), name: idx.get(String(c.id))?.name ?? c.name, path: crumb(idx, String(c.id)), position: c.position })),
          images: ro().allowed('media') ? await imageRows(ro(), p) : undefined,
          attributes: await userAttrs(p),
          ...(p.type_id === 'configurable' ? { variants: 'konfigurierbares Produkt: Varianten mit get_variants' } : {}),
          ...(p.parent_ids?.length ? { parentIds: p.parent_ids.map(String) } : {}),
        });
      })),

    tool('get_category', 'Kategorie-Details: Name, Pfad, Beschreibung (HTML), Meta-Title, Meta-Description, Meta-Keywords, URL, aktiv, im Menü, Anzeigemodus, CMS-Block, Unterkategorien, Produktanzahl.',
      { id: z.string() }, guard(async ({ id }) => {
        const c = await ro().category(id);
        if (!c) return fail('Kategorie nicht gefunden');
        const idx = await treeIndex();
        return ok({ id: String(c.id), name: c.name, path: crumb(idx, String(c.id)), level: c.level, active: !!c.is_active, includeInMenu: !!c.include_in_menu, anchor: !!c.is_anchor, url: await ro().categoryUrl(c), urlKey: c.url_key ?? null,
          description: c.description ?? null, metaTitle: c.meta_title ?? null, metaDescription: c.meta_description ?? null, keywords: c.meta_keywords ?? null, displayMode: c.display_mode ?? null, cmsBlock: c.landing_page_block ? { id: String(c.landing_page_block.id), identifier: c.landing_page_block.identifier, title: c.landing_page_block.title } : null,
          productCount: c.product_count, children: [...idx].filter(([, v]) => v.parent === String(c.id)).map(([cid, v]) => ({ id: cid, name: v.name, active: v.active })) });
      })),

    tool('search_media', 'Produktbilder des Shops durchsuchen (OpenMage hat keine zentrale Medienbibliothek für Produktbilder): Bilder von Produkten, deren Name/SKU zum Suchbegriff passt. Liefert mediaId (für Seiten, view_image, propose_*), URL, Alt-Text und Produkt.',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        if (!ro().allowed('media')) return fail('ZUGRIFF VERWEIGERT: Medienbibliothek ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).');
        const n = lim(limit, 20, 50), r = await searchProducts({ term, includeVariants: true, limit: 50, fields: true });
        const out: OmRecord[] = [];
        for (const p of r.items) { if (out.length >= n) break; for (const im of await imageRows(ro(), p)) if (!im.hidden && out.length < n) out.push({ ...im, product: { id: String(p.id), name: p.name, number: p.sku } }); }
        return ok(out);
      })),

    tool('list_cms_pages', 'CMS-Seiten (Landingpages, Ratgeber, Service-Seiten) oder CMS-Blöcke des Shops LESEN: id, URL-Schlüssel (identifier), Titel, aktiv, Store-Views, URL, Meta-Description. term sucht in Titel und identifier, Paginierung über offset. Ändert nichts.',
      { entity: z.enum(['page', 'block']).optional().describe('Standard page'), term: z.string().optional(), limit: z.number().optional(), offset: z.number().optional() },
      guard(async a => ok(await listCms(ro(), { entity: a.entity ?? 'page', term: a.term, limit: a.limit, offset: a.offset })))),

    tool('get_cms_page', 'Liest eine CMS-Seite oder einen CMS-Block vollständig (per id oder identifier): Titel, Überschrift, Metas, Inhalt als HTML, enthaltene Direktiven ({{block …}}, {{widget …}}). Grundlage, um bestehende Inhalte einzubeziehen oder mit propose_cms_page_changes zu korrigieren. Ändert nichts.',
      { id: z.string(), entity: z.enum(['page', 'block']).optional() }, guard(async ({ id, entity }) => { const r = await getCms(ro(), entity ?? 'page', id); return r ? ok(r) : fail('Nicht gefunden'); })),

    tool('read_page', 'Liest eine Seite des EIGENEN Shops per Storefront-URL (Startseite, Kategorie, Produkt, CMS-Seite): Titel, Meta-Description, Überschriften, Text, Bilder, interne Links und welche Entität dahinter steht (Produkt, Kategorie, CMS-Seite). Nur URLs des Shops, kein freies Internet. Ändert nichts.',
      { url: z.string().url() }, guard(async ({ url }) => {
        const base = await ro().storefrontBase().catch(() => ro().publicUrl);
        const allowed = [base, ro().publicUrl, ro().base].filter(Boolean);
        const u = assertShopUrl(url, allowed);
        const r = await fetchShopPage(u.href, allowed, { publicUrl: ro().publicUrl, internalBase: ro().base, fetchImpl: (href, init) => (session.storefrontFetch ?? fetch)(href, init) });
        if (!r.ok) return fail(`Seite antwortet mit HTTP ${r.status}`);
        const page = parseStorefront((await r.text()).slice(0, 2_500_000), u.href);
        const target = await ro().resolveUrl(u.pathname.replace(/^\/+/, '')).catch(() => null);
        const { sections: _s, blockSequence: _b, ...rest } = page; void _s; void _b;
        return ok({ url: u.href, ...rest, target, hint: target?.type === 'CMS_PAGE' ? 'Inhalt der CMS-Seite: get_cms_page' : target?.type === 'PRODUCT' ? 'Daten: get_product' : target?.type === 'CATEGORY' ? 'Daten: get_category' : undefined });
      })),

    tool('list_products', 'Produkte in großer Zahl LESEN (Analysen, Massenänderungen): Verkaufspreis, Streichpreis, regulärer Preis, Sonderpreis, Bestand, aktiv, Sichtbarkeit, Typ, SEO-Status. Filter: Kategorie (categoryId = direkt zugeordnete Produkte, Unterkategorien einzeln angeben), Suchbegriff (Name oder SKU), Preisspanne (Verkaufspreis), aktiv, maxStock. Paginierung über offset (max. 100 je Aufruf; details=true max. 25 mit Beschreibung + Attributen). Einzelprodukte von Varianten nur mit includeVariants.',
      { categoryId: z.string().optional(), term: z.string().optional(), minPrice: z.number().optional(), maxPrice: z.number().optional(), active: z.boolean().optional(), maxStock: z.number().optional(), includeVariants: z.boolean().optional(), details: z.boolean().optional(), limit: z.number().optional(), offset: z.number().optional() },
      guard(async a => {
        const n = lim(a.limit, 50, a.details ? 25 : 100), page = Math.floor(Math.max(0, a.offset ?? 0) / n) + 1;
        const r = await searchProducts({ ...a, limit: n, page, fields: true });
        let rows = r.items;
        if (a.minPrice != null || a.maxPrice != null) rows = rows.filter(p => { const s = priceOf(p).selling; return s != null && (a.minPrice == null || s >= a.minPrice) && (a.maxPrice == null || s <= a.maxPrice); });
        if (a.maxStock != null) rows = rows.filter(p => p.qty != null && Number(p.qty) <= a.maxStock!);
        const products = await Promise.all(rows.map(async p => {
          const s = priceOf(p), imgs = p.images ?? [];
          return { id: String(p.id), number: p.sku, name: p.name, type: p.type_id, price: s.selling, listPrice: s.list, regularPrice: s.regular, specialPrice: s.special, specialTo: s.to, stock: p.qty ?? null, inStock: p.is_in_stock ?? null, active: isActive(p), visibility: VISIBILITY[Number(p.visibility)],
            descriptionLength: plain(omAttr(p, 'description')).length, hasMetaTitle: !!omStr(p, 'meta_title'), hasMetaDescription: !!omStr(p, 'meta_description'), hasImage: imgs.some(e => !e.disabled), imagesWithoutAlt: imgs.filter(e => !e.disabled && !plain(e.label)).length,
            ...(a.details ? { description: excerpt(omAttr(p, 'description'), 500), shortDescription: excerpt(omAttr(p, 'short_description'), 300), attributes: await userAttrs((await ro().product(p.sku)) ?? p) } : {}) };
        }));
        return ok({ total: r.total, priceBasis: basisWord(await ro().priceBasis()), offset: (page - 1) * n, returned: products.length, ...(page < r.pages ? { nextOffset: page * n } : {}), products });
      })),

    tool('list_product_attributes', 'Produktattribute (z. B. Hersteller, Farbe, Material) mit Typ, Geltungsbereich und Auswahlwerten LESEN, Grundlage für propose_product_changes (fields.attributes) und Varianten. Ohne term nur eigene Attribute. Ändert nichts.',
      { term: z.string().optional(), code: z.string().optional() }, guard(async ({ term, code }) => {
        const all = (await ro().attributes()).attributes;
        const rows = code ? all.filter(x => x.code === code) : all.filter(x => x.is_user_defined && (!term || String(x.code).includes(term.toLowerCase()) || String(x.label ?? '').toLowerCase().includes(term.toLowerCase())));
        return ok(rows.slice(0, 200).map(x => ({ code: x.code, label: x.label, input: x.input, scope: x.scope, userDefined: !!x.is_user_defined, writable: x.writable !== false, values: ((x.options ?? []) as { label: string; value: unknown }[]).filter(o => o.value !== '' && o.value != null).slice(0, 100).map(o => o.label) })));
      })),

    tool('get_seo_urls', 'Kanonische Storefront-URLs von Produkten oder Kategorien (URL-Schlüssel + Suffix der Store-View) für interne Links. Produkte, die nicht einzeln sichtbar sind, haben keine URL. Ändert nichts.',
      { entity: z.enum(['product', 'category']), ids: z.array(z.string()).max(50) }, guard(async ({ entity, ids }) => {
        const out: OmRecord[] = [];
        for (const id of ids) {
          if (entity === 'product') { const p = await ro().productByRef(id); out.push(p ? { id: String(p.id), name: p.name, urlKey: omStr(p, 'url_key'), url: await ro().productUrl(p), active: isActive(p) } : { id, error: 'nicht gefunden' }); }
          else { const c = await ro().category(id); out.push(c ? { id: String(c.id), name: c.name, urlKey: c.url_key ?? null, url: await ro().categoryUrl(c), active: !!c.is_active } : { id, error: 'nicht gefunden' }); }
        }
        return ok(out);
      })),

    tool('seo_audit', 'SEO-Bestandsaufnahme (nur lesen), seitenweise für große Kataloge: entity=product prüft aktive, einzeln sichtbare Produkte, entity=category aktive Kategorien auf Meta-Title (fehlt, über 60, unter 30, doppelt), Meta-Description (fehlt, außerhalb 120 bis 158, doppelt), dünne Beschreibung (unter 50 Wörtern) und bei Produkten Bilder (kein Bild, Bild ohne Alt-Text). Liefert Anzahl und IDs je Problem (wichtig zuerst) und die schwächsten Datensätze; nextOffset = nächste Seite. Ändert nichts: Korrekturen über propose_product_changes, propose_category_changes, propose_alt_texts.',
      { entity: z.enum(['product', 'category']), limit: z.number().optional().describe('Datensätze je Seite, Standard 200'), offset: z.number().optional() }, guard(async a => ok(await seoAudit(ro(), a)))),

    tool('get_product_images', 'Liest die Bilder eines oder vieler Produkte (max. 50): je Bild mediaId, Position, Titelbild (cover = Basisbild), Rollen (image/small_image/thumbnail), Datei, URL, Alt-Text (Bild-Label), hidden (ausgeblendet), altMissing. Ändert nichts.',
      { productIds: z.array(z.string()).optional(), productNumbers: z.array(z.string()).optional() }, guard(async ({ productIds, productNumbers }) => {
        if (!ro().allowed('media')) return fail('ZUGRIFF VERWEIGERT: Medienbibliothek ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).');
        const refs = [...(productIds ?? []), ...(productNumbers ?? [])];
        if (!refs.length) return fail('productIds oder productNumbers angeben');
        if (refs.length > 50) return fail('Maximal 50 Produkte pro Aufruf');
        const ps = await loadProducts(ro(), refs, { images: true }); // Galerie kommt mit der Liste (with=images), Detail nur zur Sicherheit
        const seen = new Set<number>(), out: OmRecord[] = [];
        for (const p of ps.values()) { if (seen.has(p.id)) continue; seen.add(p.id); const full = p.images ? p : (await ro().product(p.sku)) ?? p; out.push({ id: String(p.id), number: p.sku, name: p.name, type: p.type_id, images: await imageRows(ro(), full) }); }
        return ok(out);
      })),

    tool('find_image_gaps', 'Findet Produkte mit Bildlücken (seitenweise, mit nextOffset): missing="images" = Produkte ohne sichtbares Bild, missing="alt" = Produkte mit Bildern ohne Alt-Text (liefert diese Bilder). Filter: Kategorie, aktiv, includeVariants. Ändert nichts.',
      { missing: z.enum(['images', 'alt']), categoryId: z.string().optional(), active: z.boolean().optional(), includeVariants: z.boolean().optional(), limit: z.number().optional(), offset: z.number().optional() },
      guard(async a => {
        if (!ro().allowed('media')) return fail('ZUGRIFF VERWEIGERT: Medienbibliothek ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).');
        const n = lim(a.limit, 25, 100), page = Math.floor(Math.max(0, a.offset ?? 0) / 100) + 1;
        const r = await searchProducts({ ...a, limit: 100, page, fields: true });
        const hits: OmRecord[] = [];
        for (const p of r.items) {
          const vis = (p.images ?? []).filter(e => !e.disabled);
          if (a.missing === 'images' && !vis.length && p.type_id !== 'configurable') hits.push({ id: String(p.id), number: p.sku, name: p.name, active: isActive(p) });
          if (a.missing === 'alt' && vis.some(e => !plain(e.label))) hits.push({ id: String(p.id), number: p.sku, name: p.name, active: isActive(p), imagesWithoutAlt: (await imageRows(ro(), p)).filter(i => !i.hidden && i.altMissing) });
        }
        return ok({ missing: a.missing, scanned: r.items.length, ofProducts: r.total, offset: (page - 1) * 100, found: hits.length, products: hits.slice(0, n), ...(page < r.pages ? { nextOffset: page * 100 } : {}), hint: 'Je Aufruf werden 100 Produkte geprüft; mit nextOffset weiterblättern, bis keiner mehr kommt.' });
      })),

    tool('get_translations', 'Liest Name, Beschreibung, Kurzbeschreibung (Produkte), Meta-Title, Meta-Description, Meta-Keywords JE STORE-VIEW für Produkte oder Kategorien (max. 20). own=false heißt: die Store-View hat keinen eigenen Wert und zeigt den globalen Text. Ändert nichts.',
      { entity: z.enum(['product', 'category']), ids: z.array(z.string()).max(20), stores: z.array(z.string()).optional().describe('Store-View-Codes; ohne = alle'), full: z.boolean().optional() },
      guard(async a => {
        const views = (await storeViewList(ro())).filter(v => !a.stores?.length || a.stores.includes(v.code)), FIELDS = TRANSLATION_FIELDS[a.entity], out: OmRecord[] = [];
        for (const id of a.ids) {
          const glob = a.entity === 'product' ? await ro().productByRef(id, 'admin') : await ro().category(id, 'admin');
          if (!glob) { out.push({ id, error: 'nicht gefunden' }); continue; }
          const ref = a.entity === 'product' ? String(glob.sku) : String(glob.id), per: OmRecord = {};
          for (const v of views) {
            const rec = a.entity === 'product' ? await ro().product(ref, v.code) : await ro().category(ref, v.code);
            per[v.code] = Object.fromEntries(Object.entries(FIELDS).map(([f, def]) => { const val = omAttr(rec, def.attr!), own = !!rec?.store_overrides?.includes(def.attr!); return [f, { value: a.full ? val ?? null : excerpt(val, 300) || null, own }]; }));
          }
          out.push({ id: String(glob.id), name: glob.name, global: Object.fromEntries(Object.entries(FIELDS).map(([f, def]) => [f, a.full ? omAttr(glob, def.attr!) ?? null : excerpt(omAttr(glob, def.attr!), 300) || null])), storeViews: per });
        }
        return ok(out);
      })),

    tool('get_variants', 'Liest die Varianten eines konfigurierbaren Produkts: Achsen (z. B. Farbe) mit Ausprägungen und alle Einzelprodukte mit Ausprägung, SKU, Preis, Status, Bestand. Ändert nichts.',
      { id: z.string().describe('ID oder SKU des Hauptprodukts') }, guard(async ({ id }) => ok(await readVariants(ro(), id)))),

    tool('preview_bulk_filter', 'Zählt, welche Produkte ein Stapel-Filter trifft (alle Seiten; categoryId = direkt zugeordnete Produkte, Unterkategorien einzeln angeben), und zeigt 10 Beispiele, um den Umfang VOR propose_bulk_product_change abzustimmen. Ändert nichts.',
      bulkFilterShape(), guard(async f => {
        const { rows, scanned, total } = await resolveBulk(ro(), f);
        return ok({ matched: rows.length, scanned, total, max: BULK_MAX, examples: await Promise.all(rows.slice(0, 10).map(brief)) });
      })),

    tool('list_promotions', 'LIEST Promotionen = Warenkorb-Preisregeln (max. 100 je Aufruf): Name, Status (läuft/geplant/abgelaufen/inaktiv), Zeitraum, Rabatt als Text, Code-Art (ohne Code / fester Code), Priorität, Limits und Anzahl Einlösungen (nur Zählwerte, nie Kunden oder Bestellungen). Ändert nichts.',
      { status: z.enum(['running', 'scheduled', 'expired', 'inactive', 'all']).optional(), term: z.string().optional(), withCode: z.boolean().optional(), limit: z.number().optional(), page: z.number().optional() },
      guard(async a => {
        const n = lim(a.limit, 50, 100), page = Math.max(1, Math.floor(a.page ?? 1));
        const r = await ro().salesRules({ ...(a.term ? { name: a.term } : {}), limit: n, page, sort: 'sort_order', dir: 'asc' });
        const want: Record<string, string> = { running: 'läuft', scheduled: 'geplant', expired: 'abgelaufen', inactive: 'inaktiv' };
        const rows = r.items.filter(x => (!a.status || a.status === 'all' || promoStatus(x) === want[a.status]) && (a.withCode == null || (Number(x.coupon_type) !== 1) === a.withCode));
        return ok({ total: r.meta.total, page, returned: rows.length, hasMore: page < r.meta.pages, promotions: await Promise.all(rows.map(x => promoView(ro(), x))) });
      })),

    tool('get_promotion', 'LIEST eine Promotion (Warenkorb-Preisregel) im Detail: Rabatt, Einschränkung auf Kategorien/Artikel, Mindestbestellwert, Code mit Zählwerten, Limits. Keine Kunden- oder Bestelldaten. Ändert nichts.',
      { id: z.string() }, guard(async ({ id }) => { const r = await ro().salesRule(id); return r ? ok(await promoView(ro(), r, true)) : fail('Promotion nicht gefunden'); })),

    tool('propose_product_changes', `SCHLÄGT Änderungen an einem oder vielen Produkten vor (max. ${MAX_ITEMS}). Es wird NICHTS geschrieben: Der Nutzer sieht Alt → Neu, wählt aus und gibt frei; erst dann schreibt der Server. Der Aufruf wartet auf die Entscheidung. Felder: ${Object.keys(OM_PRODUCT_FIELDS).join(', ')}, attributes. Preise als Zahl ODER Regel (der Server rechnet): {percent:-10, round:".99"} | {add:2.5} | {set:19.99}. price = Verkaufspreis, listPrice = Streichpreis (null entfernt ihn; in OpenMage wird daraus regulärer Preis + Sonderpreis), specialFromDate/specialToDate = Zeitraum des Sonderpreises (JJJJ-MM-TT). stock = ganze Zahl, active = true/false, visibility = none|catalog|search|both, description/shortDescription = HTML, attributes = {code: Wert} für eigene Attribute (Auswahlwerte per Label, siehe list_product_attributes). Texte gelten für die Store-View aus den Einstellungen bzw. global, wenn sie keinen eigenen Wert hat.`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('Produkt-ID oder SKU; bei numerischen SKUs eindeutig als "id:123" bzw. "sku:123"'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildProductChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_new_products', 'SCHLÄGT NEUE PRODUKTE vor (z. B. aus hochgeladenen Fotos: erst view_image, dann Name, Beschreibung, SEO aus dem Bild ableiten). Es wird NICHTS geschrieben: Der Nutzer sieht die Produkte samt Bildern und gibt frei. Standard: inaktiv (Entwurf), Bestand 0, sichtbar in Katalog und Suche, alle Websites. Preis NIE schätzen: fehlt er, per ask_user erfragen. Keine erfundenen Fakten.',
      { title: z.string(), reason: z.string(), products: z.array(z.object({
        name: z.string(), description: z.string().describe('HTML'), price: z.number(), sku: z.string().optional(), stock: z.number().optional(), active: z.boolean().optional(), shortDescription: z.string().optional(),
        metaTitle: z.string().optional(), metaDescription: z.string().optional(), keywords: z.string().optional(), weight: z.number().optional(), categoryIds: z.array(z.string()).optional(),
        images: z.array(z.string()).optional().describe('staged:… (Anhang/import_image), mediaId (om-…) oder https-URL; erstes = Titelbild'), taxClass: z.string().optional().describe('Steuerklasse (Label), Standard „Taxable Goods“'),
      })) },
      guard(async a => { const { cs } = await buildNewProductsChangeSet(ro(), a); return ok(await session.requestChange(cs)); })),

    tool('propose_category_changes', `SCHLÄGT Änderungen an Kategorien vor (Freigabe-Workflow wie bei Produkten). Felder: ${Object.keys(OM_CATEGORY_FIELDS).join(', ')} (description = HTML). URL-Schlüssel über propose_seo_urls, Produktzuordnung über propose_category_products.`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string(), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildCategoryChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_category_products', 'SCHLÄGT vor, Produkte einer Kategorie zuzuordnen (add, optional mit Position) oder aus ihr zu entfernen (remove). Es wird NICHTS geschrieben, bis der Nutzer freigibt; Rückgängig stellt die Zuordnung mit Position wieder her.',
      { title: z.string(), reason: z.string(), categoryId: z.string(), add: z.array(z.object({ productId: z.string(), position: z.number().optional() })).optional(), remove: z.array(z.string()).optional() },
      guard(async a => { const { cs, payload } = await buildCategoryProductsChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_product_images', `SCHLÄGT Bildänderungen an Produkten vor (max. ${MAX_ITEMS}): Bilder hinzufügen, ausblenden (remove), umsortieren, Titelbild setzen. add.image: staged:… (Anhang, import_image, generate_image), mediaId (om-…, vorhandenes Shop-Bild) oder https-URL. remove/order/cover: mediaId aus get_product_images (bzw. das image eines neuen Bildes). Entfernen blendet das Bild aus (bleibt in OpenMage gespeichert). Es wird NICHTS geschrieben, bis der Nutzer freigibt. Alt-Texte vorhandener Bilder: propose_alt_texts.`,
      { title: z.string(), reason: z.string(), products: z.array(z.object({ productId: z.string(), add: z.array(z.object({ image: z.string(), position: z.number().optional().describe('0 = vorne'), cover: z.boolean().optional(), alt: z.string().optional() })).optional(), remove: z.array(z.string()).optional(), order: z.array(z.string()).optional(), cover: z.string().optional() })) },
      guard(async a => { const { cs, payload } = await buildProductImagesChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_alt_texts', `SCHLÄGT Alt-Texte (OpenMage: Bild-Label) für Produktbilder vor (max. ${MAX_ITEMS}). Jedes Bild MUSS vorher mit view_image angesehen worden sein, sonst wird es übersprungen. Konkret beschreiben, was zu sehen ist, ≤ ${ALT_MAX} Zeichen, ohne „Bild von“. Gilt für die Store-View aus den Einstellungen bzw. global. Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { title: z.string(), reason: z.string(), images: z.array(z.object({ mediaId: z.string(), alt: z.string() })) },
      guard(async a => { const { cs, payload } = await buildAltTextChangeSet(ro(), a, viewedImages(session.events)); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_translations', `SCHLÄGT Übersetzungen für Produkte oder Kategorien vor: eigene Werte je Store-View (max. ${MAX_ITEMS} Einträge). Felder: name, description, shortDescription (nur Produkte), metaTitle, metaDescription, keywords. null entfernt den eigenen Wert (Store-View zeigt wieder den globalen Text, „Standardwert verwenden“). Es wird NICHTS geschrieben, bis der Nutzer freigibt. Übersetzt NICHT selbst, du lieferst die fertigen Texte.`,
      { title: z.string(), reason: z.string(), entity: z.enum(['product', 'category']), changes: z.array(z.object({ id: z.string(), store: z.string().describe('Store-View-Code (list_store_views) oder Locale'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildTranslationChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_seo_urls', 'SCHLÄGT neue URL-Schlüssel für Produkte oder Kategorien vor. Der Server normalisiert (klein, ä→ae, Bindestriche) und prüft, ob der Schlüssel frei ist. Nach Freigabe legt OpenMage eine 301-Weiterleitung von der alten URL an (wenn „Save Rewrites History“ aktiv ist). Nur ändern, wenn der Nutzer es will oder die URL unsprechend ist.',
      { title: z.string(), reason: z.string(), entity: z.enum(['product', 'category']), changes: z.array(z.object({ id: z.string(), urlKey: z.string().describe('z. B. "vase-kiesel-steinzeug" (ohne .html, ohne Pfad)') })) },
      guard(async a => { const { cs, payload } = await buildSeoUrlChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_variants', 'SCHLÄGT Änderungen an den Einzelprodukten EINES konfigurierbaren Produkts vor: je Variante (sku, id oder options wie {"Farbe": "Salbei"}) Preis (Zahl oder Regel), Streichpreis, Bestand, aktiv. Neue Varianten legt Lotse in OpenMage nicht an (im Admin anlegen); Rückgängig stellt die alten Werte exakt wieder her.',
      { title: z.string(), reason: z.string(), productId: z.string(), changes: z.array(z.object({ sku: z.string().optional(), id: z.string().optional(), options: z.record(z.string(), z.string()).optional(), price: priceRule().or(z.number()).optional(), listPrice: priceRule().or(z.number()).or(z.null()).optional(), stock: z.number().optional(), active: z.boolean().optional() })) },
      guard(async a => { const { cs, payload } = await buildVariantsChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_bulk_product_change', `STAPELVERARBEITUNG: SCHLÄGT EINE Regel für ALLE Produkte eines Filters vor (bis ${BULK_MAX.toLocaleString('de-DE')}), ohne sie aufzuzählen. Der Server liest alle passenden Produkte seitenweise, rechnet selbst und zeigt Gruppen (ohne/mit Warnungen, abwählbar) und eine Stichprobe. Nach Freigabe schreibt er in Blöcken mit Fortschritt; Rückgängig stellt alle alten Werte wieder her. change: price {percent|add|set, round?}, listPrice {…} | null (entfernen) | "currentPrice" (Streichpreis = bisheriger Preis), specialFromDate/specialToDate (JJJJ-MM-TT|null), active.`,
      { title: z.string(), reason: z.string(), filter: z.object(bulkFilterShape()), change: z.object({ price: priceRule().optional(), listPrice: z.union([priceRule(), z.null(), z.literal('currentPrice')]).optional(), specialFromDate: z.string().nullable().optional(), specialToDate: z.string().nullable().optional(), active: z.boolean().optional() }) },
      guard(async ({ title, reason, filter, change }) => {
        const c = change as BulkChange;
        for (const k of ['specialFromDate', 'specialToDate'] as const) if (c[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(c[k]))) return fail(`${k}: JJJJ-MM-TT oder null`);
        const { rows, scanned, total } = await resolveBulk(ro(), filter);
        const hints = scanned < total ? [`Nur die ersten ${scanned.toLocaleString('de-DE')} von ${total.toLocaleString('de-DE')} Produkten geprüft. Filter enger fassen.`] : [];
        const { cs, payload } = bulkChangeSet(title, reason || describeBulk(c), c, rows, await ro().priceBasis(), await ro().store(), hints);
        return ok(await session.requestChange(cs, payload));
      })),

    tool('propose_promotion', 'SCHLÄGT eine neue Promotion (Warenkorb-Preisregel, ohne id) oder die Änderung einer bestehenden (mit id) vor. Es wird NICHTS geschrieben, bis der Nutzer freigibt. Neu: name, discount, code und active sind Pflicht (active=true mit künftigem validFrom = geplant). discount: type percentage | absolute (€ je Artikel) | cart_fixed (€ auf den Warenkorb) | buy_x_get_y, value, optional step (bei buy_x_get_y: X), maxQty, applyToShipping, categoryIds/productIds (Rabatt nur auf diese Artikel, zugleich Bedingung „Artikel im Warenkorb“). code: none | fixed (code); OpenMage-Einzelcodes legt Lotse nicht an. minSubtotal = Mindestbestellwert. Datum JJJJ-MM-TT, null entfernt. Gilt für alle Kundengruppen und Websites.',
      { id: z.string().optional(), reason: z.string(), name: z.string().optional(), description: z.string().nullable().optional(), active: z.boolean().optional(), validFrom: z.string().nullable().optional(), validUntil: z.string().nullable().optional(),
        code: z.object({ mode: z.enum(['none', 'fixed']), code: z.string().optional() }).optional(),
        discount: z.object({ type: z.enum(['percentage', 'absolute', 'cart_fixed', 'buy_x_get_y']), value: z.number(), step: z.number().optional(), maxQty: z.number().nullable().optional(), applyToShipping: z.boolean().optional(), categoryIds: z.array(z.string()).optional(), productIds: z.array(z.string()).optional() }).optional(),
        minSubtotal: z.number().nullable().optional(), priority: z.number().optional(), exclusive: z.boolean().optional().describe('true = weitere Regeln danach nicht anwenden'), maxUsesPerCustomer: z.number().nullable().optional(), maxUsesPerCoupon: z.number().nullable().optional() },
      guard(async a => { const { cs, payload } = await buildPromotionChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_cms_page_changes', `SCHLÄGT Änderungen an vorhandenen CMS-Seiten vor (max. 50): Felder ${CMS_FIELDS.join(', ')} (content = vollständiges HTML der Seite). Vorher get_cms_page lesen und nur ändern, was nötig ist (z. B. kaputte Links, Metas). Vorhandene Direktiven ({{block …}}) bleiben, neue werden entschärft. Systemseiten (404, Cookies, Startseite) sind ausgeschlossen. Es wird NICHTS geschrieben, bis der Nutzer freigibt; Rückgängig stellt die alten Werte exakt wieder her. Neue Seiten: draft_page + publish_page.`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('Seiten-id oder identifier'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const { cs, payload } = await buildCmsPageChangeSet(ro(), a); return ok(await session.requestChange(cs, payload)); })),

    tool('propose_promotion_status', `SCHLÄGT vor, eine oder viele Promotionen (max. ${MAX_ITEMS}) zu aktivieren, zu deaktivieren oder zu beenden (end = Enddatum heute + inaktiv). Es wird NICHTS geschrieben, bis der Nutzer freigibt.`,
      { ids: z.array(z.string()), action: z.enum(['activate', 'deactivate', 'end']), reason: z.string().optional() },
      guard(async a => ok(await session.requestChange(await buildPromotionStatusChangeSet(ro(), a))))),
  ] as AnyTool[];
}

function priceRule() { return z.object({ percent: z.number().optional(), add: z.number().optional(), set: z.number().optional(), round: z.string().optional().describe('".99", ".95", ".00" oder "none"') }); }
function bulkFilterShape() {
  return { categoryId: z.string().optional(), term: z.string().optional(), minPrice: z.number().optional(), maxPrice: z.number().optional(), active: z.boolean().optional(), typeId: z.enum(['simple', 'configurable', 'virtual', 'bundle', 'grouped', 'downloadable']).optional(), skus: z.array(z.string()).max(200).optional() };
}
