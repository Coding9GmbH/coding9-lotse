import 'server-only';
// OpenMage: page drafts: preview data, link check, publishing as a change set with exact undo.
// Targets: landingpage = new CMS page (HTML with scoped CSS, configured store view or all), category = new CMS block +
// category display "statischer Block (und Produkte)" + landing_page, product = replace product description (one product) or append the
// content below the existing description (several). No CMS block for products: Magento 1's catalog filter doesn't support
// {{block}} in product texts (only skin/media/store), so the directive would appear as text on the page. Product sliders become
// static product boxes with the real data at the time of publishing (Magento 1 has no SKU list widget).
import { z } from 'zod';
import type { ChangeAsset, ChangeItem, ChatEvent, PublishedInfo, UndoOp } from '@/lib/protocol';
import { withScript } from '@/lib/script-scan';
import { GENERIC_BLOCKS, type ImageRef, type PageSpec, type PreviewCtx, type PreviewProduct } from '../../cms';
import { readStaged, stagedMeta } from '../../media';
import { renderPageHtml } from '../../page-html';
import { expandSpec } from '../../patterns';
import { collectLinks, findingText, rewriteLinks } from '../../seo-links';
import type { Session } from '../../sessions';
import type { PlatformCapabilities, PlatformPages } from '../types';
import { noDirectives } from '../magento/pagebuilder';
import { demoteH1, hasH1 } from '../magento/pages';
import { errMsg, newIdSafe, trackedUndo, type ApplyResult } from './kit';
import type { OmClient } from './client';
import { checkOmLinks } from './links';
import { cmsIdentifier, DISPLAY_MODE, isActive, isVisible, money, omAttr, omStr, parseMediaId, plain, priceOf, productPath, categoryPath, stripTitleAffixes, type OmCategory, type OmProduct, type OmRecord } from './map';
import { LIST_FIELDS, type OmReader } from './reader';
import { getCategory, getProduct, reg, reqOp, undoOpenmage, writeScoped } from './write';

/** What pages can do in OpenMage: free landing pages (CMS pages), category content (CMS block above the product list), product description */
export const OPENMAGE_CAPABILITIES: PlatformCapabilities = { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['landingpage', 'category', 'product'], blocks: GENERIC_BLOCKS, pageFormat: 'html', reuse: false };

const SVG_MAX = 200 * 1024;

// ================= Preview =================
export async function previewProducts(ro: OmReader, refs: string[]): Promise<Record<string, PreviewProduct & { url?: string }>> {
  const ids = refs.filter(r => /^\d+$/.test(r)), skus = refs.filter(r => !/^\d+$/.test(r));
  const list = [...await ro.productsByIds(ids, { fields: LIST_FIELDS }), ...await ro.productsBySkus(skus, { fields: LIST_FIELDS })];
  const sf = await ro.suffixes().catch(() => ({ product: '.html', category: '.html' })), base = await ro.storefrontBase().catch(() => ro.publicUrl);
  const out: Record<string, PreviewProduct & { url?: string }> = {};
  for (const p of list) {
    const s = priceOf(p), path = productPath(p, sf.product);
    const v: PreviewProduct & { url?: string } = { id: String(p.id), sku: p.sku, name: p.name ?? p.sku, price: money(s.selling), ...(s.list != null ? { listPrice: money(s.list) } : {}), img: ro.allowed('media') ? await ro.mediaUrl(omStr(p, 'small_image') ?? p.image) : undefined, description: (omStr(p, 'description') ?? omStr(p, 'short_description')) ?? undefined, active: isActive(p), visible: isVisible(p), url: path && isVisible(p) ? `${base}/${path}` : undefined };
    out[String(p.id)] = v; out[p.sku] = v; // blocks may reference ID or SKU
  }
  return out;
}

/** Image references of a draft: mediaId of the blocks (image/image2) */
function mediaRefs(spec: Partial<PageSpec>): string[] {
  const out = new Set<string>();
  for (const s of spec.sections ?? []) for (const b of s.blocks ?? []) for (const k of ['image', 'image2'] as const) { const im = b?.[k]; if (im && typeof im === 'object' && im.mediaId) out.add(im.mediaId); }
  return [...out];
}

