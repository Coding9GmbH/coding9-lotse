import 'server-only';
// SEO rules (pure + change set/executor for SEO URLs): slug check, SEO audit per product/category, duplicate metas.
import type { ChangeItem, ChangeSet, UndoOp } from '@/lib/protocol';
import { htmlToText } from '@/lib/text';
import { MAX_ITEMS } from '../changes';
import { HEX32, newId, type ShopReader, type Shopware, type SwEntity } from '../shopware';
import { canonicalSeoPaths, linkContext, ROUTE, underRoots, visibleProducts, type LinkCtx } from '../seo-links';

export const KIND = 'seo-urls';
export const META = { titleMax: 60, titleMin: 30, descMin: 120, descMax: 158, thinWords: 50 };

// ---- Slugs ----
const RESERVED = /^(detail|navigation|landingpage|account|checkout|search|suggest|widgets|wishlist|note|newsletter|maintenance|api|store-api|admin|media|thumbnail|bundles|theme|sitemap|robots\.txt|cookie|form|_[a-z]+)$/;
/** Normalize (lowercase, ä→ae ö→oe ü→ue ß→ss, hyphens) and check a slug. Categories end with "/", as in Shopware. */
export function slugify(input: string, kind: 'product' | 'category'): { slug: string; error?: string } {
  let s = String(input ?? '').trim().replace(/^https?:\/\/[^/]+/i, '').toLowerCase();
  s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, '-und-').replace(/[^a-z0-9/]+/g, '-');
  const seg = s.split('/').map(x => x.replace(/-+/g, '-').replace(/^-|-$/g, '')).filter(Boolean);
  const slug = seg.join('/') + (kind === 'category' && seg.length ? '/' : '');
  if (!seg.length) return { slug, error: 'Slug ist leer' };
  if (seg.some(x => HEX32.test(x))) return { slug, error: 'Slug enthält eine technische ID' };
  if (RESERVED.test(seg[0])) return { slug, error: `„${seg[0]}“ ist ein reservierter Shopware-Pfad` };
  if (slug.length > 200) return { slug, error: 'Slug ist länger als 200 Zeichen' };
  return { slug };
}
export const pathKey = (p: string) => String(p ?? '').replace(/^\/+|\/+$/g, '').toLowerCase();
const variants = (slug: string) => { const k = slug.replace(/\/+$/, ''); return [k, k + '/']; };

// ---- Change set: custom SEO URLs ----
export interface SeoUrlChange { entity: 'product' | 'category'; id: string; slug: string }
export interface SeoUrlArgs { title: string; reason: string; salesChannelId?: string; languageId?: string; changes: SeoUrlChange[] }
/** Payload per item (afterRaw): exactly the fields of the new canonical seo-url */
export interface SeoUrlPayload { salesChannelId: string; languageId: string; foreignKey: string; routeName: string; pathInfo: string; seoPathInfo: string }
const PATH_INFO = { product: '/detail/', category: '/navigation/' } as const;
const NOUN = { product: 'Produkt', category: 'Kategorie' } as const;

