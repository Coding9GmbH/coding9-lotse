import 'server-only';
// Google Search Console: real search data instead of rules of thumb. Performance, opportunities (weak click rate), content gaps,
// impact measurement of applied changes (metas, texts, layouts).
// Read only (Google + shop). Shop changes still go through propose_product_changes / propose_category_changes.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, CheckFinding, MeasureTarget, SeoImpact } from '@/lib/protocol';
import { onApplied, pool } from '../changes';
import { registerCheck } from '../checks';
import { kvGet, kvSet } from '../db';
import type { LinkKind } from '../seo-links';
import type { ShopReader } from '../shopware';
import type { ShopLookup } from '../platform/types';
import { asLookup } from '../platform/shopware/lookup';
import { getPlatform } from '../platform';
import { ok, guard, type AnyTool } from '../tool-kit';
import type { Feature } from './types';
import { getSettings } from '../settings';
import { getGscConfig, searchAnalyticsCached, type Dim, type DimFilter, type Operator, type Row, type ServiceKey } from './gsc-google';
import { addDays, aggregate, BASE_DAYS, baselineKind, cannibalization, compareEffect, contentGaps, declines, isoDay, LAG_DAYS, MIN_IMPRESSIONS, measureWindow, opportunities, pathRegex, pct, range, round, strikingDistance, view, type Baseline, type Metrics, type Verdict } from './gsc-logic';
import type { PageRef } from './gsc-map';

type Cfg = { key: ServiceKey; property: string };
const NOT_CONNECTED = 'Google Search Console ist nicht verbunden. Der Nutzer kann sie unter Einstellungen → Integrationen → Search Console einrichten (Service-Konto + Property).';
const BLOCKED = 'Der Zugriff der KI auf die Search Console ist ausgeschaltet. Der Nutzer kann ihn unter Einstellungen → KI-Zugriff aktivieren.';
const allowed = () => getSettings().scopes.gsc !== false;
const need = (): Cfg => { if (!allowed()) throw new Error(BLOCKED); const c = getGscConfig(); if (!c) throw new Error(NOT_CONNECTED); return c; };
const LAG_NOTE = `Search-Console-Daten sind ca. ${LAG_DAYS} Tage alt; der Zeitraum endet deshalb vor heute.`;
export const propose = (label: string): Record<string, string> => ({ product: 'propose_product_changes', category: 'propose_category_changes', landing: `Landingpage-Metas: im ${label}-Admin bzw. beim Neuveröffentlichen der Seite (publish_page)`, home: `Startseite: Metas des Verkaufskanals im ${label}-Admin` });
/** Read side: platform-neutral (ShopLookup); a Shopware read client is accepted as before */
type Shop = ShopReader | ShopLookup;
const KIND_OF: Record<string, LinkKind> = { product: 'product', category: 'category', 'landing-page': 'landing' };
/** Fields whose change can move search traffic: metas, name/title, texts and FAQ (not prices, stock or status) */
export const MEASURED_FIELDS = new Set(['metaTitle', 'metaDescription', 'keywords', 'name', 'description', 'shortDescription', 'faq']);
/** At most this many pages per change set get a baseline (two Search Console queries each) */
export const MAX_BASELINES = 50;

// ---- Baselines for success measurement ----
const KV = 'gsc_baselines';
export const listBaselines = (): Baseline[] => kvGet<Baseline[]>(KV) ?? [];
const saveBaselines = (b: Baseline[]) => kvSet(KV, b.slice(-500));
const metrics = (rows: Row[]): Metrics => aggregate(rows);

/** Remembers clicks/impressions/CTR/position of the last 28 days for a page that was just changed. Only if Google knows the page. */
export async function recordBaseline(cfg: Cfg, ro: Shop, a: { entity: Baseline['entity']; entityId: string; label: string; fields: Baseline['fields']; changeSetId: string; chatId?: string }, now = new Date()): Promise<Baseline | null> {
  const kind = KIND_OF[a.entity];
  const { paths, urls } = await asLookup(ro).entityPaths(kind, a.entityId);
  if (!paths.length) return null;
  const r = range(BASE_DAYS, now), re = pathRegex(paths);
  const rows = await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['page'], filters: [{ dimension: 'page', operator: 'includingRegex', expression: re }] });
  const m = metrics(rows);
  if (!m.impressions) return null;
  const site = metrics(await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate }));
  const b: Baseline = { id: `b_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`, entity: a.entity, entityId: a.entityId, label: a.label, urls: rows.length ? rows.map(x => x.keys[0]) : urls, pathRegex: re, fields: a.fields,
    changedAt: now.toISOString(), changeSetId: a.changeSetId, chatId: a.chatId, before: { ...m, startDate: r.startDate, endDate: r.endDate, days: r.days }, site };
  // Earlier, not yet measured baselines of the same page are skewed from now on
  const all = listBaselines().map(x => (x.entityId === a.entityId && !x.measured ? { ...x, measured: { at: now.toISOString(), verdict: 'überholt: Seite erneut geändert, bevor gemessen wurde' } } : x));
  saveBaselines([...all, b]);
  return b;
}