export async function previewData(ro: OmReader, spec: PageSpec): Promise<PreviewCtx> {
  const refs = new Set<string>();
  for (const s of spec.sections) for (const b of s.blocks) (b.productIds ?? []).forEach(i => refs.add(String(i)));
  if (spec.previewProductId) refs.add(spec.previewProductId);
  if (spec.previewCategoryId && /^\d+$/.test(spec.previewCategoryId)) {
    const r = await ro.products({ category_id: spec.previewCategoryId, status: 1, visibility: '2,4', limit: 8 }).catch(() => ({ items: [] as OmProduct[] }));
    r.items.forEach(p => refs.add(String(p.id)));
  }
  const products = refs.size ? await previewProducts(ro, [...refs]) : {};
  const urls: Record<string, string | null | undefined> = {};
  for (const id of mediaRefs(spec)) {
    if (id.startsWith('staged:')) { const m = stagedMeta(id.slice(7)); urls[id] = m ? `/staged/${m.file}` : null; continue; }
    const mid = parseMediaId(id);
    if (mid) { const p = await ro.productById(mid.productId, 'admin').catch(() => null); urls[id] = await ro.mediaUrl(p?.images?.find(e => e.id === mid.imageId)?.file); }
  }
  return { products, product: spec.previewProductId ? products[spec.previewProductId] : undefined, imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im.url ?? urls[im.mediaId ?? '']) };
}

