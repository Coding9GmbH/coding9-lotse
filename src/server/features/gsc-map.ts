import 'server-only';
// Search Console ↔ Shop: Seiten-URLs auf Produkte/Kategorien/Landingpages abbilden (über SEO-URLs) und umgekehrt die URL-Pfade einer Entität.
import { canonicalSeoPaths, ROUTE, ROUTE_KIND, type LinkKind } from '../seo-links';
import type { ShopReader, SwEntity } from '../shopware';

export interface PageRef { kind: LinkKind | 'home'; id?: string; name?: string; number?: string; active?: boolean; salesChannel?: string; metaTitle?: string | null; metaDescription?: string | null }
export const ENTITY: Record<LinkKind, 'product' | 'category' | 'landing-page'> = { product: 'product', category: 'category', landing: 'landing-page' };
const TECH = /^(detail|navigation|landingPage)\/([0-9a-f]{32})\/?$/i;
const TECH_KIND: Record<string, LinkKind> = { detail: 'product', navigation: 'category', landingpage: 'landing' };
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
const httpDomains = (scs: SwEntity[]) => scs.flatMap(sc => (sc.domains ?? []).filter((d: SwEntity) => /^https?:\/\//.test(String(d.url))).map((d: SwEntity) => ({ sc, d, url: String(d.url).replace(/\/+$/, '') })));
const prefixOf = (u: string) => { try { return new URL(u).pathname.replace(/\/+$/, ''); } catch { return ''; } };

/** Pfad-Kandidaten einer Seiten-URL: voller Pfad und ohne Sprach-/Domain-Präfix (z. B. /en) */
export function pathCandidates(url: string, prefixes: string[]): string[] {
  let p: string; try { p = dec(new URL(url).pathname); } catch { return []; }
  const out = [p.replace(/^\/+/, '')];
  for (const pre of prefixes) if (pre && (p === pre || p.startsWith(pre + '/'))) out.push(p.slice(pre.length).replace(/^\/+/, ''));
  return [...new Set(out)];
}

/** Seiten-URLs (aus GSC) → Shop-Entität mit Name und aktuellen Metas. Nicht zuordenbar = null. */
export async function mapUrls(ro: ShopReader, urls: string[], o: { metas?: boolean } = {}): Promise<Map<string, PageRef | null>> {
  const out = new Map<string, PageRef | null>(); if (!urls.length) return out;
  const doms = httpDomains(await ro.salesChannels()), prefixes = [...new Set(doms.map(x => prefixOf(x.url)).filter(Boolean))];
  const cand = new Map(urls.map(u => [u, pathCandidates(u, prefixes)]));
  const paths = [...new Set([...cand.values()].flat().filter(p => p && !TECH.test(p)).flatMap(p => [p.replace(/\/+$/, ''), p.replace(/\/+$/, '') + '/']))];
  const hits = new Map<string, SwEntity>();
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    const r = await ro.search('seo-url', { limit: chunk.length * 4, filter: [{ type: 'equalsAny', field: 'seoPathInfo', value: chunk }, { type: 'equals', field: 'isDeleted', value: false }] });
    for (const s of r.data) { const k = String(s.seoPathInfo).replace(/\/+$/, '').toLowerCase(), cur = hits.get(k); if (ROUTE_KIND[s.routeName] && (!cur || (s.isCanonical && !cur.isCanonical))) hits.set(k, s); }
  }
  const refs = new Map<string, { kind: LinkKind; id: string; scId?: string } | 'home'>();
  for (const [u, cs] of cand) {
    let ref: { kind: LinkKind; id: string; scId?: string } | 'home' | undefined;
    for (const c of cs) {
      const t = c.match(TECH); if (t) { ref = { kind: TECH_KIND[t[1].toLowerCase()], id: t[2].toLowerCase() }; break; }
      if (!c.replace(/\/+$/, '')) { ref = 'home'; break; }
      const s = hits.get(c.replace(/\/+$/, '').toLowerCase()); if (s) { ref = { kind: ROUTE_KIND[s.routeName], id: s.foreignKey, scId: s.salesChannelId }; break; }
    }
    if (ref) refs.set(u, ref);
  }
  const ents = new Map<string, SwEntity>();
  for (const kind of ['product', 'category', 'landing'] as LinkKind[]) {
    const ids = [...new Set([...refs.values()].flatMap(r => (r !== 'home' && r.kind === kind ? [r.id] : [])))];
    for (let i = 0; i < ids.length; i += 200) { const chunk = ids.slice(i, i + 200); for (const e of (await ro.search(ENTITY[kind], { ids: chunk, limit: chunk.length })).data) ents.set(`${kind}:${e.id}`, e); }
  }
  // Varianten ohne eigenen Namen: Name des Hauptprodukts
  const parents = [...new Set([...ents.values()].filter(e => e.parentId && !(e.translated?.name ?? e.name)).map(e => e.parentId as string))];
  const par = parents.length ? new Map((await ro.search('product', { ids: parents, limit: parents.length })).data.map(p => [p.id, p])) : new Map<string, SwEntity>();
  const scName = new Map(doms.map(x => [x.sc.id, x.sc.translated?.name ?? x.sc.name]));
  for (const u of urls) {
    const r = refs.get(u);
    if (!r) { out.set(u, null); continue; }
    if (r === 'home') { out.set(u, { kind: 'home', name: 'Startseite' }); continue; }
    const e = ents.get(`${r.kind}:${r.id}`);
    if (!e) { out.set(u, null); continue; }
    const p = e.parentId ? par.get(e.parentId) : undefined;
    out.set(u, { kind: r.kind, id: r.id, name: e.translated?.name ?? e.name ?? p?.translated?.name ?? p?.name, ...(e.productNumber ? { number: e.productNumber } : {}), active: e.active !== false,
      ...(r.scId && scName.get(r.scId) ? { salesChannel: scName.get(r.scId) } : {}),
      ...(o.metas ? { metaTitle: e.translated?.metaTitle ?? e.metaTitle ?? null, metaDescription: e.translated?.metaDescription ?? e.metaDescription ?? null } : {}) });
  }
  return out;
}

/** URL-Pfade einer Entität über alle Storefront-Domains (kanonische SEO-URL + technischer Pfad), relativ ohne führenden Slash, inkl. Domain-Präfix. */
export async function entityPaths(ro: ShopReader, kind: LinkKind, id: string): Promise<{ paths: string[]; urls: string[] }> {
  const doms = httpDomains(await ro.salesChannels()), paths = new Set<string>(), urls = new Set<string>();
  const tech = { product: 'detail', category: 'navigation', landing: 'landingPage' }[kind];
  for (const { sc, d, url } of doms) {
    const pre = prefixOf(url).replace(/^\/+/, ''), join = (p: string) => (pre ? `${pre}/${p}` : p);
    const seo = await canonicalSeoPaths(ro, { salesChannelId: sc.id, languageId: d.languageId }, [{ kind, id }]).catch(() => new Map<string, SwEntity>());
    const s = seo.get(`${ROUTE[kind]}:${id}`)?.seoPathInfo as string | undefined;
    if (s) { paths.add(join(s)); urls.add(`${url}/${s}`); }
    paths.add(join(`${tech}/${id}`));
  }
  return { paths: [...paths], urls: [...urls] };
}
