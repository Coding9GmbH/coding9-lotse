import 'server-only';
// Shopify: Seitenentwurf veröffentlichen (Änderungsset „page“, atomar, exakt rückgängig).
//   landingpage → Online-Store-Seite (pageCreate, Inhalt = gerendertes HTML) + Vollbreiten-Vorlage templates/page.lotse-<handle>.json
//   category    → Kollektion bekommt templates/collection.lotse-<handle>.json (Theme-Vorlage + Lotse-Abschnitte) als templateSuffix;
//                 mode "description": stattdessen Inhalt als Kollektionsbeschreibung (ohne Theme-Schreibzugriff)
//   product     → Produkte bekommen templates/product.lotse-<slug>.json (Produktvorlage + Lotse-Abschnitte) als templateSuffix
// Inhalte von Kollektionen/Produkten stehen in Shop-Metafeldern lotse.<key> (multi_line_text_field), der Abschnitt
// sections/lotse-content.liquid gibt sie aus. Schlägt ein Schritt fehl, nimmt der Executor alle bisherigen Schritte sofort zurück.
import type { ChangeAsset, ChangeItem, ChangeSet, PublishedInfo, UndoOp } from '@/lib/protocol';
import { cut, errMsg, trackedUndo, type ApplyCtx, type ApplyResult } from '../../changes';
import { expandSpec } from '../../patterns';
import type { ImageObj, ImageRef, PageSpec, PreviewProduct } from '../../cms';
import { stagedMeta } from '../../media';
import { renderPageHtml, renderPageParts } from '../../page-html';
import { newId } from '../../shopware';
import { shortId, toGid, type Json, type ShopifyClient } from './client';
import { collectionsByIds, idsWhere, mediaByIds, productsByIds, qField, shopInfo, stripHtml, type Q } from './data';
import { deleteOp, M, reqOp, runCreating, runRecording, undoShopify } from './ops';
import { PREVIEW_SEL, previewProduct } from './preview';
import {
  isLotseSuffix, mainTheme, MAX_HTML, metaKey, pageTemplate, parseTemplate, readThemeFiles, SECTION_FILE, SECTION_LIQUID, storedBase, stripLotse, suffixOf, templateFile,
  templateSlug, templateText, ThemeAccessError, upsertThemeFile, verifyThemeFile, withLotseSections, type TemplateKind,
} from './theme';
import { uploadStagedImage } from './upload';

export type PublishTargetShopify = 'landingpage' | 'category' | 'product';
export interface ShopifyPublishArgs {
  target: PublishTargetShopify; url?: string; title?: string; categoryId?: string; productIds?: string[]; layout?: string;
  metaTitle?: string; metaDescription?: string; published?: boolean; mode?: 'theme' | 'description';
}
export interface ShopifyPublishPayload {
  spec: PageSpec; target: PublishTargetShopify; mode: 'theme' | 'description';
  /** Vorlagen-Slug (Suffix lotse-<slug>) bzw. Handle der Landingpage */
  slug: string; title: string; published: boolean;
  collectionId?: string; productIds?: string[]; metaTitle?: string; metaDescription?: string;
}

const MAX_PRODUCTS = 50;
const tooBig = (k: string, n: number) => new Error(`${k} ist zu groß (${n} Zeichen, Shopify-Grenze ${MAX_HTML}). Bitte kürzen oder Blöcke aufteilen.`);
/** Basis einer Zuordnung zur Build-Zeit: Nicht-Lotse-Vorlage = ihre Datei, Lotse-Vorlage = erst beim Übernehmen bekannt (null) */
const baseKey = (kind: Exclude<TemplateKind, 'page'>, s: string | null | undefined) => (isLotseSuffix(s) ? null : templateFile(kind, s));

/** Bilder des Entwurfs (für die Karte: was wird hochgeladen/importiert) */
function specImages(spec: PageSpec): ImageObj[] {
  const out: ImageObj[] = [];
  for (const s of expandSpec(spec).sections ?? []) for (const b of s.blocks ?? []) for (const k of ['image', 'image2'] as const) { const im = b[k]; if (im) out.push(typeof im === 'string' ? { url: im } : im); }
  return out;
}

