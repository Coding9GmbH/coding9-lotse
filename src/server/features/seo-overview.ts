import 'server-only';
// SEO-Übersicht („SEO“ in der Navigation): bündelt die besten Hebel aus Search Console (Chancen, Inhaltslücken) und Sistrix (Chancen, OnPage)
// zu fertigen Aufträgen, die der Nutzer mit einem Klick in einen neuen Chat legt. Nur lesen; geschrieben wird erst nach Freigabe im Chat.
import { SEO_DONE_RECHECK_DAYS, type SeoItem, type SeoMark, type SeoOnpage, type SeoOverview } from '@/lib/protocol';
import type { ShopLookup } from '../platform/types';
import { BASE_DAYS, contentGaps, expectedCtr, MIN_IMPRESSIONS, pct, range, round } from './gsc-logic';
import { clearGscCache, getGscConfig, searchAnalyticsCached } from './gsc-google';
import { findOpportunities, rankingInsights } from './gsc';
import { addressParam, clearSistrixCache, getSistrixConfig, rowsOf, sistrixCached, type Row, type SistrixConfig } from './sistrix-api';
import { pickProject } from './sistrix';
import { getSettings } from '../settings';
import { kvGet, kvSet } from '../db';
import { singleton } from '../state';

const HOURS6 = 6 * 60 * 60_000;
const KIND_LABEL: Record<string, string> = { product: 'Produkt', category: 'Kategorie', landing: 'Landingpage', home: 'Startseite' };
const TOOL_FOR: Record<string, string> = { product: 'get_product', category: 'get_category', landing: 'read_page' };
const num = (n: number) => String(round(n)).replace('.', ',');
const META_RULES = 'Meta-Title höchstens 60 Zeichen, Meta-Description 120 bis 158 Zeichen, mit Nutzen und der Suchanfrage, nur belegte Fakten';

async function gscItems(lookup: ShopLookup): Promise<SeoItem[]> {
  const cfg = getGscConfig(); if (!cfg) return [];
  const out: SeoItem[] = [];
  const ranking = await rankingInsights(cfg, lookup, { top: 6 });
  const declined = new Set(ranking.decline.map(d => d.ref?.id).filter(Boolean)); // Klickverlust geht vor: dort zuerst die Ursache klären
  const opp = await findOpportunities(cfg, lookup, { top: 8, queries: true, minImpressions: Math.max(MIN_IMPRESSIONS, 20) });
  for (const { o, ref, queries } of opp.items) {
    if (!ref || ref.kind === 'home' || !ref.id || declined.has(ref.id)) continue; // nicht zuordenbar oder nur im Admin änderbar: kein Auftrag
    const qs = queries.map(q => `„${q.keys[0]}“ (${q.impressions} Impr.)`).slice(0, 4);
    out.push({
      id: `gsc:meta:${ref.id}`, source: 'gsc', kind: 'meta', impact: o.potentialClicks,
      title: `Meta-Daten verbessern: ${ref.name ?? o.page}`,
      detail: `${KIND_LABEL[ref.kind]} · viele Impressionen, schwache Klickrate${qs.length ? ` · ${qs.slice(0, 2).join(', ')}` : ''}`,
      metrics: [{ label: 'Impressionen', value: String(o.impressions) }, { label: 'Klickrate', value: pct(o.ctr) }, { label: 'Position', value: num(o.position) }, { label: 'Potenzial', value: `+${o.potentialClicks} Klicks` }],
      prompt: `Verbessere Meta-Title und Meta-Description für ${KIND_LABEL[ref.kind]} „${ref.name}“ (ID ${ref.id}). Laut Search Console hat die Seite ${o.impressions} Impressionen bei ${pct(o.ctr)} Klickrate (Position ${num(o.position)}, erwartet wären etwa ${pct(o.expectedCtr)}).${qs.length ? ` Top-Suchanfragen: ${qs.join(', ')}.` : ''} Lies zuerst die aktuelle Seite mit ${TOOL_FOR[ref.kind] ?? 'dem passenden Lesewerkzeug'} und schlage dann bessere Metas als Änderungsset vor (${META_RULES}).`,
    });
  }
  const r = range(BASE_DAYS);
  const rows = await searchAnalyticsCached(cfg, { startDate: r.startDate, endDate: r.endDate, dimensions: ['query', 'page'], maxRows: 50_000 });
  for (const g of contentGaps(rows, { minImpressions: 50 }).slice(0, 5)) {
    out.push({
      id: `gsc:gap:${g.query}`, source: 'gsc', kind: 'gap', impact: Math.round(g.impressions * 0.05),
      title: `Inhaltslücke: „${g.query}“`,
      detail: g.reason === 'keine Seite auf Seite 1' ? `Beste Position ${num(g.bestPosition)}: keine Seite rankt gut` : 'Die beste Seite passt thematisch nicht zur Suchanfrage',
      metrics: [{ label: 'Impressionen', value: String(g.impressions) }, { label: 'Klicks', value: String(g.clicks) }, { label: 'Beste Position', value: num(g.bestPosition) }],
      prompt: `Zur Suchanfrage „${g.query}“ gibt es laut Search Console ${g.impressions} Impressionen, aber ${g.reason === 'keine Seite auf Seite 1' ? `keine Seite rankt gut (beste Position ${num(g.bestPosition)})` : `die beste Seite (${g.bestPage}) passt thematisch nicht`}. Prüfe mit search_categories und search_products, ob eine bestehende Kategorie dazu passt. Dann schlage vor, deren Text zu ergänzen, und nur falls nichts passt, eine neue Landingpage. Bestätige den Umfang vorher per Rückfrage.`,
    });
  }
  out.push(...rankingItems(ranking, new Set(out.filter(i => i.kind === 'meta').map(i => i.id.replace(/^gsc:meta:/, '')))));
  return out;
}

