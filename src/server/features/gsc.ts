import 'server-only';
// Google Search Console: echte Suchdaten statt Faustregeln. Leistung, Chancen (schwache Klickrate), Inhaltslücken, Erfolgsmessung von Meta-Änderungen.
// Nur lesen (Google + Shop). Änderungen am Shop laufen weiter über propose_product_changes / propose_category_changes.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { ChangeItem, CheckFinding } from '@/lib/protocol';
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
import { getGscConfig, searchAnalyticsCached, type Dim, type DimFilter, type Operator, type Row, type ServiceKey } from './gsc-google';
import { aggregate, BASE_DAYS, compareEffect, contentGaps, isoDay, LAG_DAYS, MIN_IMPRESSIONS, measureWindow, opportunities, pathRegex, pct, range, round, view, type Baseline, type Metrics } from './gsc-logic';
import type { PageRef } from './gsc-map';

type Cfg = { key: ServiceKey; property: string };
const NOT_CONNECTED = 'Google Search Console ist nicht verbunden. Der Nutzer kann sie unter Einstellungen → Google Search Console einrichten (Service-Konto + Property).';
const need = (): Cfg => { const c = getGscConfig(); if (!c) throw new Error(NOT_CONNECTED); return c; };
const LAG_NOTE = `Search-Console-Daten sind ca. ${LAG_DAYS} Tage alt; der Zeitraum endet deshalb vor heute.`;
const propose = (label: string): Record<string, string> => ({ product: 'propose_product_changes', category: 'propose_category_changes', landing: `Landingpage-Metas: im ${label}-Admin bzw. beim Neuveröffentlichen der Seite (publish_page)`, home: `Startseite: Metas des Verkaufskanals im ${label}-Admin` });
/** Lese-Seite: plattform-neutral (ShopLookup); ein Shopware-Lese-Client wird wie bisher akzeptiert */
type Shop = ShopReader | ShopLookup;
const KIND_OF: Record<string, LinkKind> = { product: 'product', category: 'category', 'landing-page': 'landing' };
const META_FIELDS = new Set(['metaTitle', 'metaDescription']);

// ---- Ausgangswerte (Baselines) für die Erfolgsmessung ----
const KV = 'gsc_baselines';
export const listBaselines = (): Baseline[] => kvGet<Baseline[]>(KV) ?? [];
const saveBaselines = (b: Baseline[]) => kvSet(KV, b.slice(-500));
const metrics = (rows: Row[]): Metrics => aggregate(rows);

/** Merkt sich Klicks/Impressionen/CTR/Position der letzten 28 Tage einer Seite, deren Metas gerade geändert wurden. Nur wenn Google die Seite kennt. */
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
  // Frühere, noch nicht gemessene Ausgangswerte derselben Seite sind ab jetzt verfälscht
  const all = listBaselines().map(x => (x.entityId === a.entityId && !x.measured ? { ...x, measured: { at: now.toISOString(), verdict: 'überholt: Seite erneut geändert, bevor gemessen wurde' } } : x));
  saveBaselines([...all, b]);
  return b;
}

/** Beobachter: angewendete Änderungssets mit Meta-Title/-Description von Produkten, Kategorien, Landingpages */
export async function baselinesFor(cfg: Cfg, items: ChangeItem[], ctx: { ro: Shop; chatId?: string; changeSetId: string }, now = new Date()) {
  const groups = new Map<string, ChangeItem[]>();
  for (const it of items) if (it.field && META_FIELDS.has(it.field) && it.entityId && KIND_OF[it.entity]) groups.set(`${it.entity}:${it.entityId}`, [...(groups.get(`${it.entity}:${it.entityId}`) ?? []), it]);
  const out: Baseline[] = [];
  for (const its of groups.values()) {
    const b = await recordBaseline(cfg, ctx.ro, { entity: its[0].entity as Baseline['entity'], entityId: its[0].entityId!, label: its[0].label, changeSetId: ctx.changeSetId, chatId: ctx.chatId,
      fields: its.map(i => ({ field: i.field!, before: i.before, after: i.after, afterRaw: typeof i.afterRaw === 'string' ? i.afterRaw : undefined })) }, now).catch(() => null);
    if (b) out.push(b);
  }
  return out;
}
onApplied('gsc', async (cs, items, { ro, lookup, chatId }) => { const cfg = getGscConfig(); if (cfg) await baselinesFor(cfg, items, { ro: lookup ?? ro, chatId, changeSetId: cs.id }); });