// ================= Rendering (pure) =================
export interface RenderCtx { imageUrl: (im: ImageRef) => string | null | undefined; products: Record<string, PreviewProduct & { url?: string }>; scope: string }
/** Draft → HTML content for OpenMage: static HTML (one root div with scoped CSS), directives defused */
export function renderContent(spec: PageSpec, ctx: RenderCtx): string {
  return noDirectives(renderPageHtml(expandSpec(spec), { imageUrl: ctx.imageUrl, products: ctx.products, scope: ctx.scope }));
}
/** Append new content below the existing description */
export const appendHtml = (existing: string | null | undefined, html: string) => { const cur = String(existing ?? '').trim(); return `${cur}${cur ? '\n' : ''}${html}`; };
/** Identifier of a Lotse block (unique per publication) */
export const blockIdentifier = (what: string, id: string) => `lotse-${what}-${id}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

// ================= Publishing: change set =================
export interface PublishArgs {
  target: 'landingpage' | 'category' | 'product';
  url?: string; title?: string; allStoreViews?: boolean;
  categoryId?: string; displayMode?: 'PRODUCTS_AND_PAGE' | 'PAGE';
  productIds?: string[]; mode?: 'replace' | 'append';
  metaTitle?: string; metaDescription?: string;
}
export interface PagePayload {
  target: PublishArgs['target']; name: string; store: string; content: string;
  page?: { identifier: string; title: string; contentHeading: string; metaDescription: string; stores: string[] };
  category?: { id: string; displayMode: string; metas: Record<string, string>; url: string | null };
  products?: { mode: 'replace' | 'append'; items: { id: string; sku: string; name: string; url: string | null; expect: string | null }[] };
  storefront: string;
}
const cut = (t: unknown, n = 160) => { const s = plain(t); return s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '–'; };

/** Resolve images: shop product images (om-…) and URLs directly, staged SVG inlined; other uploads are not supported (no media API for CMS) */
async function imageResolver(ro: OmReader, spec: PageSpec): Promise<{ imageUrl: RenderCtx['imageUrl']; assets: ChangeAsset[] }> {
  const urls = new Map<string, string>(), assets: ChangeAsset[] = [], bad: string[] = [];
  const staged = (id: string) => {
    const m = stagedMeta(id), f = m ? readStaged(id) : null;
    if (!m || !f) { bad.push(`Vorgemerktes Bild ${id} nicht gefunden`); return; }
    if (m.mime !== 'image/svg+xml') { bad.push(`„${m.name}“ (${m.mime.split('/')[1]})`); return; }
    if (f.buf.length > SVG_MAX) { bad.push(`„${m.name}“ (SVG größer als 200 KB)`); return; }
    urls.set(`staged:${id}`, `data:image/svg+xml;base64,${f.buf.toString('base64')}`);
    assets.push({ name: m.name, url: `/staged/${m.file}`, alt: m.alt ?? undefined, note: 'Vektorgrafik, wird in die Seite eingebettet' });
  };
  for (const id of mediaRefs(spec)) {
    if (id.startsWith('staged:')) { staged(id.slice(7)); continue; }
    const mid = parseMediaId(id);
    if (!mid) { bad.push(`mediaId ${id} (OpenMage: om-… aus search_media)`); continue; }
    const p = await ro.productById(mid.productId, 'admin');
    const u = await ro.mediaUrl(p?.images?.find(e => e.id === mid.imageId)?.file);
    if (!u) bad.push(`Medium ${id} nicht gefunden`); else urls.set(id, u);
  }
  const json = JSON.stringify(spec.sections);
  for (const m of json.matchAll(/\/staged\/([a-z0-9]+)\.([a-z]+)/g)) if (!urls.has(`staged:${m[1]}`)) staged(m[1]);
  if (bad.length) throw new Error(`OpenMage hat keine Schnittstelle, um Bilder für CMS-Seiten hochzuladen. Nicht verwendbar: ${[...new Set(bad)].join(', ')}. Verwende Produktbilder des Shops (search_media → mediaId om-…), öffentliche https-Bild-URLs oder Vektorgrafiken (create_svg_image).`);
  const imageUrl = (im: ImageRef) => (typeof im === 'string' ? im : im.mediaId ? urls.get(im.mediaId) ?? null : im.url ?? null);
  return { imageUrl, assets };
}
const inlineStaged = (spec: PageSpec, imageUrl: RenderCtx['imageUrl']): PageSpec => JSON.parse(JSON.stringify(spec).replace(/\/staged\/([a-z0-9]+)\.svg/g, (all, id) => imageUrl({ mediaId: `staged:${id}` }) ?? all));

export async function buildPagePublish(ro: OmReader, spec: PageSpec, a: PublishArgs) {
  const items: ChangeItem[] = [], warn: string[] = [];
  const info = (label: string, fieldLabel: string, before: string, after: string, w: string[] = [], html?: ChangeItem['html']) => items.push({ id: `i${items.length}`, entity: 'info', label, fieldLabel, before, after, warn: w, ...(html ? { html } : {}) });
  const sfBase = await ro.storefrontBase().catch(() => ro.publicUrl), sf = await ro.suffixes().catch(() => ({ product: '.html', category: '.html' })), store = await ro.store(), view = await ro.storeView(store).catch(() => undefined);
  // Page title = meta title; OpenMage appends the theme suffix (" | Shopname") itself
  const mt = stripTitleAffixes(a.metaTitle ?? spec.seo?.metaTitle ?? '', view), md = (a.metaDescription ?? spec.seo?.metaDescription ?? '').trim();

  const links = await checkOmLinks(ro, collectLinks(expandSpec(spec).sections));
  let work = links.report.rewrites.size ? rewriteLinks(spec, links.report.rewrites) : spec;
  warn.push(...links.report.findings.filter(f => f.level === 'wichtig').slice(0, 5).map(findingText));
  if (a.target !== 'landingpage') { const d = demoteH1(work); if (d.n) { work = d.spec; warn.push(`${d.n} H1-Überschrift(en) im Inhalt als H2 gesetzt: Die H1 liefert OpenMage (${a.target === 'category' ? 'Kategoriename' : 'Produktname'}).`); } }

  // Slider products: static product boxes with real data
  const refs = [...new Set(expandSpec(work).sections.flatMap(s => s.blocks.flatMap(b => (b.type === 'product-slider' ? b.productIds ?? [] : []).map(String))))];
  const products = refs.length ? await previewProducts(ro, refs) : {};
  for (const r of refs) { const p = products[r]; if (!p) { warn.push(`Produkt ${r} nicht gefunden: fehlt in der Produktliste`); continue; } if (!p.active || !p.visible) warn.push(`Produkt „${p.name}“ ist ${!p.active ? 'deaktiviert' : 'nicht einzeln sichtbar'} und sollte nicht verlinkt werden`); }
  if (refs.length) warn.push('Produktboxen sind statisch (Name, Preis, Bild zum Zeitpunkt der Veröffentlichung); Preisänderungen im Shop erscheinen darin nicht automatisch');

  const { imageUrl, assets } = await imageResolver(ro, work);
  work = inlineStaged(work, imageUrl);
  const scope = `lotse-${newIdSafe().slice(0, 8)}`, content = renderContent(work, { imageUrl, products, scope });
  const blocks = expandSpec(work).sections.reduce((n, s) => n + s.blocks.length, 0);
  const base: Omit<PagePayload, 'content' | 'storefront'> = { target: a.target, name: spec.name, store };

  if (a.target === 'landingpage') {
    if (!a.url) throw new Error('url fehlt (Pfad der Landingpage, z. B. "ratgeber/vasen")');
    const identifier = cmsIdentifier(a.url);
    const taken = await ro.cmsPageByIdentifier(identifier);
    if (taken) throw new Error(`URL „${identifier}“ ist schon vergeben (CMS-Seite „${taken.title}“, id ${taken.id}). Andere url wählen.`);
    const route = await ro.resolveUrl(identifier).catch(() => null);
    if (route && route.type !== 'HOME') throw new Error(`URL „${identifier}“ gehört schon zu ${route.type === 'PRODUCT' ? 'einem Produkt' : route.type === 'CATEGORY' ? 'einer Kategorie' : 'einer Seite'}. Andere url wählen.`);
    const h1 = hasH1(work), firstH1 = plain(JSON.stringify(expandSpec(work).sections).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/\\"/g, '"') ?? '');
    const title = (a.title ?? (firstH1 || spec.name)).trim().slice(0, 255);
    const stores = a.allStoreViews ? ['admin'] : [store];
    info('Neue Landingpage (CMS-Seite)', 'Anlegen', '–', `${spec.name} · ${blocks} Blöcke · HTML`, warn);
    info('Neue Landingpage', 'URL', '–', `/${identifier}`, ['Die Seite ist nach der Freigabe sofort aktiv und im Shop sichtbar']);
    info('Neue Landingpage', 'Seitentitel (Browser-Titel)', '–', mt || title, mt ? ['OpenMage nutzt den Seitentitel als Meta-Title'] : ['Kein eigener Meta-Title: OpenMage nimmt den Seitentitel']);
    info('Neue Landingpage', 'Überschrift des Themes', '–', h1 ? 'keine (H1 kommt aus dem Inhalt)' : title, h1 ? [] : ['Der Entwurf hat keine H1: das Theme zeigt den Seitentitel als H1']);
    info('Neue Landingpage', 'Store-View', '–', stores[0] === 'admin' ? 'alle Store-Views' : store);
    info('Neue Landingpage', 'Meta-Description', '–', md || '–', md ? [] : ['Keine Meta-Description']);
    return { cs: { id: newIdSafe(), kind: 'page', title: `Seite veröffentlichen: ${spec.name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec) }, payload: { ...base, content, page: { identifier, title: mt || title, contentHeading: h1 ? '' : title, metaDescription: md, stores }, storefront: `${sfBase}/${identifier}` } satisfies PagePayload };
  }

  if (a.target === 'category') {
    if (!a.categoryId) throw new Error('categoryId fehlt');
    const c = await ro.category(a.categoryId);
    if (!c) throw new Error(`Kategorie ${a.categoryId} nicht gefunden`);
    if (Number(c.level) < 2) throw new Error('Die Wurzelkategorie hat keine eigene Seite');
    const mode = a.displayMode ?? 'PRODUCTS_AND_PAGE', curMode = omStr(c, 'display_mode') ?? 'PRODUCTS', curBlock = c.landing_page_block;
    const name = String(c.name ?? c.id), label = `Kategorie „${name}“`, metas: Record<string, string> = {};
    if (mt && mt !== omStr(c, 'meta_title')) metas.meta_title = mt;
    if (md && md !== omStr(c, 'meta_description')) metas.meta_description = md;
    info('Neuer CMS-Block', 'Anlegen', '–', `${spec.name} · ${blocks} Blöcke · HTML`, warn);
    info(label, 'Inhalt (CMS-Block)', curBlock ? `„${curBlock.title}“ (id ${curBlock.id})` : c.landing_page ? `Block ${c.landing_page}` : 'kein Block', spec.name, curBlock ? ['Der bisherige Block bleibt in OpenMage erhalten und wird nur nicht mehr angezeigt'] : []);
    info(label, 'Anzeigemodus', DISPLAY_MODE[curMode] ?? curMode, DISPLAY_MODE[mode], mode === 'PAGE' ? ['Nur der Block, keine Produktliste'] : []);
    if (plain(omAttr(c, 'description'))) info(label, 'Kategoriebeschreibung', cut(omAttr(c, 'description'), 80), 'bleibt unverändert (steht über dem Block)');
    if (metas.meta_title) info(label, 'Meta-Title', cut(omStr(c, 'meta_title')), mt);
    if (metas.meta_description) info(label, 'Meta-Description', cut(omStr(c, 'meta_description')), md);
    const path = categoryPath(c, sf.category), url = path ? `${sfBase}/${path}` : null;
    return { cs: { id: newIdSafe(), kind: 'page', title: `Kategorie-Inhalt veröffentlichen: ${name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec) }, payload: { ...base, content, category: { id: String(c.id), displayMode: mode, metas, url }, storefront: url ?? sfBase } satisfies PagePayload };
  }

  const ids = [...new Set((a.productIds ?? []).map(String))];
  if (!ids.length) throw new Error('productIds fehlt');
  if (ids.length > 50) throw new Error('Maximal 50 Produkte je Veröffentlichung');
  const list: OmProduct[] = [];
  for (const id of ids) { const p = await ro.productByRef(id); if (!p) throw new Error(`Produkt ${id} nicht gefunden`); list.push(p); }
  const mode = a.mode ?? (list.length === 1 ? 'replace' : 'append');
  const rows = list.map(p => { const path = productPath(p, sf.product); return { id: String(p.id), sku: p.sku, name: String(p.name ?? p.sku), url: path && isVisible(p) ? `${sfBase}/${path}` : null, expect: omStr(p, 'description') }; });
  for (const p of list) {
    const cur = String(omAttr(p, 'description') ?? ''), after = mode === 'replace' ? content : appendHtml(cur, content);
    info(`Produkt „${p.name}“ (${p.sku})`, 'Beschreibung', cut(cur), mode === 'replace' ? `${spec.name} · ${blocks} Blöcke` : `bisheriger Text + „${spec.name}“ darunter`, [...warn, mode === 'replace' ? 'Ersetzt die bisherige Beschreibung (Rückgängig stellt sie wieder her)' : 'Hängt den Inhalt unter die bisherige Beschreibung'], { before: cur, after });
  }
  if (list.length > 1) items[0].warn.push(`Alle ${list.length} Produkte bekommen denselben Inhalt`);
  return { cs: { id: newIdSafe(), kind: 'page', title: `Produktinhalt veröffentlichen: ${spec.name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec) }, payload: { ...base, content, products: { mode, items: rows }, storefront: rows.find(r => r.url)?.url ?? sfBase } satisfies PagePayload };
}

