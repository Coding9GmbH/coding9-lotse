// Magento Page Builder: content in Page Builder's storage format (Mage-OS/Magento 2.4), so pages, CMS blocks and
// product descriptions remain editable with Page Builder in the admin (pure → testable).
// Structure: one row (row, "contained") with content types: html (free HTML, HTML-encoded in storage, Magento decodes it
// on output), products (widget "Catalog Products List": prices, stock, cart live from Magento) and block (CMS block widget).

/** HTML-encode the way Page Builder stores the html content type (Knockout text binding) */
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
/**
 * Magento evaluates "{{…}}" in content as a directive (variables, widgets), even in encoded HTML. Free HTML must
 * therefore not contain "{{": "{ {" is equivalent in CSS and JS and barely visible in text.
 */
export const noDirectives = (html: string) => html.replace(/\{\{/g, '{ {');

export type PbPart = { kind: 'html'; html: string; /** directives already checked (don't defuse) */ checked?: boolean } | { kind: 'products'; skus: string[] } | { kind: 'block'; blockId: number };

export const PB_ROW_OPEN = '<div data-content-type="row" data-appearance="contained" data-element="main"><div data-enable-parallax="0" data-parallax-speed="0.5" data-background-images="{}" data-background-type="image" data-video-loop="true" data-video-play-only-visible="true" data-video-lazy-load="true" data-video-fallback-src="" data-element="inner" style="justify-content: flex-start; display: flex; flex-direction: column; background-position: left top; background-size: cover; background-repeat: no-repeat; background-attachment: scroll; border-style: none; border-width: 1px; border-radius: 0px; margin: 0px 0px 10px; padding: 10px;">';
const ROW_CLOSE = '</div></div>';

const attrs = (a: Record<string, string | number>) => Object.entries(a).map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
/** Encoding of widget parameters like Page Builder (brackets, quotes and backslashes replaced) */
const wysiwyg = (s: string) => s.replace(/\{/g, '^[').replace(/\}/g, '^]').replace(/"/g, '`').replace(/\\/g, '|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Widget "Catalog Products List" with a fixed SKU list (order as given) */
export function productsWidget(skus: string[]): string {
  const list = skus.map(s => s.replace(/[,{}"\\]/g, '').trim()).filter(Boolean).join(', ');
  const cond = JSON.stringify({ 1: { aggregator: 'all', new_child: '', type: 'Magento\\CatalogWidget\\Model\\Rule\\Condition\\Combine', value: '1' }, '1--1': { operator: '()', type: 'Magento\\CatalogWidget\\Model\\Rule\\Condition\\Product', attribute: 'sku', value: list } });
  return `{{widget ${attrs({ type: 'Magento\\CatalogWidget\\Block\\Product\\ProductsList', template: 'Magento_CatalogWidget::product/widget/content/grid.phtml', anchor_text: '', id_path: '', show_pager: 0, products_count: Math.max(1, skus.length), condition_option: 'sku', condition_option_value: wysiwyg(list), type_name: 'Catalog Products List', conditions_encoded: wysiwyg(cond), sort_order: 'position_by_sku' })}}}`;
}
/** Widget "CMS Static Block" */
export const blockWidget = (blockId: number) => `{{widget ${attrs({ type: 'Magento\\Cms\\Block\\Widget\\Block', template: 'widget/static_block/default.phtml', block_id: blockId, type_name: 'CMS Static Block' })}}}`;

export function pbPart(p: PbPart): string {
  if (p.kind === 'html') return `<div data-content-type="html" data-appearance="default" data-element="main">${encode(p.checked ? p.html : noDirectives(p.html))}</div>`;
  if (p.kind === 'products') return `<div data-content-type="products" data-appearance="grid" data-element="main">${productsWidget(p.skus)}</div>`;
  return `<div data-content-type="block" data-appearance="default" data-element="main">${blockWidget(p.blockId)}</div>`;
}
/** Parts → Page Builder content (one row) */
export const toPageBuilder = (parts: PbPart[]) => PB_ROW_OPEN + parts.map(pbPart).join('') + ROW_CLOSE;

/** Is the text Page Builder content? (otherwise Magento shows the WYSIWYG editor) */
export const isPageBuilder = (html: string | null | undefined) => /data-content-type="/.test(String(html ?? ''));

/**
 * Appends a part to existing content (e.g. CMS block widget below the product description): Page Builder content
 * gets a new row, other content (classic HTML) is carried over as an html content type into the same row.
 */
export function appendPart(existing: string | null | undefined, part: PbPart): string {
  const cur = String(existing ?? '');
  if (!cur.trim()) return toPageBuilder([part]);
  if (isPageBuilder(cur)) return cur + toPageBuilder([part]);
  return toPageBuilder([{ kind: 'html', html: cur }, part]);
}

/** Make the content of an html content type readable again (for checks, e.g. links in pages) */
export function readableHtml(content: string | null | undefined): string {
  return String(content ?? '').replace(/(<div[^>]*data-content-type="html"[^>]*>)([\s\S]*?)(<\/div>)/g, (_, a: string, inner: string, c: string) => (/[<>]/.test(inner) ? a + inner + c : a + decode(inner) + c));
}

/**
 * Counterpart to readableHtml: re-encode html content types with raw HTML the way Page Builder stores them
 * (nested divs are counted). guard checks the readable content (e.g. directives); unchanged, already encoded content stays verbatim.
 */
export function storableHtml(content: string, guard: (html: string) => string = s => s): string {
  const open = /<div[^>]*data-content-type="html"[^>]*>/g;
  let out = '', pos = 0, m: RegExpExecArray | null;
  while ((m = open.exec(content))) {
    const start = m.index + m[0].length, tag = /<div\b|<\/div>/gi;
    tag.lastIndex = start;
    let depth = 1, t: RegExpExecArray | null, end = -1;
    while ((t = tag.exec(content))) { depth += t[0].toLowerCase() === '</div>' ? -1 : 1; if (!depth) { end = t.index; break; } }
    if (end < 0) break;
    const inner = content.slice(start, end), raw = /[<>]/.test(inner), text = raw ? inner : decode(inner), safe = guard(text);
    out += content.slice(pos, start) + (raw || safe !== text ? encode(safe) : inner);
    pos = end; open.lastIndex = end;
  }
  return out + content.slice(pos);
}
