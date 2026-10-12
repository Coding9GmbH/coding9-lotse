import 'server-only';
// Magento: interne Links in Texten und Seiten prüfen (Entwurf, Veröffentlichen, Shop-Check). Ziele werden über das öffentliche
// GraphQL (route) aufgelöst: nicht gefunden = kaputt, Produkt deaktiviert oder nicht einzeln sichtbar, Kategorie inaktiv,
// Weiterleitung (301/302) = besser direkt auf die neue URL verlinken. Liest nur über den geschützten Lese-Client.
import type { LinkFinding, LinkRef, LinkReport } from '../../seo-links';
import { isActive } from './map';
import { relPath } from './lookup';
import type { MagentoReader } from './reader';

/** Pfade, die keine Seiten sind (Assets, Medien, Warenkorb, Konto) */
const NOT_PAGE = /^(static|media|pub|checkout|customer|wishlist|sales|newsletter|contact|search|catalogsearch|review|rest|graphql)(\/|$)/i;
const MAX_LINKS = 200;

export interface MagentoLinkCheck { report: LinkReport; checked: number }

/** Einordnung eines href: intern (Pfad relativ zur Shop-Basis), extern, Anker/sonstiges, ungültig */
export function classifyHref(href: string, bases: string[]): { type: 'internal'; path: string } | { type: 'external' | 'other' | 'invalid' } {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(mailto|tel|sms):/i.test(h)) return { type: 'other' };
  if (/^(javascript|data|vbscript):/i.test(h)) return { type: 'invalid' };
  if (/^\{\{/.test(h)) return { type: 'other' }; // Magento-Direktive ({{store url=…}}) – Ziel ergibt Magento erst beim Ausgeben
  if (/^https?:\/\//i.test(h)) { const p = relPath(h, bases); return p == null ? { type: 'external' } : { type: 'internal', path: p.replace(/[?#].*$/, '') }; }
  if (h.startsWith('//')) return { type: 'external' };
  if (h.startsWith('/')) return { type: 'internal', path: h.replace(/^\/+/, '').replace(/[?#].*$/, '') };
  return { type: 'other' }; // relative Pfade ohne / (selten) nicht prüfen
}

/** Auflösungs-Cache je Pfad; über viele Aufrufe geteilt (Shop-Check), damit derselbe Pfad nur einmal aufgelöst wird */
export type LinkCache = Map<string, Promise<string | null>>;

export async function checkMagentoLinks(ro: MagentoReader, links: LinkRef[], cache?: LinkCache): Promise<MagentoLinkCheck> {
  const bases = [await ro.storefrontBase().catch(() => ''), ro.publicUrl, ro.base].filter(Boolean);
  const findings: LinkFinding[] = [], rewrites = new Map<string, string>(), seen = cache ?? new Map<string, Promise<string | null>>();
  let internal = 0, external = 0, checked = 0;
  // Problem eines Pfads (null = in Ordnung), je Pfad nur einmal auflösen
  const problem = (path: string): Promise<string | null> => {
    if (!seen.has(path)) seen.set(path, (async () => {
      const r = await ro.resolveUrl(path);
      if (!r) return 'Ziel nicht gefunden (Seite existiert nicht oder ist deaktiviert)';
      if (r.redirect_code && r.relative_url && r.relative_url.replace(/^\/+/, '') !== path) return `Weiterleitung (${r.redirect_code}) auf /${r.relative_url.replace(/^\/+/, '')}`;
      if (r.type === 'PRODUCT' && r.sku) { const p = await ro.product(r.sku).catch(() => null); if (!p) return 'Produkt nicht gefunden'; if (!isActive(p)) return 'Produkt ist deaktiviert'; if (Number(p.visibility) === 1) return 'Produkt ist nicht einzeln sichtbar'; }
      if (r.type === 'CATEGORY' && r.id != null) { const c = await ro.category(r.id).catch(() => null); if (!c) return 'Kategorie nicht gefunden'; if (!c.is_active) return 'Kategorie ist inaktiv'; }
      return null;
    })().catch(() => null)); // Auflösung nicht möglich (Bereich gesperrt o. Ä.): nicht als kaputt melden
    return seen.get(path)!;
  };
  for (const l of links) {
    const c = classifyHref(l.href, bases);
    if (c.type === 'external') { external++; continue; }
    if (c.type === 'invalid') { findings.push({ href: l.href, text: l.text, level: 'wichtig', problem: 'Ungültiger Link (javascript:/data:)' }); continue; }
    if (c.type !== 'internal') continue;
    internal++;
    if (!c.path || NOT_PAGE.test(c.path) || checked >= MAX_LINKS) continue;
    checked++;
    const p = await problem(c.path);
    if (!p) continue;
    const redirect = /^Weiterleitung/.test(p);
    findings.push({ href: l.href, text: l.text, level: redirect ? 'empfohlen' : 'wichtig', problem: redirect ? `${p}, besser direkt auf das Ziel verlinken` : p });
    if (redirect) { const to = p.match(/auf (\/\S+)/)?.[1]; if (to) rewrites.set(l.href, /^https?:/i.test(l.href) ? `${bases[0] || ro.publicUrl}${to}` : to); }
  }
  return { report: { ctx: null, internal, external, findings, rewrites }, checked };
}
