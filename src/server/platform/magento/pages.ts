import 'server-only';
// Magento: Seitenentwürfe – Vorschau-Daten, Link-Prüfung, Veröffentlichung als Änderungsset mit exaktem Rückgängig.
// Ziele: landingpage = neue CMS-Seite, category = neuer CMS-Block + Kategorie-Anzeige „Statischer Block und Produkte“,
// product = Produktbeschreibung (ein Produkt) oder CMS-Block als Widget unter der Beschreibung (mehrere Produkte).
// Inhalte im Page-Builder-Format (pagebuilder.ts): im Admin weiter bearbeitbar, Produktboxen als Magento-Widget mit Live-Preisen.
import { z } from 'zod';
import type { ChangeAsset, ChangeItem, ChatEvent, PublishedInfo, UndoOp } from '@/lib/protocol';
import { withScript } from '@/lib/script-scan';
import { GENERIC_BLOCKS, type BlockSpec, type ImageRef, type PageSpec, type PreviewCtx, type PreviewProduct } from '../../cms';
import { readStaged, stagedMeta } from '../../media';
import { renderPageHtml } from '../../page-html';
import { expandSpec } from '../../patterns';
import { collectLinks, findingText, rewriteLinks } from '../../seo-links';
import type { Session } from '../../sessions';
import type { PlatformCapabilities, PlatformPages } from '../types';
import { errMsg, newIdSafe, trackedUndo, type ApplyResult } from './kit';
import type { MagentoClient } from './client';
import { checkMagentoLinks } from './links';
import { attr, attrStr, money, parseMediaId, plain, priceState, urlKey, type MCategory, type MProduct, type MRecord } from './map';
import { appendPart, toPageBuilder, type PbPart } from './pagebuilder';
import type { MagentoReader } from './reader';
import { getEnt, reg, reqOp, undoMagento, writeScoped } from './write';

/** Was Seiten in Magento können: freie Landingpages (CMS-Seiten), Kategorie-Inhalt (CMS-Block über der Produktliste), Produktbeschreibung */
export const MAGENTO_CAPABILITIES: PlatformCapabilities = { pageTypes: ['landingpage', 'product_list', 'product_detail'], publishTargets: ['landingpage', 'category', 'product'], blocks: GENERIC_BLOCKS, pageFormat: 'html', reuse: false };

const SVG_MAX = 200 * 1024;

// ================= Vorschau =================
export async function previewProducts(ro: MagentoReader, refs: string[]): Promise<Record<string, PreviewProduct>> {
  const ids = refs.filter(r => /^\d+$/.test(r)), skus = refs.filter(r => !/^\d+$/.test(r));
  const list = [...await ro.productsByIds(ids), ...await ro.productsBySkus(skus)];
  const cfg = await ro.storefrontConfig().catch(() => ({ product_url_suffix: '.html' }));
  const base = await ro.storefrontBase().catch(() => ro.publicUrl);
  const out: Record<string, PreviewProduct> = {};
  for (const p of list) {
    const s = priceState(p), key = attrStr(p, 'url_key');
    const v: PreviewProduct = { id: String(p.id), sku: p.sku, name: p.name, price: money(s.selling), ...(s.list != null ? { listPrice: money(s.list) } : {}), img: ro.allowed('media') ? await ro.mediaUrl(attrStr(p, 'small_image') ?? attrStr(p, 'image')) : undefined, description: (attr(p, 'description') ?? attr(p, 'short_description')) as string | undefined, active: Number(p.status) === 1, visible: Number(p.visibility) !== 1, url: key && Number(p.visibility) !== 1 ? `${base}/${key}${cfg.product_url_suffix ?? ''}` : undefined };
    out[String(p.id)] = v; out[p.sku] = v; // Blöcke dürfen ID oder SKU nennen
  }
  return out;
}

/** Bild-Verweise eines Entwurfs: mediaId der Blöcke (image/image2) */
function mediaRefs(spec: Partial<PageSpec>): string[] {
  const out = new Set<string>();
  for (const s of spec.sections ?? []) for (const b of s.blocks ?? []) for (const k of ['image', 'image2'] as const) { const im = b?.[k]; if (im && typeof im === 'object' && im.mediaId) out.add(im.mediaId); }
  return [...out];
}