// ================= Executor =================
async function createBlock(c: OmClient, title: string, identifier: string, content: string, undo: UndoOp[]): Promise<{ id: number; identifier: string }> {
  const b = await c.req('POST', '/v1/cms/blocks', { title: title.slice(0, 255), identifier, content, is_active: true, stores: ['admin'] }) as OmRecord;
  const id = Number(b?.id);
  if (!id) throw new Error('CMS-Block wurde nicht angelegt');
  undo.push(reqOp('cms-block', String(id), 'DELETE', `/v1/cms/blocks/${id}`));
  return { id, identifier: String(b.identifier ?? identifier) };
}
const adminBase = (c: OmClient) => `${c.publicUrl || c.base}/index.php/admin`;

reg.register('page', async (c, cs, payload, _sel, ctx): Promise<ApplyResult> => {
  const p = payload as PagePayload, undo = trackedUndo(ctx, cs.items.length), admin = adminBase(c);
  const out: PublishedInfo = { name: p.name };
  try {
    if (p.target === 'landingpage' && p.page) {
      const pg = p.page;
      const r = await c.req('POST', '/v1/cms/pages', { identifier: pg.identifier, title: pg.title, content: p.content, content_heading: pg.contentHeading, root_template: 'one_column', meta_description: pg.metaDescription, is_active: true, stores: pg.stores }) as OmRecord;
      const id = Number(r?.id);
      if (!id) throw new Error('CMS-Seite wurde nicht angelegt');
      undo.push(reqOp('cms-page', String(id), 'DELETE', `/v1/cms/pages/${id}`));
      const back = await c.req('GET', `/v1/cms/pages/${id}`) as OmRecord;
      if (back?.content !== p.content || back?.identifier !== pg.identifier) throw new Error('Gespeicherter Inhalt weicht ab (OpenMage hat ihn verändert)');
      Object.assign(out, { cmsPageId: String(id), url: `/${pg.identifier}`, storefront: p.storefront, adminUrl: `${admin}/cms_page/edit/page_id/${id}` });
    } else if (p.target === 'category' && p.category) {
      const k = p.category;
      const block = await createBlock(c, `Lotse: ${p.name}`, blockIdentifier('kategorie', k.id), p.content, undo);
      undo.push(...await writeScoped(c, 'category', k.id, p.store, { display_mode: k.displayMode, landing_page: block.id, ...k.metas }));
      const after = await getCategory(c, k.id, p.store);
      if (Number(after?.landing_page) !== block.id || omStr(after, 'display_mode') !== k.displayMode) throw new Error('Kategorie zeigt den neuen Block nicht (Store-View-Wert überschreibt ihn?)');
      Object.assign(out, { cmsBlockId: String(block.id), storefront: p.storefront, adminUrl: `${admin}/catalog_category/edit/id/${k.id}` });
    } else if (p.target === 'product' && p.products) {
      const { mode, items } = p.products;
      for (const it of items) {
        const cur = await getProduct(c, it.sku, p.store);
        if (!cur) throw new Error(`Produkt ${it.sku} nicht mehr vorhanden`);
        const now = omStr(cur, 'description');
        if ((now ?? '') !== (it.expect ?? '')) throw new Error(`Beschreibung von ${it.sku} wurde inzwischen geändert, bitte neu vorschlagen`);
        undo.push(...await writeScoped(c, 'product', it.sku, p.store, { description: mode === 'append' ? appendHtml(now, p.content) : p.content }));
      }
      Object.assign(out, { storefront: items.map(i => i.url).filter(Boolean), adminUrl: items[0] ? `${admin}/catalog_product/edit/id/${items[0].id}` : undefined });
    } else throw new Error(`Unbekanntes Ziel ${p.target}`);
  } catch (e) {
    const back = await undoOpenmage(c, undo), failed = back.filter(b => !b.ok);
    return { results: cs.items.map(i => ({ itemId: i.id, ok: false, error: errMsg(e) })), undo: failed.length ? undo : [], error: `${errMsg(e)}${failed.length ? ` (Zurücknehmen unvollständig: ${failed.map(f => f.error).join('; ')})` : ''}` };
  }
  return { results: cs.items.map(i => ({ itemId: i.id, ok: true })), undo, published: out };
});