const quote = (qs: { query: string; impressions: number; position: number }[], n = 3) => qs.slice(0, n).map(q => `„${q.query}“ (Position ${num(q.position)}, ${q.impressions} Impr.)`).join(', ');

/** Rankings aus der Search Console: kurz vor Seite 1, eigene Seiten gegeneinander, Klickverluste.
 *  Je Seite nur ein Hebel: Klickverlust vor Meta-Daten (metaIds) vor „kurz vor Seite 1“. */
export function rankingItems(r: Pick<Awaited<ReturnType<typeof rankingInsights>>, 'striking' | 'cannibal' | 'decline'>, metaIds: Set<string>): SeoItem[] {
  const out: SeoItem[] = [], declined = new Set(r.decline.map(d => d.ref?.id).filter(Boolean));
  // Anfragen mit Kannibalisierung nicht zusätzlich auf einer der Seiten stärken: erst die Hauptseite klären
  const contested = new Set(r.cannibal.map(c => c.x.query));
  for (const { x: raw, ref } of r.striking) {
    if (!ref?.id || ref.kind === 'home' || metaIds.has(ref.id) || declined.has(ref.id)) continue;
    const queries = raw.queries.filter(q => !contested.has(q.query));
    if (!queries.length) continue;
    const x = { ...raw, queries, impressions: queries.reduce((n, q) => n + q.impressions, 0), potentialClicks: queries.reduce((n, q) => n + Math.max(0, Math.round(q.impressions * (expectedCtr(3) - q.ctr))), 0) };
    out.push({
      id: `gsc:striking:${ref.id}`, source: 'gsc', kind: 'striking', impact: x.potentialClicks,
      title: `Kurz vor Seite 1: ${ref.name ?? x.page}`,
      detail: `${KIND_LABEL[ref.kind]} · ${quote(x.queries, 2)}`,
      metrics: [{ label: 'Impressionen', value: String(x.impressions) }, { label: 'Beste Anfrage', value: `Pos. ${num(x.queries[0].position)}` }, { label: 'Potenzial', value: `+${x.potentialClicks} Klicks` }],
      prompt: `${KIND_LABEL[ref.kind]} „${ref.name}“ (ID ${ref.id}) rankt laut Search Console knapp hinter den Top-Plätzen: ${quote(x.queries, 4)}. Lies die Seite mit ${TOOL_FOR[ref.kind] ?? 'dem passenden Lesewerkzeug'} und prüfe, ob diese Suchanfragen in Meta-Title, Überschriften und Text abgedeckt sind und die Suchintention beantwortet wird. Schlage gezielte Ergänzungen vor (Title mit der wichtigsten Anfrage vorn, ein Abschnitt oder FAQ zu offenen Fragen, ${META_RULES}) und nenne Seiten, die intern mit passendem Ankertext hierher verlinken sollten. Als Änderungsset, Umfang vorher per Rückfrage bestätigen.`,
    });
  }
  for (const { x, refs } of r.cannibal) {
    const named = x.pages.map((p, i) => ({ p, ref: refs[i] })).filter(v => v.ref?.id);
    if (named.length < 2) continue; // nur, wenn mindestens zwei Seiten im Shop zuordenbar sind
    const list = named.map(({ p, ref }) => `${KIND_LABEL[ref!.kind] ?? 'Seite'} „${ref!.name}“ (ID ${ref!.id}, Position ${num(p.position)}, ${Math.round(p.share * 100)} % der Impressionen)`).join('; ');
    out.push({
      id: `gsc:cannibal:${x.query}`, source: 'gsc', kind: 'cannibal', impact: Math.round(x.impressions * 0.03),
      title: `Seiten konkurrieren um „${x.query}“`,
      detail: named.map(({ ref }) => ref!.name).join(' · '),
      metrics: [{ label: 'Impressionen', value: String(x.impressions) }, { label: 'Seiten', value: String(named.length) }, { label: 'Beste Position', value: num(x.bestPosition) }],
      prompt: `Für die Suchanfrage „${x.query}“ (${x.impressions} Impressionen, beste Position ${num(x.bestPosition)}) teilen sich laut Search Console mehrere eigene Seiten die Rankings: ${list}. Lies alle Seiten und schlage eine Hauptseite vor, die die Suchintention am besten trifft. Schärfe die anderen Seiten auf ihr eigenes Thema (Meta-Title, Überschrift, Text ohne die Anfrage als Hauptbegriff) und ergänze dort einen internen Link mit passendem Ankertext auf die Hauptseite. Weiterleitungen oder Zusammenlegen nur nach Rückfrage. Bestätige Hauptseite und Umfang per Rückfrage, dann ein Änderungsset.`,
    });
  }
  for (const { x, ref } of r.decline) {
    if (!ref?.id || ref.kind === 'home') continue;
    const lost = x.before.clicks - x.after.clicks;
    out.push({
      id: `gsc:decline:${ref.id}`, source: 'gsc', kind: 'decline', impact: lost * 3, // verlorene Klicks wiegen schwerer als geschätztes Potenzial
      title: `Klicks verloren: ${ref.name ?? x.page}`,
      detail: `${KIND_LABEL[ref.kind]} · ${x.before.clicks} → ${x.after.clicks} Klicks gegenüber den 28 Tagen davor${ref.active === false ? ' · im Shop inaktiv' : ''}`,
      metrics: [{ label: 'Klicks', value: `${Math.round(x.change * 100)} %` }, { label: 'ggü. Shop', value: `${Math.round(x.vsSite * 100)} %` }, { label: 'Position', value: `${num(x.before.position)} → ${num(x.after.position)}` }],
      prompt: `${KIND_LABEL[ref.kind]} „${ref.name}“ (ID ${ref.id}) hat laut Search Console ${x.before.clicks} → ${x.after.clicks} Klicks (${Math.round(x.change * 100)} %, stärker als der ganze Shop) und Position ${num(x.before.position)} → ${num(x.after.position)} im Vergleich zu den 28 Tagen davor. Finde die Ursache, bevor du etwas änderst: Welche Suchanfragen haben verloren (gsc_performance, dimension query, Filter auf die Seite)? Ist die Seite aktiv, sichtbar, lieferbar, wurde URL, Title oder Text kürzlich geändert? Lies die Seite mit ${TOOL_FOR[ref.kind] ?? 'dem passenden Lesewerkzeug'}. Fasse die wahrscheinlichste Ursache zusammen und schlage erst dann Gegenmaßnahmen vor; Texte nur ändern, wenn das die Ursache ist.`,
    });
  }
  return out;
}