export async function buildSeoUrlChangeSet(ro: ShopReader, a: SeoUrlArgs, ctxIn?: LinkCtx): Promise<ChangeSet> {
  if (!a.changes?.length) throw new Error('changes ist leer');
  if (a.changes.length > MAX_ITEMS) throw new Error(`Maximal ${MAX_ITEMS} SEO-URLs pro Änderungsset, bitte aufteilen.`);
  const ctx = ctxIn ?? await linkContext(ro, a.salesChannelId, a.languageId);
  if (!ctx) throw new Error('Kein Verkaufskanal mit Domain gefunden');
  const lang = (await ro.search('language', { ids: [ctx.languageId], limit: 1 }).catch(() => ({ data: [] as SwEntity[] }))).data[0];
  const ids = (e: 'product' | 'category') => [...new Set(a.changes.filter(c => c.entity === e).map(c => c.id))];
  const load = async (e: 'product' | 'category') => { const l = ids(e); return l.length ? (await ro.search(e, { ids: l, limit: l.length })).data : []; };
  const rows: Record<string, SwEntity> = Object.fromEntries([...(await load('product')).map(r => [`product:${r.id}`, r]), ...(await load('category')).map(r => [`category:${r.id}`, r])]);
  const visible = await visibleProducts(ro, ctx.salesChannelId, Object.entries(rows).filter(([k]) => k.startsWith('product:')).map(([, r]) => r));
  const cur = await canonicalSeoPaths(ro, ctx, a.changes.filter(c => c.entity === 'product' || c.entity === 'category').map(c => ({ kind: c.entity, id: c.id })));
  const norm = a.changes.map(c => ({ c, ...slugify(c.slug, c.entity === 'category' ? 'category' : 'product') }));
  const wanted = [...new Set(norm.filter(n => !n.error).flatMap(n => variants(n.slug)))];
  const taken = new Map<string, SwEntity[]>();
  for (let i = 0; i < wanted.length; i += 200) {
    const r = await ro.search('seo-url', { limit: 500, filter: [{ type: 'equalsAny', field: 'seoPathInfo', value: wanted.slice(i, i + 200) }, { type: 'equals', field: 'salesChannelId', value: ctx.salesChannelId }, { type: 'equals', field: 'languageId', value: ctx.languageId }] });
    for (const s of r.data) taken.set(pathKey(s.seoPathInfo), [...(taken.get(pathKey(s.seoPathInfo)) ?? []), s]);
  }
  const items: ChangeItem[] = [], skipped: { id: string; reason: string }[] = [], inSet = new Map<string, string>(); let unchanged = 0;
  for (const { c, slug, error } of norm) {
    const key = `${c.entity}:${c.id}`;
    if (c.entity !== 'product' && c.entity !== 'category') { skipped.push({ id: c.id, reason: `entity „${c.entity}“ nicht unterstützt (product, category)` }); continue; }
    const row = rows[key];
    if (!row) { skipped.push({ id: c.id, reason: `${NOUN[c.entity]} nicht gefunden` }); continue; }
    const label = c.entity === 'product' ? `${row.translated?.name ?? row.name ?? row.productNumber}${row.productNumber ? ` (${row.productNumber})` : ''}` : `${row.translated?.name ?? row.name}`;
    if (error) { skipped.push({ id: c.id, reason: `${label}: ${error} („${c.slug}“)` }); continue; }
    if (c.entity === 'product' && !visible.has(c.id)) { skipped.push({ id: c.id, reason: `${label}: im Verkaufskanal ${ctx.salesChannel} nicht sichtbar, dort gibt es keine Produktseite (erst Sichtbarkeit setzen)` }); continue; }
    if (inSet.has(key)) { skipped.push({ id: c.id, reason: `${label}: doppelt im Vorschlag` }); continue; }
    const k = pathKey(slug), route = ROUTE[c.entity], old = cur.get(`${route}:${c.id}`);
    if (old && old.seoPathInfo === slug && old.isModified) { unchanged++; continue; }
    const other = (taken.get(k) ?? []).find(s => !(s.foreignKey === c.id && s.routeName === route));
    if (other) { skipped.push({ id: c.id, reason: `${label}: „${slug}“ ist im Verkaufskanal schon vergeben (${other.routeName === ROUTE.product ? 'Produkt' : other.routeName === ROUTE.category ? 'Kategorie' : other.routeName} ${other.foreignKey})` }); continue; }
    const dup = [...inSet.entries()].find(([, s]) => s === k);
    if (dup) { skipped.push({ id: c.id, reason: `${label}: „${slug}“ ist im Vorschlag schon für ${dup[0]} vorgesehen` }); continue; }
    inSet.set(key, k);
    const warn: string[] = [];
    if (pathKey(c.slug) !== k) warn.push(`Slug normalisiert: „${c.slug}“ → „${slug}“`);
    if (row.active === false) warn.push(`${NOUN[c.entity]} ist inaktiv`);
    if (c.entity === 'category' && row.type && row.type !== 'page') warn.push(`Kategorie vom Typ „${row.type}“ hat keine eigene Seite`);
    if (c.entity === 'category' && !underRoots(ctx, row)) warn.push(`Kategorie liegt nicht unter Navigation/Footer/Service von ${ctx.salesChannel}`);
    if (old && pathKey(old.seoPathInfo) !== k) warn.push('Bisherige URL bleibt als Weiterleitung (301) auf die neue erhalten');
    else if (old && old.seoPathInfo !== slug) warn.push(`Nur Schreibweise geändert („${old.seoPathInfo}“ → „${slug}“)`);
    else if (old) warn.push('URL bleibt gleich und wird als eigene URL festgeschrieben (Shopware generiert sie nicht mehr neu)');
    const payload: SeoUrlPayload = { salesChannelId: ctx.salesChannelId, languageId: ctx.languageId, foreignKey: c.id, routeName: route, pathInfo: PATH_INFO[c.entity] + c.id, seoPathInfo: slug };
    items.push({ id: key, entity: c.entity, entityId: c.id, label, field: 'seoUrl', fieldLabel: `SEO-URL · ${ctx.salesChannel}${lang ? ` · ${lang.translated?.name ?? lang.name}` : ''}`,
      before: old ? `${ctx.domain}/${old.seoPathInfo}` : '– (keine SEO-URL)', after: `${ctx.domain}/${slug}`, afterRaw: payload, warn });
  }
  if (!items.length) throw new Error(`Keine SEO-URL anwendbar (${unchanged} unverändert, ${skipped.length} übersprungen: ${skipped.slice(0, 3).map(s => s.reason).join('; ')})`);
  return { id: newId(), kind: KIND, entity: 'seo-url', noun: { one: 'SEO-URL', many: 'SEO-URLs' }, applyLabel: 'SEO-URLs setzen', title: a.title, reason: a.reason, items, skipped, unchanged, atomic: false };
}

