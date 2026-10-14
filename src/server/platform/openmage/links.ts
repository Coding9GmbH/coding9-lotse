import 'server-only';
// OpenMage: check internal links in texts and pages (draft, publish, shop check). Targets are resolved via the URL rewrites
// of the store view and the CMS pages: not found = broken, product disabled or not individually visible,
// category inactive, redirect (301/302) = better link directly to the new URL. Reads only via the guarded read client.
import type { LinkFinding, LinkRef, LinkReport } from '../../seo-links';
import { relPath } from '../magento/lookup';
import { isActive, isVisible } from './map';
import type { OmReader } from './reader';

/** Paths that are not pages (assets, media, cart, account) */
const NOT_PAGE = /^(skin|js|media|checkout|customer|wishlist|sales|newsletter|contacts?|catalogsearch|review|api|lotse-api|index\.php\/admin|admin)(\/|$)/i;
const MAX_LINKS = 200;

export interface OmLinkCheck { report: LinkReport; checked: number }

/** Classification of an href: internal (path relative to the shop base), external, anchor/other, invalid */
export function classifyHref(href: string, bases: string[]): { type: 'internal'; path: string } | { type: 'external' | 'other' | 'invalid' } {
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(mailto|tel|sms):/i.test(h)) return { type: 'other' };
  if (/^(javascript|data|vbscript):/i.test(h)) return { type: 'invalid' };
  if (/^\{\{/.test(h)) return { type: 'other' }; // directive ({{store url=…}}): OpenMage only resolves the target when rendering
  if (/^https?:\/\//i.test(h)) { const p = relPath(h, bases); return p == null ? { type: 'external' } : { type: 'internal', path: p.replace(/[?#].*$/, '').replace(/^index\.php\/?/, '') }; }
  if (h.startsWith('//')) return { type: 'external' };
  if (h.startsWith('/')) return { type: 'internal', path: h.replace(/^\/+/, '').replace(/[?#].*$/, '').replace(/^index\.php\/?/, '') };
  return { type: 'other' };
}

/** Resolutions per path (problem text or null); shareable across calls, e.g. in the shop check per read client */
export type OmLinkCache = Map<string, Promise<string | null>>;

export async function checkOmLinks(ro: OmReader, links: LinkRef[], seen: OmLinkCache = new Map()): Promise<OmLinkCheck> {
  const bases = [await ro.storefrontBase().catch(() => ''), ro.publicUrl, ro.base].filter(Boolean);
  const findings: LinkFinding[] = [], rewrites = new Map<string, string>();
  let internal = 0, external = 0, checked = 0;
  const problem = (path: string): Promise<string | null> => {
    if (!seen.has(path)) seen.set(path, (async () => {
      const r = await ro.resolveUrl(path);
      if (!r) return 'Ziel nicht gefunden (Seite existiert nicht oder ist deaktiviert)';
      if (r.redirect_code && r.relative_url && r.relative_url.replace(/^\/+/, '') !== path) return `Weiterleitung (${r.redirect_code}) auf /${r.relative_url.replace(/^\/+/, '')}`;
      if (r.type === 'REDIRECT') return 'Weiterleitung ohne erreichbares Ziel';
      if (r.type === 'PRODUCT' && r.id != null) { const p = await ro.productById(r.id).catch(() => null); if (!p) return 'Produkt nicht gefunden'; if (!isActive(p)) return 'Produkt ist deaktiviert'; if (!isVisible(p)) return 'Produkt ist nicht einzeln sichtbar'; }
      if (r.type === 'CATEGORY' && r.id != null) { const c = await ro.category(r.id).catch(() => null); if (!c) return 'Kategorie nicht gefunden'; if (!c.is_active) return 'Kategorie ist inaktiv'; }
      return null;
    })().catch(() => null)); // resolution not possible (scope blocked or similar): do not report as broken
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
    const redirect = /^Weiterleitung \(/.test(p);
    findings.push({ href: l.href, text: l.text, level: redirect ? 'empfohlen' : 'wichtig', problem: redirect ? `${p}, besser direkt auf das Ziel verlinken` : p });
    if (redirect) { const to = p.match(/auf (\/\S+)/)?.[1]; if (to) rewrites.set(l.href, /^https?:/i.test(l.href) ? `${bases[0] || ro.publicUrl}${to}` : to); }
  }
  return { report: { ctx: null, internal, external, findings, rewrites }, checked };
}