export async function previewData(ro: MagentoReader, spec: PageSpec): Promise<PreviewCtx> {
  const refs = new Set<string>();
  for (const s of spec.sections) for (const b of s.blocks) (b.productIds ?? []).forEach(i => refs.add(String(i)));
  if (spec.previewProductId) refs.add(spec.previewProductId);
  if (spec.previewCategoryId && /^\d+$/.test(spec.previewCategoryId)) {
    const r = await ro.products({ filters: [[{ field: 'category_id', value: spec.previewCategoryId }], [{ field: 'status', value: 1 }], [{ field: 'visibility', value: [2, 4], condition_type: 'in' }]], pageSize: 8 }).catch(() => ({ items: [] as MProduct[] }));
    r.items.forEach(p => refs.add(String(p.id)));
  }
  const products = refs.size ? await previewProducts(ro, [...refs]) : {};
  const urls: Record<string, string | null | undefined> = {};
  for (const id of mediaRefs(spec)) {
    if (id.startsWith('staged:')) { const m = stagedMeta(id.slice(7)); urls[id] = m ? `/staged/${m.file}` : null; continue; }
    const mid = parseMediaId(id);
    if (mid) { const [p] = await ro.productsByIds([mid.productId], 'all').catch(() => []); urls[id] = await ro.mediaUrl(p?.media_gallery_entries?.find(e => e.id === mid.entryId)?.file); }
  }
  return { products, product: spec.previewProductId ? products[spec.previewProductId] : undefined, imageUrl: (im: ImageRef) => (typeof im === 'string' ? im : im.url ?? urls[im.mediaId ?? '']) };
}