/** Writes a custom canonical SEO URL (isModified = true, Shopware no longer overwrites it); returns exact undo steps. */
export async function applySeoUrl(swW: Pick<Shopware, 'search' | 'create' | 'update' | 'req'>, p: SeoUrlPayload): Promise<UndoOp[]> {
  const base = [{ type: 'equals', field: 'salesChannelId', value: p.salesChannelId }, { type: 'equals', field: 'languageId', value: p.languageId }];
  const own = { type: 'equals', field: 'foreignKey', value: p.foreignKey }, route = { type: 'equals', field: 'routeName', value: p.routeName };
  // canonical: unique per (channel, language, target, route); an entry marked as deleted also occupies the slot
  const cur = (await swW.search('seo-url', { limit: 1, filter: [...base, own, route, { type: 'equals', field: 'isCanonical', value: true }] })).data[0];
  const byPath = (await swW.search('seo-url', { limit: 10, filter: [...base, { type: 'equalsAny', field: 'seoPathInfo', value: variants(p.seoPathInfo) }] })).data;
  if (byPath.some(s => !(s.foreignKey === p.foreignKey && s.routeName === p.routeName))) throw new Error(`„${p.seoPathInfo}“ ist inzwischen vergeben`);
  const same = byPath[0];
  const restore = (s: SwEntity, keys: string[]): UndoOp => ({ op: 'patch', entity: 'seo-url', id: s.id, data: Object.fromEntries(keys.map(k => [k, s[k] ?? null])) });
  if (cur && same && cur.id === same.id) { // same URL (spelling) → only mark/adjust
    await swW.update('seo-url', cur.id, { seoPathInfo: p.seoPathInfo, isModified: true });
    return [restore(cur, ['seoPathInfo', 'isModified'])];
  }
  const undo: UndoOp[] = [];
  if (cur) { await swW.update('seo-url', cur.id, { isCanonical: null }); undo.push(restore(cur, ['isCanonical'])); } // make room for the new canonical URL
  try {
    if (same) { // a previous URL of this entry becomes canonical again
      await swW.update('seo-url', same.id, { seoPathInfo: p.seoPathInfo, isCanonical: true, isModified: true, isDeleted: false });
      undo.push(restore(same, ['seoPathInfo', 'isCanonical', 'isModified', 'isDeleted']));
    } else {
      const id = newId();
      await swW.create('seo-url', { id, ...p, isCanonical: true, isModified: true, isDeleted: false });
      undo.push({ op: 'delete', entity: 'seo-url', id });
    }
  } catch (e) { if (cur) await swW.update('seo-url', cur.id, { isCanonical: true }).catch(() => {}); throw e; }
  return undo;
}

// ---- SEO-Audit ----
export type Level = 'wichtig' | 'empfohlen';
export interface IssueDef { label: string; level: Level; w: number; fix: string }
export const ISSUES: Record<string, IssueDef> = {
  'seoUrl.missing': { label: 'Keine SEO-URL (nur technischer Pfad)', level: 'wichtig', w: 3, fix: 'propose_seo_urls' },
  'links.broken': { label: 'Beschreibung verlinkt kaputte/inaktive Ziele', level: 'wichtig', w: 3, fix: 'Beschreibung korrigieren (propose_*_changes, description)' },
  'metaTitle.missing': { label: 'Meta-Title fehlt', level: 'wichtig', w: 3, fix: 'metaTitle' },
  'metaTitle.duplicate': { label: 'Meta-Title doppelt vergeben', level: 'wichtig', w: 3, fix: 'metaTitle' },
  'metaDescription.missing': { label: 'Meta-Description fehlt', level: 'wichtig', w: 3, fix: 'metaDescription' },
  'image.cover': { label: 'Kein Titelbild', level: 'wichtig', w: 3, fix: 'Produktbild ergänzen' },
  'metaTitle.long': { label: `Meta-Title länger als ${META.titleMax} Zeichen`, level: 'empfohlen', w: 2, fix: 'metaTitle' },
  'metaDescription.length': { label: `Meta-Description außerhalb ${META.descMin} bis ${META.descMax} Zeichen`, level: 'empfohlen', w: 2, fix: 'metaDescription' },
  'metaDescription.duplicate': { label: 'Meta-Description doppelt vergeben', level: 'empfohlen', w: 2, fix: 'metaDescription' },
  'description.thin': { label: `Beschreibung fehlt oder dünn (< ${META.thinWords} Wörter)`, level: 'empfohlen', w: 2, fix: 'description' },
  'image.alt': { label: 'Bilder ohne Alt-Text (leer oder nur Dateiname)', level: 'empfohlen', w: 2, fix: 'Alt-Texte der Bilder (Medien) pflegen' },
  'seoUrl.technical': { label: 'SEO-URL enthält technische ID', level: 'empfohlen', w: 2, fix: 'propose_seo_urls' },
  'metaTitle.short': { label: `Meta-Title kürzer als ${META.titleMin} Zeichen`, level: 'empfohlen', w: 1, fix: 'metaTitle' },
};