/** Observer: applied change sets with SEO-relevant fields (metas, texts, FAQ) of products, categories, landing pages,
 *  plus existing pages whose layout/page content a publish replaced (targets). At most MAX_BASELINES pages per set. */
export async function baselinesFor(cfg: Cfg, items: ChangeItem[], ctx: { ro: Shop; chatId?: string; changeSetId: string; targets?: MeasureTarget[]; layout?: string }, now = new Date()) {
  const groups = new Map<string, { entity: Baseline['entity']; entityId: string; label: string; fields: Baseline['fields'] }>();
  for (const it of items) {
    if (!it.field || !MEASURED_FIELDS.has(it.field) || !it.entityId || !KIND_OF[it.entity]) continue;
    const k = `${it.entity}:${it.entityId}`, g = groups.get(k) ?? { entity: it.entity as Baseline['entity'], entityId: it.entityId, label: it.label, fields: [] };
    // afterRaw only for plain strings: the drift check compares it with today's value (FAQ objects and HTML stay without)
    g.fields.push({ field: it.field, before: it.before, after: it.after, afterRaw: typeof it.afterRaw === 'string' && it.field !== 'description' ? it.afterRaw : undefined });
    groups.set(k, g);
  }
  for (const t of ctx.targets ?? []) {
    const k = `${t.entity}:${t.id}`, g = groups.get(k) ?? { entity: t.entity, entityId: t.id, label: t.label, fields: [] };
    g.fields.push({ field: 'layout', before: 'bisheriger Seiteninhalt', after: ctx.layout ?? 'neuer Seiteninhalt' });
    groups.set(k, g);
  }
  const out: Baseline[] = [];
  for (const g of [...groups.values()].slice(0, MAX_BASELINES)) {
    const b = await recordBaseline(cfg, ctx.ro, { ...g, changeSetId: ctx.changeSetId, chatId: ctx.chatId }, now).catch(() => null);
    if (b) out.push(b);
  }
  return out;
}
onApplied('gsc', async (cs, items, { ro, lookup, chatId }) => {
  const cfg = allowed() ? getGscConfig() : null;
  if (cfg) await baselinesFor(cfg, items, { ro: lookup ?? ro, chatId, changeSetId: cs.id, targets: cs.measureTargets, layout: cs.title });
});

/** Measure success: baseline vs. equally long period after the change (after 14 days of data at the earliest). */
export async function measure(cfg: Cfg, ro: Shop, b: Baseline, now = new Date()) {
  const w = measureWindow(b, now);
  const head = { baselineId: b.id, entity: b.entity, entityId: b.entityId, label: b.label, changedAt: b.changedAt.slice(0, 10), fields: b.fields.map(f => ({ field: f.field, before: f.before, after: f.after })), urls: b.urls.slice(0, 3), before: { ...view(b.before), period: `${b.before.startDate} bis ${b.before.endDate}` } };
  if (w.status === 'zu früh') return { ...head, status: 'zu früh' as const, measurableFrom: w.measurableFrom, completeFrom: w.completeFrom, message: `Noch nicht messbar: ${w.days ? `erst ${w.days} ${w.days === 1 ? 'Tag' : 'Tage'}` : 'noch keine'} Daten nach der Änderung. Vorläufig messbar ab ${w.measurableFrom}, vollständig ab ${w.completeFrom}.` };
  const rows = await searchAnalyticsCached(cfg, { startDate: w.startDate, endDate: w.endDate!, dimensions: ['page'], filters: [{ dimension: 'page', operator: 'includingRegex', expression: b.pathRegex }] });
  const after = metrics(rows);
  const siteAfter = b.site ? metrics(await searchAnalyticsCached(cfg, { startDate: w.startDate, endDate: w.endDate! })) : null;
  const res = compareEffect({ ...b.before, days: b.before.days }, { ...after, days: w.days }, b.site && siteAfter ? { before: { ...b.site, days: b.before.days }, after: { ...siteAfter, days: w.days } } : undefined);
  // Has the change been overwritten or undone in the meantime?
  const cur = await asLookup(ro).current(b.entity, b.entityId).catch(() => null);
  const drift = cur ? b.fields.filter(f => f.afterRaw != null && (cur.translated?.[f.field] ?? cur[f.field] ?? null) !== f.afterRaw).map(f => f.field) : [];
  if (drift.length) res.notes.unshift(`Achtung: ${drift.join(', ')} hat heute einen anderen Wert als nach der Änderung (rückgängig gemacht oder erneut geändert). Die Messung bezieht sich nicht mehr eindeutig auf diese Änderung.`);
  if (w.status === 'vorläufig') res.notes.unshift(`Vorläufig: erst ${w.days} von ${b.before.days} Tagen nach der Änderung verfügbar (vergleicht Durchschnitt pro Tag). Vollständig ab ${w.completeFrom}.`);
  const last: Baseline['last'] = { at: now.toISOString(), status: w.status, verdict: res.verdict, change: { clicksPerDay: res.change.clicksPerDay, ctr: res.change.ctr, position: res.change.position }, after, drift: drift.length > 0 };
  saveBaselines(listBaselines().map(x => (x.id !== b.id ? x : { ...x, last, ...(w.status === 'vollständig' && !x.measured ? { measured: { at: now.toISOString(), verdict: res.verdict } } : {}) })));
  return { ...head, status: w.status, after: { ...res.after, period: `${w.startDate} bis ${w.endDate}` }, verdict: res.verdict, change: res.change, zScore: res.zScore, notes: res.notes, beforeDetail: res.before };
}