// ======================= Änderungsset (liest über den geschützten Reader) =======================
export async function buildShopifyPublish(q: Q, spec: PageSpec, a: ShopifyPublishArgs, ctx: { primaryUrl: string; render: (spec: PageSpec) => { before: string; after: string; full: string } }): Promise<{ cs: ChangeSet; payload: ShopifyPublishPayload }> {
  const items: ChangeItem[] = [], assets: ChangeAsset[] = [], base = ctx.primaryUrl.replace(/\/+$/, '');
  const info = (label: string, fieldLabel: string, before: string, after: string, warn: string[] = []) => items.push({ id: `i${items.length}`, entity: 'info', label, fieldLabel, before, after, warn });
  for (const o of specImages(spec)) {
    if (o.mediaId?.startsWith('staged:')) { const m = stagedMeta(o.mediaId.slice(7)); assets.push({ name: m?.name, url: `/staged/${m?.file}`, alt: o.alt ?? m?.alt ?? undefined, note: 'wird unter Inhalte → Dateien hochgeladen' }); }
    else if (!o.mediaId && o.url && !/(^|\.)cdn\.shopify\.com$|\.myshopify\.com$/i.test(safeHost(o.url))) assets.push({ name: o.url.split('/').pop(), url: o.url, alt: o.alt, note: 'wird unter Inhalte → Dateien importiert' });
  }
  const mode = a.target === 'category' && a.mode === 'description' ? 'description' : 'theme'; // Entwurfstyp je Ziel prüft publish_page (tools.ts)
  const mt = a.metaTitle ?? spec.seo?.metaTitle, md = a.metaDescription ?? spec.seo?.metaDescription;
  const parts = ctx.render(spec), blocks = expandSpec(spec).sections.reduce((n, s) => n + s.blocks.length, 0);
  for (const [k, v] of Object.entries({ 'Inhalt über dem Theme-Inhalt': parts.before, 'Inhalt unter dem Theme-Inhalt': parts.after })) if (v.length > MAX_HTML) throw tooBig(k, v.length);
  const published = a.published !== false;
  let payload: ShopifyPublishPayload;

  if (a.target === 'landingpage') {
    const raw = String(a.url ?? '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '').replace(/^pages\//, '');
    const handle = templateSlug(raw);
    if (!handle) throw new Error('url fehlt: Handle der neuen Seite, z. B. "ratgeber-vasen" (wird zu /pages/ratgeber-vasen)');
    const taken = (await q<Json>('query PageTaken($query: String) { pages(first: 1, query: $query) { nodes { id title handle } } }', { query: qField('handle', handle) })).pages.nodes.find((p: Json) => p.handle === handle);
    if (taken) throw new Error(`/pages/${handle} ist schon vergeben (Seite „${taken.title}“, id ${shortId(taken.id)}). Bitte eine andere url wählen.`);
    const title = stripHtml(a.title ?? spec.name).slice(0, 255);
    payload = { spec, target: 'landingpage', mode, slug: handle, title, published, metaTitle: mt, metaDescription: md };
    info('Neue Seite', 'Anlegen', '–', `${title} · ${blocks} Blöcke · ${published ? 'sichtbar' : 'ausgeblendet'}`);
    info('Neue Seite', 'URL', '–', `${base}/pages/${handle}`, raw !== handle ? [`URL normalisiert (${raw} → ${handle})`] : []);
    info('Theme', 'Vorlage', '–', `${templateFile('page', suffixOf(handle))} (volle Breite, Abschnitt „Lotse-Inhalt“)`, ['Darf Lotse das Theme nicht schreiben (Theme-Freigabe fehlt), wird die Seite mit der Standardvorlage angelegt.']);
  } else if (a.target === 'category') {
    if (!a.categoryId) throw new Error('categoryId fehlt (Kollektion)');
    const [c] = await collectionsByIds(q, [a.categoryId], 'id title handle templateSuffix descriptionHtml seo { title description }');
    if (!c) throw new Error(`Kollektion ${a.categoryId} nicht gefunden`);
    const slug = templateSlug(c.handle) || shortId(c.id), suffix = suffixOf(slug), label = `Kollektion „${c.title}“`;
    payload = { spec, target: 'category', mode, slug, title: c.title, published, collectionId: shortId(c.id), metaTitle: mt, metaDescription: md };
    if (mode === 'description') {
      items.push({ id: `i${items.length}`, entity: 'info', label, fieldLabel: 'Beschreibung', before: cut(stripHtml(c.descriptionHtml)), after: `Inhalt des Entwurfs (${blocks} Blöcke) als Beschreibung`, html: { before: c.descriptionHtml ?? '', after: parts.full.slice(0, 20000) }, warn: ['Die bisherige Beschreibung wird ersetzt (Rückgängig stellt sie wieder her). Wie die Beschreibung erscheint, bestimmt das Theme (meist über der Produktliste).'] });
    } else {
      const baseLabel = baseKey('collection', c.templateSuffix) ?? `Basis der Lotse-Vorlage ${templateFile('collection', c.templateSuffix)}`;
      info(label, 'Vorlage', c.templateSuffix ? templateFile('collection', c.templateSuffix) : 'Standard (templates/collection.json)', `${templateFile('collection', suffix)}: Kopie von ${baseLabel} (Theme-Abschnitte bleiben, Lotse-Inhalt ${parts.before && parts.after ? 'über und unter' : parts.before ? 'über' : 'unter'} der Produktliste)`,
        isLotseSuffix(c.templateSuffix) && c.templateSuffix !== suffix ? [`Die Kollektion nutzt schon die Lotse-Vorlage ${c.templateSuffix}; sie wird ersetzt.`] : []);
    }
    if (mt) info(label, 'Meta-Title', cut(c.seo?.title), cut(mt));
    if (md) info(label, 'Meta-Description', cut(c.seo?.description), cut(md));
  } else {
    const ids = [...new Set(a.productIds ?? [])];
    if (!ids.length) throw new Error('productIds fehlt');
    if (ids.length > MAX_PRODUCTS) throw new Error(`Maximal ${MAX_PRODUCTS} Produkte je Veröffentlichung`);
    const rows = await productsByIds(q, ids, 'id title handle templateSuffix', 25);
    const missing = ids.filter(i => !rows.some(r => shortId(r.id) === shortId(toGid('Product', i)))); if (missing.length) throw new Error(`Produkt(e) nicht gefunden: ${missing.join(', ')}`);
    const slug = templateSlug(a.layout ?? spec.name); if (!slug) throw new Error('layout fehlt: Name der Produktvorlage, z. B. "keramik"');
    payload = { spec, target: 'product', mode, slug, title: spec.name, published, productIds: rows.map(r => shortId(r.id)) };
    // alle Produkte brauchen dieselbe Basisvorlage (sonst bekämen Produkte eine fremde Vorlage); die Basis von Lotse-Vorlagen prüft der Executor
    const groups = new Map<string, string[]>();
    for (const p of rows) { const k = baseKey('product', p.templateSuffix); if (k) groups.set(k, [...(groups.get(k) ?? []), p.title]); }
    if (groups.size > 1) throw new Error(`Die Produkte nutzen unterschiedliche Produktvorlagen (${[...groups].map(([f, ts]) => `${f}: ${ts.slice(0, 5).join(', ')}${ts.length > 5 ? ' …' : ''}`).join('; ')}). Bitte je Vorlage getrennt veröffentlichen, mit eigenem layout-Namen.`);
    const target = templateFile('product', suffixOf(slug)), lotse = rows.filter(p => isLotseSuffix(p.templateSuffix));
    const baseOf = (s: string | null | undefined) => baseKey('product', s) ?? `Basis von ${templateFile('product', s)}`;
    for (const p of rows) info(`Produkt „${p.title}“`, 'Vorlage', p.templateSuffix ? templateFile('product', p.templateSuffix) : 'Standard (templates/product.json)', `${target} (Basis: ${baseOf(p.templateSuffix)})`);
    info('Theme', 'Vorlage', '–', `${target}: Kopie von ${[...groups.keys()][0] ?? baseOf(lotse[0]?.templateSuffix)} + Lotse-Inhalt ${parts.before && parts.after ? 'über und unter' : parts.before ? 'über' : 'unter'} dem Produktbereich`,
      ['Gilt für alle gewählten Produkte; gibt es die Vorlage schon, wird sie ersetzt (Rückgängig stellt sie wieder her).', ...(lotse.length ? ['Die Basis bisheriger Lotse-Vorlagen liest Lotse beim Übernehmen: weicht sie ab, wird nichts geschrieben.'] : [])]);
  }
  const cs: ChangeSet = { id: newId(), kind: 'page', title: `Seite veröffentlichen: ${spec.name}`, reason: null, items, assets, skipped: [], atomic: true, noun: { one: 'Schritt', many: 'Schritte' } };
  return { cs, payload };
}
const safeHost = (u: string) => { try { return new URL(u).host; } catch { return ''; } };

// ======================= Executor (privilegierter Client) =======================
const fileNameOf = (source: string) => { try { return decodeURIComponent(new URL(source).pathname.split('/').pop() || ''); } catch { return ''; } };
/** Datei anlegen. Geht die Antwort verloren, wird die neue Datei per Dateiname nachgelesen und zum Löschen vorgemerkt. */
export async function createShopFile(client: ShopifyClient, source: string, alt: string, undo: UndoOp[]): Promise<Json> {
  const q: Q = (d, v) => client.gql(d, v), name = fileNameOf(source);
  const ids = () => (name ? idsWhere(q, 'files', qField('filename', name)) : Promise.resolve([] as string[]));
  const r = await runCreating<Json>(client, M.fileCreate, { files: [{ originalSource: source, contentType: 'IMAGE', alt }] }, undo, 'file', ids);
  const id = r.files?.[0]?.id as string | undefined;
  if (!id) throw new Error('Shopify lieferte keine Datei-ID');
  if (!undo.some(o => o.op === 'delete' && o.entity === 'file' && o.id === id)) undo.push(deleteOp('file', id));
  return r.files[0];
}
/** Bilder auflösen: vorgemerkte hochladen, fremde URLs importieren (Dateien), vorhandene Medien → URL. Angelegte Dateien → Rückgängig */
async function resolveImages(client: ShopifyClient, spec: PageSpec, undo: UndoOp[], sleep: (ms: number) => Promise<void>): Promise<(im: ImageRef) => string | null> {
  const q: Q = (d, v) => client.gql(d, v), urls = new Map<string, string | null>();
  const key = (o: ImageObj) => o.mediaId ?? o.url ?? '';
  const shopMedia = [...new Set(specImages(spec).map(o => o.mediaId).filter((m): m is string => !!m && !m.startsWith('staged:')))];
  if (shopMedia.length) for (const m of await mediaByIds(q, shopMedia)) { urls.set(shortId(m.id), m.image?.url ?? null); urls.set(m.id, m.image?.url ?? null); }
  for (const o of specImages(spec)) {
    const k = key(o); if (!k || urls.has(k)) continue;
    let source: string | null = null, alt = o.alt ?? '';
    if (o.mediaId?.startsWith('staged:')) { const up = await uploadStagedImage(client, o.mediaId.slice(7)); source = up.originalSource; alt = o.alt ?? up.alt; }
    else if (o.url && /^https?:\/\//.test(o.url)) { if (/(^|\.)cdn\.shopify\.com$|\.myshopify\.com$/i.test(safeHost(o.url))) { urls.set(k, o.url); continue; } source = o.url; }
    if (!source) { urls.set(k, null); continue; }
    const file = await createShopFile(client, source, alt, undo);
    urls.set(k, await fileUrl(client, file.id, file.image?.url, sleep));
  }
  return im => { const o = typeof im === 'string' ? { url: im } : im; return urls.get(key(o)) ?? (o.url && !o.mediaId ? o.url : null); };
}
/** Dateien werden asynchron verarbeitet: auf READY warten (sonst fehlt die CDN-URL) */
async function fileUrl(client: ShopifyClient, id: string, now: string | undefined, sleep: (ms: number) => Promise<void>): Promise<string> {
  if (now) return now;
  for (let i = 0; i < 12; i++) {
    const n = (await client.gql<Json>('query FileReady($ids: [ID!]!) { nodes(ids: $ids) { ... on MediaImage { id fileStatus image { url } } } }', { ids: [id] })).nodes?.[0];
    if (n?.image?.url) return n.image.url;
    if (n?.fileStatus === 'FAILED') throw new Error('Shopify konnte ein Bild nicht verarbeiten (Datei FAILED)');
    await sleep(Math.min(4000, 400 * (i + 1)));
  }
  throw new Error('Bild wurde nicht rechtzeitig verarbeitet (Shopify-Datei nicht READY)');
}

async function productsFor(client: ShopifyClient, spec: PageSpec, primaryUrl: string, currency: string): Promise<Record<string, PreviewProduct & { url?: string }>> {
  const ids = new Set<string>();
  for (const s of expandSpec(spec).sections ?? []) for (const b of s.blocks ?? []) (b.productIds ?? []).forEach(i => ids.add(String(i)));
  const valid = [...ids].filter(i => /^\d+$|^gid:\/\/shopify\/Product\//.test(i)), out: Record<string, PreviewProduct & { url?: string }> = {};
  if (!valid.length) return out;
  for (const p of await productsByIds((d, v) => client.gql(d, v), valid, PREVIEW_SEL, 25)) {
    if (p.status !== 'ACTIVE') continue; // Entwürfe/Archiv nicht verlinken (im Shop nicht sichtbar)
    const pp = previewProduct(p, currency, primaryUrl); out[pp.id!] = pp; out[p.id] = pp;
  }
  return out;
}

/** Shop-Metafelder lotse.<key> setzen; Rückgängig: alter Wert bzw. löschen */
async function setShopHtml(client: ShopifyClient, shopId: string, values: Record<string, string>, undo: UndoOp[]) {
  const keys = Object.keys(values); if (!keys.length) return;
  const cur = (await client.gql<Json>('query LotseMeta($keys: [String!]) { shop { metafields(namespace: "lotse", keys: $keys, first: 25) { nodes { key type value } } } }', { keys: keys.map(k => `lotse.${k}`) })).shop.metafields.nodes as Json[];
  const prior = new Map(cur.map(m => [m.key, m])), restore = keys.filter(k => prior.has(k)), drop = keys.filter(k => !prior.has(k)), back: UndoOp[] = [];
  if (restore.length) back.push(reqOp('metafield', shopId, M.metafieldsSet, { metafields: restore.map(k => ({ ownerId: shopId, namespace: 'lotse', key: k, type: prior.get(k)!.type, value: prior.get(k)!.value })) }));
  if (drop.length) back.push(reqOp('metafield', shopId, M.metafieldsDelete, { metafields: drop.map(k => ({ ownerId: shopId, namespace: 'lotse', key: k })) }));
  await runRecording(client, M.metafieldsSet, { metafields: keys.map(k => ({ ownerId: shopId, namespace: 'lotse', key: k, type: 'multi_line_text_field', value: values[k] })) }, undo, back);
}

/** Lotse-Abschnitt anlegen/aktualisieren (Rückgängig: löschen, sobald ungenutzt, bzw. alter Inhalt) */
async function ensureSection(client: ShopifyClient, themeId: string, undo: UndoOp[]) {
  const prior = (await readThemeFiles(client, themeId, [SECTION_FILE])).get(SECTION_FILE);
  await upsertThemeFile(client, themeId, SECTION_FILE, SECTION_LIQUID, prior, undo);
}

export interface BaseTemplate { /** Basisdatei (Nicht-Lotse-Vorlage), bei unbekannter Basis die Lotse-Vorlage selbst */ file: string; known: boolean; tpl: Json }
const isLotseFile = (f: string) => /\.lotse-[a-z0-9-]+\.json$/.test(f);
/**
 * Basisvorlage einer Zuordnung (templateSuffix). Nicht-Lotse-Vorlage: die Datei selbst (fehlt sie, zeigt Shopify die Standardvorlage).
 * Lotse-Vorlage: gespeicherte Basis (Einstellung base der Lotse-Abschnitte), sonst eine inhaltsgleiche Theme-Vorlage, sonst die
 * Lotse-Vorlage ohne Lotse-Abschnitte (Basis unbekannt). files: alle JSON-Vorlagen dieser Art (templates/<kind>.json, templates/<kind>.*.json).
 */
export function resolveBase(files: Map<string, string>, kind: Exclude<TemplateKind, 'page'>, suffix: string | null | undefined): BaseTemplate {
  const own = templateFile(kind, suffix), std = templateFile(kind, null);
  const plain = (f: string): BaseTemplate => {
    const name = files.has(f) ? f : std, text = files.get(name);
    if (text == null) throw new Error(`Das Theme hat keine JSON-Vorlage ${std} (Online Store 2.0 nötig).${kind === 'collection' ? ' Für Kollektionen geht mode "description".' : ''}`);
    return { file: name, known: true, tpl: parseTemplate(text) };
  };
  if (!isLotseSuffix(suffix) || !files.has(own)) return plain(own);
  const tpl = parseTemplate(files.get(own)!), stored = storedBase(tpl, kind), stripped = stripLotse(tpl);
  if (stored) return files.has(stored) ? plain(stored) : { file: stored, known: true, tpl: stripped }; // Basis inzwischen gelöscht: Kopie aus der Lotse-Vorlage
  const same = JSON.stringify(stripped);
  for (const [f, text] of files) {
    if (isLotseFile(f)) continue;
    try { if (JSON.stringify(parseTemplate(text)) === same) return { file: f, known: true, tpl: parseTemplate(text) }; } catch { /* keine JSON-Vorlage */ }
  }
  return { file: own, known: false, tpl: stripped };
}
/**
 * Gemeinsame Basis aller Zuordnungen, sonst Fehler (bevor etwas geschrieben wird). Gibt es die Ziel-Vorlage schon (andere Seiten nutzen sie
 * vielleicht) und ist ihre Basis bekannt, muss sie gleich sein.
 */
export function commonBase(files: Map<string, string>, kind: Exclude<TemplateKind, 'page'>, owners: { title: string; templateSuffix?: string | null }[], suffix: string): BaseTemplate {
  const groups = new Map<string, { base: BaseTemplate; titles: string[] }>();
  for (const o of owners) { const b = resolveBase(files, kind, o.templateSuffix), g = groups.get(b.file) ?? { base: b, titles: [] }; g.titles.push(o.title); groups.set(b.file, g); }
  const what = kind === 'product' ? 'Produkte' : 'Kollektionen';
  if (groups.size !== 1) throw new Error(`Die ${what} haben unterschiedliche Basisvorlagen (${[...groups].map(([f, g]) => `${f}: ${g.titles.slice(0, 5).join(', ')}${g.titles.length > 5 ? ' …' : ''}`).join('; ')}). Bitte je Vorlage getrennt veröffentlichen, mit eigenem layout-Namen.`);
  const base = [...groups.values()][0].base, target = templateFile(kind, suffix);
  if (files.has(target) && !owners.some(o => o.templateSuffix === suffix)) {
    const existing = resolveBase(files, kind, suffix);
    if (existing.known && base.known && existing.file !== base.file) throw new Error(`Die vorhandene Vorlage ${target} basiert auf ${existing.file}, die gewählten ${what} auf ${base.file}. Bitte einen anderen layout-Namen wählen (sonst änderten sich andere Seiten mit dieser Vorlage).`);
  }
  return base;
}

export async function applyShopifyPublish(client: ShopifyClient, cs: ChangeSet, p: ShopifyPublishPayload, o: { sleep?: (ms: number) => Promise<void>; ctx?: ApplyCtx } = {}): Promise<ApplyResult> {
  const undo = trackedUndo(o.ctx, cs.items.length), sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))), notes: string[] = [];
  try {
    const shop = await shopInfo((d, v) => client.gql(d, v)), base = shop.primaryUrl.replace(/\/+$/, '');
    // Vorlagen-Ziele: Theme, Zuordnungen und gemeinsame Basisvorlage prüfen, bevor etwas geschrieben (oder ein Bild hochgeladen) wird
    const tkind: 'collection' | 'product' | null = p.target === 'product' ? 'product' : p.target === 'category' && p.mode !== 'description' ? 'collection' : null;
    let prep: { theme: { id: string; name: string }; owners: Json[]; baseTpl: BaseTemplate } | null = null;
    if (tkind) {
      const theme = await mainTheme(client);
      const owners: Json[] = tkind === 'collection'
        ? await collectionsByIds((d, v) => client.gql(d, v), [p.collectionId!], 'id title handle templateSuffix seo { title description }')
        : await productsByIds((d, v) => client.gql(d, v), p.productIds!, 'id title handle templateSuffix', 25);
      if (!owners.length || (tkind === 'product' && owners.length !== p.productIds!.length)) throw new Error(`${tkind === 'collection' ? 'Kollektion' : 'Produkt'} nicht mehr vorhanden`);
      const files = await readThemeFiles(client, theme.id, [templateFile(tkind, null), `templates/${tkind}.*.json`]);
      prep = { theme, owners, baseTpl: commonBase(files, tkind, owners as { title: string; templateSuffix?: string | null }[], suffixOf(p.slug)) };
    }
    const imageUrl = await resolveImages(client, p.spec, undo, sleep);
    const products = await productsFor(client, p.spec, base, shop.currency);
    const scope = `lotse-${p.target === 'landingpage' ? 'page' : p.target}-${p.slug}`.slice(0, 60);
    const admin = `https://${shop.myshopifyDomain}/admin`;
    let out: PublishedInfo;

    if (p.target === 'landingpage') {
      const body = renderPageHtml(p.spec, { imageUrl, products, scope }), suffix = suffixOf(p.slug);
      let templated = true;
      try {
        const t = await mainTheme(client), tpl = templateFile('page', suffix), text = templateText(pageTemplate());
        await ensureSection(client, t.id, undo);
        const prior = (await readThemeFiles(client, t.id, [tpl])).get(tpl);
        await upsertThemeFile(client, t.id, tpl, text, prior, undo);
        await verifyThemeFile(client, t.id, tpl, text, sleep);
        notes.push(`Vorlage ${tpl} im Theme „${t.name}“`);
      } catch (e) { if (!(e instanceof ThemeAccessError)) throw e; templated = false; notes.push(`${e.message} Die Seite nutzt deshalb die Standardvorlage.`); }
      const metafields = [p.metaTitle && { namespace: 'global', key: 'title_tag', type: 'single_line_text_field', value: p.metaTitle }, p.metaDescription && { namespace: 'global', key: 'description_tag', type: 'multi_line_text_field', value: p.metaDescription }].filter(Boolean);
      const pageIds = () => idsWhere((d, v) => client.gql(d, v), 'pages', qField('handle', p.slug)); // geht die Antwort verloren, wird die Seite per Handle gefunden und zurückgenommen
      const r = await runCreating<Json>(client, M.pageCreate, { page: { title: p.title, handle: p.slug, body, isPublished: p.published, ...(templated ? { templateSuffix: suffix } : {}), ...(metafields.length ? { metafields } : {}) } }, undo, 'page', pageIds);
      const id = r.page?.id; if (!id) throw new Error('Shopify lieferte keine Seiten-ID');
      undo.push(deleteOp('page', id));
      // Prüfen: Seite mit Handle, Vorlage und Inhalt vorhanden
      const chk = (await client.gql<Json>('query PageCheck($id: ID!) { page(id: $id) { id handle templateSuffix isPublished body } }', { id })).page;
      if (chk && chk.handle !== p.slug) throw new Error(`Shopify hat den Handle zu ${chk.handle} geändert: /pages/${p.slug} ist offenbar schon vergeben. Bitte eine andere url wählen.`);
      if (!chk || (templated && chk.templateSuffix !== suffix) || !String(chk.body ?? '').includes(scope)) throw new Error('Prüfung fehlgeschlagen: Seite nicht wie geschrieben gespeichert');
      out = { name: p.title, storefront: `${base}/pages/${chk.handle}`, adminUrl: `${admin}/pages/${shortId(id)}`, url: `/pages/${chk.handle}`, notes };
    } else if (p.target === 'category' && p.mode === 'description') {
      const gid = toGid('Collection', p.collectionId!), [c] = await collectionsByIds((d, v) => client.gql(d, v), [gid], 'id handle descriptionHtml seo { title description }');
      if (!c) throw new Error('Kollektion nicht mehr vorhanden');
      const body = renderPageParts(p.spec, { imageUrl, products, scope }), html = body.before + body.after;
      const seo = p.metaTitle || p.metaDescription ? { seo: { title: p.metaTitle ?? c.seo?.title ?? null, description: p.metaDescription ?? c.seo?.description ?? null } } : {};
      await runRecording(client, M.collectionUpdate, { input: { id: gid, descriptionHtml: html, ...seo } }, undo,
        reqOp('collection', gid, M.collectionUpdate, { input: { id: gid, descriptionHtml: c.descriptionHtml ?? '', ...(seo.seo ? { seo: { title: c.seo?.title ?? null, description: c.seo?.description ?? null } } : {}) } }));
      out = { name: p.title, storefront: `${base}/collections/${c.handle}`, adminUrl: `${admin}/collections/${shortId(gid)}`, notes };
    } else {
      const kind = tkind!, { theme, owners, baseTpl } = prep!, suffix = suffixOf(p.slug), tpl = templateFile(kind, suffix);
      const parts = renderPageParts(p.spec, { imageUrl, products, scope });
      if (!parts.before && !parts.after) throw new Error('Der Entwurf hat außer theme-main keinen Inhalt');
      // erst hier stehen die echten Bild-URLs fest: Grenze erneut prüfen (klare Meldung statt Fehler von metafieldsSet)
      for (const [k, v] of Object.entries({ 'Inhalt über dem Theme-Inhalt': parts.before, 'Inhalt unter dem Theme-Inhalt': parts.after })) if (v.length > MAX_HTML) throw tooBig(k, v.length);
      const keys = { before: parts.before ? metaKey(kind, p.slug, 'before') : null, after: parts.after ? metaKey(kind, p.slug, 'after') : null };
      // Basis wird in den Lotse-Abschnitten vermerkt, damit spätere Veröffentlichungen sie kennen
      const text = templateText(withLotseSections(baseTpl.tpl, kind, keys, baseTpl.known && !isLotseFile(baseTpl.file) ? baseTpl.file : undefined));
      notes.push(`Basisvorlage: ${baseTpl.file}${baseTpl.known ? '' : ' (ohne Lotse-Abschnitte)'}`);
      await ensureSection(client, theme.id, undo);
      const shopId = (await client.gql<Json>('query ShopId { shop { id } }')).shop.id;
      await setShopHtml(client, shopId, Object.fromEntries([[keys.before, parts.before], [keys.after, parts.after]].filter(([k]) => k) as [string, string][]), undo);
      const prior = (await readThemeFiles(client, theme.id, [tpl])).get(tpl);
      await upsertThemeFile(client, theme.id, tpl, text, prior, undo);
      await verifyThemeFile(client, theme.id, tpl, text, sleep);
      for (const x of owners) {
        if (kind === 'collection') {
          const seo = p.metaTitle || p.metaDescription ? { seo: { title: p.metaTitle ?? x.seo?.title ?? null, description: p.metaDescription ?? x.seo?.description ?? null } } : {};
          if (x.templateSuffix === suffix && !seo.seo) continue;
          await runRecording(client, M.collectionUpdate, { input: { id: x.id, templateSuffix: suffix, ...seo } }, undo,
            reqOp('collection', x.id, M.collectionUpdate, { input: { id: x.id, templateSuffix: x.templateSuffix ?? null, ...(seo.seo ? { seo: { title: x.seo?.title ?? null, description: x.seo?.description ?? null } } : {}) } }));
        } else {
          if (x.templateSuffix === suffix) continue;
          await runRecording(client, M.productUpdate, { product: { id: x.id, templateSuffix: suffix } }, undo, reqOp('product', x.id, M.productUpdate, { product: { id: x.id, templateSuffix: x.templateSuffix ?? null } }));
        }
      }
      // Prüfen: Zuordnung gesetzt
      const after: Json[] = kind === 'collection' ? await collectionsByIds((d, v) => client.gql(d, v), [p.collectionId!], 'id templateSuffix') : await productsByIds((d, v) => client.gql(d, v), p.productIds!, 'id templateSuffix', 25);
      if (after.some(x => x.templateSuffix !== suffix)) throw new Error('Prüfung fehlgeschlagen: Vorlage ist nicht zugeordnet');
      notes.push(`Vorlage ${tpl} im Theme „${theme.name}“`);
      out = kind === 'collection'
        ? { name: p.title, storefront: `${base}/collections/${owners[0].handle}`, adminUrl: `${admin}/collections/${shortId(owners[0].id)}`, template: tpl, notes }
        : { name: p.title, storefront: owners.map(x => `${base}/products/${x.handle}`), adminUrl: `${admin}/themes/${shortId(theme.id)}/editor?template=product.${suffix}`, template: tpl, notes };
    }
    return { results: cs.items.map(i => ({ itemId: i.id, ok: true })), undo, published: out };
  } catch (e) {
    // atomar: bisherige Schritte sofort zurücknehmen
    if (e instanceof ThemeAccessError && p.target === 'category') e.message += ' Alternative ohne Theme: publish_page mit mode "description" (Inhalt als Kollektionsbeschreibung).';
    const r = undo.length ? await undoShopify(client, undo) : [];
    const failed = r.filter(x => !x.ok);
    const msg = `${errMsg(e)}${undo.length ? (failed.length ? ` Zurücknehmen teilweise fehlgeschlagen: ${failed.map(x => x.error).join('; ')}` : ' Alle bereits ausgeführten Schritte wurden zurückgenommen.') : ''}`;
    return { results: cs.items.map(i => ({ itemId: i.id, ok: false, error: msg })), undo: failed.length ? undo : [], error: msg };
  }
}