// ================= PlatformPages =================
const PUBLISH_DESCRIPTION = `BEANTRAGT die Veröffentlichung des aktuellen Entwurfs in OpenMage (statisches HTML mit begrenztem CSS, im Admin weiter bearbeitbar). Es wird nichts geschrieben, bis der Nutzer freigibt; der Aufruf wartet auf die Entscheidung. Rückgängig nimmt alles exakt zurück.
- target=landingpage (Entwurf landingpage): neue CMS-Seite unter url (z. B. "ratgeber/vasen"), title = Seitentitel (= Meta-Title in OpenMage; Standard: H1 des Inhalts), metaDescription, allStoreViews (Standard: nur die Store-View aus den Einstellungen). Hat der Entwurf eine H1, bleibt die Theme-Überschrift leer.
- target=category (Entwurf product_list): neuer CMS-Block mit dem Inhalt, Kategorie zeigt „statischer Block und Produkte“ (displayMode PAGE = nur der Block); Block steht über der Produktliste, die Kategoriebeschreibung bleibt. metaTitle/metaDescription setzen die Metas der Kategorie.
- target=product (Entwurf product_detail): mode=replace ersetzt die Produktbeschreibung (Standard bei einem Produkt), mode=append hängt den Inhalt unter die bisherige Beschreibung jedes Produkts (Standard bei mehreren). Kein CMS-Block: Magento 1 rendert {{block}} in Produkttexten nicht.
Produkt-Slider werden zu statischen Produktboxen mit echten Daten (Name, Preis, Bild, Link) zum Zeitpunkt der Veröffentlichung. Bilder: nur Produktbilder (om-…), öffentliche URLs oder SVG aus create_svg_image; hochgeladene Fotos kann OpenMage für Seiten nicht übernehmen.`;

