import 'server-only';
// Seiten-Entwurf → statisches HTML für Plattformen ohne Einkaufswelten (Shopify-Seiten, Magento-CMS-Seiten, Kategorie-/Kollektionstexte).
// Nur die generischen Blöcke (GENERIC_BLOCKS + Patterns). Bilder müssen vorher in endgültige URLs aufgelöst sein (Upload nach Freigabe),
// Produkte kommen als Vorschau-Daten (Name, Preis formatiert, Bild, url) von der Plattform.
import { GENERIC_BLOCKS, wrapCustom, type BlockSpec, type ImageRef, type PageSpec, type PreviewProduct, type SectionSpec } from './cms';
import { expandSpec } from './patterns';
import { cssVars } from './styleguide';

export interface HtmlCtx {
  /** ImageRef → endgültige, öffentliche URL (null = Bild weglassen) */
  imageUrl: (im: ImageRef) => string | null | undefined;
  /** Produkte nach ID; url = Produktseite im Shop */
  products?: Record<string, PreviewProduct & { url?: string }>;
  /** Wurzel-Klasse (eindeutig je Seite), Standard lotse-page */
  scope?: string;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c as '&' | '<' | '>' | '"']));
const alt = (im: ImageRef | undefined) => (im && typeof im === 'object' ? im.alt ?? '' : '');

/** Blocktypen eines bereits expandierten Entwurfs, die nicht erlaubt sind */
function unsupportedIn(ex: Partial<PageSpec>, allowed: readonly string[]): string[] {
  const bad = new Set<string>();
  for (const s of ex.sections ?? []) for (const b of s.blocks ?? []) if (b?.type && !allowed.includes(b.type)) bad.add(b.type);
  return [...bad];
}
/** Blocktypen eines Entwurfs, die NICHT als statisches HTML gehen (nach Pattern-Auflösung) */
export const unsupportedBlocks = (spec: Partial<PageSpec>, allowed: readonly string[] = GENERIC_BLOCKS): string[] => unsupportedIn(expandSpec(spec), allowed);

/**
 * Rendert den Entwurf als eigenständiges HTML-Fragment (ein Wurzel-<div> mit begrenztem <style>, ohne <html>/<body>).
 * Wirft, wenn Blöcke enthalten sind, die nur Shopware-Einkaufswelten können (pdp-*, product-listing, sidebar-filter, reuse).
 */
export function renderPageHtml(spec: PageSpec, ctx: HtmlCtx): string {
  const ex = expandSpec(spec), bad = unsupportedIn(ex, GENERIC_BLOCKS); // einmal expandieren (Muster bauen HTML/CSS und Scope-IDs)
  if (bad.length) throw new Error(`Blocktyp(en) ${bad.join(', ')} gibt es nur in Shopware-Einkaufswelten. Erlaubt: ${GENERIC_BLOCKS.join(', ')} und pattern.`);
  const root = ctx.scope ?? 'lotse-page';
  return wrapRoot(root, renderBlocks(ex.sections ?? [], ctx));
}

/**
 * Wie renderPageHtml, aber geteilt am theme-main-Block (Plattformen mit Theme-Vorlagen): before = Inhalt über dem Theme-Inhalt
 * (Produktliste bzw. Produktbereich), after = darunter. Ohne theme-main steht alles in before. Leere Teile sind ''.
 */
export function renderPageParts(spec: PageSpec, ctx: HtmlCtx): { before: string; after: string; themeMain: boolean } {
  const ex = expandSpec(spec), bad = unsupportedIn(ex, [...GENERIC_BLOCKS, 'theme-main']);
  if (bad.length) throw new Error(`Blocktyp(en) ${bad.join(', ')} gehen hier nicht. Erlaubt: ${GENERIC_BLOCKS.join(', ')}, theme-main und pattern.`);
  const root = ctx.scope ?? 'lotse-page', before: SectionSpec[] = [], after: SectionSpec[] = [];
  let seen = false;
  for (const s of ex.sections ?? []) {
    const blocks = s.blocks ?? [], i = blocks.findIndex(b => b?.type === 'theme-main');
    if (seen) { after.push(s); continue; }
    if (i < 0) { before.push(s); continue; }
    seen = true;
    if (i > 0) before.push({ ...s, blocks: blocks.slice(0, i) });
    if (i < blocks.length - 1) after.push({ ...s, blocks: blocks.slice(i + 1) });
  }
  const part = (list: SectionSpec[]) => { const body = renderBlocks(list, ctx); return body.replace(/<section class="lp-sec"><\/section>/g, '') ? wrapRoot(root, body) : ''; };
  return { before: part(before), after: part(after), themeMain: seen };
}

