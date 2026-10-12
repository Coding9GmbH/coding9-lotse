// Magento Page Builder: Inhalte im Speicherformat von Page Builder (Mage-OS/Magento 2.4), damit Seiten, CMS-Blöcke und
// Produktbeschreibungen im Admin mit Page Builder bearbeitbar bleiben (rein → testbar).
// Aufbau: eine Zeile (row, „contained“) mit Inhaltstypen: html (freies HTML, im Speicher HTML-kodiert, Magento dekodiert es
// beim Ausgeben), products (Widget „Catalog Products List“: Preise, Bestand, Warenkorb live aus Magento) und block (CMS-Block-Widget).

/** HTML-kodieren wie Page Builder den html-Inhaltstyp speichert (Knockout text-Bindung) */
const encode = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
/**
 * Magento wertet „{{…}}“ in Inhalten als Direktive aus (Variablen, Widgets), auch im kodierten HTML. Freies HTML darf
 * deshalb keine „{{“ enthalten: „{ {“ ist in CSS und JS gleichwertig und im Text kaum sichtbar.
 */
export const noDirectives = (html: string) => html.replace(/\{\{/g, '{ {');

export type PbPart = { kind: 'html'; html: string; /** Direktiven schon geprüft (nicht entschärfen) */ checked?: boolean } | { kind: 'products'; skus: string[] } | { kind: 'block'; blockId: number };

export const PB_ROW_OPEN = '<div data-content-type="row" data-appearance="contained" data-element="main"><div data-enable-parallax="0" data-parallax-speed="0.5" data-background-images="{}" data-background-type="image" data-video-loop="true" data-video-play-only-visible="true" data-video-lazy-load="true" data-video-fallback-src="" data-element="inner" style="justify-content: flex-start; display: flex; flex-direction: column; background-position: left top; background-size: cover; background-repeat: no-repeat; background-attachment: scroll; border-style: none; border-width: 1px; border-radius: 0px; margin: 0px 0px 10px; padding: 10px;">';
const ROW_CLOSE = '</div></div>';

const attrs = (a: Record<string, string | number>) => Object.entries(a).map(([k, v]) => `${k}="${String(v).replace(/"/g, '&quot;')}"`).join(' ');
/** Kodierung der Widget-Parameter wie Page Builder (Klammern, Anführungszeichen und Backslashes ersetzt) */
const wysiwyg = (s: string) => s.replace(/\{/g, '^[').replace(/\}/g, '^]').replace(/"/g, '`').replace(/\\/g, '|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Widget „Catalog Products List“ mit fester SKU-Liste (Reihenfolge wie angegeben) */
export function productsWidget(skus: string[]): string {
  const list = skus.map(s => s.replace(/[,{}"\\]/g, '').trim()).filter(Boolean).join(', ');
  const cond = JSON.stringify({ 1: { aggregator: 'all', new_child: '', type: 'Magento\\CatalogWidget\\Model\\Rule\\Condition\\Combine', value: '1' }, '1--1': { operator: '()', type: 'Magento\\CatalogWidget\\Model\\Rule\\Condition\\Product', attribute: 'sku', value: list } });
  return `{{widget ${attrs({ type: 'Magento\\CatalogWidget\\Block\\Product\\ProductsList', template: 'Magento_CatalogWidget::product/widget/content/grid.phtml', anchor_text: '', id_path: '', show_pager: 0, products_count: Math.max(1, skus.length), condition_option: 'sku', condition_option_value: wysiwyg(list), type_name: 'Catalog Products List', conditions_encoded: wysiwyg(cond), sort_order: 'position_by_sku' })}}}`;
}
/** Widget „CMS Static Block“ */
export const blockWidget = (blockId: number) => `{{widget ${attrs({ type: 'Magento\\Cms\\Block\\Widget\\Block', template: 'widget/static_block/default.phtml', block_id: blockId, type_name: 'CMS Static Block' })}}}`;

export function pbPart(p: PbPart): string {
  if (p.kind === 'html') return `<div data-content-type="html" data-appearance="default" data-element="main">${encode(p.checked ? p.html : noDirectives(p.html))}</div>`;
  if (p.kind === 'products') return `<div data-content-type="products" data-appearance="grid" data-element="main">${productsWidget(p.skus)}</div>`;
  return `<div data-content-type="block" data-appearance="default" data-element="main">${blockWidget(p.blockId)}</div>`;
}
/** Teile → Page-Builder-Inhalt (eine Zeile) */
export const toPageBuilder = (parts: PbPart[]) => PB_ROW_OPEN + parts.map(pbPart).join('') + ROW_CLOSE;

/** Ist der Text Page-Builder-Inhalt? (Magento zeigt sonst den WYSIWYG-Editor) */
export const isPageBuilder = (html: string | null | undefined) => /data-content-type="/.test(String(html ?? ''));

/**
 * Hängt einen Teil an vorhandenen Inhalt an (z. B. CMS-Block-Widget unter die Produktbeschreibung): Page-Builder-Inhalt
 * bekommt eine neue Zeile, anderer Inhalt (klassisches HTML) wird als html-Inhaltstyp in dieselbe Zeile übernommen.
 */
export function appendPart(existing: string | null | undefined, part: PbPart): string {
  const cur = String(existing ?? '');
  if (!cur.trim()) return toPageBuilder([part]);
  if (isPageBuilder(cur)) return cur + toPageBuilder([part]);
  return toPageBuilder([{ kind: 'html', html: cur }, part]);
}

/** Inhalt eines html-Inhaltstyps wieder lesbar machen (für Prüfungen, z. B. Links in Seiten) */
export function readableHtml(content: string | null | undefined): string {
  return String(content ?? '').replace(/(<div[^>]*data-content-type="html"[^>]*>)([\s\S]*?)(<\/div>)/g, (_, a: string, inner: string, c: string) => (/[<>]/.test(inner) ? a + inner + c : a + decode(inner) + c));
}

/**
 * Gegenstück zu readableHtml: html-Inhaltstypen mit rohem HTML wieder so kodieren, wie Page Builder sie speichert
 * (verschachtelte divs werden gezählt). guard prüft den lesbaren Inhalt (z. B. Direktiven); unveränderte, schon kodierte Inhalte bleiben wörtlich.
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