export const openmagePages = (reader: (s: Session) => OmReader): PlatformPages => ({
  previewData: (session, spec) => previewData(reader(session), spec),
  async prepareDraft(session, spec) {
    const r = await checkOmLinks(reader(session), collectLinks(expandSpec(spec).sections)).catch(() => null);
    if (!r) return { spec };
    return { spec: r.report.rewrites.size ? rewriteLinks(spec, r.report.rewrites) : spec, links: r.report };
  },
  async focus(session, raw): Promise<ChatEvent | null> {
    const ro = reader(session);
    if (raw.previewProductId) { const p = await ro.productByRef(raw.previewProductId).catch(() => null); if (p) return { t: 'focus', kind: 'product', id: String(p.id), name: p.name ?? p.sku, path: p.sku, cmsPage: null }; }
    else if (raw.previewCategoryId) { const c: OmCategory | null = await ro.category(raw.previewCategoryId).catch(() => null); if (c) return { t: 'focus', kind: 'category', id: String(c.id), name: c.name ?? String(c.id), path: null, cmsPage: null }; }
    return null;
  },
  publishTool: {
    description: PUBLISH_DESCRIPTION,
    shape: {
      target: z.enum(OPENMAGE_CAPABILITIES.publishTargets as unknown as ['landingpage', 'category', 'product']),
      url: z.string().optional().describe('landingpage: Pfad, z. B. "ratgeber/vasen" (ohne Domain)'),
      title: z.string().optional().describe('landingpage: Seitentitel (Browser-Titel)'),
      allStoreViews: z.boolean().optional().describe('landingpage: in allen Store-Views sichtbar'),
      categoryId: z.string().optional(), displayMode: z.enum(['PRODUCTS_AND_PAGE', 'PAGE']).optional(),
      productIds: z.array(z.string()).optional(), mode: z.enum(['replace', 'append']).optional(),
      metaTitle: z.string().optional(), metaDescription: z.string().optional(),
    },
  },
  async buildPublish(session, spec, args) { return buildPagePublish(reader(session), spec, args as unknown as PublishArgs); },
});