export interface AuditInput { id: string; name?: string; number?: string; metaTitle?: string | null; metaDescription?: string | null; description?: string | null; isProduct: boolean; hasCover?: boolean; imagesWithoutAlt?: number; seoPath?: string | null; brokenLinks?: number }
const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();
export const wordCount = (html: unknown) => (htmlToText(String(html ?? '')).match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;
export const dupKey = (t: unknown) => clean(t).toLowerCase();

/** Check items of a product/category. dups: meta values that occur more than once in the shop. */
export function evaluate(e: AuditInput, dups: { title: Set<string>; desc: Set<string> }): string[] {
  const out: string[] = [], mt = clean(e.metaTitle), md = clean(e.metaDescription);
  if (e.seoPath === null) out.push('seoUrl.missing'); else if (e.seoPath && /(^|\/)[0-9a-f]{32}(\/|$)/i.test(e.seoPath)) out.push('seoUrl.technical');
  if (e.brokenLinks) out.push('links.broken');
  if (!mt) out.push('metaTitle.missing');
  else { if (mt.length > META.titleMax) out.push('metaTitle.long'); else if (mt.length < META.titleMin) out.push('metaTitle.short'); if (dups.title.has(dupKey(mt))) out.push('metaTitle.duplicate'); }
  if (!md) out.push('metaDescription.missing');
  else { if (md.length < META.descMin || md.length > META.descMax) out.push('metaDescription.length'); if (dups.desc.has(dupKey(md))) out.push('metaDescription.duplicate'); }
  if (wordCount(e.description) < META.thinWords) out.push('description.thin');
  if (e.isProduct && e.hasCover === false) out.push('image.cover');
  if (e.isProduct && (e.imagesWithoutAlt ?? 0) > 0) out.push('image.alt');
  return out;
}

/** Values that occur in more than one record (normalized). */
export function duplicates(rows: { id: string; value: unknown }[]): Map<string, string[]> {
  const by = new Map<string, string[]>();
  for (const r of rows) { const k = dupKey(r.value); if (k) by.set(k, [...(by.get(k) ?? []), r.id]); }
  return new Map([...by].filter(([, ids]) => ids.length > 1));
}

/** Report: count per issue (important first), IDs per issue (truncated) and the weakest records. */
export function summarize(rows: (AuditInput & { issues: string[] })[], fixTool: string, listMax = 50) {
  const counts = new Map<string, string[]>();
  for (const r of rows) for (const c of r.issues) counts.set(c, [...(counts.get(c) ?? []), r.id]);
  const order = [...counts.keys()].sort((a, b) => ISSUES[b].w - ISSUES[a].w || counts.get(b)!.length - counts.get(a)!.length);
  const fix = (d: IssueDef) => (/^(meta|description)/.test(d.fix) ? `${fixTool} fields.${d.fix}` : d.fix);
  return {
    summary: order.map(c => ({ issue: c, label: ISSUES[c].label, level: ISSUES[c].level, count: counts.get(c)!.length, fix: fix(ISSUES[c]) })),
    ids: Object.fromEntries(order.map(c => [c, counts.get(c)!.slice(0, listMax)])),
    worst: rows.filter(r => r.issues.length).map(r => ({ r, score: r.issues.reduce((n, c) => n + ISSUES[c].w, 0) })).sort((a, b) => b.score - a.score).slice(0, 25)
      .map(({ r }) => ({ id: r.id, name: r.name, ...(r.number ? { number: r.number } : {}), issues: r.issues })),
  };
}
