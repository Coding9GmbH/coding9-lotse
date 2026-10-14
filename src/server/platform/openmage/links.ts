import 'server-only';
// OpenMage: check internal links in texts and pages (draft, publish, shop check). Targets are resolved via the URL rewrites
// of the store view and the CMS pages: not found = broken, product disabled or not individually visible,
// category inactive, redirect (301/302) = better link directly to the new URL. Reads only via the guarded read client.
import type { LinkRef } from '../../seo-links';
import { checkLinksWith, classifyHref as classifyWith, type LinkCache, type MagentoLinkCheck } from '../magento/links';
import { isActive, isVisible } from './map';
import type { OmReader } from './reader';

/** Paths that are not pages (assets, media, cart, account) */
const NOT_PAGE = /^(skin|js|media|checkout|customer|wishlist|sales|newsletter|contacts?|catalogsearch|review|api|lotse-api|index\.php\/admin|admin)(\/|$)/i;
const stripIndex = (p: string) => p.replace(/^index\.php\/?/, '');

export type OmLinkCheck = MagentoLinkCheck;

/** Classification of an href: internal (path relative to the shop base, without index.php/), external, anchor/other, invalid */
export const classifyHref = (href: string, bases: string[]) => classifyWith(href, bases, stripIndex);

/** Resolutions per path (problem text or null); shareable across calls, e.g. in the shop check per read client */
export type OmLinkCache = LinkCache;

export function checkOmLinks(ro: OmReader, links: LinkRef[], seen: OmLinkCache = new Map()): Promise<OmLinkCheck> {
  return checkLinksWith(ro, links, seen, { notPage: NOT_PAGE, normPath: stripIndex, problem: async path => {
    const r = await ro.resolveUrl(path);
    if (!r) return 'Ziel nicht gefunden (Seite existiert nicht oder ist deaktiviert)';
    if (r.redirect_code && r.relative_url && r.relative_url.replace(/^\/+/, '') !== path) return `Weiterleitung (${r.redirect_code}) auf /${r.relative_url.replace(/^\/+/, '')}`;
    if (r.type === 'REDIRECT') return 'Weiterleitung ohne erreichbares Ziel';
    if (r.type === 'PRODUCT' && r.id != null) { const p = await ro.productById(r.id).catch(() => null); if (!p) return 'Produkt nicht gefunden'; if (!isActive(p)) return 'Produkt ist deaktiviert'; if (!isVisible(p)) return 'Produkt ist nicht einzeln sichtbar'; }
    if (r.type === 'CATEGORY' && r.id != null) { const c = await ro.category(r.id).catch(() => null); if (!c) return 'Kategorie nicht gefunden'; if (!c.is_active) return 'Kategorie ist inaktiv'; }
    return null;
  } });
}