const kwOf = (r: Row, domain: string): string => { for (const k of ['kw', 'keyword', 'term']) if (typeof r[k] === 'string') return r[k] as string; const d = r.domain; return typeof d === 'string' && d !== domain ? d : ''; };
const urlOf = (r: Row): string | null => { for (const k of ['url', 'address', 'page']) { const v = r[k]; if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v; } return null; };

async function sistrixItems(lookup: ShopLookup, ttl: number): Promise<{ items: SeoItem[]; onpage: SeoOnpage }> {
  const cfg = getSistrixConfig(); if (!cfg?.domain) return { items: [], onpage: { status: 'none' } };
  const out: SeoItem[] = [];
  const opp = rowsOf((await sistrixCached(cfg, 'domain.opportunities', { ...addressParam(cfg.domain), limit: 10 }, ttl)).answer, 'opportunity', 'opportunities');
  const urls = [...new Set(opp.map(urlOf).filter((u): u is string => !!u))];
  const map = urls.length ? await lookup.mapUrls(urls, { metas: true }).catch(() => null) : null;
  for (const r of opp) {
    const kw = kwOf(r, cfg.domain), u = urlOf(r), ref = map && u ? map.get(u) ?? null : null;
    if (!kw || !ref?.id || ref.kind === 'home') continue;
    const gain = typeof r.gain === 'number' ? r.gain : null, pos = typeof r.position === 'number' ? r.position : null;
    out.push({
      id: `sistrix:opp:${ref.id}:${kw}`, source: 'sistrix', kind: 'keyword', impact: gain ?? 0,
      title: `Keyword nutzen: „${kw}“ auf ${ref.name ?? u}`,
      detail: `${KIND_LABEL[ref.kind]}${pos !== null ? ` · aktuell Position ${num(pos)}` : ''}${typeof r.competition === 'number' ? ` · Wettbewerb ${num(r.competition)}` : ''}`,
      metrics: [...(gain !== null ? [{ label: 'Gewinn (0–100)', value: num(gain) }] : []), ...(pos !== null ? [{ label: 'Position', value: num(pos) }] : [])],
      prompt: `Sistrix sieht für das Keyword „${kw}“ Potenzial auf ${KIND_LABEL[ref.kind]} „${ref.name}“ (ID ${ref.id})${pos !== null ? `, aktuell Position ${num(pos)}` : ''}${gain !== null ? `, Gewinn ${num(gain)} von 100` : ''}. Lies die Seite mit ${TOOL_FOR[ref.kind] ?? 'dem passenden Lesewerkzeug'}, prüfe, ob das Keyword in Titel, Überschrift, Text und Metas vorkommt, und schlage gezielte Verbesserungen als Änderungsset vor (${META_RULES}). Nichts erfinden, nur belegte Fakten.`,
    });
  }
  const on = await onpageItems(cfg, ttl);
  return { items: [...out, ...on.items], onpage: on.onpage };
}

