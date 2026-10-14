import 'server-only';
// Shopware tools of the AI (read via session.sw = ReadOnlyShopware, write only via change sets).
// Core tools (ask_user, draft_page, publish_page, style guide, images) live in ../../tools.ts, feature areas in ../../features.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { PAGE_TYPES, type RawBlock } from '../../cms';
import { buildCategoryChangeSet, buildNewProductsChangeSet, buildProductChangeSet, CATEGORY_FIELDS, MAX_ITEMS, PRODUCT_FIELDS } from '../../changes';
import { noteMedia } from '../../media';
import { storefrontBase } from '../../runtime';
import type { Session } from '../../sessions';
import type { ShopReader, SwEntity } from '../../shopware';
import { assertShopUrl, fetchShopPage, parseStorefront, resolveCmsTarget } from '../../storefront';
import { collectSignals } from '../../styleguide';
import { fail, guard, lim, nextOffsetOf, ok, pageOf, type AnyTool } from '../../tool-kit';

const money = (p: SwEntity) => (p?.price?.[0]?.gross != null ? `${Number(p.price[0].gross).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €` : null);
export const brief = (p: SwEntity) => ({
  id: p.id, name: p.translated?.name ?? p.name, number: p.productNumber, price: money(p),
  manufacturer: p.manufacturer?.translated?.name, image: p.cover?.media?.url, cmsPageId: p.cmsPageId,
  ...(noteMedia(p.cover?.media) ? { imageAiGenerated: true } : {}),
});

// Blocks of an existing Shopping Experience in reading order (source for reuse blocks)
export const cmsPageCriteria = { associations: { sections: { sort: [{ field: 'position' }], associations: { blocks: { sort: [{ field: 'position' }], associations: { slots: {} } } } } } };
export async function loadRawBlocks(sw: ShopReader, cmsPageId: string): Promise<RawBlock[]> {
  const p = await sw.get('cms-page', cmsPageId, cmsPageCriteria);
  if (!p) throw new Error(`CMS-Seite ${cmsPageId} nicht gefunden`);
  return (p.sections as SwEntity[]).flatMap(s => (s.blocks as SwEntity[]).map((b): RawBlock => ({
    type: b.type, name: b.name, cssClass: b.cssClass, backgroundColor: b.backgroundColor, backgroundMediaId: b.backgroundMediaId, backgroundMediaMode: b.backgroundMediaMode,
    marginTop: b.marginTop, marginBottom: b.marginBottom, marginLeft: b.marginLeft, marginRight: b.marginRight,
    slots: (b.slots as SwEntity[]).map(sl => ({ slot: sl.slot, type: sl.type, config: sl.config ?? null })),
  })));
}

export const SHOPWARE_TOOL_NAMES = ['list_sales_channels', 'search_categories', 'search_products', 'get_product', 'get_category', 'search_media', 'list_cms_pages', 'get_cms_page', 'read_page', 'get_brand_signals', 'list_products', 'propose_product_changes', 'propose_new_products', 'propose_category_changes'];