/** Erfolg messen: Ausgangswert vs. gleich langer Zeitraum nach der Änderung (frühestens nach 14 Tagen Daten). */
export async function measure(cfg: Cfg, ro: Shop, b: Baseline, now = new Date()) {
  const w = measureWindow(b, now);
  const head = { baselineId: b.id, entity: b.entity, entityId: b.entityId, label: b.label, changedAt: b.changedAt.slice(0, 10), fields: b.fields.map(f => ({ field: f.field, before: f.before, after: f.after })), urls: b.urls.slice(0, 3), before: { ...view(b.before), period: `${b.before.startDate} bis ${b.before.endDate}` } };
  if (w.status === 'zu früh') return { ...head, status: 'zu früh' as const, measurableFrom: w.measurableFrom, completeFrom: w.completeFrom, message: `Noch nicht messbar: ${w.days ? `erst ${w.days} ${w.days === 1 ? 'Tag' : 'Tage'}` : 'noch keine'} Daten nach der Änderung. Vorläufig messbar ab ${w.measurableFrom}, vollständig ab ${w.completeFrom}.` };
  const rows = await searchAnalyticsCached(cfg, { startDate: w.startDate, endDate: w.endDate!, dimensions: ['page'], filters: [{ dimension: 'page', operator: 'includingRegex', expression: b.pathRegex }] });
  const after = metrics(rows);
  const siteAfter = b.site ? metrics(await searchAnalyticsCached(cfg, { startDate: w.startDate, endDate: w.endDate! })) : null;
  const res = compareEffect({ ...b.before, days: b.before.days }, { ...after, days: w.days }, b.site && siteAfter ? { before: { ...b.site, days: b.before.days }, after: { ...siteAfter, days: w.days } } : undefined);
  // Wurde die Änderung inzwischen überschrieben oder rückgängig gemacht?
  const cur = await asLookup(ro).current(b.entity, b.entityId).catch(() => null);
  const drift = cur ? b.fields.filter(f => f.afterRaw != null && (cur.translated?.[f.field] ?? cur[f.field] ?? null) !== f.afterRaw).map(f => f.field) : [];
  if (drift.length) res.notes.unshift(`Achtung: ${drift.join(', ')} hat heute einen anderen Wert als nach der Änderung (rückgängig gemacht oder erneut geändert). Die Messung bezieht sich nicht mehr eindeutig auf diese Änderung.`);
  if (w.status === 'vorläufig') res.notes.unshift(`Vorläufig: erst ${w.days} von ${b.before.days} Tagen nach der Änderung verfügbar (vergleicht Durchschnitt pro Tag). Vollständig ab ${w.completeFrom}.`);
  if (w.status === 'vollständig' && !b.measured) saveBaselines(listBaselines().map(x => (x.id === b.id ? { ...x, measured: { at: now.toISOString(), verdict: res.verdict } } : x)));
  return { ...head, status: w.status, after: { ...res.after, period: `${w.startDate} bis ${w.endDate}` }, verdict: res.verdict, change: res.change, zScore: res.zScore, notes: res.notes, beforeDetail: res.before };
}

// ---- Chancen + Inhaltslücken (auch für den Shop-Check) ----
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
const refView = (ref: PageRef | null) => (ref ? { kind: ref.kind, ...(ref.id ? { id: ref.id } : {}), name: ref.name, ...(ref.number ? { number: ref.number } : {}), ...(ref.active === false ? { active: false } : {}) } : null);