const nOrNull = (v: unknown) => (typeof v === 'number' ? v : null);

/** Technische Probleme aus dem OnPage-Crawl des Sistrix-Optimizers. Ohne eindeutiges Projekt sagt der Status, warum nichts kommt. */
async function onpageItems(cfg: SistrixConfig, ttl: number): Promise<{ items: SeoItem[]; onpage: SeoOnpage }> {
  const all = rowsOf((await sistrixCached(cfg, 'project.overview', {}, ttl)).answer, 'project', 'projects')
    .map(p => ({ hash: String(p.hash ?? ''), name: String(p.name ?? p.domain ?? '') })).filter(p => p.hash);
  const pr = pickProject(all.map(p => ({ ...p })), cfg.domain, cfg.project);
  if (!pr) return { items: [], onpage: { status: 'none' } };
  if ('choose' in pr) return { items: [], onpage: { status: 'choose', projects: all } };
  const projects = all.length > 1 ? all : undefined;
  // Übersicht und Crawl kosten keine Credits
  const crawls = rowsOf((await sistrixCached(cfg, 'project.onpage.overview', { project: pr.hash }, ttl)).answer, 'crawl', 'crawls')
    .sort((a, b) => String(b.time ?? b.date ?? '').localeCompare(String(a.time ?? a.date ?? '')));
  const lc = crawls[0];
  const lastCrawl = lc ? { date: String(lc.time ?? lc.date ?? ''), pages: nOrNull(lc.pages), errors: nOrNull(lc.error ?? lc.errors), warnings: nOrNull(lc.warnings ?? lc.warning), notices: nOrNull(lc.notice ?? lc.notices) } : null;
  const crawl = rowsOf((await sistrixCached(cfg, 'project.onpage.crawl', { project: pr.hash }, ttl)).answer, 'issue', 'issues', 'crawl');
  if (!crawl.length) return { items: [], onpage: { status: 'empty', project: pr, projects, lastCrawl } };
  const typeOf = (c: Row) => String(c.type ?? '').toLowerCase();
  const rank = (c: Row) => (typeOf(c) === 'error' ? 0 : typeOf(c) === 'warning' ? 1 : 2);
  const items: SeoItem[] = [];
  for (const c of crawl.filter(x => typeof x.count === 'number' && x.count > 0 && rank(x) < 2).sort((a, b) => rank(a) - rank(b) || (Number(b.count) || 0) - (Number(a.count) || 0)).slice(0, 15)) {
    const name = String(c.name ?? ''); if (!name) continue;
    const err = rank(c) === 0, label = err ? 'Fehler' : 'Warnung';
    items.push({
      id: `sistrix:onpage:${name}`, source: 'sistrix', kind: 'onpage', impact: (err ? 10_000 : 0) + (Number(c.count) || 0), // Fehler vor Warnungen
      title: `${label}: ${name}`, detail: '', // Crawl-Datum und Projekt stehen einmal im Kopf der Gruppe
      metrics: [{ label: 'Fundstellen', value: String(c.count) }],
      prompt: `Der Sistrix-OnPage-Crawl meldet „${name}“ (${label}, ${c.count} Fundstellen). Rufe sistrix_onpage mit issue="${name}"${all.length > 1 ? ` und project="${pr.hash}"` : ''} auf, ordne die URLs dem Shop zu und behebe, was über Texte lösbar ist (Meta-Daten, Überschriften, Alt-Texte), als Änderungsset. Technische Ursachen (Server, Weiterleitungen, Canonical) nur benennen, nicht behaupten, sie zu beheben.`,
    });
  }
  return { items, onpage: { status: 'ok', project: pr, projects, lastCrawl } };
}