// ---- Impact list for the SEO section: stored state only, never a request to Google ----
const VERDICT: Record<Verdict, NonNullable<SeoImpact['verdict']>> = { verbessert: 'better', verschlechtert: 'worse', 'kein klarer Effekt': 'unclear', 'zu wenig Daten': 'little-data' };
const perDay = (n: number, days: number) => round(n / Math.max(1, days), 2);

export function impactView(b: Baseline, now = new Date()): SeoImpact {
  const w = measureWindow(b, now), superseded = !!b.measured && !b.last && /überholt/.test(b.measured.verdict);
  const status: SeoImpact['status'] = superseded ? 'superseded' : b.last?.status === 'vollständig' ? 'complete' : w.status === 'zu früh' ? 'too-early' : 'preliminary';
  return {
    id: b.id, entity: b.entity, entityId: b.entityId, label: b.label, kind: baselineKind(b.fields), fields: b.fields.map(f => f.field), changedAt: b.changedAt, ...(b.chatId ? { chatId: b.chatId } : {}),
    status, measurableFrom: w.measurableFrom, completeFrom: w.completeFrom,
    before: { clicksPerDay: perDay(b.before.clicks, b.before.days), ctr: round(b.before.ctr * 100, 2), position: round(b.before.position) },
    ...(b.last ? { verdict: VERDICT[b.last.verdict], change: b.last.change, measuredAt: b.last.at, ...(b.last.drift ? { drift: true } : {}) } : {}),
    ...(b.dismissed ? { dismissed: true } : {}),
  };
}
/** Newest change first */
export const impactList = (now = new Date()): SeoImpact[] => [...listBaselines()].reverse().map(b => impactView(b, now));

/** Measure all open changes that already have enough days (not final, not superseded, not hidden); at most `limit` per call */
export async function measureOpen(cfg: Cfg, ro: Shop, now = new Date(), limit = 30) {
  const open = [...listBaselines()].reverse().filter(b => !b.measured && !b.dismissed && measureWindow(b, now).status !== 'zu früh').slice(0, limit);
  const failed: { id: string; error: string }[] = [];
  await pool(open, 3, b => measure(cfg, ro, b, now).catch(e => { failed.push({ id: b.id, error: e instanceof Error ? e.message : String(e) }); }));
  return { measured: open.length - failed.length, failed };
}

/** Hide/show a measurement in the SEO section (the AI still sees it); false if the id is unknown */
export function dismissImpact(id: string, dismissed: boolean, now = new Date()): boolean {
  const all = listBaselines(); if (!all.some(b => b.id === id)) return false;
  saveBaselines(all.map(b => (b.id !== id ? b : { ...b, dismissed: dismissed ? now.toISOString() : undefined })));
  return true;
}

