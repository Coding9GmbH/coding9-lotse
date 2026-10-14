import 'server-only';
// SEO module: read canonical SEO URLs, suggest internal links, set custom SEO URLs (approval) and shop-wide SEO check.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { applyEach, registerApplier } from '../changes';
import { canonicalSeoPaths, checkLinks, collectLinks, extractLinks, linkContext, ROUTE, type LinkCtx, type LinkKind } from '../seo-links';
import { HEX32, SYSTEM_LANGUAGE, type ShopReader, type SwEntity } from '../shopware';
import { singleton } from '../state';
import { ok, fail, guard, nextOffsetOf, pageOf, type AnyTool } from '../tool-kit';
import type { Feature } from './types';
import { altIsFileName } from './product-images';
import { applySeoUrl, buildSeoUrlChangeSet, duplicates, evaluate, KIND, summarize, type SeoUrlPayload } from './seo-rules';

registerApplier(KIND, (swW, cs, _payload, selected, ctx) => applyEach(cs, selected, it => applySeoUrl(swW, it.afterRaw as SeoUrlPayload), ctx));

const NAV_FILTER = (ctx: LinkCtx) => (ctx.navigationCategoryId ? [{ type: 'contains', field: 'path', value: `|${ctx.navigationCategoryId}|` }] : []);
// Categories with their own page in the channel: under navigation, footer or service
const ROOTS_FILTER = (ctx: LinkCtx) => (ctx.rootIds.length ? [{ type: 'multi', operator: 'or', queries: ctx.rootIds.map(r => ({ type: 'contains', field: 'path', value: `|${r}|` })) }] : []);
const plainText = (t: unknown) => String(t ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const STOP = new Set('der die das und oder mit für von aus auf in im am an zu zum zur ein eine einer eines den dem des ist sind wie was wer the and for with to of a an unsere unser ihr ihre sie wir du dich dein deine alle mehr sehr auch nur noch bei als so'.split(' '));
/** Search terms from free text: content words, longest first (max. 6) */
export const keywords = (text: string) => [...new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []).filter(w => !STOP.has(w)))].sort((a, b) => b.length - a.length).slice(0, 6).join(' ');
/** Anchor text: product name without trailing dimensions, or category name/meta title core */
export function anchorFor(kind: LinkKind, e: SwEntity): string {
  const name = String(e.translated?.name ?? e.name ?? '').trim();
  if (kind === 'product') { const parts = name.split(/,\s*/); const two = parts.slice(0, 2).join(', '); return two.length <= 55 ? two : parts[0]; }
  const core = String(e.translated?.metaTitle ?? '').split(/\s[|–—-]\s/)[0].trim();
  return core && core.length <= 60 && core.toLowerCase().includes(name.toLowerCase()) ? core : name;
}

/** Duplicate metas per (shop, entity, filter): the scan (only id + metas, up to 5000 records) runs on the first audit page
 *  and is kept briefly for following pages instead of re-reading all records for every page. */
interface DupScan { at: number; title: Map<string, string[]>; desc: Map<string, string[]>; truncated: boolean }
export const DUP_TTL_MS = 5 * 60_000;
const dupCache = () => singleton('seo-dup-scan', () => new Map<string, DupScan>());
export async function duplicateMetas(ro: ShopReader, entity: string, filter: Record<string, unknown>[], fresh: boolean): Promise<DupScan> {
  const key = `${ro.base}|${entity}|${JSON.stringify(filter)}`, hit = dupCache().get(key);
  if (hit && !fresh && Date.now() - hit.at < DUP_TTL_MS) return hit;
  const metas: SwEntity[] = []; let truncated = false;
  for (let page = 1; ; page++) {
    const m = await ro.search(entity, { limit: 500, page, filter, includes: { [entity]: ['id', 'metaTitle', 'metaDescription'] } });
    metas.push(...m.data);
    if (m.data.length < 500) break; if (metas.length >= 5000) { truncated = true; break; }
  }
  const scan: DupScan = { at: Date.now(), title: duplicates(metas.map(m => ({ id: m.id, value: m.metaTitle }))), desc: duplicates(metas.map(m => ({ id: m.id, value: m.metaDescription }))), truncated };
  dupCache().set(key, scan);
  return scan;
}