// ---- Zwischenspeicher und Markierungen ----
// Das Ergebnis liegt dauerhaft in der DB: Aufrufe des SEO-Bereichs kosten keine Credits. Neu geholt wird per „Aktualisieren“,
// nach einem Tag oder wenn sich die Anbindung ändert. Markierungen (erledigt/ignoriert) überleben das Neuholen.
const STORE = 'seo-overview', MARKS = 'seo-marks', MAX_AGE = 24 * 60 * 60_000, DAY = 24 * 60 * 60_000;
interface Stored { fp: string; overview: SeoOverview }
type Marks = Record<string, SeoMark>;
const getMarks = (): Marks => kvGet<Marks>(MARKS) ?? {};

/** Anbindung, Domain, Projekt und KI-Zugriff: ändert sich etwas davon, passt der gespeicherte Stand nicht mehr */
function fingerprint(): string {
  const g = getGscConfig(), x = getSistrixConfig(), sc = getSettings().scopes;
  return JSON.stringify([g?.property ?? null, g?.key.client_email ?? null, x?.domain ?? null, x?.country ?? null, x?.project ?? null, sc.gsc !== false, sc.sistrix !== false]);
}

const withMarks = (o: SeoOverview, m: Marks): SeoOverview => ({ ...o, items: o.items.map(i => ({ ...i, mark: m[i.id] })) });