// ---- Opportunities + content gaps (also for the shop check) ----
export async function findOpportunities(cfg: Cfg, ro: Shop, a: { days?: number; minImpressions?: number; maxPosition?: number; top?: number; queries?: boolean }, now = new Date()) {
  const r = range(a.days ?? BASE_DAYS, now);
  const rows = await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['page'], maxRows: 50_000 });
  const all = opportunities(rows, { minImpressions: a.minImpressions, maxPosition: a.maxPosition });
  const top = all.slice(0, Math.min(Math.max(a.top ?? 15, 1), 50));
  const map = await asLookup(ro).mapUrls(top.map(o => o.page), { metas: true }).catch(() => null);
  const queries = new Map<string, Row[]>();
  if (a.queries !== false) await pool(top, 3, async o => { queries.set(o.page, (await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['query'], filters: [{ dimension: 'page', operator: 'equals', expression: o.page }], maxRows: 5 })).slice(0, 5)); });
  return { period: r, pagesChecked: rows.length, total: all.length, mapped: !!map, items: top.map(o => ({ o, ref: map?.get(o.page) ?? null, queries: queries.get(o.page) ?? [] })) };
}
// ---- Rankings: just short of page 1, cannibalization, losses (also for the shop check and SEO area) ----
/** One query [query, page] for the last 28 days, plus [page] for this and the previous period; all cached. */
export async function rankingInsights(cfg: Cfg, ro: Shop, a: { top?: number } = {}, now = new Date()) {
  const r = range(BASE_DAYS, now), prev = range(BASE_DAYS, now, addDays(r.startDate, -1));
  const [qp, cur, before] = await Promise.all([
    searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['query', 'page'], maxRows: 50_000 }),
    searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['page'], maxRows: 50_000 }),
    searchAnalyticsCached(cfg, { startDate: prev.startDate, endDate: prev.endDate, dimensions: ['page'], maxRows: 50_000 }),
  ]);
  const top = Math.min(Math.max(a.top ?? 10, 1), 50);
  const striking = strikingDistance(qp), cannibal = cannibalization(qp), decline = declines(before, cur);
  const s = striking.slice(0, top), c = cannibal.slice(0, top), d = decline.slice(0, top);
  const map = await asLookup(ro).mapUrls([...new Set([...s.map(x => x.page), ...c.flatMap(x => x.pages.map(p => p.page)), ...d.map(x => x.page)])], { metas: true }).catch(() => null);
  const ref = (u: string) => map?.get(u) ?? null;
  return { period: r, previous: prev, totals: { striking: striking.length, cannibal: cannibal.length, decline: decline.length },
    striking: s.map(x => ({ x, ref: ref(x.page) })), cannibal: c.map(x => ({ x, refs: x.pages.map(p => ref(p.page)) })), decline: d.map(x => ({ x, ref: ref(x.page) })) };
}

export const refView = (ref: PageRef | null) => (ref ? { kind: ref.kind, ...(ref.id ? { id: ref.id } : {}), name: ref.name, ...(ref.number ? { number: ref.number } : {}), ...(ref.active === false ? { active: false } : {}) } : null);