const blockRenderers = (ctx: HtmlCtx): Record<string, (b: BlockSpec) => string> => {
  const img = (im: ImageRef | undefined, h = 340) => {
    const src = im ? ctx.imageUrl(im) : null;
    return src ? `<img src="${esc(src)}" alt="${esc(alt(im))}" loading="lazy" style="width:100%;height:100%;min-height:${h}px;object-fit:cover;display:block">` : '';
  };
  const card = (p: PreviewProduct & { url?: string }) => {
    const inner = `${p.img ? `<span class="lp-pi"><img src="${esc(p.img)}" alt="${esc(p.name)}" loading="lazy"></span>` : ''}<b>${esc(p.name)}</b>${p.price ? `<span class="lp-price">${esc(p.price)}</span>` : ''}`;
    return p.url ? `<a class="lp-card" href="${esc(p.url)}">${inner}</a>` : `<div class="lp-card">${inner}</div>`;
  };
  return {
    'text': b => `<div class="lp-t">${b.html ?? ''}</div>`,
    'text-hero': b => `<div class="lp-t lp-hero">${b.html ?? ''}</div>`,
    'text-two-column': b => `<div class="lp-cols lp-c2"><div class="lp-t">${b.leftHtml ?? ''}</div><div class="lp-t">${b.rightHtml ?? ''}</div></div>`,
    'text-three-column': b => `<div class="lp-cols lp-c3"><div class="lp-t">${b.leftHtml ?? ''}</div><div class="lp-t">${b.centerHtml ?? ''}</div><div class="lp-t">${b.rightHtml ?? ''}</div></div>`,
    'image-cover': b => img(b.image, parseInt(b.minHeight ?? '') || 340),
    'image-text': b => `<div class="lp-cols lp-c2">${img(b.image)}<div class="lp-t">${b.html ?? ''}</div></div>`,
    'text-image': b => `<div class="lp-cols lp-c2"><div class="lp-t">${b.html ?? ''}</div>${img(b.image)}</div>`,
    'image-two-column': b => `<div class="lp-cols lp-c2">${img(b.image)}${img(b.image2)}</div>`,
    'custom-html': b => wrapCustom(b),
    'product-slider': b => {
      const list = (b.productIds ?? []).map(id => ctx.products?.[id]).filter((p): p is PreviewProduct => !!p);
      return list.length ? `${b.title ? `<h2>${esc(b.title)}</h2>` : ''}<div class="lp-grid">${list.map(card).join('')}</div>` : '';
    },
  };
};

function renderBlocks(sections: SectionSpec[], ctx: HtmlCtx): string {
  const R = blockRenderers(ctx);
  return sections.map(s => `<section class="lp-sec">${(s.blocks ?? []).map(b => {
    const h = (R[b.type] ?? (() => ''))(b);
    if (!h) return '';
    const st = [b.marginTop && `margin-top:${esc(b.marginTop)}`, b.marginBottom && `margin-bottom:${esc(b.marginBottom)}`, b.backgroundColor && `background:${esc(b.backgroundColor)}`].filter(Boolean).join(';');
    return `<div class="lp-blk"${st ? ` style="${st}"` : ''}>${h}</div>`;
  }).join('')}</section>`).join('');
}

function wrapRoot(root: string, body: string): string {
  const vars = cssVars();
  const css = `.${root}{${vars}}.${root} .lp-sec{max-width:1200px;margin:0 auto}.${root} .lp-blk{margin:24px 0}
.${root} .lp-cols{display:grid;gap:24px;align-items:center}.${root} .lp-c2{grid-template-columns:1fr 1fr}.${root} .lp-c3{grid-template-columns:repeat(3,1fr)}
.${root} .lp-hero{font-size:1.25em;text-align:center}.${root} .lp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:24px}
.${root} .lp-card{display:flex;flex-direction:column;gap:6px;color:inherit;text-decoration:none}.${root} .lp-pi{aspect-ratio:1;overflow:hidden;border-radius:var(--sg-radius,8px);display:block}
.${root} .lp-pi img{width:100%;height:100%;object-fit:cover;display:block}.${root} .lp-price{font-weight:650}
@media(max-width:700px){.${root} .lp-c2,.${root} .lp-c3{grid-template-columns:1fr}}`;
  return `<div class="${root}"><style>${css}</style>${body}</div>`;
}
