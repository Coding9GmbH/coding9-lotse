import 'server-only';
// Links in Seiten und Beschreibungen: technische Shopware-Pfade (/detail/<id>, /navigation/<id>) → SEO-URL,
// interne Ziele prüfen (existiert, aktiv, im Verkaufskanal, SEO-URL vorhanden) und externe Links (rel/target) – siehe prompts/09-seo.md.
import type { ShopReader, SwEntity } from './shopware';

export type LinkKind = 'product' | 'category' | 'landing';
export const ROUTE: Record<LinkKind, string> = { product: 'frontend.detail.page', category: 'frontend.navigation.page', landing: 'frontend.landing.page' };
export const ROUTE_KIND: Record<string, LinkKind> = Object.fromEntries(Object.entries(ROUTE).map(([k, v]) => [v, k as LinkKind]));
const TECH = /^(detail|navigation|landingPage)\/([0-9a-f]{32})\/?$/i;
const TECH_KIND: Record<string, LinkKind> = { detail: 'product', navigation: 'category', landingpage: 'landing' };
// Storefront-Routen ohne SEO-URL, die es immer gibt (keine Prüfung)
const STATIC_ROUTE = /^(account|checkout|search|suggest|wishlist|note|newsletter|widgets|maintenance|sitemap(\.xml)?|robots\.txt|media|thumbnail|bundles|theme|country|cookie|form|compare)(\/|$|\?)/i;
const GENERIC_ANCHOR = /^(hier|hier klicken|klicken sie hier|klick hier|hier entlang|mehr|mehr dazu|weiter|weiterlesen|link|zum link|click here|here|read more|more)$/i;

export interface LinkRef { href: string; text: string; rel?: string; target?: string }

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))?.slice(1).find(v => v != null);
const plain = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Alle <a href> eines HTML-Texts samt Linktext, rel und target. */
export function extractLinks(html: string): LinkRef[] {
  return [...String(html ?? '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].flatMap(m => {
    const href = attr(m[1], 'href'); if (href == null) return [];
    return [{ href: href.trim(), text: plain(m[2]).slice(0, 120) || (attr(m[2], 'alt') ?? ''), rel: attr(m[1], 'rel'), target: attr(m[1], 'target') }];
  });
}

export interface ParsedHref { type: 'internal' | 'external' | 'anchor' | 'other' | 'invalid'; kind?: LinkKind; id?: string; path?: string; absolute?: boolean }