// ---- Shop check (only if connected) ----
registerCheck({ id: 'gsc.low-ctr', area: 'Search Console', scopes: ['gsc'], platforms: 'all', run: async (sw, ctx) => {
  const cfg = getGscConfig(); if (!cfg) return null;
  const r = await findOpportunities(cfg, ctx?.lookup ?? sw, { top: 5, queries: false });
  const f: CheckFinding = { id: 'gsc.low-ctr', area: 'Search Console', severity: r.total >= 10 ? 'hoch' : 'mittel', count: r.total, total: r.pagesChecked,
    title: r.total ? `${r.total} ${r.total === 1 ? 'Seite' : 'Seiten'} mit vielen Impressionen und schwacher Klickrate` : 'Klickraten passen zu den Positionen',
    sample: r.items.map(x => ({ id: x.ref?.id ?? x.o.page, label: `${x.ref?.name ?? x.o.page} (${x.o.impressions} Impr., CTR ${pct(x.o.ctr)}, Position ${String(round(x.o.position)).replace('.', ',')})` })),
    hint: 'Google zeigt diese Seiten oft, aber wenige klicken. Meist helfen ein klarerer Meta-Title und eine Meta-Description mit Nutzen (Daten der letzten 28 Tage).',
    fixPrompt: 'Zeige mir die Search-Console-Chancen (Seiten mit vielen Impressionen und schwacher Klickrate) und schlage für die wichtigsten bessere Meta-Titles und Meta-Descriptions vor.' };
  return f;
} });
registerCheck({ id: 'gsc.cannibalization', area: 'Search Console', scopes: ['gsc'], platforms: 'all', run: async (sw, ctx) => {
  const cfg = getGscConfig(); if (!cfg) return null;
  const r = await rankingInsights(cfg, ctx?.lookup ?? sw, { top: 5 }), n = r.totals.cannibal;
  return { id: 'gsc.cannibalization', area: 'Search Console', severity: n >= 5 ? 'mittel' : 'niedrig', count: n,
    title: n ? `${n} ${n === 1 ? 'Suchanfrage' : 'Suchanfragen'}, bei denen eigene Seiten gegeneinander ranken` : 'Keine eigenen Seiten, die gegeneinander ranken',
    sample: r.cannibal.map(({ x }) => ({ id: x.query, label: `„${x.query}“: ${x.pages.length} Seiten, beste Position ${String(round(x.bestPosition)).replace('.', ',')}` })),
    hint: 'Teilen sich mehrere Seiten dieselbe Suchanfrage, weiß Google nicht, welche gemeint ist, und beide ranken schwächer. Eine Hauptseite festlegen und die anderen auf eigene Themen schärfen.',
    fixPrompt: 'Zeige mir die Suchanfragen, bei denen eigene Seiten gegeneinander ranken (Search Console), und schlage je Anfrage eine Hauptseite und konkrete Änderungen vor.' };
} });
registerCheck({ id: 'gsc.decline', area: 'Search Console', scopes: ['gsc'], platforms: 'all', run: async (sw, ctx) => {
  const cfg = getGscConfig(); if (!cfg) return null;
  const r = await rankingInsights(cfg, ctx?.lookup ?? sw, { top: 5 }), n = r.totals.decline;
  return { id: 'gsc.decline', area: 'Search Console', severity: n >= 5 ? 'hoch' : 'mittel', count: n,
    title: n ? `${n} ${n === 1 ? 'Seite' : 'Seiten'} mit deutlich weniger Klicks als in den 28 Tagen davor` : 'Keine Seite hat auffällig Klicks verloren',
    sample: r.decline.map(({ x, ref }) => ({ id: ref?.id ?? x.page, label: `${ref?.name ?? x.page}: ${x.before.clicks} → ${x.after.clicks} Klicks (Position ${String(round(x.before.position)).replace('.', ',')} → ${String(round(x.after.position)).replace('.', ',')})` })),
    hint: 'Mindestens 30 % weniger Klicks, stärker als der Trend des ganzen Shops. Häufige Ursachen: Seite inaktiv oder ausverkauft, geänderte URL oder Texte, Wettbewerber, Google-Update.',
    fixPrompt: 'Welche Seiten haben laut Search Console Klicks verloren? Finde für die wichtigsten die betroffenen Suchanfragen und mögliche Ursachen und schlage Gegenmaßnahmen vor.' };
} });
registerCheck({ id: 'gsc.measure-due', area: 'Search Console', scopes: ['gsc'], platforms: 'all', run: async () => {
  if (!getGscConfig()) return null;
  const all = listBaselines(), due = all.filter(b => !b.measured && measureWindow(b).status === 'vollständig');
  if (!all.length) return null;
  return { id: 'gsc.measure-due', area: 'Search Console', severity: 'niedrig', count: due.length, total: all.length,
    title: due.length ? `Messung fällig: ${due.length} ${due.length === 1 ? 'Änderung' : 'Änderungen'} älter als 28 Tage` : 'Keine Erfolgsmessung fällig',
    sample: due.slice(0, 5).map(b => ({ id: b.entityId, label: `${b.label} (geändert am ${b.changedAt.slice(0, 10)})` })),
    hint: 'Vergleicht Klicks, Klickrate und Position vor und nach der Änderung, damit du siehst, was gewirkt hat.',
    fixPrompt: 'Miss den Erfolg meiner Änderungen (Metas, Texte, Layouts) mit den Search-Console-Daten und fasse zusammen, was gewirkt hat.' };
} });

registerCheck({ id: 'gsc.impact-worse', area: 'Search Console', scopes: ['gsc'], platforms: 'all', run: async () => {
  if (!getGscConfig()) return null;
  const all = listBaselines(); if (!all.length) return null;
  const worse = all.filter(b => !b.dismissed && b.last?.status === 'vollständig' && b.last.verdict === 'verschlechtert' && !b.last.drift);
  return { id: 'gsc.impact-worse', area: 'Search Console', severity: worse.length ? 'mittel' : 'niedrig', count: worse.length, total: all.length,
    title: worse.length ? `${worse.length} ${worse.length === 1 ? 'Änderung hat' : 'Änderungen haben'} laut Search Console geschadet` : 'Keine gemessene Änderung hat geschadet',
    sample: worse.slice(-5).reverse().map(b => ({ id: b.entityId, label: `${b.label} (geändert am ${b.changedAt.slice(0, 10)}, Klicks pro Tag ${b.last!.change.clicksPerDay})` })),
    hint: 'Die Klickrate ist nach der Änderung deutlich gesunken, stärker als normale Schwankung. Prüfen, ob die alte Fassung besser war; Rückgängig geht im Chat der Änderung.',
    fixPrompt: 'Welche meiner Änderungen haben laut Search Console geschadet (gsc_measure_effect mit includeMeasured)? Vergleiche je Seite alte und neue Fassung, nenne mögliche Gründe und schlage vor, ob ich die Änderung im ursprünglichen Chat rückgängig machen oder gezielt verbessern sollte.' };
} });