// ---- Shop-Check (nur, wenn verbunden) ----
registerCheck({ id: 'gsc.low-ctr', area: 'Search Console', platforms: 'all', run: async (sw, ctx) => {
  const cfg = getGscConfig(); if (!cfg) return null;
  const r = await findOpportunities(cfg, ctx?.lookup ?? sw, { top: 5, queries: false });
  const f: CheckFinding = { id: 'gsc.low-ctr', area: 'Search Console', severity: r.total >= 10 ? 'hoch' : 'mittel', count: r.total, total: r.pagesChecked,
    title: r.total ? `${r.total} ${r.total === 1 ? 'Seite' : 'Seiten'} mit vielen Impressionen und schwacher Klickrate` : 'Klickraten passen zu den Positionen',
    sample: r.items.map(x => ({ id: x.ref?.id ?? x.o.page, label: `${x.ref?.name ?? x.o.page} (${x.o.impressions} Impr., CTR ${pct(x.o.ctr)}, Position ${String(round(x.o.position)).replace('.', ',')})` })),
    hint: 'Google zeigt diese Seiten oft, aber wenige klicken. Meist helfen ein klarerer Meta-Title und eine Meta-Description mit Nutzen (Daten der letzten 28 Tage).',
    fixPrompt: 'Zeige mir die Search-Console-Chancen (Seiten mit vielen Impressionen und schwacher Klickrate) und schlage für die wichtigsten bessere Meta-Titles und Meta-Descriptions vor.' };
  return f;
} });
registerCheck({ id: 'gsc.measure-due', area: 'Search Console', platforms: 'all', run: async () => {
  if (!getGscConfig()) return null;
  const all = listBaselines(), due = all.filter(b => !b.measured && measureWindow(b).status === 'vollständig');
  if (!all.length) return null;
  return { id: 'gsc.measure-due', area: 'Search Console', severity: 'niedrig', count: due.length, total: all.length,
    title: due.length ? `Messung fällig: ${due.length} Meta-${due.length === 1 ? 'Änderung' : 'Änderungen'} älter als 28 Tage` : 'Keine Erfolgsmessung fällig',
    sample: due.slice(0, 5).map(b => ({ id: b.entityId, label: `${b.label} (geändert am ${b.changedAt.slice(0, 10)})` })),
    hint: 'Vergleicht Klicks, Klickrate und Position vor und nach der Änderung, damit du siehst, was gewirkt hat.',
    fixPrompt: 'Miss den Erfolg meiner Meta-Änderungen mit den Search-Console-Daten und fasse zusammen, was gewirkt hat.' };
} });

// ---- Werkzeuge ----
const filterSchema = z.object({ operator: z.enum(['contains', 'equals', 'notContains', 'regex']).optional().describe('Standard contains'), expression: z.string().min(1) });
const toFilter = (dimension: Dim, f?: { operator?: string; expression: string }): DimFilter[] => (f ? [{ dimension, operator: (f.operator === 'regex' ? 'includingRegex' : f.operator ?? 'contains') as Operator, expression: f.expression }] : []);
const dateArgs = { days: z.number().optional().describe('Zeitraum in Tagen bis zum letzten Datentag, Standard 28'), startDate: z.string().optional().describe('JJJJ-MM-TT (statt days)'), endDate: z.string().optional().describe('JJJJ-MM-TT, Standard: heute minus 3 Tage') };

export const gsc: Feature = {
  key: 'gsc',
  platforms: 'all',
  toolNames: ['gsc_performance', 'gsc_opportunities', 'gsc_content_gaps', 'gsc_measure_effect'],
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

      tool('gsc_measure_effect', 'Misst den Erfolg von Meta-Title/-Description-Änderungen: Beim Anwenden eines Änderungssets merkt sich Lotse automatisch Klicks/Impressionen/CTR/Position der 28 Tage davor (nur Seiten, die Google kennt). Vergleicht mit dem gleich langen Zeitraum danach (vorläufig ab 14 Tagen Daten), inkl. Signifikanz und Shop-Trend. Ohne Argumente: alle offenen Messungen. Ändert nichts im Shop.',
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