/** Ordnet einen href ein. bases = Domain-URLs der Verkaufskanäle (+ API-Basis): deren Links gelten als intern. */
export function parseHref(href: string, bases: string[]): ParsedHref {
  const h = href.trim();
  if (!h || h === '#') return { type: 'anchor' };
  if (h.startsWith('#')) return { type: 'anchor' };
  if (/^(mailto|tel|sms):/i.test(h)) return { type: 'other' };
  if (/^(javascript|data|vbscript):/i.test(h)) return { type: 'invalid' };
  let rest: string, absolute = false;
  if (/^(https?:)?\/\//i.test(h)) {
    const url = h.startsWith('//') ? 'https:' + h : h;
    const base = bases.map(b => b.replace(/\/+$/, '')).filter(Boolean).sort((a, b) => b.length - a.length).find(b => { const bl = b.toLowerCase(), ul = url.toLowerCase(); return ul === bl || ul.startsWith(bl + '/') || ul.startsWith(bl + '?') || ul.startsWith(bl + '#'); });
    if (!base) return { type: 'external' };
    rest = url.slice(base.length); absolute = true;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(h)) return { type: 'other' };
  else {
    rest = h;
    // Domain mit Pfad (z. B. https://shop.de/en): Präfix entfernen
    for (const b of bases) { try { const p = new URL(b).pathname.replace(/\/+$/, ''); if (p && (rest === p || rest.startsWith(p + '/'))) { rest = rest.slice(p.length); break; } } catch {} }
  }
  const path = decodeURIComponentSafe(rest.replace(/[?#].*$/, '').replace(/^\/+/, ''));
  const m = path.match(TECH);
  if (m) return { type: 'internal', kind: TECH_KIND[m[1].toLowerCase()], id: m[2].toLowerCase(), path, absolute };
  return { type: 'internal', path, absolute };
}
const decodeURIComponentSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

// ---- Kontext: Verkaufskanal, Sprache, Domain ----
export interface LinkCtx { salesChannelId: string; salesChannel: string; languageId: string; domain: string; navigationCategoryId: string | null; rootIds: string[]; bases: string[] }
/** Kategorie liegt unter Navigation, Footer oder Service des Kanals (nur dort erzeugt Shopware Kategorie-Seiten/SEO-URLs) */
export const underRoots = (ctx: Pick<LinkCtx, 'rootIds'>, c: SwEntity) => !ctx.rootIds.length || ctx.rootIds.some(r => c.id === r || String(c.path ?? '').includes(`|${r}|`));

/** Verkaufskanal für Links: angegeben oder der erste mit Domain (Storefront); Sprache = Sprache seiner ersten Domain. */
export async function linkContext(ro: ShopReader, salesChannelId?: string, languageId?: string): Promise<LinkCtx | null> {
  const all = await ro.salesChannels();
  const sc = salesChannelId ? all.find(s => s.id === salesChannelId) : all.find(s => s.domains?.some((d: SwEntity) => /^https?:\/\//.test(String(d.url))));
  if (!sc) { if (salesChannelId) throw new Error(`Verkaufskanal ${salesChannelId} nicht gefunden`); return null; }
  const doms: SwEntity[] = (sc.domains ?? []).filter((d: SwEntity) => /^https?:\/\//.test(String(d.url)));
  const dom = (languageId ? doms.find(d => d.languageId === languageId) : null) ?? doms.find(d => d.languageId === sc.languageId) ?? doms[0];
  if (languageId && dom?.languageId !== languageId) throw new Error(`Verkaufskanal „${sc.translated?.name ?? sc.name}“ hat keine Domain für die Sprache ${languageId}`);
  const bases = [...new Set([...all.flatMap(s => (s.domains ?? []).map((d: SwEntity) => String(d.url))), ro.base].filter(u => /^https?:\/\//.test(u)))];
  return { salesChannelId: sc.id, salesChannel: sc.translated?.name ?? sc.name, languageId: dom?.languageId ?? sc.languageId, domain: String(dom?.url ?? ro.base).replace(/\/+$/, ''), navigationCategoryId: sc.navigationCategoryId ?? null, rootIds: [...new Set([sc.navigationCategoryId, sc.footerCategoryId, sc.serviceCategoryId].filter((x): x is string => !!x))], bases };
}

// ---- Ziele auflösen ----
/** IDs der Produkte, die im Kanal sichtbar sind – Varianten über die Sichtbarkeit ihres Hauptprodukts (wird vererbt). */
export async function visibleProducts(ro: ShopReader, salesChannelId: string, rows: SwEntity[]): Promise<Set<string>> {
  const ids = [...new Set(rows.flatMap(r => [r.id as string, ...(r.parentId ? [r.parentId as string] : [])]))];
  if (!ids.length) return new Set();
  const vis = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) { const chunk = ids.slice(i, i + 500); for (const x of (await ro.search('product', { ids: chunk, limit: chunk.length, filter: [{ type: 'equals', field: 'visibilities.salesChannelId', value: salesChannelId }], includes: { product: ['id'] } })).data) vis.add(x.id); }
  return new Set(rows.filter(r => vis.has(r.id) || (r.parentId && vis.has(r.parentId))).map(r => r.id as string));
}
export interface LinkTarget { kind: LinkKind; id: string; exists: boolean; active: boolean; name?: string; inChannel: boolean; isPage?: boolean; seoPath?: string; canonical?: boolean }
export interface Resolved { byId: Map<string, LinkTarget>; byPath: Map<string, LinkTarget | null>; seoChecked: boolean }

const seoKey = (path: string) => path.replace(/\/+$/, '').toLowerCase();
/** Kanonische SEO-Pfade je (Route, ID) für Kanal + Sprache. */
export async function canonicalSeoPaths(ro: ShopReader, ctx: Pick<LinkCtx, 'salesChannelId' | 'languageId'>, refs: { kind: LinkKind; id: string }[]): Promise<Map<string, SwEntity>> {
  const out = new Map<string, SwEntity>(), ids = [...new Set(refs.map(r => r.id))];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await ro.search('seo-url', { limit: chunk.length * 3, filter: [{ type: 'equalsAny', field: 'foreignKey', value: chunk }, { type: 'equals', field: 'salesChannelId', value: ctx.salesChannelId }, { type: 'equals', field: 'languageId', value: ctx.languageId }, { type: 'equals', field: 'isCanonical', value: true }, { type: 'equals', field: 'isDeleted', value: false }] });
    for (const s of r.data) out.set(`${s.routeName}:${s.foreignKey}`, s);
  }
  return out;
}

/** Löst technische IDs und SEO-Pfade gegen den Shop auf (gebündelt; fehlende Leserechte → Prüfung entfällt still). */
export async function resolveTargets(ro: ShopReader, ctx: LinkCtx, refs: { kind: LinkKind; id: string }[], paths: string[]): Promise<Resolved> {
  const byId = new Map<string, LinkTarget>(), byPath = new Map<string, LinkTarget | null>();
  let seoChecked = true;
  // SEO-Pfade → Ziel-IDs (auch alte, nicht-kanonische Pfade)
  const want = [...new Set(paths.filter(p => p && !STATIC_ROUTE.test(p)).map(seoKey))];
  const pathHits = new Map<string, SwEntity>();
  if (want.length) {
    try {
      const r = await ro.search('seo-url', { limit: want.length * 4, filter: [{ type: 'equalsAny', field: 'seoPathInfo', value: want.flatMap(p => [p, p + '/']) }, { type: 'equals', field: 'salesChannelId', value: ctx.salesChannelId }, { type: 'equals', field: 'isDeleted', value: false }] });
      for (const s of r.data) { const k = seoKey(s.seoPathInfo); if (!pathHits.has(k) || s.languageId === ctx.languageId) pathHits.set(k, s); }
    } catch { seoChecked = false; }
  }
  const all = [...refs, ...[...pathHits.values()].filter(s => ROUTE_KIND[s.routeName]).map(s => ({ kind: ROUTE_KIND[s.routeName], id: s.foreignKey as string }))];
  const ids = (k: LinkKind) => [...new Set(all.filter(r => r.kind === k).map(r => r.id))];
  const load = async (entity: string, list: string[], extra: Record<string, unknown>[]) => {
    if (!list.length) return { rows: [] as SwEntity[], inCh: new Set<string>() };
    const rows = (await ro.search(entity, { ids: list, limit: list.length })).data;
    const inCh = extra.length ? new Set((await ro.search(entity, { ids: list, limit: list.length, filter: extra })).data.map(x => x.id as string)) : new Set(rows.map(x => x.id as string));
    return { rows, inCh };
  };
  const put = (kind: LinkKind, list: string[], rows: SwEntity[], inCh: Set<string>, extra?: (x: SwEntity) => Partial<LinkTarget>) => {
    for (const id of list) {
      const x = rows.find(r => r.id === id);
      byId.set(`${kind}:${id}`, x ? { kind, id, exists: true, active: x.active !== false, name: x.translated?.name ?? x.name, inChannel: inCh.has(id), ...extra?.(x) } : { kind, id, exists: false, active: false, inChannel: false });
    }
  };
  const p = ids('product'), c = ids('category'), l = ids('landing');
  const P0 = p.length ? (await ro.search('product', { ids: p, limit: p.length })).data : [];
  const pids = [...new Set(P0.map(x => x.parentId as string).filter(id => id && !p.includes(id)))], par = pids.length ? (await ro.search('product', { ids: pids, limit: pids.length })).data : [];
  // Varianten erben active und Name vom Hauptprodukt (ohne sw-inheritance null)
  const PR = P0.map(x => { const m = x.parentId ? par.find(r => r.id === x.parentId) : undefined; return m ? { ...x, active: x.active ?? m.active, name: x.translated?.name ?? x.name ?? m.translated?.name ?? m.name, translated: undefined } : x; });
  put('product', p, PR, await visibleProducts(ro, ctx.salesChannelId, P0));
  const C = await load('category', c, []);
  put('category', c, C.rows, new Set(C.rows.filter(x => underRoots(ctx, x)).map(x => x.id)), x => ({ isPage: (x.type ?? 'page') === 'page' }));
  const L = await load('landing-page', l, [{ type: 'equals', field: 'salesChannels.id', value: ctx.salesChannelId }]); put('landing', l, L.rows, L.inCh);
  if (seoChecked && byId.size) {
    try {
      const seo = await canonicalSeoPaths(ro, ctx, [...byId.values()]);
      for (const t of byId.values()) { const s = seo.get(`${ROUTE[t.kind]}:${t.id}`); if (s) t.seoPath = s.seoPathInfo; }
    } catch { seoChecked = false; }
  }
  for (const p of want) {
    const s = pathHits.get(p), t = s && ROUTE_KIND[s.routeName] ? byId.get(`${ROUTE_KIND[s.routeName]}:${s.foreignKey}`) : undefined;
    byPath.set(p, t ? { ...t, canonical: !!s!.isCanonical && seoKey(s!.seoPathInfo) === seoKey(t.seoPath ?? '') } : null);
  }
  return { byId, byPath, seoChecked };
}

// ---- Bewertung + Umschreiben ----
/** problem: ganzer Hinweis mit Abhilfe; short: Kurzform für Listen (Shop-Check-Beispiele), fehlt sie, ist problem schon kurz (Magento/OpenMage) */
export interface LinkFinding { href: string; text: string; level: 'wichtig' | 'empfohlen'; problem: string; short?: string }
export const shortProblem = (f: Pick<LinkFinding, 'problem' | 'short'>) => f.short ?? f.problem;
export interface LinkReport { ctx: LinkCtx | null; internal: number; external: number; findings: LinkFinding[]; rewrites: Map<string, string> }

const absUrl = (ctx: LinkCtx, seoPath: string) => `${ctx.domain}/${seoPath.replace(/^\/+/, '')}`;
/** Neuer href für einen internen Link: SEO-URL statt technischem/veraltetem Pfad (gleiche Form: absolut bleibt absolut). */
function betterHref(p: ParsedHref, t: LinkTarget | null | undefined, ctx: LinkCtx, href: string): string | null {
  if (!t?.seoPath || !t.exists) return null;
  if (p.kind || (p.path != null && t.canonical === false)) {
    const suffix = href.match(/[?#].*$/)?.[0] ?? '';
    if (p.absolute) return absUrl(ctx, t.seoPath) + suffix;
    const prefix = (() => { try { return new URL(ctx.domain).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
    return `${prefix}/${t.seoPath.replace(/^\/+/, '')}${suffix}`;
  }
  return null;
}

/** Prüft Links (intern: Ziel, aktiv, Kanal, SEO-URL; extern: rel/target; Linktext) und liefert Umschreibungen technischer Links. */
export async function checkLinks(ro: ShopReader, links: LinkRef[], opts: { salesChannelId?: string; ctx?: LinkCtx | null } = {}): Promise<LinkReport> {
  const ctx = opts.ctx !== undefined ? opts.ctx : await linkContext(ro, opts.salesChannelId);
  const out: LinkReport = { ctx, internal: 0, external: 0, findings: [], rewrites: new Map() };
  if (!links.length) return out;
  const parsed = links.map(l => ({ l, p: parseHref(l.href, ctx?.bases ?? [ro.base]) }));
  const res = ctx ? await resolveTargets(ro, ctx, parsed.filter(x => x.p.kind).map(x => ({ kind: x.p.kind!, id: x.p.id! })), parsed.filter(x => x.p.type === 'internal' && !x.p.kind && x.p.path).map(x => x.p.path!)) : null;
  const seen = new Set<string>();
  // short = Kurzform (Listen), problem = short + Abhilfe
  const add = (l: LinkRef, level: LinkFinding['level'], short: string, fix = '') => { const problem = fix ? `${short}: ${fix}` : short, k = `${l.href}|${problem}`; if (!seen.has(k)) { seen.add(k); out.findings.push({ href: l.href, text: l.text, level, problem, short }); } };
  for (const { l, p } of parsed) {
    if (GENERIC_ANCHOR.test(l.text.replace(/[»›→.!…]+/g, '').trim())) add(l, 'empfohlen', `Nichtssagender Linktext „${l.text}“`, 'beschreibenden Ankertext verwenden (Ziel benennen)');
    if (p.type === 'invalid') { add(l, 'wichtig', 'Unsicherer Link (javascript:/data:)', 'entfernen'); continue; }
    if (p.type === 'anchor') { if (!l.href.trim() || l.href.trim() === '#') add(l, 'empfohlen', 'Link ohne Ziel (href leer oder „#“)'); continue; }
    if (p.type === 'other') continue;
    if (p.type === 'external') {
      out.external++;
      if (/^http:\/\//i.test(l.href)) add(l, 'empfohlen', 'Externer Link ohne HTTPS');
      if (l.target === '_blank' && !/\bnoopener\b|\bnoreferrer\b/i.test(l.rel ?? '')) add(l, 'empfohlen', 'Externer Link mit target="_blank" braucht rel="noopener"');
      continue;
    }
    out.internal++;
    if (l.target === '_blank') add(l, 'empfohlen', 'Interner Link öffnet neuen Tab', 'target="_blank" entfernen');
    if (/\bnofollow\b/i.test(l.rel ?? '')) add(l, 'empfohlen', 'Interner Link mit rel="nofollow"', 'entfernen (verschenkt Linkkraft)');
    if (!ctx || !res) continue;
    if (!p.kind && (!p.path || STATIC_ROUTE.test(p.path))) continue; // Startseite / Standard-Routen
    const t = p.kind ? res.byId.get(`${p.kind}:${p.id}`) : res.byPath.get(seoKey(p.path!));
    const what = (x: LinkTarget) => ({ product: 'Produkt', category: 'Kategorie', landing: 'Landingpage' })[x.kind] + (x.name ? ` „${x.name}“` : '');
    if (!t) { if (res.seoChecked) add(l, 'wichtig', `Ziel nicht gefunden: „/${p.path}“ ist keine bekannte SEO-URL im Verkaufskanal ${ctx.salesChannel}`, 'get_seo_urls/suggest_internal_links nutzen'); continue; }
    if (!t.exists) { add(l, 'wichtig', `${({ product: 'Produkt', category: 'Kategorie', landing: 'Landingpage' })[t.kind]} ${t.id} existiert nicht (mehr)`, 'Link entfernen oder ersetzen'); continue; }
    if (!t.active) { add(l, 'wichtig', `${what(t)} ist inaktiv`, 'nicht verlinken (Besucher landen auf einer Fehlerseite)'); continue; }
    if (t.isPage === false) add(l, 'wichtig', `${what(t)} ist keine Seite (Ordner/Link-Kategorie)`, 'anderes Ziel wählen');
    else if (!t.inChannel) add(l, 'wichtig', `${what(t)} ist im Verkaufskanal ${ctx.salesChannel} nicht sichtbar`);
    const better = betterHref(p, t, ctx, l.href);
    if (better && better !== l.href) out.rewrites.set(l.href, better);
    else if (p.kind && !t.seoPath && res.seoChecked) add(l, 'empfohlen', `${what(t)} hat keine SEO-URL`, 'technischer Link bleibt (SEO-URL per propose_seo_urls anlegen)');
  }
  return out;
}

// ---- Links in beliebigen Strukturen (Page-Spec, Slot-Configs) sammeln und umschreiben ----
const HREF_KEY = /(href|linkurl|link)$/i;
const isLinkKey = (path: string[]) => { const k = path[path.length - 1] ?? '', parent = path[path.length - 2] ?? ''; return HREF_KEY.test(k) || (k === 'value' && /^(url|link|href)$/i.test(parent)); };
// Wert sieht nach URL aus (Pfad, Schema, //, #, ?) – nicht z. B. „product.manufacturer.link“
const HREF_LIKE = /^(\/|#|\?|[a-z][a-z0-9+.-]*:)/i;
// Slot-Config { source: 'mapped', value: 'product.manufacturer.link' } ist eine Feldzuordnung, kein Link → überspringen
const isMapped = (x: Record<string, unknown>) => typeof x.source === 'string' && x.source !== 'static' && 'value' in x;

/** Alle Links eines Objekts: <a href> in HTML-Strings und Link-Felder (ctaHref, linkUrl, config.url.value …). */
export function collectLinks(obj: unknown): LinkRef[] {
  const out: LinkRef[] = [];
  const walk = (x: unknown, path: string[], parent?: Record<string, unknown>) => {
    if (typeof x === 'string') {
      if (isLinkKey(path)) { if (HREF_LIKE.test(x.trim())) { const k = path[path.length - 1]; const txt = parent?.[k.replace(/(Href|Url|Link)$/, 'Text')]; out.push({ href: x.trim(), text: typeof txt === 'string' && txt !== x ? txt : '' }); } }
      else if (/<a\b/i.test(x)) out.push(...extractLinks(x));
    } else if (Array.isArray(x)) x.forEach((v, i) => walk(v, [...path, String(i)]));
    else if (x && typeof x === 'object' && !isMapped(x as Record<string, unknown>)) for (const [k, v] of Object.entries(x)) walk(v, [...path, k], x as Record<string, unknown>);
  };
  walk(obj, []);
  return out;
}

/** href-Werte in HTML ersetzen (nur exakte Treffer aus der Map). */
export const rewriteHtml = (html: string, map: Map<string, string>) => !map.size ? html : html.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])([^"']*)\2/gi, (all, pre, q, href) => { const n = map.get(href.trim()); return n ? `${pre}${q}${n}${q}` : all; });

/** Kopie eines Objekts mit umgeschriebenen Links (HTML-Strings und Link-Felder). */
export function rewriteLinks<T>(obj: T, map: Map<string, string>): T {
  if (!map.size) return obj;
  const walk = (x: unknown, path: string[]): unknown => {
    if (typeof x === 'string') return isLinkKey(path) ? map.get(x.trim()) ?? x : /<a\b/i.test(x) ? rewriteHtml(x, map) : x;
    if (Array.isArray(x)) return x.map((v, i) => walk(v, [...path, String(i)]));
    if (x && typeof x === 'object' && !isMapped(x as Record<string, unknown>)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v, [...path, k])]));
    return x;
  };
  return walk(obj, []) as T;
}

/** Seitenentwurf: Links prüfen und technische Links durch SEO-URLs ersetzen (für Vorschau, Check und Veröffentlichung). */
export async function prepareSpecLinks<T>(ro: ShopReader, spec: T, salesChannelId?: string): Promise<{ spec: T; report: LinkReport | null }> {
  try {
    const report = await checkLinks(ro, collectLinks(spec), { salesChannelId });
    return { spec: rewriteLinks(spec, report.rewrites), report };
  } catch { return { spec, report: null }; } // Shop nicht erreichbar o. Ä.: Entwurf bleibt unverändert
}

/** Änderungsvorschläge mit HTML (Beschreibungen): technische Links → SEO-URL, Probleme als Warnung am Element. */
export async function checkHtmlItems(ro: ShopReader, items: { afterRaw?: unknown; after: string; html?: { before: string; after: string }; warn: string[] }[]) {
  const withLinks = items.filter(i => typeof i.afterRaw === 'string' && /<a\b/i.test(i.afterRaw));
  if (!withLinks.length) return;
  let report: LinkReport;
  try { report = await checkLinks(ro, withLinks.flatMap(i => extractLinks(i.afterRaw as string))); } catch { return; }
  for (const it of withLinks) {
    const hrefs = new Set(extractLinks(it.afterRaw as string).map(l => l.href));
    const html = rewriteHtml(it.afterRaw as string, report.rewrites);
    if (html !== it.afterRaw) { it.afterRaw = html; it.after = rewriteHtml(it.after, report.rewrites); if (it.html) it.html.after = html.slice(0, 4000); } // Karte zeigt, was geschrieben wird
    const fs = report.findings.filter(f => hrefs.has(f.href));
    it.warn.push(...fs.slice(0, 3).map(findingText), ...(fs.length > 3 ? [`… und ${fs.length - 3} weitere Link-Hinweise`] : []));
  }
}

export const findingText =(f: LinkFinding) => `Link ${f.text ? `„${f.text.slice(0, 50)}“ ` : ''}(${f.href.slice(0, 90)}): ${f.problem}`;