// ---- Tools ----
const filterSchema = z.object({ operator: z.enum(['contains', 'equals', 'notContains', 'regex']).optional().describe('Standard contains'), expression: z.string().min(1) });
const toFilter = (dimension: Dim, f?: { operator?: string; expression: string }): DimFilter[] => (f ? [{ dimension, operator: (f.operator === 'regex' ? 'includingRegex' : f.operator ?? 'contains') as Operator, expression: f.expression }] : []);
const dateArgs = { days: z.number().optional().describe('Zeitraum in Tagen bis zum letzten Datentag, Standard 28'), startDate: z.string().optional().describe('JJJJ-MM-TT (statt days)'), endDate: z.string().optional().describe('JJJJ-MM-TT, Standard: heute minus 3 Tage') };

export const gsc: Feature = {
  key: 'gsc',
  platforms: 'all',
  toolNames: ['gsc_performance', 'gsc_opportunities', 'gsc_content_gaps', 'gsc_rankings', 'gsc_measure_effect'],
  tools: session => {
    const { lookup } = session, PROPOSE = propose(getPlatform(session.platform).label);
    return [
      tool('gsc_performance', 'Liest echte Suchdaten aus der Google Search Console (Klicks, Impressionen, Klickrate, durchschnittliche Position) gruppiert nach Seite (page), Suchanfrage (query) oder Tag (date), mit Filtern auf Seite/Anfrage, sortiert, Top N. Seiten werden auf Produkte/Kategorien/Landingpages des Shops abgebildet. Liefert auch die Summen des Zeitraums. Ändert nichts, schreibt nichts in den Shop.',
        { dimension: z.enum(['page', 'query', 'date']), ...dateArgs, page: filterSchema.optional().describe('Filter auf die Seiten-URL, z. B. {expression:"/wohnen/"}'), query: filterSchema.optional().describe('Filter auf die Suchanfrage'),
          sortBy: z.enum(['clicks', 'impressions', 'ctr', 'position']).optional().describe('Standard clicks (date: chronologisch)'), top: z.number().optional().describe('Standard 25, max. 200'), minImpressions: z.number().optional(), fresh: z.boolean().optional().describe('true: auch noch nicht endgültige Daten der letzten Tage') },
        guard(async a => {
          const cfg = need(), r = range(a.days ?? BASE_DAYS, new Date(), a.endDate, a.startDate);
          const filters = [...toFilter('page', a.page), ...toFilter('query', a.query)], dataState = a.fresh ? 'all' as const : 'final' as const;
          const rows = await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: [a.dimension], filters, dataState, maxRows: 50_000 });
          const totals = metrics(await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, filters, dataState }));
          const n = Math.min(Math.max(Math.round(a.top ?? 25), 1), 200), sortBy = a.sortBy ?? 'clicks';
          const list = rows.filter(x => x.impressions >= (a.minImpressions ?? 0));
          if (a.dimension === 'date') list.sort((x, y) => x.keys[0].localeCompare(y.keys[0]));
          else list.sort((x, y) => (sortBy === 'position' ? x.position - y.position : y[sortBy] - x[sortBy]) || y.impressions - x.impressions);
          const shown = list.slice(0, a.dimension === 'date' ? 400 : n);
          const map = a.dimension === 'page' ? await lookup.mapUrls(shown.map(x => x.keys[0])).catch(() => null) : null;
          return ok({
            property: cfg.property, period: `${r.startDate} bis ${r.endDate} (${r.days} Tage)`, totals: view(totals), rowsTotal: list.length,
            rows: shown.map(x => ({ [a.dimension]: x.keys[0], ...view(x), ...(map ? { shop: refView(map.get(x.keys[0]) ?? null) } : {}) })),
            notes: [LAG_NOTE, ...(totals.impressions < MIN_IMPRESSIONS ? [`Nur ${totals.impressions} Impressionen: zu wenig für belastbare Aussagen.`] : []), ...(a.dimension === 'query' ? ['Google blendet seltene/anonymisierte Suchanfragen aus; die Summe der Zeilen ist kleiner als totals.'] : [])],
          });
        })),

      tool('gsc_opportunities', 'Findet Seiten mit vielen Impressionen, deren Klickrate deutlich unter dem für ihre Position üblichen Wert liegt (CTR-Kurve nach Position), sortiert nach entgangenen Klicks. Jede Seite ist dem Shop zugeordnet (Produkt/Kategorie/Landingpage mit ID, aktuellem Meta-Title und Meta-Description) und hat ihre Top-Suchanfragen. Grundlage für bessere Metas via propose_product_changes/propose_category_changes. Ändert nichts.',
        { days: z.number().optional().describe('Standard 28'), minImpressions: z.number().optional().describe(`Standard ${MIN_IMPRESSIONS}; darunter keine Aussage`), maxPosition: z.number().optional().describe('Standard 20 (Seiten 1–2)'), top: z.number().optional().describe('Standard 15, max. 50') },
        guard(async a => {
          const cfg = need(), r = await findOpportunities(cfg, lookup, { ...a, minImpressions: Math.max(a.minImpressions ?? MIN_IMPRESSIONS, 20) });
          return ok({
            property: cfg.property, period: `${r.period.startDate} bis ${r.period.endDate}`, pagesChecked: r.pagesChecked, opportunities: r.total,
            items: r.items.map(({ o, ref, queries }) => ({
              page: o.page, ...view(o), expectedCtr: pct(o.expectedCtr), potentialClicks: o.potentialClicks, shop: refView(ref),
              ...(ref?.kind === 'product' || ref?.kind === 'category' || ref?.kind === 'landing' ? { metaTitle: ref.metaTitle ?? null, metaDescription: ref.metaDescription ?? null } : {}),
              change: PROPOSE[ref?.kind ?? ''] ?? 'Seite nicht im Shop gefunden (keine SEO-URL): nicht ändern, dem Nutzer nennen',
              topQueries: queries.map(q => ({ query: q.keys[0], ...view(q) })),
            })),
            notes: [LAG_NOTE, 'Erwartete Klickrate = grobe Branchenkurve; Rich Results, Anzeigen und Marke verschieben sie. Potenzial ist eine Schätzung, kein Versprechen.', ...(r.mapped ? [] : ['Zuordnung zum Shop nicht möglich (SEO-URLs nicht lesbar).'])],
          });
        })),

      tool('gsc_content_gaps', 'Findet Suchanfragen mit Impressionen, für die keine Seite des Shops gut rankt (beste Position > 10) oder deren beste Seite thematisch nicht passt (Suchbegriffe nicht in der URL). Grundlage für neue Landingpages, Kategorietexte oder Ratgeber. Jede beste Seite ist dem Shop zugeordnet. Ändert nichts.',
        { days: z.number().optional().describe('Standard 28'), minImpressions: z.number().optional().describe('Standard 50 je Anfrage'), top: z.number().optional().describe('Standard 20, max. 100'), query: z.string().optional().describe('Nur Anfragen, die diesen Text enthalten') },
        guard(async a => {
          const cfg = need(), r = range(a.days ?? BASE_DAYS);
          const rows = await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['query', 'page'], filters: toFilter('query', a.query ? { expression: a.query } : undefined), maxRows: 50_000 });
          const gaps = contentGaps(rows, { minImpressions: Math.max(a.minImpressions ?? 50, 10) }), top = gaps.slice(0, Math.min(Math.max(a.top ?? 20, 1), 100));
          const map = await lookup.mapUrls([...new Set(top.map(g => g.bestPage))]).catch(() => null);
          return ok({
            property: cfg.property, period: `${r.startDate} bis ${r.endDate}`, queriesChecked: new Set(rows.map(x => x.keys[0])).size, gaps: gaps.length,
            items: top.map(g => ({ query: g.query, impressions: g.impressions, clicks: g.clicks, bestPosition: round(g.bestPosition), reason: g.reason, bestPage: g.bestPage, bestPageShop: refView(map?.get(g.bestPage) ?? null), pagesRanking: g.pages })),
            notes: [LAG_NOTE, 'Relevanz wird grob über die Wörter der Anfrage in der URL geschätzt; vor einem Vorschlag die Seite ansehen (get_product/get_category/read_page).', 'Vor neuen Seiten prüfen, ob eine bestehende Kategorie mit besserem Text reicht (keine Konkurrenz zwischen eigenen Seiten).'],
          });
        })),

      tool('gsc_rankings', 'Ranking-Analysen aus der Search Console (letzte 28 Tage, Verluste gegen die 28 Tage davor). striking: Seiten mit Suchanfragen auf Position 4 bis 15 (kurz vor Seite 1 bzw. den Top 3) und geschätztem Gewinn an Position 3. cannibalization: Suchanfragen, bei denen sich mehrere eigene Seiten die Impressionen teilen und keine klar oben steht. decline: Seiten mit mindestens 30 % weniger Klicks, stärker als der ganze Shop. Seiten sind dem Shop zugeordnet (mit aktuellen Metas). Ändert nichts.',
        { type: z.enum(['striking', 'cannibalization', 'decline', 'all']).optional().describe('Standard all'), top: z.number().optional().describe('Standard 10, max. 50 je Art') },
        guard(async a => {
          const cfg = need(), r = await rankingInsights(cfg, lookup, { top: a.top }), t = a.type ?? 'all';
          const shop = (ref: PageRef | null) => ({ shop: refView(ref), ...(ref && (ref.kind === 'product' || ref.kind === 'category' || ref.kind === 'landing') ? { metaTitle: ref.metaTitle ?? null, metaDescription: ref.metaDescription ?? null } : {}), change: PROPOSE[ref?.kind ?? ''] ?? 'Seite nicht im Shop gefunden: nicht ändern, dem Nutzer nennen' });
          return ok({
            property: cfg.property, period: `${r.period.startDate} bis ${r.period.endDate}`, previous: `${r.previous.startDate} bis ${r.previous.endDate}`, totals: r.totals,
            ...(t === 'all' || t === 'striking' ? { striking: r.striking.map(({ x, ref }) => ({ page: x.page, impressions: x.impressions, clicks: x.clicks, potentialClicks: x.potentialClicks, queries: x.queries.slice(0, 5).map(q => ({ query: q.query, ...view(q) })), ...shop(ref) })) } : {}),
            ...(t === 'all' || t === 'cannibalization' ? { cannibalization: r.cannibal.map(({ x, refs }) => ({ query: x.query, impressions: x.impressions, clicks: x.clicks, bestPosition: round(x.bestPosition), pages: x.pages.map((p, i) => ({ page: p.page, share: pct(p.share, 0), ...view(p), shop: refView(refs[i]) })) })) } : {}),
            ...(t === 'all' || t === 'decline' ? { decline: r.decline.map(({ x, ref }) => ({ page: x.page, before: view(x.before), after: view(x.after), clickChange: `${Math.round(x.change * 100)} %`, vsShop: `${Math.round(x.vsSite * 100)} %`, ...shop(ref) })) } : {}),
            notes: [LAG_NOTE, 'Potenzial ist eine Schätzung (Klickrate an Position 3), kein Versprechen.', 'Kannibalisierung: erst eine Hauptseite je Suchanfrage festlegen, dann die anderen auf eigene Themen schärfen und auf die Hauptseite verlinken; Weiterleitungen oder Zusammenlegen nur nach Rückfrage.', 'Verluste: erst Ursachen prüfen (Seite inaktiv/ausverkauft/umbenannt, betroffene Suchanfragen per gsc_performance mit page-Filter), nicht blind Texte ändern.'],
          });
        })),

      tool('gsc_measure_effect', 'Misst den Erfolg angewendeter Änderungen an Meta-Title/-Description, Name, Beschreibung und FAQ sowie neuer Layouts/Seiteninhalte bestehender Kategorien und Produkte: Beim Anwenden merkt sich Lotse automatisch Klicks/Impressionen/CTR/Position der 28 Tage davor (nur Seiten, die Google kennt, höchstens 50 je Änderungsset). Vergleicht mit dem gleich langen Zeitraum danach (vorläufig ab 14 Tagen Daten), inkl. Signifikanz und Shop-Trend. Ohne Argumente: alle offenen Messungen. Ändert nichts im Shop.',
        { baselineId: z.string().optional(), entityId: z.string().optional().describe('Nur Messungen dieses Produkts/dieser Kategorie'), includeMeasured: z.boolean().optional().describe('Auch bereits abgeschlossene erneut zeigen'), limit: z.number().optional().describe('Standard 10, max. 30') },
        guard(async a => {
          const cfg = need();
          let list = listBaselines().filter(b => (!a.baselineId || b.id === a.baselineId) && (!a.entityId || b.entityId === a.entityId));
          if (!a.baselineId && !a.entityId && !a.includeMeasured) list = list.filter(b => !b.measured);
          if (!list.length) return ok({ results: [], message: listBaselines().length ? 'Keine passende offene Messung.' : 'Noch keine Ausgangswerte: Sie entstehen automatisch, wenn ein Änderungsset mit Meta-Title/-Description einer Seite angewendet wird, die Google schon kennt.' });
          const lim = Math.min(Math.max(a.limit ?? 10, 1), 30), now = new Date();
          const results = await pool([...list].reverse().slice(0, lim), 3, b => measure(cfg, lookup, b, now).catch(e => ({ baselineId: b.id, label: b.label, error: e instanceof Error ? e.message : String(e) })));
          return ok({ property: cfg.property, today: isoDay(now), results, notes: [LAG_NOTE, 'Erfolg erst behaupten, wenn verdict „verbessert“ und status „vollständig“ ist; sonst ehrlich als Tendenz oder offen benennen.'] });
        })),
    ] as AnyTool[];
  },
};
