import 'server-only';
// Simplified page spec (for the AI) → Shopware cms_page payload + HTML preview
import { FRAME_CSS, FRAME_SCRIPT } from '@/lib/preview-frame';
import { injectIntoHead, spliceSections } from './real-page';
import { newId } from './shopware';
import { cssVars } from './styleguide';

// ---- Page spec types (comes from the AI, validated at runtime) ----
export type PageType = 'landingpage' | 'product_list' | 'product_detail';
export type ImageObj = { mediaId?: string; url?: string; alt?: string };
export type ImageRef = string | ImageObj;
export interface BlockSpec {
  type: string;
  html?: string; leftHtml?: string; centerHtml?: string; rightHtml?: string; css?: string; js?: string;
  image?: ImageRef; image2?: ImageRef; minHeight?: string; displayMode?: string; linkUrl?: string;
  title?: string; productIds?: string[];
  /** Product boxes: image = large image (default), standard = Shopware default, minimal = image/name/price only */
  boxLayout?: 'image' | 'standard' | 'minimal';
  marginTop?: string; marginBottom?: string; backgroundColor?: string | null;
  pattern?: string; data?: Record<string, unknown>; _pattern?: string;
  /** reuse: take over a block 1:1 from an existing Shopping Experience (cmsPageId + blockIndex per get_cms_page) */
  cmsPageId?: string; blockIndex?: number; _src?: RawBlock; cmsType?: string; like?: string;
  [k: string]: unknown;
}
/** Raw Shopware block (excerpt), as copied from an existing page */
export interface RawSlot { slot: string; type: string; config: Record<string, unknown> | null }
export interface RawBlock {
  type: string; name?: string | null; cssClass?: string | null; backgroundColor?: string | null; backgroundMediaId?: string | null; backgroundMediaMode?: string | null;
  marginTop?: string | null; marginBottom?: string | null; marginLeft?: string | null; marginRight?: string | null; slots: RawSlot[];
}
const boxLayout = (b: BlockSpec) => (b.boxLayout === 'standard' || b.boxLayout === 'minimal' ? b.boxLayout : 'image');
const SLOT_LIKE: Record<string, string> = { 'product-listing': 'product-listing', 'buy-box': 'pdp-gallery-buybox', 'product-slider': 'product-slider', 'cross-selling': 'pdp-cross-selling', 'product-description-reviews': 'pdp-description-reviews', 'sidebar-filter': 'sidebar-filter' };
/** Static value of a slot config ({source:"static", value}); mapped values → undefined */
export const staticVal = (cfg: RawSlot['config'], key: string): unknown => { const c = (cfg ?? {})[key] as { source?: string; value?: unknown } | undefined; return c && c.source !== 'mapped' ? c.value : undefined; };
/** Media/product IDs that a reused block needs for the preview */
export function reuseRefs(b: BlockSpec): { mediaIds: string[]; productIds: string[] } {
  const mediaIds: string[] = [], productIds: string[] = [];
  for (const sl of b._src?.slots ?? []) {
    const m = staticVal(sl.config, 'media'); if (typeof m === 'string' && /^[0-9a-f]{32}$/.test(m)) mediaIds.push(m);
    const p = staticVal(sl.config, 'products'); if (Array.isArray(p)) productIds.push(...p.filter((x): x is string => typeof x === 'string'));
  }
  return { mediaIds, productIds };
}
/** Resolves reuse blocks: copies the source block (type, slots, config) into the spec. loader returns a page's blocks in reading order. */
export async function resolveReuse(spec: Partial<PageSpec>, loader: (cmsPageId: string) => Promise<RawBlock[]>): Promise<string[]> {
  const errs: string[] = [], cache = new Map<string, Promise<RawBlock[]>>();
  for (const [si, s] of (spec.sections ?? []).entries()) for (const [bi, b] of (s.blocks ?? []).entries()) {
    if (b?.type !== 'reuse') continue;
    const where = `sections[${si}].blocks[${bi}]`;
    if (typeof b.cmsPageId !== 'string' || !Number.isInteger(b.blockIndex) || (b.blockIndex as number) < 0) { errs.push(`${where}: reuse braucht cmsPageId und blockIndex (ab 0, Reihenfolge wie in get_cms_page)`); continue; }
    try {
      if (!cache.has(b.cmsPageId)) cache.set(b.cmsPageId, loader(b.cmsPageId));
      const blocks = await cache.get(b.cmsPageId)!;
      const src = blocks[b.blockIndex as number];
      if (!src) { errs.push(`${where}: Seite ${b.cmsPageId} hat nur ${blocks.length} Blöcke (0–${blocks.length - 1}): ${blocks.map((x, i) => `${i}=${x.type}`).join(', ')}`); continue; }
      b._src = src; b.cmsType = src.type;
      b.like = src.slots.map(sl => SLOT_LIKE[sl.type]).find(Boolean);
      if (!b.html) b.html = src.slots.map(sl => (sl.type === 'text' || sl.type === 'html' ? staticVal(sl.config, 'content') : '')).filter(x => typeof x === 'string').join('\n');
    } catch (e) { errs.push(`${where}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return errs;
}
export interface SectionSpec { type?: 'default' | 'sidebar'; sizingMode?: 'boxed' | 'full_width'; backgroundColor?: string; blocks: BlockSpec[] }
export interface PageSpec {
  name: string; type: PageType; sections: SectionSpec[];
  seo?: { keyword?: string; metaTitle?: string; metaDescription?: string };
  previewCategoryId?: string; previewProductId?: string;
}
type SlotConfig = Record<string, unknown>;
type MediaLookup = (im: ImageRef | undefined) => string | null | undefined;
/** generic = renderable on every platform (static HTML, see page-html.ts); otherwise Shopware Shopping Experience (mapped/dynamic elements, reuse) */
/** htmlOnly = only HTML platforms with a theme (Shopify: theme-main), never in Shopware Shopping Experiences */
interface BlockDef { desc: string; cms?: string; generic?: boolean; htmlOnly?: boolean; slots: (b: BlockSpec, m: MediaLookup) => [string, string, SlotConfig][] }

const S = (v: unknown) => ({ source: 'static', value: v });
const M = (v: unknown) => ({ source: 'mapped', value: v });

const textCfg = (html: string | undefined) => ({ content: S(html ?? '') });
const imgCfg = (mediaId: string | null | undefined, b: Partial<BlockSpec> = {}) => ({
  media: S(mediaId ?? null),
  displayMode: S(b.displayMode ?? 'cover'),
  url: S(b.linkUrl ?? null),
  newTab: S(false),
  minHeight: S(b.minHeight ?? '340px'),
  verticalAlign: S(null),
});

// type → { cmsBlockType, kind(s), slots(block, media) }
export const BLOCKS: Record<string, BlockDef> = {
  'text': { generic: true, desc: 'Fließtext/HTML (h2, p, ul …). Felder: html', slots: b => [['content', 'text', textCfg(b.html)]] },
  'text-hero': { generic: true, desc: 'Große Intro-/Hero-Textzeile. Felder: html', slots: b => [['content', 'text', textCfg(b.html)]] },
  'text-two-column': { generic: true, desc: 'Zwei Textspalten. Felder: leftHtml, rightHtml', slots: b => [['left', 'text', textCfg(b.leftHtml)], ['right', 'text', textCfg(b.rightHtml)]] },
  'text-three-column': { generic: true, desc: 'Drei Textspalten (z.B. USPs). Felder: leftHtml, centerHtml, rightHtml', slots: b => [['left', 'text', textCfg(b.leftHtml)], ['center', 'text', textCfg(b.centerHtml)], ['right', 'text', textCfg(b.rightHtml)]] },
  'image-cover': { generic: true, desc: 'Vollbreites Bild/Banner. Felder: image, minHeight (z.B. "400px")', slots: (b, m) => [['image', 'image', imgCfg(m(b.image), b)]] },
  'image-text': { generic: true, desc: 'Bild links, Text rechts. Felder: image, html', slots: (b, m) => [['left', 'image', imgCfg(m(b.image), { ...b, displayMode: 'standard' })], ['right', 'text', textCfg(b.html)]] },
  'text-image': { generic: true, desc: 'Text links, Bild rechts. Felder: html, image', slots: (b, m) => [['left', 'text', textCfg(b.html)], ['right', 'image', imgCfg(m(b.image), { ...b, displayMode: 'standard' })]] },
  'image-two-column': { generic: true, desc: 'Zwei Bilder nebeneinander. Felder: image, image2', slots: (b, m) => [['left', 'image', imgCfg(m(b.image))], ['right', 'image', imgCfg(m(b.image2))]] },
  'custom-html': {
    generic: true,
    desc: 'Freies HTML + CSS + JS als {{htmlElement}} (maximale Flexibilität: Akkordeons, Tabs, Zähler, Vergleichstabellen, Formulare, Embeds). Felder: html, css?, js?. CSS-Selektoren IMMER mit ".scope" beginnen (wird automatisch auf diesen Block begrenzt, z.B. ".scope .card{…}"). JS bekommt die Variable `root` (Wurzel-Element des Blocks); kein globaler Scope nötig, läuft nach DOMContentLoaded.',
    cms: 'html',
    slots: b => [['content', 'html', { content: S(wrapCustom(b)) }]],
  },
  'product-slider': {
    generic: true,
    desc: 'Produkt-Slider mit manuell gewählten Produkten. Felder: title, productIds[], boxLayout? (image = große Bilder, Standard; standard; minimal)',
    cms: 'product-slider',
    slots: b => [['productSlider', 'product-slider', {
      title: S(b.title ?? ''), products: S(b.productIds ?? []), productAssignmentType: S('static'),
      displayMode: S(boxLayout(b) === 'image' ? 'cover' : 'standard'), boxLayout: S(boxLayout(b)), navigation: S(true), rotate: S(false),
      border: S(false), elMinWidth: S('300px'), verticalAlign: S(null),
    }]],
  },
  'product-listing': {
    desc: 'Produktliste der Kategorie (nur Kategorie-Layouts, genau 1x). Felder: boxLayout? (image = große Bilder, Standard; standard; minimal)',
    slots: b => [['content', 'product-listing', {
      boxLayout: S(boxLayout(b)), showSorting: S(true), useCustomSorting: S(false), defaultSorting: S(''),
      availableSortings: S([]), propertyWhitelist: S([]),
      filters: S('manufacturer-filter,rating-filter,price-filter,shipping-free-filter,property-filter'),
    }]],
  },
  'sidebar-filter': { desc: 'Filter-Sidebar (nur Kategorie, mit section.type="sidebar"). Keine Felder', cms: 'sidebar-filter', slots: () => [['content', 'sidebar-filter', {}]] },
  // --- Product detail page: dynamic (mapped) standard elements ---
  'pdp-heading': {
    desc: 'PDP: Produktname + Herstellerlogo. Keine Felder', cms: 'product-heading',
    slots: () => [
      ['left', 'product-name', { content: M('product.name'), verticalAlign: S(null) }],
      ['right', 'manufacturer-logo', { media: M('product.manufacturer.media'), displayMode: S('standard'), url: M('product.manufacturer.link'), newTab: S(true), minHeight: S('20px'), verticalAlign: S(null) }],
    ],
  },
  'pdp-gallery-buybox': {
    desc: 'PDP: Galerie + Kaufbox. Keine Felder', cms: 'gallery-buybox',
    slots: () => [
      ['left', 'image-gallery', { sliderItems: M('product.media'), navigationArrows: S('inside'), navigationDots: S(null), galleryPosition: S('left'), displayMode: S('standard'), minHeight: S('340px'), verticalAlign: S(null), zoom: S(true), zoomModal: S(false), magnifierOverGallery: S(false), fullScreen: S(false) }],
      ['right', 'buy-box', { product: S(null), alignment: S(null) }],
    ],
  },
  'pdp-description-reviews': { desc: 'PDP: Beschreibung/Eigenschaften/Bewertungen-Tabs. Keine Felder', cms: 'product-description-reviews', slots: () => [['content', 'product-description-reviews', { product: S(null), alignment: S(null) }]] },
  'pdp-faq': {
    desc: 'PDP: produktindividuelle FAQ (mit FAQPage-Schema). Inhalt kommt je Produkt aus dem Zusatzfeld aicb_blocks, füllen per propose_product_changes (fields.faq). Keine Felder',
    cms: 'html', slots: () => [['content', 'html', { content: M('product.customFields.aicb_blocks.faq_html') }]],
  },
  'pdp-cross-selling': { desc: 'PDP: Cross-Selling. Keine Felder', cms: 'cross-selling', slots: () => [['content', 'cross-selling', { product: S(null), displayMode: S('standard'), boxLayout: S('standard'), elMinWidth: S('200px'), verticalAlign: S(null) }]] },
  'theme-main': {
    htmlOnly: true,
    desc: 'Platzhalter für den Hauptinhalt des Themes an dieser Stelle: bei product_list die Produktliste der Kollektion (mit Filtern und Sortierung des Themes), bei product_detail Galerie, Kaufbox und Beschreibung des Produkts. Genau 1x bei product_list und product_detail, nie bei landingpage. Blöcke davor erscheinen über, Blöcke danach unter dem Theme-Inhalt. Keine Felder',
    slots: () => [],
  },
  'reuse': {
    desc: 'Übernimmt einen vorhandenen Block 1:1 aus einer bestehenden Einkaufswelt dieses Shops, auch Plugin-Blöcke (Trusted-Shops-Leiste, Magazin-Teaser, Newsletter, Theme-Layouts …), die es im Katalog nicht gibt. Gleiche Elemente, gleiche Konfiguration, gleiche Optik wie im Shop. Felder: cmsPageId, blockIndex (Position des Blocks in get_cms_page, über alle Sections gezählt, ab 0). Quelle finden: read_page (URL → cmsPage) oder list_cms_pages/get_cms_page',
    slots: () => [],
  },
};

/** Block types every platform supports (plus always "pattern"); basis for PlatformCapabilities.blocks */
export const GENERIC_BLOCKS: string[] = Object.keys(BLOCKS).filter(k => BLOCKS[k].generic);
/** A platform's block catalog ('all' = all) */
export const blocksFor = (allowed: 'all' | readonly string[]) => (allowed === 'all' ? Object.keys(BLOCKS).filter(k => !BLOCKS[k].htmlOnly) : Object.keys(BLOCKS).filter(k => allowed.includes(k)));

// Wraps html/css/js of a custom-html block: unique scope class, <style>, <script> with root variable
export function wrapCustom(b: Pick<BlockSpec, 'html' | 'css' | 'js'>, scopeId = 'aicb-' + Math.random().toString(36).slice(2, 8)) {
  const css = (b.css ?? '').replace(/\.scope\b/g, '.' + scopeId);
  const js = b.js ? `<script>(function(){var run=function(){var root=document.querySelector('.${scopeId}');if(!root)return;try{${b.js}\n}catch(e){console.error('[custom-html]',e)}};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();})();</script>` : '';
  const vars = cssVars();
  const style = (vars ? `.${scopeId}{${vars}}` : '') + css;
  return `<div class="${scopeId}">${style ? `<style>${style}</style>` : ''}${b.html ?? ''}</div>${js}`;
}

export const PAGE_TYPES = ['landingpage', 'product_list', 'product_detail'] as const;

/**
 * Validates the spec. layoutRules=false (HTML platforms): product_list/product_detail without requiring product-listing or
 * pdp-gallery-buybox, because there only the category/collection content is set; the theme provides product list and buy box.
 * themeMain=true (platform with theme templates, e.g. Shopify): product_list/product_detail need exactly one theme-main block (position of the theme content).
 */
export function validateSpec(spec: PageSpec, { layoutRules = true, themeMain = false }: { layoutRules?: boolean; themeMain?: boolean } = {}): string[] {
  const errs: string[] = [];
  if (!spec?.name) errs.push('name fehlt');
  if (!(PAGE_TYPES as readonly string[]).includes(spec?.type)) errs.push(`type muss einer von ${PAGE_TYPES.join(', ')} sein`);
  if (!Array.isArray(spec?.sections) || !spec.sections.length) errs.push('sections[] fehlt/leer');
  let listings = 0, buybox = 0, mains = 0;
  for (const [si, s] of (spec?.sections ?? []).entries()) {
    for (const [bi, b] of (s.blocks ?? []).entries()) {
      if (b.type === 'pattern') { errs.push(`sections[${si}].blocks[${bi}]: unbekanntes Pattern "${b.pattern}" (Namen laut Pattern-Katalog)`); continue; } // after expandSpec only present if the name is wrong
      if (!BLOCKS[b.type]) { errs.push(`sections[${si}].blocks[${bi}]: unbekannter Typ "${b.type}"`); continue; }
      if (b.type === 'reuse' && (typeof b.cmsPageId !== 'string' || !Number.isInteger(b.blockIndex))) { errs.push(`sections[${si}].blocks[${bi}]: reuse braucht cmsPageId und blockIndex`); continue; }
      const kind = b.type === 'reuse' ? b.like ?? '' : b.type; // reused block counts like its catalog counterpart
      if (kind === 'product-listing') listings++;
      if (kind === 'pdp-gallery-buybox') buybox++;
      if (kind === 'theme-main') { mains++; if (spec.type === 'landingpage') errs.push('theme-main nur bei type=product_list oder product_detail (eine Landingpage hat keinen Theme-Inhalt)'); }
      if (kind.startsWith('pdp-') && spec.type !== 'product_detail') errs.push(`${kind} nur bei type=product_detail`);
      if ((kind === 'product-listing' || kind === 'sidebar-filter') && spec.type !== 'product_list') errs.push(`${kind} nur bei type=product_list`);
    }
  }
  if (mains > 1) errs.push('theme-main darf nur einmal vorkommen');
  if (themeMain && (spec?.type === 'product_list' || spec?.type === 'product_detail') && mains !== 1) errs.push(`${spec.type} braucht genau einen theme-main-Block (dort zeigt das Theme ${spec.type === 'product_list' ? 'die Produktliste' : 'Galerie, Kaufbox und Beschreibung'})`);
  if (!layoutRules) return errs;
  if (spec?.type === 'product_list' && listings !== 1) errs.push('product_list braucht genau einen product-listing Block');
  if (spec?.type === 'product_detail' && buybox !== 1) errs.push('product_detail braucht genau einen pdp-gallery-buybox Block');
  return errs;
}

// image field: {mediaId} | {url, alt} | string(url)  →  mediaId (uploads if needed)
export async function compile(spec: PageSpec, resolveMedia: (im: ImageObj) => Promise<string | null>) {
  const cache = new Map<string, string | null>();
  const imgs: ImageRef[] = [];
  for (const s of spec.sections) for (const b of s.blocks) for (const k of ['image', 'image2']) if (b[k]) imgs.push(b[k]);
  for (const im of imgs) {
    const key = JSON.stringify(im);
    if (!cache.has(key)) cache.set(key, await resolveMedia(typeof im === 'string' ? { url: im } : im));
  }
  const m: MediaLookup = im => (im ? cache.get(JSON.stringify(im)) : null);

  return {
    id: newId(),
    name: spec.name,
    type: spec.type,
    sections: spec.sections.map((s, si) => ({
      id: newId(), position: si, type: s.type === 'sidebar' ? 'sidebar' : 'default',
      sizingMode: s.sizingMode ?? 'boxed', mobileBehavior: 'wrap',
      backgroundColor: s.backgroundColor ?? null,
      blocks: s.blocks.map((b, bi) => {
        const def = BLOCKS[b.type];
        if (b.type === 'reuse') { // copy of the source block with new IDs
          const src = b._src; if (!src) throw new Error(`reuse-Block ${bi} wurde nicht aufgelöst (draft_page erneut aufrufen)`);
          return {
            id: newId(), position: bi, type: src.type, name: src.name ?? null, cssClass: src.cssClass ?? null,
            sectionPosition: s.type === 'sidebar' ? 'sidebar' : 'main',
            marginTop: b.marginTop ?? src.marginTop ?? '20px', marginBottom: b.marginBottom ?? src.marginBottom ?? '20px', marginLeft: src.marginLeft ?? '20px', marginRight: src.marginRight ?? '20px',
            backgroundColor: b.backgroundColor ?? src.backgroundColor ?? null, backgroundMediaId: src.backgroundMediaId ?? null, backgroundMediaMode: src.backgroundMediaMode ?? null,
            slots: src.slots.map(sl => ({ id: newId(), slot: sl.slot, type: sl.type, config: sl.config ?? {} })),
          };
        }
        return {
          id: newId(), position: bi, type: def.cms ?? b.type,
          sectionPosition: s.type === 'sidebar' ? 'sidebar' : 'main',
          marginTop: b.marginTop ?? '20px', marginBottom: b.marginBottom ?? '20px', marginLeft: '20px', marginRight: '20px',
          backgroundColor: b.backgroundColor ?? null,
          slots: def.slots(b, m).map(([slot, type, config]) => ({ id: newId(), slot, type, config })),
        };
      }),
    })),
  };
}

// ---------- HTML preview ----------
// Runs in the sandboxed iframe (DraftFrame.tsx): scripts from custom-html and shop HTML have no access to the UI and API;
// partial updates, scroll and mark mode go through the script from lib/preview-frame.ts (postMessage).
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&' | '<' | '>' | '"']));

export interface PreviewProduct { id?: string; name?: string; price?: string | null; img?: string; description?: string; faqHtml?: string; [k: string]: unknown }
export interface PreviewCtx {
  imageUrl?: (im: ImageRef) => string | null | undefined; products?: Record<string, PreviewProduct>; product?: PreviewProduct; themeCss?: string | null;
  /** HTML of the real target page (scripts removed, URLs rewritten to /shop): the draft replaces the CMS content in it */
  realPage?: string;
  /** real dynamic blocks (buy box, product list …) of this page per block type of the draft */
  realBlocks?: Record<string, string>;
}

export function renderPreview(spec: Partial<PageSpec>, ctx: PreviewCtx = {}): string {
  const imgSrc = (im: ImageRef | undefined) => (im ? ctx.imageUrl?.(im) ?? (typeof im === 'string' ? im : im.url) : null);
  const img = (im: ImageRef | undefined, h = 340) => {
    const src = imgSrc(im);
    return src ? `<img src="${esc(src)}" style="width:100%;height:100%;min-height:${h}px;object-fit:cover;display:block">`
      : `<div class="ph" style="min-height:${h}px">Bild</div>`;
  };
  const products = (ids: string[] | undefined) => (ids ?? []).map(id => ctx.products?.[id]).filter((p): p is PreviewProduct => !!p);
  // Product box as in the shop (box layout "Großes Bild"): image, name (2 lines), price, cart
  const card = (p: PreviewProduct) => `<div class="card">${p.img ? `<div class="pi"><img src="${esc(p.img)}" alt=""></div>` : '<div class="pi ph">Produkt</div>'}<div class="pb"><b>${esc(p.name)}</b><span>${esc(p.price ?? '')}</span><i>In den Warenkorb</i></div></div>`;
  const prod = ctx.product;

  const R: Record<string, (b: BlockSpec) => string> = {
    'text': b => `<div class="t">${b.html ?? ''}</div>`,
    'text-hero': b => `<div class="t hero">${b.html ?? ''}</div>`,
    'text-two-column': b => `<div class="cols c2"><div class="t">${b.leftHtml ?? ''}</div><div class="t">${b.rightHtml ?? ''}</div></div>`,
    'text-three-column': b => `<div class="cols c3"><div class="t">${b.leftHtml ?? ''}</div><div class="t">${b.centerHtml ?? ''}</div><div class="t">${b.rightHtml ?? ''}</div></div>`,
    'image-cover': b => img(b.image, parseInt(b.minHeight ?? '') || 340),
    'image-text': b => `<div class="cols c2">${img(b.image)}<div class="t">${b.html ?? ''}</div></div>`,
    'text-image': b => `<div class="cols c2"><div class="t">${b.html ?? ''}</div>${img(b.image)}</div>`,
    'image-two-column': b => `<div class="cols c2">${img(b.image)}${img(b.image2)}</div>`,
    'custom-html': b => wrapCustom(b),
    'product-slider': b => `${b.title ? `<h3>${esc(b.title)}</h3>` : ''}<div class="slider">${products(b.productIds).map(card).join('') || '<div class="ph">Produkte</div>'}</div>`,
    'product-listing': () => `<div class="slider wrap">${Object.values(ctx.products ?? {}).slice(0, 8).map(card).join('') || '<div class="ph">Produktliste (dynamisch)</div>'}</div>`,
    'sidebar-filter': () => `<div class="ph" style="min-height:120px">Filter-Sidebar</div>`,
    'pdp-heading': () => `<h1>${esc(prod?.name ?? '{{ Produktname }}')}</h1>`,
    'pdp-gallery-buybox': () => `<div class="cols c2">${prod?.img ? `<img src="${esc(prod.img)}" style="width:100%">` : '<div class="ph" style="min-height:300px">Galerie</div>'}<div class="buy"><div class="price">${esc(prod?.price ?? '€ …')}</div><button>In den Warenkorb</button><small>Kaufbox (dynamisch)</small></div></div>`,
    'pdp-description-reviews': () => `<div class="tabs"><b>Beschreibung</b> · Bewertungen</div><div class="t">${prod?.description ?? '<i>Produktbeschreibung (dynamisch)</i>'}</div>`,
    'pdp-faq': () => prod?.faqHtml ?? '<div class="ph" style="min-height:110px">FAQ: wird je Produkt aus dem Zusatzfeld geladen</div>',
    'pdp-cross-selling': () => {
      const others = Object.values(ctx.products ?? {}).filter(p => p.id !== prod?.id).slice(0, 4);
      return others.length ? `<h3>Das könnte dir auch gefallen</h3><div class="slider">${others.map(card).join('')}</div>` : `<div class="ph">Cross-Selling (dynamisch)</div>`;
    },
    // Theme content (HTML platforms): the collection's product list or the product area with real data, where available
    'theme-main': () => spec.type === 'product_detail'
      ? `<div class="theme-main"><div class="cols c2">${prod?.img ? `<img src="${esc(prod.img)}" style="width:100%">` : '<div class="ph" style="min-height:300px">Galerie (Theme)</div>'}<div class="buy"><h1>${esc(prod?.name ?? 'Produktname')}</h1><div class="price">${esc(prod?.price ?? '€ …')}</div><button>In den Warenkorb</button><small>Produktbereich des Themes</small></div></div>${prod?.description ? `<div class="t">${prod.description}</div>` : ''}</div>`
      : `<div class="theme-main"><small>Produktliste des Themes</small><div class="slider wrap">${Object.values(ctx.products ?? {}).slice(0, 8).map(card).join('') || '<div class="ph">Produktliste (Theme)</div>'}</div></div>`,
    'reuse': b => {
      const src = b._src;
      if (!src) return `<div class="ph" style="min-height:90px">Übernommener Block (noch nicht aufgelöst)</div>`;
      const slot = (sl: RawSlot) => {
        const v = (k: string) => staticVal(sl.config, k);
        if (sl.type === 'text') return `<div class="t">${String(v('content') ?? '')}</div>`;
        if (sl.type === 'html') return `<div>${String(v('content') ?? '')}</div>`;
        if (sl.type === 'image') { const m = v('media'); const src = typeof m === 'string' ? imgSrc({ mediaId: m }) : null; return src ? `<img src="${esc(src)}" style="width:100%;display:block;object-fit:cover;min-height:200px">` : `<div class="ph" style="min-height:200px">Bild (${esc(sl.slot)})</div>`; }
        if (sl.type === 'product-slider') { const ids = v('products'); const t = v('title'); return `${t ? `<h3>${esc(t)}</h3>` : ''}<div class="slider">${products(Array.isArray(ids) ? ids : []).map(card).join('') || '<div class="ph">Produkte (dynamisch)</div>'}</div>`; }
        return `<div class="ph" style="min-height:90px">${esc(sl.type)}: wie im Shop (${esc(sl.slot)})</div>`;
      };
      const parts = src.slots.map(slot);
      const cls = parts.length === 2 ? 'cols c2' : parts.length === 3 ? 'cols c3' : '';
      return `<div class="reuse ${cls}" data-cms="${esc(src.type)}" title="Übernommen: ${esc(src.type)}">${parts.join('')}</div>`;
    },
  };

  const shop = !!ctx.themeCss || !!ctx.realPage; // the shop's real theme CSS + Shopware markup → preview looks like the shop
  const sections = (spec.sections ?? []).filter(Boolean);
  const blocksOf = (sec: SectionSpec) => (sec.blocks ?? []).filter(b => b && b.type);
  const inner = (b: BlockSpec) => {
    let h = (R[b.type] ?? (() => `<div class="ph" style="min-height:90px">${esc(b.type === 'pattern' ? `Pattern ${b.pattern ?? '?'}` : b.type)}</div>`))(b);
    if (shop) h = h.replace(/class="t( |")/g, 'class="t cms-element-text$1');
    return `<div class="blk" data-type="${esc(b.type === 'reuse' ? `reuse: ${b.cmsType ?? '?'}` : b.type)}">${h}</div>`;
  };
  // Real block of the target page (buy box, product list …) instead of a placeholder, if the page has one
  const block = (b: BlockSpec, j: number) => ctx.realBlocks && b.type in ctx.realBlocks
    ? `<div class="blk" data-type="${esc(b.type)}"${ctx.realBlocks[b.type] ? '' : ' hidden'}>${ctx.realBlocks[b.type]}</div>`
    : `<div class="cms-block pos-${j} cms-block-${esc(b.type)} position-relative"><div class="cms-block-container" style="padding:20px">${inner(b)}</div></div>`;
  const sectionsHtml = shop ? sections.map((sec, i) => `<div class="cms-section pos-${i} cms-section-default"><section class="cms-section-default boxed">${blocksOf(sec).map(block).join('')}</section></div>`).join('') : '';
  const body = shop
    ? `<main class="content-main"><div class="container-main"><div class="cms-page"><div class="cms-sections">${sectionsHtml}</div></div></div></main>`
    : sections.map(sec => `<section class="${sec.type === 'sidebar' ? 'sb' : ''}">${blocksOf(sec).map(inner).join('')}</section>`).join('');

  const base = shop ? '' : `body{font:16px/1.6 var(--sg-font-body,system-ui),system-ui,sans-serif;color:var(--sg-text,#1c2b36);margin:0;padding:16px;background:var(--sg-background,#fff)}
  section{max-width:1100px;margin:0 auto}.blk{margin:20px 0;position:relative}.t h2,h1,h3{font-family:var(--sg-font-heading,inherit)}`;
  const css = `
  :root{${cssVars()}}
  ${base}.blk{position:relative}
  .blk:hover::before{content:attr(data-type);position:absolute;top:-10px;right:0;font:10px monospace;background:var(--sg-primary,#189eff);color:#fff;padding:1px 6px;border-radius:3px;z-index:2}
  .cols{display:grid;gap:24px;align-items:center}.c2{grid-template-columns:1fr 1fr}.c3{grid-template-columns:repeat(3,1fr)}
  .hero{font-size:1.3em;text-align:center;padding:24px 0}.hero h1,.hero h2{margin:0 0 8px}
  .t h2{margin-top:0}.ph{background:repeating-linear-gradient(45deg,#f2f5f8,#f2f5f8 10px,#e8edf2 10px,#e8edf2 20px);display:grid;place-items:center;color:#7a8a99;border-radius:6px;font-size:13px}
  .slider{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(200px,calc((100% - 72px)/4));gap:32px 24px;overflow:auto;padding-bottom:4px}.slider.wrap{grid-auto-flow:row;grid-template-columns:repeat(auto-fill,minmax(min(220px,44%),1fr));grid-auto-columns:auto}
  .card{display:flex;flex-direction:column;min-width:0}
  .card .pi{aspect-ratio:1;border-radius:var(--sg-radius,10px);overflow:hidden;background:color-mix(in srgb,var(--sg-text,#2b3136) 5%,#fff);display:grid;place-items:center;color:#9aa5ae;font-size:12px}.card .pi img{width:100%;height:100%;object-fit:cover;display:block}
  .card .pb{display:flex;flex-direction:column;gap:4px;padding:14px 2px 0;flex:1}.card b{font-weight:500;font-size:15px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.8em}
  .card span{font-weight:650;font-size:15px;color:var(--sg-text,#2b3136)}.card i{font-style:normal;margin-top:12px;text-align:center;font-weight:600;font-size:13px;padding:.7em .6em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:var(--sg-radius,6px);border:1px solid color-mix(in srgb,var(--sg-primary,#0042a0) 40%,transparent);color:var(--sg-primary,#0042a0)}
  .hint,small{color:#7a8a99;font-size:12px}
  .buy{border:1px solid #dde4ea;border-radius:6px;padding:16px}.price{font-size:1.6em;font-weight:700}.buy button{background:var(--sg-primary,#189eff);color:var(--sg-primary-contrast,#fff);border:0;padding:10px 18px;border-radius:var(--sg-radius,4px);margin:10px 0}
  html{scroll-behavior:auto!important}
  .pv-new{animation:pvin .5s ease-out}@keyframes pvin{from{opacity:0;transform:translateY(8px)}}
  @media(max-width:700px){.c2,.c3{grid-template-columns:1fr}}
  ${FRAME_CSS}`;
  // Draft on the real page: header, footer, theme and dynamic blocks stay, only the CMS content is replaced
  if (shop && ctx.realPage) {
    const merged = spliceSections(ctx.realPage, sectionsHtml);
    if (merged) return injectIntoHead(merged, `<meta charset="utf-8"><style>${css}</style><script>${FRAME_SCRIPT}</script>`);
  }
  return `<!doctype html><meta charset="utf-8">${ctx.themeCss ? `<link rel="stylesheet" href="${esc(ctx.themeCss)}">` : ''}<style>${css}</style><script>${FRAME_SCRIPT}</script><body${shop ? ' class="is-ctl-navigation is-act-index"' : ''}>${body}`;
}