// ================= Rendern im Page-Builder-Format (rein) =================
export interface RenderCtx {
  /** ImageRef → endgültige URL (oder data:-URI für vorgemerkte SVG) */
  imageUrl: (im: ImageRef) => string | null | undefined;
  /** Produkt-Verweis (ID oder SKU) → SKU; unbekannte fallen weg */
  skus: Record<string, string>;
  /** Wurzel-Klasse der Seite */
  scope: string;
  /** zusätzliches CSS (z. B. Seitentitel des Themes ausblenden) */
  extraCss?: string;
}
const stripRootStyle = (html: string) => html.replace(/^(<div class="[^"]+">)<style>[\s\S]*?<\/style>/, '$1');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&']));

/**
 * Entwurf → Page-Builder-Teile: zusammenhängende Blöcke ohne Produkte als html-Inhaltstyp (statisches HTML mit begrenztem CSS),
 * product-slider als Magento-Widget „Catalog Products List“ (Preise, Bestand, Warenkorb live; nur aktive, sichtbare Produkte).
 */
export function renderParts(spec: PageSpec, ctx: RenderCtx): PbPart[] {
  const full = expandSpec(spec), parts: PbPart[] = [];
  let first = true;
  const html = (blocks: BlockSpec[]) => {
    if (!blocks.length) return;
    const h = renderPageHtml({ ...full, sections: [{ blocks }] }, { imageUrl: ctx.imageUrl, products: {}, scope: ctx.scope });
    parts.push({ kind: 'html', html: first ? (ctx.extraCss ? `<style>${ctx.extraCss}</style>` : '') + h : stripRootStyle(h) });
    first = false;
  };
  for (const s of full.sections) {
    let run: BlockSpec[] = [];
    for (const b of s.blocks) {
      if (b.type !== 'product-slider') { run.push(b); continue; }
      const skus = [...new Set((b.productIds ?? []).map(id => ctx.skus[String(id)]).filter(Boolean))];
      if (b.title) run.push({ type: 'text', html: `<h2>${esc(b.title)}</h2>`, marginBottom: '0' });
      html(run); run = [];
      if (skus.length) parts.push({ kind: 'products', skus });
    }
    html(run);
  }
  if (!parts.length) throw new Error('Der Entwurf ergibt keinen Inhalt');
  return parts;
}

/** H1 im Inhalt einer Kategorie/Produktseite: dort liefert das Theme die H1 (Kategorie-/Produktname) → H2 */
export const demoteH1 = (spec: PageSpec): { spec: PageSpec; n: number } => {
  let n = 0;
  const fix = (h: unknown) => (typeof h === 'string' ? h.replace(/<(\/?)h1\b/gi, (_, sl) => { n++; return `<${sl}h2`; }) : h);
  const full = expandSpec(spec);
  const out = { ...full, sections: full.sections.map(s => ({ ...s, blocks: s.blocks.map(b => ({ ...b, html: fix(b.html) as string | undefined, leftHtml: fix(b.leftHtml) as string | undefined, centerHtml: fix(b.centerHtml) as string | undefined, rightHtml: fix(b.rightHtml) as string | undefined })) })) };
  return { spec: out, n: n / 2 };
};
export const hasH1 = (spec: PageSpec) => /<h1\b/i.test(JSON.stringify(expandSpec(spec).sections));
/** Text der ersten H1 aus den Block-Inhalten (nicht aus dem JSON-String: keine Escapes), HTML-Entities aufgelöst */
export function firstH1Text(spec: PageSpec): string {
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  for (const s of strings(expandSpec(spec).sections)) {
    const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(s);
    if (m) return plain(m[1]).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
  }
  return '';
}
/** Seitentitel des Themes ausblenden, wenn die H1 aus dem Inhalt kommt: Luma/Blank (.page-title-wrapper), Hyvä u. a. (h1.page-title ohne Wrapper) */
export const hideThemeTitle = (identifier: string) => { const c = `.${cmsBodyClass(identifier)}`; return `${c} .page-title-wrapper,${c} h1.page-title{display:none}`; };
/** Body-Klasse, die Magento einer CMS-Seite gibt (cms-<identifier>, Sonderzeichen → -) */
export const cmsBodyClass = (identifier: string) => `cms-${identifier.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}`;
/** URL-Schlüssel (Identifier) einer CMS-Seite: Pfadsegmente wie URL-Schlüssel, optional .html */
export function cmsIdentifier(url: string): string {
  const raw = String(url ?? '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '');
  const html = /\.html?$/i.test(raw);
  const segs = raw.replace(/\.html?$/i, '').split('/').map(s => urlKey(s)).filter(Boolean);
  if (!segs.length) throw new Error('url fehlt (Pfad der Landingpage, z. B. "ratgeber/vasen")');
  const id = segs.join('/') + (html ? '.html' : '');
  if (id.length > 100) throw new Error('url ist zu lang (max. 100 Zeichen)');
  return id;
}

// ================= Veröffentlichen: Änderungsset =================
export interface PublishArgs {
  target: 'landingpage' | 'category' | 'product';
  url?: string; title?: string; allStoreViews?: boolean;
  categoryId?: string; displayMode?: 'PRODUCTS_AND_PAGE' | 'PAGE';
  productIds?: string[]; mode?: 'description' | 'block';
  metaTitle?: string; metaDescription?: string;
}
export interface PagePayload {
  target: PublishArgs['target']; name: string; store: string; content: string;
  page?: { identifier: string; title: string; metaTitle: string; metaDescription: string; store: string };
  category?: { id: string; displayMode: string; metas: Record<string, string>; url: string | null };
  products?: { mode: 'description' | 'block'; items: { id: string; sku: string; name: string; url: string | null; expect: string | null }[] };
  storefront: string;
}

const cut = (t: unknown, n = 160) => { const s = plain(t); return s ? (s.length > n ? `${s.slice(0, n)}…` : s) : '–'; };

/** Bilder für Magento auflösen: Shop-Produktbilder (mg-…) und URLs direkt, vorgemerkte SVG eingebettet; andere Uploads gehen nicht */
async function imageResolver(ro: MagentoReader, spec: PageSpec): Promise<{ imageUrl: RenderCtx['imageUrl']; assets: ChangeAsset[] }> {
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
    if (!mid) { bad.push(`mediaId ${id} (Magento: mg-… aus search_media)`); continue; }
    const [p] = await ro.productsByIds([mid.productId], 'all');
    const u = await ro.mediaUrl(p?.media_gallery_entries?.find(e => e.id === mid.entryId)?.file);
    if (!u) bad.push(`Medium ${id} nicht gefunden`); else urls.set(id, u);
  }
  // Muster mit imageUrl: vorgemerkte Bilder (/staged/…) nur als SVG
  const json = JSON.stringify(spec.sections);
  for (const m of json.matchAll(/\/staged\/([a-z0-9]+)\.([a-z]+)/g)) if (!urls.has(`staged:${m[1]}`)) { staged(m[1]); }
  if (bad.length) throw new Error(`Magento hat keine Schnittstelle, um Bilder für CMS-Seiten hochzuladen. Nicht verwendbar: ${[...new Set(bad)].join(', ')}. Verwende Produktbilder des Shops (search_media → mediaId mg-…), öffentliche https-Bild-URLs oder Vektorgrafiken (create_svg_image).`);
  const imageUrl = (im: ImageRef) => (typeof im === 'string' ? im : im.mediaId ? urls.get(im.mediaId) ?? null : im.url ?? null);
  return { imageUrl, assets };
}
/** /staged/<id>.svg in Muster-HTML durch die eingebettete Grafik ersetzen */
const inlineStaged = (spec: PageSpec, imageUrl: RenderCtx['imageUrl']): PageSpec => JSON.parse(JSON.stringify(spec).replace(/\/staged\/([a-z0-9]+)\.svg/g, (all, id) => imageUrl({ mediaId: `staged:${id}` }) ?? all));

export async function buildPagePublish(ro: MagentoReader, spec: PageSpec, a: PublishArgs) {
  const items: ChangeItem[] = [], warn: string[] = [];
  const info = (label: string, fieldLabel: string, before: string, after: string, w: string[] = [], html?: ChangeItem['html']) => items.push({ id: `i${items.length}`, entity: 'info', label, fieldLabel, before, after, warn: w, ...(html ? { html } : {}) });
  const mt = (a.metaTitle ?? spec.seo?.metaTitle ?? '').trim(), md = (a.metaDescription ?? spec.seo?.metaDescription ?? '').trim();
  const sfBase = await ro.storefrontBase().catch(() => ro.publicUrl), cfg = await ro.storefrontConfig().catch(() => ({ product_url_suffix: '.html', category_url_suffix: '.html' }));

  // Links prüfen und Weiterleitungen direkt verlinken
  const links = await checkMagentoLinks(ro, collectLinks(expandSpec(spec).sections));
  let work = links.report.rewrites.size ? rewriteLinks(spec, links.report.rewrites) : spec;
  warn.push(...links.report.findings.filter(f => f.level === 'wichtig').slice(0, 5).map(findingText));

  // Inhalt einer Kategorie/Produktseite: H1 liefert das Theme
  if (a.target !== 'landingpage') { const d = demoteH1(work); if (d.n) { work = d.spec; warn.push(`${d.n} H1-Überschrift(en) im Inhalt als H2 gesetzt: Die H1 liefert Magento (${a.target === 'category' ? 'Kategoriename' : 'Produktname'}).`); } }

  // Produkte der Slider → SKU (Widget braucht SKUs); inaktive/unsichtbare zeigt Magento nicht
  const refs = [...new Set(expandSpec(work).sections.flatMap(s => s.blocks.flatMap(b => (b.type === 'product-slider' ? b.productIds ?? [] : []).map(String))))];
  const prods = refs.length ? await previewProducts(ro, refs) : {}, skus: Record<string, string> = {};
  for (const r of refs) { const p = prods[r]; if (!p) { warn.push(`Produkt ${r} nicht gefunden: fehlt in der Produktliste`); continue; } skus[r] = String(p.sku); if (!p.active || !p.visible) warn.push(`Produkt „${p.name}“ ist ${!p.active ? 'deaktiviert' : 'nicht einzeln sichtbar'} und erscheint im Shop nicht`); }

  const { imageUrl, assets } = await imageResolver(ro, work);
  work = inlineStaged(work, imageUrl);
  const scope = `lotse-${newIdSafe().slice(0, 8)}`;
  const blocks = expandSpec(work).sections.reduce((n, s) => n + s.blocks.length, 0);
  const base: Omit<PagePayload, 'content' | 'storefront'> = { target: a.target, name: spec.name, store: ro.storeCode };

  if (a.target === 'landingpage') {
    if (!a.url) throw new Error('url fehlt (Pfad der Landingpage, z. B. "ratgeber/vasen")');
    const identifier = cmsIdentifier(a.url);
    const taken = (await ro.cmsPages({ filters: [[{ field: 'identifier', value: identifier }]], pageSize: 5 })).items;
    if (taken.length) throw new Error(`URL „${identifier}“ ist schon vergeben (CMS-Seite „${taken[0].title}“, id ${taken[0].id}). Andere url wählen.`);
    const route = await ro.resolveUrl(identifier).catch(() => null);
    if (route) throw new Error(`URL „${identifier}“ gehört schon zu ${route.type === 'PRODUCT' ? 'einem Produkt' : route.type === 'CATEGORY' ? 'einer Kategorie' : 'einer Seite'}. Andere url wählen.`);
    const h1 = hasH1(work), firstH1 = firstH1Text(work);
    const title = (a.title ?? (firstH1 || spec.name)).trim().slice(0, 255);
    const store = a.allStoreViews ? 'all' : ro.storeCode;
    const content = toPageBuilder(renderParts(work, { imageUrl, skus, scope, extraCss: h1 ? hideThemeTitle(identifier) : undefined }));
    info('Neue Landingpage (CMS-Seite)', 'Anlegen', '–', `${spec.name} · ${blocks} Blöcke · Page Builder`, warn);
    info('Neue Landingpage', 'URL', '–', `/${identifier}`, ['Die Seite ist nach der Freigabe sofort aktiv und im Shop sichtbar']);
    info('Neue Landingpage', 'Seitentitel', '–', title, h1 ? ['Die H1 kommt aus dem Inhalt; der Seitentitel des Themes wird auf dieser Seite ausgeblendet.'] : []);
    info('Neue Landingpage', 'Store-View', '–', store === 'all' ? 'alle Store-Views' : store);
    info('Neue Landingpage', 'Meta-Title', '–', mt || title, mt ? [] : ['Kein Meta-Title: Magento nimmt den Seitentitel']);
    info('Neue Landingpage', 'Meta-Description', '–', md || '–', md ? [] : ['Keine Meta-Description']);
    return { cs: { id: newIdSafe(), kind: 'page', title: `Seite veröffentlichen: ${spec.name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec) }, payload: { ...base, content, page: { identifier, title, metaTitle: mt, metaDescription: md, store }, storefront: `${sfBase}/${identifier}` } satisfies PagePayload };
  }

  if (a.target === 'category') {
    if (!a.categoryId) throw new Error('categoryId fehlt');
    const c = await ro.category(a.categoryId);
    if (!c) throw new Error(`Kategorie ${a.categoryId} nicht gefunden`);
    if (Number(c.level) < 2) throw new Error('Die Wurzelkategorie hat keine eigene Seite');
    const mode = a.displayMode ?? 'PRODUCTS_AND_PAGE', curMode = attrStr(c, 'display_mode') ?? 'PRODUCTS', curBlock = attrStr(c, 'landing_page');
    const oldBlock = curBlock ? (await ro.cmsBlocks({ filters: [[{ field: 'block_id', value: curBlock }]], pageSize: 1 }).catch(() => ({ items: [] as MRecord[] }))).items[0] : null;
    const content = toPageBuilder(renderParts(work, { imageUrl, skus, scope }));
    const name = String(c.name ?? c.id), label = `Kategorie „${name}“`, MODE: Record<string, string> = { PRODUCTS: 'nur Produkte', PAGE: 'nur statischer Block', PRODUCTS_AND_PAGE: 'statischer Block und Produkte' };
    const metas: Record<string, string> = {};
    if (mt && mt !== attrStr(c, 'meta_title')) metas.meta_title = mt;
    if (md && md !== attrStr(c, 'meta_description')) metas.meta_description = md;
    info('Neuer CMS-Block', 'Anlegen', '–', `${spec.name} · ${blocks} Blöcke · Page Builder`, warn);
    info(label, 'Inhalt (CMS-Block)', oldBlock ? `„${oldBlock.title}“ (id ${oldBlock.id})` : curBlock ? `Block ${curBlock}` : 'kein Block', spec.name, oldBlock ? ['Der bisherige Block bleibt in Magento erhalten und wird nur nicht mehr angezeigt'] : []);
    info(label, 'Anzeigemodus', MODE[curMode] ?? curMode, MODE[mode], mode === 'PAGE' ? ['Nur der Block, keine Produktliste'] : []);
    if (plain(attr(c, 'description'))) info(label, 'Kategoriebeschreibung', cut(attr(c, 'description'), 80), 'bleibt unverändert (steht über dem Block)');
    if (metas.meta_title) info(label, 'Meta-Title', cut(attrStr(c, 'meta_title')), mt);
    if (metas.meta_description) info(label, 'Meta-Description', cut(attrStr(c, 'meta_description')), md);
    const k = attrStr(c, 'url_path') ?? attrStr(c, 'url_key'), url = k ? `${sfBase}/${k}${cfg.category_url_suffix ?? ''}` : null;
    return { cs: { id: newIdSafe(), kind: 'page', title: `Kategorie-Inhalt veröffentlichen: ${name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec) }, payload: { ...base, content, category: { id: String(c.id), displayMode: mode, metas, url }, storefront: url ?? sfBase } satisfies PagePayload };
  }

  // Produkt(e)
  const ids = [...new Set((a.productIds ?? []).map(String))];
  if (!ids.length) throw new Error('productIds fehlt');
  if (ids.length > 50) throw new Error('Maximal 50 Produkte je Veröffentlichung');
  const list: MProduct[] = [];
  for (const id of ids) { const p = await ro.productByRef(id); if (!p) throw new Error(`Produkt ${id} nicht gefunden`); list.push(p); }
  const mode = a.mode ?? (list.length === 1 ? 'description' : 'block');
  const parts = renderParts(work, { imageUrl, skus, scope });
  const url = (p: MRecord) => { const k = attrStr(p, 'url_key'); return k && Number(p.visibility) !== 1 ? `${sfBase}/${k}${cfg.product_url_suffix ?? ''}` : null; };
  const rows = list.map(p => ({ id: String(p.id), sku: p.sku, name: String(p.name ?? p.sku), url: url(p), expect: (attr(p, 'description') as string | undefined) ?? null }));
  let content: string;
  if (mode === 'description') {
    content = toPageBuilder(parts);
    for (const p of list) info(`Produkt „${p.name}“ (${p.sku})`, 'Beschreibung', cut(attr(p, 'description')), `${spec.name} · ${blocks} Blöcke`, [...warn, 'Ersetzt die bisherige Beschreibung (Rückgängig stellt sie wieder her)'], { before: String(attr(p, 'description') ?? ''), after: renderPreviewHtml(parts) });
    if (list.length > 1) items[0].warn.push(`Alle ${list.length} Produkte bekommen denselben Text`);
  } else {
    content = toPageBuilder(parts); // Inhalt des CMS-Blocks; die Beschreibungen bekommen ein Widget darauf
    info('Neuer CMS-Block (Produktinhalt)', 'Anlegen', '–', `${spec.name} · ${blocks} Blöcke · Page Builder`, warn);
    for (const p of list) info(`Produkt „${p.name}“ (${p.sku})`, 'Beschreibung', cut(attr(p, 'description'), 80), 'bisheriger Text + Block darunter');
  }
  return { cs: { id: newIdSafe(), kind: 'page', title: `Produktinhalt veröffentlichen: ${spec.name}`, reason: null, items, assets, skipped: [], atomic: true, ...withScript(spec) }, payload: { ...base, content, products: { mode, items: rows }, storefront: rows.find(r => r.url)?.url ?? sfBase } satisfies PagePayload };
}
/** Lesbare Vorschau der Teile für die Änderungskarte (Produkt-Widget als Platzhalter) */
const renderPreviewHtml = (parts: PbPart[]) => parts.map(p => (p.kind === 'html' ? p.html : p.kind === 'products' ? `<p><b>Produktliste (Magento-Widget):</b> ${esc(p.skus.join(', '))}</p>` : '')).join('');

// ================= Executor =================
const blockIdentifier = (what: string, id: string) => `lotse-${what}-${id}-${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
async function createBlock(c: MagentoClient, title: string, identifier: string, content: string, undo: UndoOp[]): Promise<number> {
  const b = await c.req('POST', '/V1/cmsBlock', { block: { identifier, title: title.slice(0, 255), content, active: true } }, { store: 'all' }) as MRecord;
  const id = Number(b?.id);
  if (!id) throw new Error('CMS-Block wurde nicht angelegt');
  undo.push(reqOp('cms-block', String(id), 'DELETE', `/all/V1/cmsBlock/${id}`));
  return id;
}

reg.register('page', async (c, cs, payload, _sel, ctx): Promise<ApplyResult> => {
  const p = payload as PagePayload, undo = trackedUndo(ctx, cs.items.length), admin = c.publicUrl || c.base;
  const out: PublishedInfo = { name: p.name };
  try {
    if (p.target === 'landingpage' && p.page) {
      const pg = p.page;
      const r = await c.req('POST', '/V1/cmsPage', { page: { identifier: pg.identifier, title: pg.title, content: p.content, content_heading: '', active: true, page_layout: '1column', meta_title: pg.metaTitle || pg.title, meta_description: pg.metaDescription } }, { store: pg.store }) as MRecord;
      const id = Number(r?.id);
      if (!id) throw new Error('CMS-Seite wurde nicht angelegt');
      undo.push(reqOp('cms-page', String(id), 'DELETE', `/all/V1/cmsPage/${id}`));
      const back = await c.req('GET', `/V1/cmsPage/${id}`, undefined, { store: 'all' }) as MRecord;
      if (back?.content !== p.content || back?.identifier !== pg.identifier) throw new Error('Gespeicherter Inhalt weicht ab (Magento hat ihn verändert)');
      Object.assign(out, { cmsPageId: String(id), url: `/${pg.identifier}`, storefront: p.storefront, adminUrl: `${admin}/admin/cms/page/edit/page_id/${id}` });
    } else if (p.target === 'category' && p.category) {
      const k = p.category;
      const blockId = await createBlock(c, `Lotse: ${p.name}`, blockIdentifier('kategorie', k.id), p.content, undo);
      undo.push(...await writeScoped(c, 'category', k.id, p.store, { display_mode: k.displayMode, landing_page: String(blockId), ...k.metas }));
      const after = await getEnt(c, 'category', k.id, p.store);
      if (String(attr(after, 'landing_page') ?? '') !== String(blockId) || attr(after, 'display_mode') !== k.displayMode) throw new Error('Kategorie zeigt den neuen Block nicht (Store-View-Wert überschreibt ihn?)');
      Object.assign(out, { cmsBlockId: String(blockId), storefront: p.storefront, adminUrl: `${admin}/admin/catalog/category/edit/id/${k.id}` });
    } else if (p.target === 'product' && p.products) {
      const { mode, items } = p.products;
      let content = p.content;
      if (mode === 'block') content = String(await createBlock(c, `Lotse Produktinhalt: ${p.name}`, blockIdentifier('produkt', items[0]?.sku ?? 'x'), p.content, undo));
      for (const it of items) {
        const cur = await getEnt(c, 'product', it.sku, p.store);
        if (!cur) throw new Error(`Produkt ${it.sku} nicht mehr vorhanden`);
        const now = (attr(cur, 'description') as string | undefined) ?? null;
        if ((now ?? '') !== (it.expect ?? '')) throw new Error(`Beschreibung von ${it.sku} wurde inzwischen geändert, bitte neu vorschlagen`);
        const next = mode === 'block' ? appendPart(now, { kind: 'block', blockId: Number(content) }) : content;
        undo.push(...await writeScoped(c, 'product', it.sku, p.store, { description: next }));
      }
      Object.assign(out, { ...(mode === 'block' ? { cmsBlockId: content } : {}), storefront: items.map(i => i.url).filter(Boolean), adminUrl: items[0] ? `${admin}/admin/catalog/product/edit/id/${items[0].id}` : undefined });
    } else throw new Error(`Unbekanntes Ziel ${p.target}`);
  } catch (e) {
    // atomar: bereits Geschriebenes sofort zurücknehmen
    const back = await undoMagento(c, undo);
    const failed = back.filter(b => !b.ok);
    return { results: cs.items.map(i => ({ itemId: i.id, ok: false, error: errMsg(e) })), undo: failed.length ? undo : [], error: `${errMsg(e)}${failed.length ? ` (Zurücknehmen unvollständig: ${failed.map(f => f.error).join('; ')})` : ''}` };
  }
  return { results: cs.items.map(i => ({ itemId: i.id, ok: true })), undo, published: out };
});

// ================= PlatformPages =================
const PUBLISH_DESCRIPTION = `BEANTRAGT die Veröffentlichung des aktuellen Entwurfs in Magento (Inhalt im Page-Builder-Format, im Admin weiter bearbeitbar). Es wird nichts geschrieben, bis der Nutzer freigibt; der Aufruf wartet auf die Entscheidung. Rückgängig nimmt alles exakt zurück.
- target=landingpage (Entwurf landingpage): neue CMS-Seite unter url (z. B. "ratgeber/vasen"), title = Seitentitel (Standard: H1 des Inhalts), metaTitle/metaDescription, allStoreViews (Standard: nur die Store-View aus den Einstellungen).
- target=category (Entwurf product_list): neuer CMS-Block mit dem Inhalt, Kategorie zeigt „statischer Block und Produkte“ (displayMode PAGE = nur der Block); Block steht über der Produktliste, die Kategoriebeschreibung bleibt. metaTitle/metaDescription setzen die Metas der Kategorie.
- target=product (Entwurf product_detail): mode=description ersetzt die Produktbeschreibung (Standard bei einem Produkt), mode=block legt einen CMS-Block an und hängt ihn als Widget unter die Beschreibung jedes Produkts (Standard bei mehreren).
Produkt-Slider werden zum Magento-Widget „Produktliste“ (Preise, Bestand, Warenkorb live). Bilder: nur Produktbilder (mg-…), öffentliche URLs oder SVG aus create_svg_image; hochgeladene Fotos kann Magento für Seiten nicht übernehmen.`;

export const magentoPages = (reader: (s: Session) => MagentoReader): PlatformPages => ({
  previewData: (session, spec) => previewData(reader(session), spec),

  async prepareDraft(session, spec) {
    const ro = reader(session);
    const r = await checkMagentoLinks(ro, collectLinks(expandSpec(spec).sections)).catch(() => null);
    if (!r) return { spec };
    return { spec: r.report.rewrites.size ? rewriteLinks(spec, r.report.rewrites) : spec, links: r.report };
  },

  async focus(session, raw): Promise<ChatEvent | null> {
    const ro = reader(session);
    if (raw.previewProductId) { const p = await ro.productByRef(raw.previewProductId).catch(() => null); if (p) return { t: 'focus', kind: 'product', id: String(p.id), name: p.name, path: p.sku, cmsPage: null }; }
    else if (raw.previewCategoryId) { const c: MCategory | null = await ro.category(raw.previewCategoryId).catch(() => null); if (c) return { t: 'focus', kind: 'category', id: String(c.id), name: c.name, path: null, cmsPage: null }; }
    return null;
  },

  publishTool: {
    description: PUBLISH_DESCRIPTION,
    shape: {
      target: z.enum(MAGENTO_CAPABILITIES.publishTargets as unknown as ['landingpage', 'category', 'product']),
      url: z.string().optional().describe('landingpage: Pfad, z. B. "ratgeber/vasen" (ohne Domain)'),
      title: z.string().optional().describe('landingpage: Seitentitel'),
      allStoreViews: z.boolean().optional().describe('landingpage: in allen Store-Views sichtbar'),
      categoryId: z.string().optional(), displayMode: z.enum(['PRODUCTS_AND_PAGE', 'PAGE']).optional(),
      productIds: z.array(z.string()).optional(), mode: z.enum(['description', 'block']).optional(),
      metaTitle: z.string().optional(), metaDescription: z.string().optional(),
    },
  },

  async buildPublish(session, spec, args) {
    return buildPagePublish(reader(session), spec, args as unknown as PublishArgs);
  },
});
