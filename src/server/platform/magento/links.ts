import 'server-only';
// Magento: check internal links in texts and pages (draft, publish, shop check). Targets are resolved via the public
// GraphQL (route): not found = broken, product disabled or not individually visible, category inactive,
// redirect (301/302) = better to link directly to the new URL. Reads only via the protected read client.
import type { LinkFinding, LinkRef, LinkReport } from '../../seo-links';
import { isActive } from './map';
import { relPath } from './lookup';
import type { MagentoReader } from './reader';

/** Paths that are not pages (assets, media, cart, account) */
const NOT_PAGE = /^(static|media|pub|checkout|customer|wishlist|sales|newsletter|contact|search|catalogsearch|review|rest|graphql)(\/|$)/i;
const MAX_LINKS = 200;

export interface MagentoLinkCheck { report: LinkReport; checked: number }

/** Classification of an href: internal (path relative to the shop base), external, anchor/other, invalid */
export function classifyHref(href: string, bases: string[]): { type: 'internal'; path: string } | { type: 'external' | 'other' | 'invalid' } {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(mailto|tel|sms):/i.test(h)) return { type: 'other' };
  if (/^(javascript|data|vbscript):/i.test(h)) return { type: 'invalid' };
  if (/^\{\{/.test(h)) return { type: 'other' }; // Magento directive ({{store url=…}}): Magento resolves the target only on output
  if (/^https?:\/\//i.test(h)) { const p = relPath(h, bases); return p == null ? { type: 'external' } : { type: 'internal', path: p.replace(/[?#].*$/, '') }; }
  if (h.startsWith('//')) return { type: 'external' };
  if (h.startsWith('/')) return { type: 'internal', path: h.replace(/^\/+/, '').replace(/[?#].*$/, '') };
  return { type: 'other' }; // do not check relative paths without / (rare)
}

/** Resolution cache per path; shared across many calls (shop check) so the same path is resolved only once */
export type LinkCache = Map<string, Promise<string | null>>;

export async function checkMagentoLinks(ro: MagentoReader, links: LinkRef[], cache?: LinkCache): Promise<MagentoLinkCheck> {
  const bases = [await ro.storefrontBase().catch(() => ''), ro.publicUrl, ro.base].filter(Boolean);
  const findings: LinkFinding[] = [], rewrites = new Map<string, string>(), seen = cache ?? new Map<string, Promise<string | null>>();
  let internal = 0, external = 0, checked = 0;
  // Problem of a path (null = OK), resolve each path only once
  const problem = (path: string): Promise<string | null> => {
    if (!seen.has(path)) seen.set(path, (async () => {
      const r = await ro.resolveUrl(path);
      if (!r) return 'Ziel nicht gefunden (Seite existiert nicht oder ist deaktiviert)';
      if (r.redirect_code && r.relative_url && r.relative_url.replace(/^\/+/, '') !== path) return `Weiterleitung (${r.redirect_code}) auf /${r.relative_url.replace(/^\/+/, '')}`;
      if (r.type === 'PRODUCT' && r.sku) { const p = await ro.product(r.sku).catch(() => null); if (!p) return 'Produkt nicht gefunden'; if (!isActive(p)) return 'Produkt ist deaktiviert'; if (Number(p.visibility) === 1) return 'Produkt ist nicht einzeln sichtbar'; }
      if (r.type === 'CATEGORY' && r.id != null) { const c = await ro.category(r.id).catch(() => null); if (!c) return 'Kategorie nicht gefunden'; if (!c.is_active) return 'Kategorie ist inaktiv'; }
      return null;
    })().catch(() => null)); // resolution not possible (area blocked or similar): do not report as broken
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