export function shopwareTools(session: Session): AnyTool[] {
  const { sw } = session;
  return [
    tool('list_sales_channels', 'Verkaufskanäle samt Domains (für Landingpage-URLs und Storefront-Links) und Einstiegskategorie (navigationCategoryId = Startseite des Verkaufskanals).', {}, guard(async () => {
      const sc = await sw.salesChannels();
      return ok(sc.map(s => ({ id: s.id, name: s.translated?.name ?? s.name, domains: s.domains?.map((d: SwEntity) => d.url), navigationCategoryId: s.navigationCategoryId ?? null })));
    })),

    tool('search_categories', 'Kategorien suchen (Name) oder – ohne term – die obersten Kategorien listen. Liefert id, Name, Breadcrumb, Typ, aktuelle CMS-Seite, Kurzbeschreibung (max. 100 je Aufruf).',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        const r = await sw.search('category', {
          limit: lim(limit, 20, 100), ...(term ? { term } : { filter: [{ type: 'range', field: 'level', parameters: { lte: 3 } }] }),
          associations: { cmsPage: {} },
        });
        return ok(r.data.map(c => ({ id: c.id, name: c.translated?.name, path: c.translated?.breadcrumb?.join(' > '), type: c.type, cmsPage: c.cmsPage?.name ?? null, description: (c.translated?.description ?? '').slice(0, 200) })));
      })),

    tool('search_products', 'Produkte suchen (Freitext) und/oder auf eine Kategorie einschränken (max. 50 je Aufruf; Massenlesen: list_products).',
      { term: z.string().optional(), categoryId: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, categoryId, limit }) => {
        const r = await sw.search('product', {
          limit: lim(limit, 15, 50), ...(term ? { term } : {}),
          filter: [{ type: 'equals', field: 'parentId', value: null }, ...(categoryId ? [{ type: 'equals', field: 'categoriesRo.id', value: categoryId }] : [])],
          associations: { cover: { associations: { media: {} } }, manufacturer: {} },
        });
        return ok({ total: r.total, products: r.data.map(brief) });
      })),

    tool('get_product', 'Produktdetails: Beschreibung, Eigenschaften, Bilder, Kategorien, Hersteller, SEO-Felder.',
      { id: z.string() }, guard(async ({ id }) => {
        const p = await sw.get('product', id, { associations: { cover: { associations: { media: {} } }, media: { associations: { media: {} } }, manufacturer: {}, categories: {}, properties: { associations: { group: {} } }, cmsPage: {} } });
        if (!p) return fail('Produkt nicht gefunden');
        return ok({
          ...brief(p), description: p.translated?.description, metaTitle: p.translated?.metaTitle, metaDescription: p.translated?.metaDescription, keywords: p.translated?.keywords,
          stock: p.stock, ean: p.ean, categories: p.categories?.map((c: SwEntity) => ({ id: c.id, name: c.translated?.name })),
          properties: p.properties?.map((x: SwEntity) => `${x.group?.translated?.name}: ${x.translated?.name}`),
          images: p.media?.filter((m: SwEntity) => m.media?.url).map((m: SwEntity) => (noteMedia(m.media) ? { url: m.media.url, aiGenerated: true } : m.media.url)), cmsPage: p.cmsPage?.name ?? null,
        });
      })),

    tool('get_category', 'Kategorie-Details inkl. Beschreibung, SEO-Felder, Unterkategorien und aktuell zugewiesener CMS-Seite.',
      { id: z.string() }, guard(async ({ id }) => {
        const c = await sw.get('category', id, { associations: { cmsPage: {}, children: {} } });
        if (!c) return fail('Kategorie nicht gefunden');
        return ok({ id: c.id, name: c.translated?.name, path: c.translated?.breadcrumb, description: c.translated?.description, metaTitle: c.translated?.metaTitle, metaDescription: c.translated?.metaDescription, cmsPage: c.cmsPage ? { id: c.cmsPage.id, name: c.cmsPage.name } : null, children: c.children?.map((x: SwEntity) => ({ id: x.id, name: x.translated?.name })) });
      })),

    tool('search_media', 'Medienbibliothek durchsuchen (vorhandene Bilder wiederverwenden). Liefert mediaId + URL; aiGenerated: true = KI-Bild (muss auf der Seite gekennzeichnet sein).',
      { term: z.string().optional(), limit: z.number().optional() }, guard(async ({ term, limit }) => {
        const r = await sw.search('media', { limit: lim(limit, 20, 50), ...(term ? { term } : {}), filter: [{ type: 'contains', field: 'mimeType', value: 'image' }] });
        return ok(r.data.map(m => ({ mediaId: m.id, file: `${m.fileName}.${m.fileExtension}`, url: m.url, alt: m.alt, title: m.title ?? undefined, ...(noteMedia(m) ? { aiGenerated: true } : {}) })));
      })),

    tool('list_cms_pages', 'Vorhandene CMS-Layouts (Shopping Experiences) auflisten.',
      { type: z.enum(PAGE_TYPES).optional() }, guard(async ({ type }) => {
        const r = await sw.search('cms-page', { limit: 30, filter: type ? [{ type: 'equals', field: 'type', value: type }] : [] });
        return ok(r.data.map(p => ({ id: p.id, name: p.name, type: p.type })));
      })),

    tool('get_cms_page', 'Liest den Aufbau einer vorhandenen Einkaufswelt (Sections → Blöcke → Slots mit Elementtyp und Config). Nutze das, um zu lernen, wie Shopware-Layouts (auch die Standard-Layouts) strukturiert sind, oder um ein bestehendes Layout als Vorlage zu übernehmen. Auch via categoryId/productId die zugewiesene Seite.',
      { id: z.string().optional(), categoryId: z.string().optional(), productId: z.string().optional() }, guard(async ({ id, categoryId, productId }) => {
        if (!id && categoryId) id = (await sw.get('category', categoryId))?.cmsPageId;
        if (!id && productId) id = (await sw.get('product', productId))?.cmsPageId;
        if (!id) return fail('Keine CMS-Seite gefunden (id/categoryId/productId angeben oder Ziel hat noch kein Layout).');
        const p = await sw.get('cms-page', id, cmsPageCriteria);
        if (!p) return fail('CMS-Seite nicht gefunden');
        const cut = (v: unknown) => (typeof v === 'string' && v.length > 1500 ? v.slice(0, 1500) + '…' : v);
        let blockIndex = 0; // running across all sections; this is how a reuse block addresses its source
        return ok({
          id: p.id, name: p.name, type: p.type,
          hint: 'Einen Block 1:1 übernehmen: {type:"reuse", cmsPageId:"' + p.id + '", blockIndex:<blockIndex>}',
          sections: p.sections.map((s: SwEntity) => ({ type: s.type, sizingMode: s.sizingMode, blocks: s.blocks.map((b: SwEntity) => ({ blockIndex: blockIndex++, block: b.type, sectionPosition: b.sectionPosition, slots: b.slots.map((sl: SwEntity) => ({ slot: sl.slot, element: sl.type, config: Object.fromEntries(Object.entries((sl.config ?? {}) as Record<string, { source?: string; value?: unknown } | null>).map(([k, c]) => [k, c?.source === 'mapped' ? `mapped:${c.value}` : cut(c?.value)])) })) })) })),
        });
      })),

    tool('read_page', 'Liest eine Seite des EIGENEN Shops per Storefront-URL (Kategorie, Produkt, Landingpage, Magazin-Artikel …): Titel, Meta-Description, Überschriften, Text, Bilder, interne Links sowie den echten Aufbau der Einkaufswelt (Sections → Blöcke → Elemente, auch Plugin-Blöcke) und die zugehörige CMS-Seite (cmsPage.id für get_cms_page / reuse). Nur URLs der Shop-Domains – kein freies Internet.',
      { url: z.string().url() }, guard(async ({ url }) => {
        const sc = await sw.salesChannels();
        const allowed = [...sc.flatMap(c => (c.domains ?? []).map((d: SwEntity) => String(d.url))), sw.base, await storefrontBase().catch(() => '')];
        const u = assertShopUrl(url, allowed);
        // follow redirects hop by hop: every target must be a shop address before it is requested
        const r = await fetchShopPage(u.href, allowed, { fetchImpl: (href, init) => (session.storefrontFetch ?? fetch)(href, init) });
        if (!r.ok) return fail(`Seite antwortet mit HTTP ${r.status}`);
        const html = (await r.text()).slice(0, 2_500_000);
        const page = parseStorefront(html, u.href);
        const target = await resolveCmsTarget(sw, u.href).catch(e => ({ error: e instanceof Error ? e.message : String(e) }));
        return ok({ url: u.href, ...page, target, hint: target && 'cmsPage' in target && target.cmsPage ? `Aufbau im Detail: get_cms_page id=${target.cmsPage.id}; Blöcke übernehmen: {type:"reuse", cmsPageId:"${target.cmsPage.id}", blockIndex}` : 'Keine CMS-Seite zugeordnet (Seite ohne Einkaufswelt oder unbekannte URL).' });
      })),

    tool('get_brand_signals', 'Onboarding: sammelt Marken-Signale aus dem laufenden Shop – Theme-Konfiguration (Admin → Darstellung), Storefront-CSS (Variablen, häufige Farben, Schriften, Button-Regeln), Logo, Überschriften sowie echte Produkt-/Kategorietexte für die Tonalität.', {}, guard(async () => {
      const sc = (await sw.salesChannels()).find(c => c.domains?.length);
      return ok(await collectSignals(sw, sc?.domains[0].url ?? sw.base, session.storefrontFetch ?? fetch));
    })),

    tool('list_products', 'Produkte in großer Zahl LESEN (für Preis-/Daten-Analysen und Massenänderungen): Preis brutto/netto, Streichpreis, Bestand, aktiv, Steuer. Filter: Kategorie, Suchbegriff, Preisspanne (brutto), aktiv, Bestand. Paginierung via offset (max 100 pro Aufruf); blättern mit nextOffset bei gleichem limit. Varianten standardmäßig ausgeblendet.',
      { categoryId: z.string().optional(), term: z.string().optional(), minPrice: z.number().optional(), maxPrice: z.number().optional(), active: z.boolean().optional(), maxStock: z.number().optional(), includeVariants: z.boolean().optional(), details: z.boolean().optional().describe('true = zusätzlich Kurzbeschreibung + Eigenschaften (Basis für individuelle Texte/FAQ; dann max. 25 pro Aufruf)'), limit: z.number().optional(), offset: z.number().optional() }, guard(async a => {
        const filter: Record<string, unknown>[] = [];
        if (!a.includeVariants) filter.push({ type: 'equals', field: 'parentId', value: null });
        if (a.categoryId) filter.push({ type: 'equals', field: 'categoriesRo.id', value: a.categoryId });
        if (a.active != null) filter.push({ type: 'equals', field: 'active', value: a.active });
        if (a.maxStock != null) filter.push({ type: 'range', field: 'stock', parameters: { lte: a.maxStock } });
        // price range server-side (gross price of the default currency) so that total and pages are correct
        if (a.minPrice != null || a.maxPrice != null) filter.push({ type: 'range', field: 'price', parameters: { ...(a.minPrice != null ? { gte: a.minPrice } : {}), ...(a.maxPrice != null ? { lte: a.maxPrice } : {}) } });
        const pg = pageOf(a.offset, lim(a.limit, 50, a.details ? 25 : 100)); // Shopware paginates by page
        const r = await sw.search('product', { limit: pg.limit, page: pg.page, ...(a.term ? { term: a.term } : {}), filter, 'total-count-mode': 1, associations: { tax: {}, manufacturer: {}, ...(a.details ? { properties: { associations: { group: {} } } } : {}) }, sort: [{ field: 'productNumber', order: 'ASC' }] });
        const rows = r.data, nextOffset = nextOffsetOf(pg.offset, rows.length, pg.limit, r.total);
        return ok({ total: r.total, returned: rows.length, offset: pg.offset, ...(pg.note ? { note: pg.note } : {}), ...(nextOffset != null ? { nextOffset } : {}), products: rows.map(p => ({ id: p.id, number: p.productNumber, name: p.translated?.name ?? p.name, gross: p.price?.[0]?.gross ?? null, net: p.price?.[0]?.net ?? null, listPriceGross: p.price?.[0]?.listPrice?.gross ?? null, stock: p.stock, active: p.active, taxRate: p.tax?.taxRate, manufacturer: p.manufacturer?.translated?.name, descriptionLength: (p.translated?.description ?? '').length, hasMetaTitle: !!p.translated?.metaTitle, hasMetaDescription: !!p.translated?.metaDescription, hasImage: !!p.coverId, hasFaq: !!p.customFields?.aicb_blocks?.faq_html, cmsPageId: p.cmsPageId ?? null, ...(a.details ? { description: (p.translated?.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500), properties: p.properties?.map((x: SwEntity) => `${x.group?.translated?.name}: ${x.translated?.name}`) } : {}) })) });
      })),

    tool('propose_product_changes', `SCHLÄGT Änderungen an einem oder vielen Produkten vor (max. ${MAX_ITEMS}). Es wird NICHTS geschrieben: Der Nutzer sieht einen Alt→Neu-Vergleich, wählt aus und gibt frei; erst dann schreibt der Server. Der Aufruf wartet auf die Entscheidung und liefert das Ergebnis. Erlaubte Felder: ${Object.keys(PRODUCT_FIELDS).join(', ')}. faq = produktindividuelle FAQ als {title?, items:[{q,a}]} (2–10 Paare, reiner Text, nur belegte Fakten) für den Layout-Block pdp-faq. Preise (brutto) als Zahl ODER Regel (der Server rechnet): {percent:-10, round:".99"} | {add:2.5, round:".00"} | {set:19.99}; listPrice (Streichpreis) analog, null entfernt ihn. stock = ganze Zahl, active = true/false, Texte als String (description = HTML).`,
      { title: z.string().describe('Kurzer Titel, z.B. "Sommerpreise Clothing −10 %"'), reason: z.string().describe('Begründung/Regel in 1–2 Sätzen'), changes: z.array(z.object({ id: z.string().describe('productId'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const cs = await buildProductChangeSet(sw, a); return ok(await session.requestChange(cs)); })),

    tool('propose_new_products', 'SCHLÄGT NEUE PRODUKTE vor (z. B. aus hochgeladenen Fotos: erst view_image, dann Name, Beschreibung, SEO aus dem Bild ableiten). Es wird NICHTS geschrieben: Der Nutzer sieht die Produkte samt Bildern, wählt aus und gibt frei; erst dann legt der Server sie an. Standard: inaktiv (Entwurf) und Bestand 0. Preis NIE schätzen – fehlt er, per ask_user erfragen. Keine erfundenen Fakten (Material, Maße, Herkunft) – nur was auf dem Bild klar erkennbar ist oder der Nutzer sagt.',
      { title: z.string(), reason: z.string(), products: z.array(z.object({
        name: z.string(), description: z.string().describe('HTML: 2–4 kurze Absätze/Liste, konkret'), price: z.number().describe('Bruttopreis in €'),
        stock: z.number().optional(), active: z.boolean().optional().describe('Standard false = inaktiv anlegen'), productNumber: z.string().optional(),
        metaTitle: z.string().optional(), metaDescription: z.string().optional(), keywords: z.string().optional(), ean: z.string().optional(),
        manufacturer: z.string().optional(), taxRate: z.number().optional(), categoryIds: z.array(z.string()).optional(),
        images: z.array(z.string()).optional().describe('staged:… (Anhänge/import_image) oder mediaIds aus der Medienverwaltung; erstes = Titelbild'),
      })) },
      guard(async a => { const cs = await buildNewProductsChangeSet(sw, a); return ok(await session.requestChange(cs)); })),

    tool('propose_category_changes', `SCHLÄGT Änderungen an Kategorien vor (Freigabe-Workflow wie bei Produkten). Erlaubte Felder: ${Object.keys(CATEGORY_FIELDS).join(', ')} (description = HTML).`,
      { title: z.string(), reason: z.string(), changes: z.array(z.object({ id: z.string().describe('categoryId'), fields: z.record(z.string(), z.any()) })) },
      guard(async a => { const cs = await buildCategoryChangeSet(sw, a); return ok(await session.requestChange(cs)); })),
  ] as AnyTool[];
}
