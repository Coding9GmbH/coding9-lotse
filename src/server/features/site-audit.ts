import 'server-only';
// Technical check of the live pages: reads the home page, one category and one product page of the own shop plus robots.txt and
// sitemap, and checks what search engines see (noindex, canonical, title/description, H1, structured data, mobile, language).
// Platform-neutral via the adapter's storefront.base/fetch, read-only. Complements the Sistrix crawl and also works without Sistrix.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CheckSeverity } from '@/lib/protocol';
import type { ShopLookup } from '../platform/types';
import { getPlatform } from '../platform';
import { ok, guard, type AnyTool } from '../tool-kit';
import type { Fetcher } from '../styleguide';
import type { Feature } from './types';

const TIMEOUT_MS = 15_000, MAX_BYTES = 3_000_000, MAX_HOPS = 3;
export type PageKind = 'home' | 'category' | 'product';
export interface Fetched { url: string; status: number; body: string; headers: Record<string, string> }
export interface PageAudit {
  kind: PageKind; url: string; status: number; noindex: boolean;
  title: string; description: string; canonical: string | null; canonicalSelf: boolean | null;
  h1: number; schema: string[]; viewport: boolean; lang: string | null;
}

// ---- Evaluation (pure) ----
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))?.slice(2).find(v => v !== undefined) ?? null;
/** <meta name|property="…" content="…"> in any attribute order */
function meta(html: string, key: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if ((attr(m[0], 'name') ?? attr(m[0], 'property'))?.toLowerCase() === key) return attr(m[0], 'content');
  return null;
}
/** Page URL without parameters, anchor, www. and trailing slash: this is how search engines compare canonical and page */
export const sameUrl = (a: string, b: string) => {
  const n = (u: string) => { try { const x = new URL(u); return `${x.host.replace(/^www\./, '').toLowerCase()}${decodeURI(x.pathname).replace(/\/+$/, '')}`; } catch { return u; } };
  return n(a) === n(b);
};

/** Structured data types: JSON-LD (incl. @graph, lists) and microdata (itemtype) */
export function schemaTypes(html: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>, t = o['@type'];
    for (const x of Array.isArray(t) ? t : [t]) if (typeof x === 'string') out.add(x.replace(/^.*[/#]/, ''));
    for (const [k, x] of Object.entries(o)) if (k !== '@context' && typeof x === 'object') walk(x);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1].trim())); } catch { /* broken JSON-LD does not count */ } }
  for (const m of html.matchAll(/\sitemtype\s*=\s*["']([^"']+)["']/gi)) for (const t of m[1].split(/\s+/)) out.add(t.replace(/^.*[/#]/, ''));
  return [...out];
}

export function auditPage(p: Fetched, kind: PageKind): PageAudit {
  const html = p.body, head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html;
  const robots = `${meta(head, 'robots') ?? ''} ${meta(head, 'googlebot') ?? ''} ${p.headers['x-robots-tag'] ?? ''}`.toLowerCase();
  const canonTag = [...head.matchAll(/<link\b[^>]*>/gi)].map(m => m[0]).find(t => (attr(t, 'rel') ?? '').toLowerCase().split(/\s+/).includes('canonical'));
  const canonRaw = canonTag ? attr(canonTag, 'href') : null;
  let canonical: string | null = null; try { canonical = canonRaw ? new URL(decode(canonRaw), p.url).href : null; } catch { canonical = canonRaw; }
  const body = html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ');
  return {
    kind, url: p.url, status: p.status, noindex: /\bnoindex\b|\bnone\b/.test(robots),
    title: decode(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''), description: decode(meta(head, 'description') ?? ''),
    canonical, canonicalSelf: canonical ? sameUrl(canonical, p.url) : null,
    h1: (body.match(/<h1\b/gi) ?? []).length, schema: schemaTypes(html),
    viewport: !!meta(head, 'viewport'), lang: attr(html.match(/<html\b[^>]*>/i)?.[0] ?? '', 'lang'),
  };
}

/** robots.txt: does "User-agent: *" block the whole site? Which sitemaps are listed? */
export function parseRobots(text: string): { blocksAll: boolean; sitemaps: string[] } {
  const sitemaps: string[] = []; let agents: string[] = [], inRules = false, blocksAll = false, allowAll = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) continue;
    const [k, ...rest] = line.split(':'), key = k.trim().toLowerCase(), val = rest.join(':').trim();
    if (key === 'sitemap') { if (val) sitemaps.push(val); continue; }
    if (key === 'user-agent') { if (inRules) { agents = []; inRules = false; } agents.push(val.toLowerCase()); continue; }
    inRules = true;
    if (!agents.includes('*')) continue;
    if (key === 'disallow' && val === '/') blocksAll = true;
    if (key === 'allow' && val === '/') allowAll = true;
  }
  return { blocksAll: blocksAll && !allowAll, sitemaps };
}

