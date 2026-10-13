// Entwurf auf der echten Seite: das HTML der Shop-Seite (Kopf, Fuß, Theme, Kaufbox, Produktliste) bleibt, nur der CMS-Inhalt
// (.cms-sections) wird durch den Entwurf ersetzt. Rein (kein Netz): Teile finden, Skripte entfernen, einsetzen. Shopware-Markup.

const external = (url: string) => /^(?:https?:)?\/\//i.test(url.trim());
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?([^"'\\s>]+)`, 'i'))?.[1];

/**
 * Skripte des Shops bleiben (Menü, Slider, Galerie laufen in der isolierten Vorschau), Skripte und Vorladehinweise fremder Domains
 * (Tracking, Consent-Dienste) und Kommentare werden entfernt. Die Shop-URL ist vorher auf /shop umgeschrieben, Shop-Skripte sind also relativ.
 */
export function stripScripts(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (m, attrs: string) => { const src = attr(attrs, 'src'); return src && external(src) ? '' : m; })
    .replace(/<link\b[^>]*\brel=["']?(?:modulepreload|preload|prefetch)["']?[^>]*>/gi, m => { const href = attr(m, 'href'); return href && external(href) ? '' : m; });
}

const openDiv = () => /<div\b[^>]*>/gi; // je Aufruf eine eigene Instanz: ineinander verschachtelte Suchen teilen sonst lastIndex
const hasClass = (attrs: string, cls: string) => {
  const m = attrs.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  return !!m && (m[1] ?? m[2]).split(/\s+/).includes(cls);
};

/** Index hinter dem </div>, das das <div> schließt, dessen Start-Tag bei openEnd endet (verschachtelte divs gezählt); null = schließt nicht */
function divEnd(html: string, openEnd: number): number | null {
  const tag = /<(\/?)div\b[^>]*>/gi;
  tag.lastIndex = openEnd;
  let depth = 1;
  for (let t: RegExpExecArray | null; (t = tag.exec(html)); ) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return t.index + t[0].length;
  }
  return null;
}

/** Erstes <div> mit der Klasse; end = Index hinter dem passenden </div> (verschachtelte divs gezählt). null, wenn es fehlt oder nicht schließt. */
export function findDivByClass(html: string, cls: string): { start: number; openEnd: number; end: number } | null {
  const re = openDiv();
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    if (!hasClass(m[0], cls)) continue;
    const start = m.index, openEnd = start + m[0].length, end = divEnd(html, openEnd);
    return end == null ? null : { start, openEnd, end };
  }
  return null;
}

/** Inhalt von .cms-sections durch sectionsHtml ersetzen. null, wenn die Seite keinen CMS-Bereich hat (anderes Theme, Fehlerseite). */
export function spliceSections(html: string, sectionsHtml: string): string | null {
  const el = findDivByClass(html, 'cms-sections');
  if (!el) return null;
  const closeLen = '</div>'.length;
  return html.slice(0, el.openEnd) + sectionsHtml + html.slice(el.end - closeLen);
}

/** Erster CMS-Block (<div class="cms-block …">), dessen Markup das Muster enthält; für Themes mit eigenen Blocktypen */
function findBlockContaining(html: string, marker: RegExp): { start: number; end: number } | null {
  const re = openDiv();
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    if (!hasClass(m[0], 'cms-block')) continue;
    const end = divEnd(html, m.index + m[0].length);
    if (end != null && marker.test(html.slice(m.index, end))) return { start: m.index, end };
  }
  return null;
}

/** Dynamische Blöcke des Entwurfs → mögliche CMS-Blocktypen der echten Seite (Standard zuerst, dann gängige Theme-Varianten) */
export const REAL_BLOCK_TYPES: Record<string, string[]> = {
  'pdp-heading': ['product-heading'],
  'pdp-gallery-buybox': ['gallery-buybox', 'zen-gallery-heading-buybox', 'zen-gallery-buybox'],
  'pdp-description-reviews': ['product-description-reviews'],
  'pdp-cross-selling': ['cross-selling'],
  'product-listing': ['product-listing'],
  'sidebar-filter': ['sidebar-filter'],
};
/** Erkennung über das Markup, falls das Theme eigene Blocktypen nutzt (Kaufbox: Standard-Klassen des Storefront-Themes) */
const REAL_BLOCK_MARKERS: Record<string, RegExp> = { 'pdp-gallery-buybox': /product-detail-buy(?:-container|\b)|product-detail-buybox|buy-widget/ };

/**
 * Echte Blöcke der Seite je Blocktyp des Entwurfs (z. B. die Kaufbox). Fasst ein Theme Überschrift und Kaufbox in einem Block zusammen,
 * ersetzt dieser die Kaufbox und die Überschrift des Entwurfs entfällt (leerer Eintrag), damit nichts doppelt erscheint.
 */
export function extractBlocks(html: string, byType: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ours, types] of Object.entries(byType)) {
    let hit: { start: number; end: number } | null = null, used = '';
    for (const t of types) { const el = findDivByClass(html, `cms-block-${t}`); if (el) { hit = el; used = t; break; } }
    if (!hit && REAL_BLOCK_MARKERS[ours]) { hit = findBlockContaining(html, REAL_BLOCK_MARKERS[ours]); used = 'marker'; }
    if (hit) out[ours] = html.slice(hit.start, hit.end);
    if (hit && ours === 'pdp-gallery-buybox' && /heading/.test(used) && !('pdp-heading' in out)) out['pdp-heading'] = '';
  }
  return out;
}

/** Eigene Styles und Rahmen-Skript vor </head> einsetzen (ohne <head>: an den Anfang) */
export function injectIntoHead(html: string, headExtra: string): string {
  return /<\/head\s*>/i.test(html) ? html.replace(/<\/head\s*>/i, () => `${headExtra}</head>`) : headExtra + html; // Funktion: kein $-Muster im Skript auswerten
}