async function seoFor(ro: ShopReader, ctx: LinkCtx, kind: LinkKind, rows: SwEntity[]) {
  const seo = rows.length ? await canonicalSeoPaths(ro, ctx, rows.map(r => ({ kind, id: r.id }))).catch(() => new Map<string, SwEntity>()) : new Map<string, SwEntity>();
  const prefix = (() => { try { return new URL(ctx.domain).pathname.replace(/\/+$/, ''); } catch { return ''; } })();
  const tech = { product: 'detail', category: 'navigation', landing: 'landingPage' }[kind];
  return (id: string) => { const s = seo.get(`${ROUTE[kind]}:${id}`)?.seoPathInfo as string | undefined; return { href: s ? `${prefix}/${s}` : `${prefix}/${tech}/${id}`, url: s ? `${ctx.domain}/${s}` : `${ctx.domain}/${tech}/${id}`, hasSeoUrl: !!s }; };
}

export const seo: Feature = {
  key: 'seo',
  platforms: ['shopware'],
  toolNames: ['get_seo_urls', 'suggest_internal_links', 'propose_seo_urls', 'seo_audit'],
  tools: session => {
    const { sw } = session;
    return [
      tool('get_seo_urls', 'Liefert die kanonischen Storefront-URLs (SEO-URLs) von Produkten, Kategorien und Landingpages als absolute URLs je Verkaufskanal-Domain und Sprache, inkl. ob die URL individuell gesetzt ist (isModified) und ob das Ziel aktiv ist. Fehlt eine SEO-URL, kommt der technische Pfad mit hasSeoUrl:false. Ändert nichts.',
        { productIds: z.array(z.string()).optional(), categoryIds: z.array(z.string()).optional(), landingPageIds: z.array(z.string()).optional(), salesChannelId: z.string().optional().describe('Standard: alle Verkaufskanäle mit Domain') },
        guard(async a => {
          const refs: { kind: LinkKind; id: string }[] = [...(a.productIds ?? []).map(id => ({ kind: 'product' as const, id })), ...(a.categoryIds ?? []).map(id => ({ kind: 'category' as const, id })), ...(a.landingPageIds ?? []).map(id => ({ kind: 'landing' as const, id }))];
          if (!refs.length) return fail('productIds, categoryIds oder landingPageIds angeben');
          if (refs.length > 100) return fail('Maximal 100 IDs pro Aufruf');
          const channels = (await sw.salesChannels()).filter(s => (!a.salesChannelId || s.id === a.salesChannelId) && s.domains?.some((d: SwEntity) => /^https?:\/\//.test(String(d.url))));
          if (!channels.length) return fail('Kein passender Verkaufskanal mit Domain gefunden');
          const langs = Object.fromEntries((await sw.search('language', { limit: 50 }).catch(() => ({ data: [] as SwEntity[] }))).data.map(l => [l.id, l.name]));
          const entity = { product: 'product', category: 'category', landing: 'landing-page' } as const;
          const names = new Map<string, SwEntity>();
          for (const k of ['product', 'category', 'landing'] as const) { const ids = refs.filter(r => r.kind === k).map(r => r.id); if (ids.length) for (const e of (await sw.search(entity[k], { ids, limit: ids.length })).data) names.set(`${k}:${e.id}`, e); }
          const urls = new Map<string, unknown[]>();
          for (const sc of channels) for (const d of sc.domains.filter((x: SwEntity) => /^https?:\/\//.test(String(x.url)))) {
            const ctx = { salesChannelId: sc.id, languageId: d.languageId, domain: String(d.url).replace(/\/+$/, '') };
            const seo = await canonicalSeoPaths(sw, ctx, refs);
            for (const r of refs) {
              const s = seo.get(`${ROUTE[r.kind]}:${r.id}`), tech = { product: 'detail', category: 'navigation', landing: 'landingPage' }[r.kind];
              urls.set(`${r.kind}:${r.id}`, [...(urls.get(`${r.kind}:${r.id}`) ?? []), { salesChannel: sc.translated?.name ?? sc.name, salesChannelId: sc.id, language: langs[d.languageId] ?? d.languageId, url: s ? `${ctx.domain}/${s.seoPathInfo}` : `${ctx.domain}/${tech}/${r.id}`, hasSeoUrl: !!s, ...(s ? { seoPath: s.seoPathInfo, isModified: !!s.isModified } : {}) }]);
            }
          }
          return ok(refs.map(r => { const e = names.get(`${r.kind}:${r.id}`); return e ? { kind: r.kind, id: r.id, name: e.translated?.name ?? e.name, ...(e.productNumber ? { number: e.productNumber } : {}), active: e.active !== false, urls: urls.get(`${r.kind}:${r.id}`) } : { kind: r.kind, id: r.id, error: 'nicht gefunden' }; }));
        })),

      tool('suggest_internal_links', 'Schlägt passende INTERNE Links vor: aktive, im Verkaufskanal sichtbare Produkte und Kategorien (Seiten) zu einem Thema/Text oder rund um ein Produkt bzw. eine Kategorie, jeweils mit SEO-URL (href für Seiten/Beschreibungen, url absolut) und beschreibendem Ankertext. Inaktive oder unsichtbare Ziele kommen nie vor. Schreibt nichts; die Links baust du selbst in Entwurf/Beschreibung ein.',
        { topic: z.string().optional().describe('Thema/Keyword, z. B. "Steinzeug Vase"'), text: z.string().optional().describe('Text, für den Links gesucht werden (Suchbegriffe werden extrahiert)'), productId: z.string().optional().describe('Links rund um dieses Produkt (seine Kategorien + verwandte Produkte)'), categoryId: z.string().optional().describe('Links rund um diese Kategorie (Unter-/Oberkategorie + Produkte)'), limit: z.number().optional().describe('Je Typ, Standard 5, max. 10'), excludeIds: z.array(z.string()).optional(), salesChannelId: z.string().optional() },
        guard(async a => {
          const ctx = await linkContext(sw, a.salesChannelId);
          if (!ctx) return fail('Kein Verkaufskanal mit Domain gefunden');
          const n = Math.min(Math.max(a.limit ?? 5, 1), 10), ex = new Set(a.excludeIds ?? []);
          const base = a.productId ? await sw.get('product', a.productId) : null, cat = a.categoryId ? await sw.get('category', a.categoryId) : null;
          if (a.productId && !base) return fail('Produkt nicht gefunden');
          if (a.categoryId && !cat) return fail('Kategorie nicht gefunden');
          if (base) ex.add(base.id); if (cat) ex.add(cat.id);
          const term = a.topic?.trim() || (a.text ? keywords(a.text) : '');
          if (!term && !base && !cat) return fail('topic, text, productId oder categoryId angeben');
          const pFilter: Record<string, unknown>[] = [{ type: 'equals', field: 'active', value: true }, { type: 'equals', field: 'parentId', value: null }, { type: 'equals', field: 'visibilities.salesChannelId', value: ctx.salesChannelId }];
          const cFilter: Record<string, unknown>[] = [{ type: 'equals', field: 'active', value: true }, { type: 'equals', field: 'type', value: 'page' }, ...NAV_FILTER(ctx)];
          const near = base?.categoryIds?.length ? base.categoryIds as string[] : cat ? [cat.id] : null;
          const products = (await sw.search('product', { limit: n * 3, ...(term ? { term } : {}), filter: [...pFilter, ...(near && !term ? [{ type: 'equalsAny', field: 'categoriesRo.id', value: near }] : [])] })).data.filter(p => !ex.has(p.id)).slice(0, n);
          const catRows = base?.categoryIds?.length && !term ? (await sw.search('category', { ids: base.categoryIds, limit: 20, filter: cFilter })).data
            : cat && !term ? (await sw.search('category', { limit: n * 2, filter: [...cFilter, { type: 'multi', operator: 'or', queries: [{ type: 'equals', field: 'parentId', value: cat.id }, ...(cat.parentId ? [{ type: 'equals', field: 'id', value: cat.parentId }] : [])] }] })).data
              : (await sw.search('category', { limit: n * 2, term, filter: cFilter })).data;
          let cats = catRows.filter(c => !ex.has(c.id) && c.id !== ctx.navigationCategoryId).slice(0, n);
          const more = [...new Set(products.flatMap(p => (p.categoryIds ?? []) as string[]))].filter(id => !ex.has(id) && id !== ctx.navigationCategoryId && !cats.some(c => c.id === id));
          if (cats.length < n && more.length) cats = [...cats, ...(await sw.search('category', { ids: more, limit: more.length, filter: cFilter })).data].slice(0, n); // categories of the matching products
          const pu = await seoFor(sw, ctx, 'product', products), cu = await seoFor(sw, ctx, 'category', cats);
          return ok({
            salesChannel: ctx.salesChannel, domain: ctx.domain, term: term || undefined,
            products: products.map(p => ({ id: p.id, name: p.translated?.name ?? p.name, number: p.productNumber, anchor: anchorFor('product', p), ...pu(p.id) })),
            categories: cats.map(c => ({ id: c.id, name: c.translated?.name ?? c.name, path: c.translated?.breadcrumb?.slice(1).join(' > '), anchor: anchorFor('category', c), ...cu(c.id) })),
            hint: 'Im HTML href verwenden (<a href="…">Ankertext</a>), 2 bis 5 thematisch passende Links pro Seite, Ankertext beschreibend. hasSeoUrl:false = nur technischer Pfad: vorher SEO-URL anlegen (propose_seo_urls).',
          });
        })),

      tool('propose_seo_urls', 'SCHLÄGT eigene SEO-URLs (Slugs) für Produkte/Kategorien vor, je Verkaufskanal + Sprache. Der Server normalisiert und prüft den Slug (klein, ä→ae ö→oe ü→ue ß→ss, Bindestriche, keine IDs, nicht im Kanal vergeben). Es wird NICHTS geschrieben, bis der Nutzer freigibt; dann wird die neue URL kanonisch (isModified, Shopware überschreibt sie nicht mehr), die alte bleibt als Weiterleitung. Rückgängig stellt die vorige kanonische URL wieder her. Slug ohne Domain und ohne führenden Slash, z. B. "vase-kiesel-steinzeug-22-cm" bzw. "wohnen/wohnaccessoires".',
        { title: z.string(), reason: z.string(), salesChannelId: z.string().optional().describe('Standard: erster Verkaufskanal mit Domain'), languageId: z.string().optional().describe('Standard: Sprache der Kanal-Domain'), changes: z.array(z.object({ entity: z.enum(['product', 'category']), id: z.string(), slug: z.string() })) },
        guard(async a => { const cs = await buildSeoUrlChangeSet(sw, a); return ok(await session.requestChange(cs)); })),

      tool('seo_audit', 'Shopweiter SEO-Check (nur lesen), seitenweise für große Kataloge: entity=product|category prüft Meta-Title (fehlt, >60, <30, doppelt), Meta-Description (fehlt, außerhalb 120 bis 158, doppelt), dünne Beschreibung (<50 Wörter), Titelbild, Bilder ohne Alt-Text, fehlende/technische SEO-URL und Links in der Beschreibung (kaputte/inaktive Ziele); entity=pages prüft Links und Produkt-Slider/-Boxen in Einkaufswelten auf inaktive/fehlende Produkte, Kategorien und Seiten. Produkte: nur Hauptprodukte, die im Verkaufskanal sichtbar sind; Kategorien: Seiten unter Navigation/Footer/Service des Kanals. Liefert Anzahl je Problem (wichtig zuerst), IDs je Problem und die schwächsten Datensätze; nextOffset = nächste Seite (mit gleichem limit aufrufen). Ändert nichts; Korrekturen über propose_product_changes, propose_category_changes, propose_seo_urls.',
        { entity: z.enum(['product', 'category', 'pages']), limit: z.number().optional().describe('Datensätze pro Seite, Standard 100, max. 250 (pages: max. 50 Layouts)'), offset: z.number().optional(), includeInactive: z.boolean().optional().describe('Standard false: nur aktive'), categoryId: z.string().optional().describe('Nur Produkte dieser Kategorie'), salesChannelId: z.string().optional() },
        guard(async a => {
          const ctx = await linkContext(sw, a.salesChannelId);
          if (!ctx) return fail('Kein Verkaufskanal mit Domain gefunden');
          const pages = a.entity === 'pages', { limit, page, offset, note: offsetNote } = pageOf(a.offset, Math.min(Math.max(Math.round(a.limit ?? (pages ? 20 : 100)), 1), pages ? 50 : 250));
          if (pages) return ok(await auditPages(sw, ctx, limit, offset, offsetNote));
          const isP = a.entity === 'product';
          // Products: only those visible in the channel (Shopware only generates SEO URLs for them); categories: under navigation/footer/service
          const filter: Record<string, unknown>[] = isP ? [{ type: 'equals', field: 'parentId', value: null }, { type: 'equals', field: 'visibilities.salesChannelId', value: ctx.salesChannelId }, ...(a.categoryId ? [{ type: 'equals', field: 'categoriesRo.id', value: a.categoryId }] : [])] : [{ type: 'equals', field: 'type', value: 'page' }, ...ROOTS_FILTER(ctx)];
          if (!a.includeInactive) filter.push({ type: 'equals', field: 'active', value: true });
          const r = await sw.search(a.entity, { limit, page, filter, 'total-count-mode': 1, sort: [{ field: isP ? 'productNumber' : 'level', order: 'ASC' }, ...(isP ? [] : [{ field: 'name', order: 'ASC' }])], ...(isP ? { associations: { media: { associations: { media: {} } } } } : {}) });
          const { title: dT, desc: dD, truncated } = await duplicateMetas(sw, a.entity, filter, offset === 0); // duplicate metas shop-wide, following pages from the cache
          const seo = await canonicalSeoPaths(sw, ctx, r.data.map(e => ({ kind: a.entity as LinkKind, id: e.id }))).catch(() => null);
          const links = await checkLinks(sw, r.data.flatMap(e => extractLinks(e.translated?.description ?? '')), { ctx }).catch(() => null);
          const broken = new Set((links?.findings ?? []).filter(f => f.level === 'wichtig').map(f => f.href));
          const dups = { title: new Set(dT.keys()), desc: new Set(dD.keys()) };
          const rows = r.data.map(e => {
            const input = {
              id: e.id, name: e.translated?.name ?? e.name, number: e.productNumber, metaTitle: e.translated?.metaTitle, metaDescription: e.translated?.metaDescription, description: e.translated?.description, isProduct: isP,
              hasCover: !!e.coverId, imagesWithoutAlt: (e.media ?? []).filter((m: SwEntity) => { if (!m.media) return false; const alt = m.media.translated?.alt ?? m.media.alt; return !plainText(alt) || altIsFileName(alt, m.media.fileName); }).length, // like get_product_images/find_image_gaps: empty or just the file name
              seoPath: seo && e.active !== false ? (seo.get(`${ROUTE[a.entity as LinkKind]}:${e.id}`)?.seoPathInfo ?? null) : undefined, // inactive ones get no SEO URL
              brokenLinks: extractLinks(e.translated?.description ?? '').filter(l => broken.has(l.href)).length,
            };
            return { ...input, issues: evaluate(input, dups) };
          });
          const rep = summarize(rows, isP ? 'propose_product_changes' : 'propose_category_changes');
          const nextOffset = nextOffsetOf(offset, r.data.length, limit, r.total);
          return ok({
            entity: a.entity, salesChannel: ctx.salesChannel, total: r.total, offset, ...(offsetNote ? { offsetNote } : {}), checked: r.data.length, nextOffset, withIssues: rows.filter(x => x.issues.length).length, ...rep,
            duplicates: { metaTitle: [...dT].slice(0, 10).map(([value, ids]) => ({ value, ids: ids.slice(0, 20) })), metaDescription: [...dD].slice(0, 10).map(([value, ids]) => ({ value: value.slice(0, 80), ids: ids.slice(0, 20) })), ...(truncated ? { note: 'nur die ersten 5000 Datensätze verglichen' } : {}) },
            ...(seo ? {} : { note: 'SEO-URLs nicht lesbar (Bereich „Einkaufswelten-Layouts“ gesperrt), nicht geprüft' }),
            ...(ctx.languageId !== SYSTEM_LANGUAGE ? { languageNote: 'Metas und Texte wurden in der Standardsprache des Shops geprüft (dort schreiben auch propose_product_changes/propose_category_changes), SEO-URLs in der Sprache der Kanal-Domain' } : {}),
            hint: nextOffset != null ? `Weitere Datensätze: seo_audit mit offset=${nextOffset}, limit=${limit}` : 'Alle Datensätze geprüft.',
          });
        })),
    ] as AnyTool[];
  },
};

/** Shopping Experiences: check links in text/HTML elements and fixed products in sliders/boxes against the shop. */
export async function auditPages(sw: ShopReader, ctx: LinkCtx, limit: number, offset: number, offsetNote?: string) {
  const r = await sw.search('cms-page', { limit, page: offset / limit + 1, 'total-count-mode': 1, sort: [{ field: 'name', order: 'ASC' }], associations: { sections: { associations: { blocks: { associations: { slots: {} } } } } } });
  const pages = r.data.map(p => {
    const slots: SwEntity[] = (p.sections ?? []).flatMap((s: SwEntity) => (s.blocks ?? []).flatMap((b: SwEntity) => b.slots ?? []));
    const cfg = (sl: SwEntity) => sl.translated?.config ?? sl.config ?? {};
    const links = slots.flatMap(sl => collectLinks(cfg(sl)));
    const productIds = slots.flatMap(sl => { const c = cfg(sl); const v = c.products?.source === 'static' ? c.products.value : c.product?.source === 'static' ? [c.product.value] : []; return (Array.isArray(v) ? v : []).filter((x: unknown): x is string => typeof x === 'string' && HEX32.test(x)); });
    return { id: p.id, name: p.name, type: p.type, links, productIds: [...new Set(productIds)] };
  });
  const allLinks = [...pages.flatMap(p => p.links), ...pages.flatMap(p => p.productIds.map(id => ({ href: `/detail/${id}`, text: '(Produkt im Slider/Box)' })))];
  const rep = await checkLinks(sw, allLinks, { ctx });
  const found = pages.map(p => {
    const hrefs = new Set([...p.links.map(l => l.href), ...p.productIds.map(id => `/detail/${id}`)]);
    const fs = rep.findings.filter(f => hrefs.has(f.href));
    return { id: p.id, name: p.name, type: p.type, links: p.links.length, sliderProducts: p.productIds.length, problems: fs.map(f => ({ level: f.level, href: f.href, text: f.text, problem: f.problem, short: f.short })).slice(0, 15) };
  }).filter(p => p.problems.length);
  const nextOffset = nextOffsetOf(offset, r.data.length, limit, r.total);
  return {
    entity: 'pages', salesChannel: ctx.salesChannel, total: r.total, offset, ...(offsetNote ? { offsetNote } : {}), checked: r.data.length, nextOffset,
    counts: { wichtig: rep.findings.filter(f => f.level === 'wichtig').length, empfohlen: rep.findings.filter(f => f.level === 'empfohlen').length, technischeLinksMitSeoUrl: new Set(pages.flatMap(p => p.links.map(l => l.href)).filter(h => rep.rewrites.has(h))).size },
    pages: found.sort((a, b) => b.problems.filter(x => x.level === 'wichtig').length - a.problems.filter(x => x.level === 'wichtig').length),
    hint: (nextOffset != null ? `Weitere Layouts: seo_audit entity=pages offset=${nextOffset}, limit=${limit}. ` : '') + 'Inaktive/fehlende Ziele aus Slidern bzw. Texten entfernen oder ersetzen (Seite neu entwerfen/veröffentlichen); technische Links werden beim Veröffentlichen automatisch durch SEO-URLs ersetzt.',
  };
}