export interface SiteFinding { id: string; severity: CheckSeverity; title: string; detail: string; urls: string[]; fix: string }
export interface SiteInput { base: string; platform: string; pages: PageAudit[]; robots: Fetched | null; sitemap: { url: string; status: number } | null }
const KIND: Record<PageKind, string> = { home: 'Startseite', category: 'Kategorie', product: 'Produktseite' };
const list = (ps: PageAudit[]) => ps.map(p => `${KIND[p.kind]} ${p.url}`).join(', ');

/** Findings with a task; Lotse does not change the theme, robots.txt or shop settings itself, the task asks for concrete steps */
export function siteFindings(s: SiteInput): SiteFinding[] {
  const out: SiteFinding[] = [], ok = s.pages.filter(p => p.status === 200);
  const where = (topic: string) => `Erkläre kurz, warum das für Google wichtig ist, und nenne die konkreten Schritte, wo man es in ${s.platform} behebt (${topic}). Lotse kann Theme, Vorlagen und Shop-Einstellungen nicht selbst ändern: nichts behaupten zu beheben, keine Änderungssets dafür.`;
  const add = (id: string, severity: CheckSeverity, title: string, detail: string, pages: PageAudit[] | string[], fix: string) =>
    out.push({ id, severity, title, detail, urls: pages.map(p => (typeof p === 'string' ? p : p.url)), fix });
  const read = (ps: PageAudit[]) => `Lies die betroffenen Seiten mit read_page, falls verfügbar (${list(ps)}).`;

  const bad = s.pages.filter(p => p.status !== 200);
  if (bad.length) add('site:status', 'hoch', 'Shop-Seiten nicht erreichbar', bad.map(p => `${KIND[p.kind]}: HTTP ${p.status || 'Fehler'}`).join(' · '), bad,
    `Der Technik-Check konnte diese Seiten nicht abrufen: ${bad.map(p => `${KIND[p.kind]} ${p.url} (HTTP ${p.status || 'nicht erreichbar'})`).join(', ')}. ${where('Erreichbarkeit, Wartungsmodus, Weiterleitungen, Zugriffsschutz')}`);
  const noindex = ok.filter(p => p.noindex);
  if (noindex.length) add('site:noindex', 'hoch', 'Seiten für Google gesperrt (noindex)', `${noindex.map(p => KIND[p.kind]).join(', ')} tragen „noindex“ und erscheinen nicht in den Suchergebnissen`, noindex,
    `Diese Seiten tragen „noindex“ (Meta-Robots oder X-Robots-Tag) und werden von Google nicht indexiert: ${list(noindex)}. ${read(noindex)} ${where('SEO-Einstellungen, Theme, Wartungs- oder Passwortschutz, Plugins')}`);
  if (s.robots && s.robots.status === 200 && parseRobots(s.robots.body).blocksAll)
    add('site:robots-block', 'hoch', 'robots.txt sperrt den ganzen Shop', '„Disallow: /“ für alle Suchmaschinen', [s.robots.url],
      `Die robots.txt (${s.robots.url}) enthält für „User-agent: *“ ein „Disallow: /“ und sperrt damit den ganzen Shop für Suchmaschinen. ${where('robots.txt bzw. deren Vorlage')}`);
  if (!s.sitemap || s.sitemap.status !== 200)
    add('site:sitemap', 'mittel', 'Keine erreichbare XML-Sitemap', s.sitemap ? `${s.sitemap.url}: HTTP ${s.sitemap.status || 'Fehler'}` : 'weder in der robots.txt eingetragen noch unter /sitemap.xml', s.sitemap ? [s.sitemap.url] : [s.base],
      `Für ${s.base} ist keine XML-Sitemap erreichbar${s.sitemap ? ` (${s.sitemap.url}: HTTP ${s.sitemap.status || 'Fehler'})` : ''}. Eine Sitemap hilft Google, alle Produkt- und Kategorieseiten zu finden; sie gehört in die robots.txt und in die Search Console. ${where('Sitemap-Erzeugung, robots.txt, Search Console')}`);
  else if (s.robots?.status === 200 && !parseRobots(s.robots.body).sitemaps.length)
    add('site:sitemap-robots', 'niedrig', 'Sitemap nicht in der robots.txt eingetragen', `${s.sitemap.url} ist erreichbar, aber die robots.txt verweist nicht darauf`, [s.robots.url],
      `Die Sitemap ${s.sitemap.url} ist erreichbar, steht aber nicht in der robots.txt (${s.robots.url}). Eine Zeile „Sitemap: ${s.sitemap.url}“ hilft allen Suchmaschinen. ${where('robots.txt')}`);
  if (!/^https:/i.test(s.base)) add('site:https', 'mittel', 'Shop nicht über HTTPS', `${s.base} nutzt kein HTTPS`, [s.base],
    `Der Shop ist unter ${s.base} ohne HTTPS erreichbar. HTTPS ist ein Rankingfaktor und Voraussetzung für Vertrauen. ${where('Domain/Zertifikat, Verkaufskanal-Domains, Weiterleitung http → https')}`);
  const noCanon = ok.filter(p => !p.noindex && !p.canonical), otherCanon = ok.filter(p => !p.noindex && p.canonical && p.canonicalSelf === false);
  if (noCanon.length) add('site:canonical-missing', 'mittel', 'Canonical-Tag fehlt', noCanon.map(p => KIND[p.kind]).join(', '), noCanon,
    `Diese Seiten haben kein Canonical-Tag: ${list(noCanon)}. Ohne Canonical kann Google Varianten (Filter, Sortierung, Parameter) als Duplikate werten. ${where('Theme bzw. SEO-Einstellungen')}`);
  if (otherCanon.length) add('site:canonical-other', 'mittel', 'Canonical zeigt auf eine andere Seite', otherCanon.map(p => `${KIND[p.kind]} → ${p.canonical}`).join(' · '), otherCanon,
    `Bei diesen Seiten verweist das Canonical-Tag auf eine andere URL, Google indexiert dann nur das Ziel: ${otherCanon.map(p => `${KIND[p.kind]} ${p.url} → ${p.canonical}`).join(', ')}. Prüfe, ob das gewollt ist (z. B. Variante → Hauptprodukt) oder ein Fehler (falsche Domain, http statt https, alte URL). ${where('Theme, SEO-URLs, Domains')}`);
  const noTitle = ok.filter(p => !p.title), noDesc = ok.filter(p => !p.description);
  if (noTitle.length) add('site:title', 'hoch', 'Seiten ohne Title-Tag', noTitle.map(p => KIND[p.kind]).join(', '), noTitle,
    `Diese Seiten liefern kein <title>: ${list(noTitle)}. ${read(noTitle)} Fehlt nur der Meta-Title im Datensatz, schlage ihn als Änderungsset vor; liegt es am Theme, ${where('Theme-Vorlage')}`);
  if (noDesc.length) add('site:description', 'mittel', 'Seiten ohne Meta-Description', noDesc.map(p => KIND[p.kind]).join(', '), noDesc,
    `Diese Seiten liefern keine Meta-Description: ${list(noDesc)}. ${read(noDesc)} Ist sie im Datensatz leer, schlage eine vor (120 bis 158 Zeichen, Nutzen und Suchbegriff, nur belegte Fakten) als Änderungsset; für die Startseite ${where('Verkaufskanal- bzw. Startseiten-Einstellungen')}`);
  const h1 = ok.filter(p => p.h1 !== 1);
  if (h1.length) add('site:h1', 'mittel', 'Nicht genau eine H1 je Seite', h1.map(p => `${KIND[p.kind]}: ${p.h1} H1`).join(' · '), h1,
    `Jede Seite sollte genau eine H1 mit dem Hauptthema haben. Gefunden: ${h1.map(p => `${KIND[p.kind]} ${p.url}: ${p.h1}`).join(', ')}. ${read(h1)} Stammt eine zusätzliche H1 aus einem Text (Beschreibung, Einkaufswelt), schlage die Korrektur zu H2 als Änderungsset vor; kommt sie aus dem Theme, ${where('Theme-Vorlage')}`);
  const prod = ok.filter(p => p.kind === 'product' && !p.schema.includes('Product'));
  if (prod.length) add('site:schema-product', 'mittel', 'Produktseite ohne strukturierte Produktdaten', 'kein schema.org/Product (Preis, Verfügbarkeit, Bewertungen für Rich Results)', prod,
    `Auf der Produktseite ${prod.map(p => p.url).join(', ')} fehlen strukturierte Daten vom Typ schema.org/Product (mit Offer: Preis, Währung, Verfügbarkeit). Ohne sie zeigt Google keine Preis- und Verfügbarkeitsangaben im Suchergebnis. ${where('Theme oder SEO-Plugin für strukturierte Daten (JSON-LD)')}`);
  const crumbs = ok.filter(p => p.kind !== 'home' && !p.schema.includes('BreadcrumbList'));
  if (crumbs.length) add('site:schema-breadcrumb', 'niedrig', 'Keine Breadcrumb-Daten', crumbs.map(p => KIND[p.kind]).join(', '), crumbs,
    `Diese Seiten haben keine strukturierten Breadcrumb-Daten (schema.org/BreadcrumbList): ${list(crumbs)}. Google zeigt dann den Pfad im Suchergebnis nicht als Navigation. ${where('Theme oder SEO-Plugin für strukturierte Daten')}`);
  const vp = ok.filter(p => !p.viewport);
  if (vp.length) add('site:viewport', 'mittel', 'Kein Viewport für Mobilgeräte', list(vp), vp,
    `Diese Seiten setzen kein <meta name="viewport">: ${list(vp)}. Google bewertet die mobile Version (Mobile-First); ohne Viewport wirkt die Seite auf dem Handy winzig. ${where('Theme-Vorlage')}`);
  const lang = ok.filter(p => !p.lang);
  if (lang.length) add('site:lang', 'niedrig', 'Sprache der Seite nicht angegeben', '<html> ohne lang-Attribut', lang,
    `Diese Seiten geben im <html>-Tag keine Sprache an (lang): ${list(lang)}. Das hilft Suchmaschinen und Screenreadern. ${where('Theme-Vorlage')}`);
  return out;
}