/** Nach frischem Abholen: was nicht mehr gemeldet wird, ist erledigt (Markierung fällt weg); „Erledigt“, das nach einer Woche noch gemeldet wird, kommt zurück */
export function reconcileMarks(o: SeoOverview, marks: Marks, now = Date.now()): Marks {
  const failed = new Set(o.errors.map(e => e.source)), present = new Map(o.items.map(i => [i.id, i]));
  const out: Marks = {};
  for (const [id, m] of Object.entries(marks)) {
    const src = id.split(':')[0] as 'gsc' | 'sistrix', item = present.get(id);
    if (!item) { if (failed.has(src) || !o[src]) out[id] = m; continue; } // Quelle fehlte: Markierung behalten
    if (m.state === 'done' && now - Date.parse(m.at) >= SEO_DONE_RECHECK_DAYS * DAY) continue;
    out[id] = m;
  }
  return out;
}

/** Erledigt/ignoriert setzen oder (null) aufheben */
export function setSeoMark(id: string, state: SeoMark['state'] | null): SeoMark | null {
  const m = getMarks();
  if (state) m[id] = { state, at: new Date().toISOString() }; else delete m[id];
  kvSet(MARKS, m);
  return m[id] ?? null;
}

/** Nur gespeicherter, noch passender Stand (Arbeitsfläche): holt nie neu und kostet daher keine Credits */
export function seoOverviewStored(): SeoOverview | null {
  const st = kvGet<Stored>(STORE);
  return st?.fp === fingerprint() ? { ...withMarks(st.overview, getMarks()), cached: true } : null;
}

/** Gespeicherten Stand liefern oder neu holen (refresh = an allen Zwischenspeichern vorbei). Gleichzeitige Abrufe teilen sich eine Abholung. */
export async function seoOverviewCached(lookup: ShopLookup, refresh = false): Promise<SeoOverview> {
  const fp = fingerprint(), st = kvGet<Stored>(STORE);
  if (!refresh && st?.fp === fp && Date.now() - Date.parse(st.overview.generatedAt) < MAX_AGE) return { ...withMarks(st.overview, getMarks()), cached: true };
  const inflight = singleton('seo-inflight', () => ({ p: null as Promise<SeoOverview> | null }));
  inflight.p ??= (async () => {
    try {
      if (refresh) { clearSistrixCache(); clearGscCache(); }
      const o = await seoOverview(lookup, refresh);
      if (!o.errors.length) kvSet(STORE, { fp, overview: o } satisfies Stored); // mit Fehlern nicht speichern: der nächste Aufruf versucht es erneut
      const m = reconcileMarks(o, getMarks()); kvSet(MARKS, m);
      return withMarks(o, m);
    } finally { inflight.p = null; }
  })();
  return inflight.p;
}

/** Alle Hebel, je Quelle nach Wirkung sortiert; ein Ausfall einer Quelle blockiert die andere nicht */
export async function seoOverview(lookup: ShopLookup, fresh = false): Promise<SeoOverview> {
  const sc = getSettings().scopes; // KI-Zugriff aus = Lotse zeigt und sendet nichts aus dieser Quelle
  const gsc = !!getGscConfig() && sc.gsc !== false, sistrix = !!getSistrixConfig()?.domain && sc.sistrix !== false;
  const errors: SeoOverview['errors'] = [];
  const ttl = fresh ? 0 : HOURS6;
  let onpage: SeoOnpage | undefined;
  const [g, s] = await Promise.all([
    gsc ? gscItems(lookup).catch(e => { errors.push({ source: 'gsc', error: e instanceof Error ? e.message : String(e) }); return [] as SeoItem[]; }) : [],
    sistrix ? sistrixItems(lookup, ttl).then(r => { onpage = r.onpage; return r.items; }).catch(e => { errors.push({ source: 'sistrix', error: e instanceof Error ? e.message : String(e) }); return [] as SeoItem[]; }) : [],
  ]);
  const byImpact = (a: SeoItem, b: SeoItem) => b.impact - a.impact;
  return { gsc, sistrix, items: [...g.sort(byImpact), ...s.sort(byImpact)], errors, generatedAt: new Date().toISOString(), ...(onpage ? { onpage } : {}) };
}