// ---- Fetching ----
const site = (u: URL) => u.host.replace(/^www\./, '').toLowerCase();
/** Load a page of the own shop; redirects only within the same domain (with/without www), response capped */
export async function fetchSite(fetchImpl: Fetcher, url: string, base: string): Promise<Fetched> {
  const home = new URL(base); let cur = new URL(url, base);
  for (let hop = 0; ; hop++) {
    if (site(cur) !== site(home) || !/^https?:$/.test(cur.protocol)) throw new Error(`Weiterleitung auf fremde Adresse (${cur.origin})`);
    const r = await fetchImpl(cur.href, { redirect: 'manual', headers: { accept: 'text/html,application/xml,text/plain;q=0.9', 'user-agent': 'Lotse-SEO-Check' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { await r.body?.cancel().catch(() => {}); if (hop >= MAX_HOPS) throw new Error('Zu viele Weiterleitungen'); cur = new URL(loc, cur); continue; }
    const body = (await r.text()).slice(0, MAX_BYTES);
    return { url: cur.href, status: r.status, body, headers: Object.fromEntries([...r.headers].map(([k, v]) => [k.toLowerCase(), v])) };
  }
}
const safe = (f: Fetcher, url: string, base: string): Promise<Fetched> => fetchSite(f, url, base).catch(() => ({ url: new URL(url, base).href, status: 0, body: '', headers: {} }));

/** Internal links of the home page (same domain, no files) to find one category and one product page */
export function internalLinks(html: string, url: string): string[] {
  const out = new Set<string>(), home = new URL(url);
  for (const m of html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"'#]+)["']/gi)) {
    try { const u = new URL(m[1], url); if (site(u) === site(home) && /^https?:$/.test(u.protocol) && !/\.(jpe?g|png|webp|gif|svg|pdf|xml|txt)$/i.test(u.pathname) && u.pathname !== '/') out.add(u.origin + u.pathname); } catch { /* invalid link */ }
    if (out.size >= 150) break;
  }
  return [...out];
}

export interface SiteAudit { base: string; checkedAt: string; pages: PageAudit[]; robots: { url: string; status: number; sitemaps: string[]; blocksAll: boolean } | null; sitemap: { url: string; status: number } | null; findings: SiteFinding[] }

/** Full check: home page, one category and one product page each (found via the home page links and mapUrls), robots.txt, sitemap */
export async function siteAudit(sf: { base(): Promise<string>; fetch: Fetcher }, lookup: ShopLookup, platform: string): Promise<SiteAudit> {
  const base = (await sf.base()).replace(/\/+$/, '');
  const home = await safe(sf.fetch, base + '/', base);
  const pages: PageAudit[] = [auditPage(home, 'home')];
  if (home.status === 200) {
    const links = internalLinks(home.body, home.url);
    const map = links.length ? await lookup.mapUrls(links).catch(() => null) : null;
    const pick = (kind: string) => links.find(l => map?.get(l)?.kind === kind && map.get(l)?.active !== false);
    for (const [kind, target] of [['category', pick('category')], ['product', pick('product')]] as const) if (target) pages.push(auditPage(await safe(sf.fetch, target, base), kind));
  }
  const robotsRes = await safe(sf.fetch, '/robots.txt', base);
  const robots = robotsRes.status === 200 && !/<html/i.test(robotsRes.body.slice(0, 500)) ? robotsRes : { ...robotsRes, status: robotsRes.status === 200 ? 404 : robotsRes.status };
  const parsed = robots.status === 200 ? parseRobots(robots.body) : { blocksAll: false, sitemaps: [] };
  const smUrl = parsed.sitemaps[0] ?? `${base}/sitemap.xml`;
  const sm = await safe(sf.fetch, smUrl, base);
  const sitemap = { url: sm.url, status: sm.status === 200 && /<(urlset|sitemapindex)\b/i.test(sm.body.slice(0, 5000)) ? 200 : sm.status === 200 ? 415 : sm.status };
  const findings = siteFindings({ base, platform, pages, robots, sitemap: parsed.sitemaps.length || sm.status === 200 ? sitemap : null });
  return { base, checkedAt: new Date().toISOString(), pages, robots: { url: robots.url, status: robots.status, ...parsed }, sitemap, findings };
}

// ---- Tool ----
export const siteCheck: Feature = {
  key: 'site-check',
  platforms: 'all',
  toolNames: ['seo_site_check'],
  tools: session => {
    const p = getPlatform(session.platform);
    return [
      tool('seo_site_check', 'Technik-Check der Live-Seiten des eigenen Shops, wie Google sie sieht: Startseite, eine Kategorie- und eine Produktseite sowie robots.txt und XML-Sitemap. Prüft Erreichbarkeit, noindex, Canonical, Title und Meta-Description, Anzahl der H1, strukturierte Daten (Product, BreadcrumbList), Viewport und Sprache. Liefert Befunde mit Schweregrad und betroffenen URLs. Ändert nichts.',
        {},
        guard(async () => {
          const r = await siteAudit(p.storefront, session.lookup, p.label);
          return ok({ ...r, pages: r.pages.map(({ url, kind, status, noindex, title, description, canonical, canonicalSelf, h1, schema, viewport, lang }) => ({ kind, url, status, noindex, title, description: description.slice(0, 200), canonical, canonicalSelf, h1, schema, viewport, lang })),
            notes: ['Stichprobe: je eine Seite pro Seitentyp. Was auf einer Produktseite fehlt, fehlt meist auf allen (gleiche Theme-Vorlage).', 'Theme, robots.txt und Shop-Einstellungen ändert Lotse nicht: konkrete Schritte für den Admin nennen. Fehlende Metas oder eine zusätzliche H1 in Texten lassen sich per Änderungsset beheben.'] });
        })),
    ] as AnyTool[];
  },
};
