// Search Console: pure evaluation (no network): periods, CTR curve, opportunities, content gaps, success measurement.
import type { Row } from './gsc-google';

export const LAG_DAYS = 3;          // Search Console data is about 2-3 days old
export const MIN_IMPRESSIONS = 100; // below this, no statements about click rates
export const MIN_DAYS = 14;         // measure after 14 days at the earliest
export const BASE_DAYS = 28;

// ---- Days (YYYY-MM-DD, UTC) ----
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(day + 'T00:00:00Z') + n * 86_400_000));
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
/** Last day with (final) data */
export const lastDataDay = (now = new Date()) => addDays(isoDay(now), -LAG_DAYS);
export function range(days = BASE_DAYS, now = new Date(), endDate?: string, startDate?: string) {
  const end = endDate ?? lastDataDay(now), start = startDate ?? addDays(end, -(Math.max(1, days) - 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error('Datum im Format JJJJ-MM-TT angeben');
  if (start > end) throw new Error('startDate liegt nach endDate');
  return { startDate: start, endDate: end, days: daysBetween(start, end) + 1 };
}

// ---- Expected click rate per position (rough industry curve of organic results, desktop+mobile) ----
const CURVE = [0, 0.28, 0.15, 0.10, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];
export function expectedCtr(position: number): number {
  const p = Math.max(1, position);
  if (p <= 10) { const i = Math.floor(p), f = p - i; return i >= 10 ? CURVE[10] : CURVE[i] + (CURVE[i + 1] - CURVE[i]) * f; }
  if (p <= 20) return 0.012 - (0.012 - 0.006) * ((p - 10) / 10);
  return 0.004;
}

export interface Metrics { clicks: number; impressions: number; ctr: number; position: number }
/** Sum of several rows: click rate recalculated, position weighted by impressions */
export function aggregate(rows: Pick<Row, 'clicks' | 'impressions' | 'position'>[]): Metrics {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0), impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const position = impressions ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : 0;
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position };
}

export const pct = (x: number, d = 1) => `${(x * 100).toFixed(d).replace('.', ',')} %`;
export const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
export const view = (m: Metrics) => ({ clicks: m.clicks, impressions: m.impressions, ctr: pct(m.ctr, 2), position: round(m.position) });

// ---- Opportunities: many impressions, click rate clearly below expectation for the position ----
export interface Opportunity extends Metrics { page: string; expectedCtr: number; potentialClicks: number }
export function opportunities(rows: Row[], o: { minImpressions?: number; maxPosition?: number; factor?: number } = {}): Opportunity[] {
  const min = o.minImpressions ?? MIN_IMPRESSIONS, maxPos = o.maxPosition ?? 20, factor = o.factor ?? 0.7;
  return rows.filter(r => r.impressions >= min && r.position <= maxPos).flatMap(r => {
    const exp = expectedCtr(r.position);
    if (r.ctr >= exp * factor) return [];
    return [{ page: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, expectedCtr: exp, potentialClicks: Math.round(r.impressions * (exp - r.ctr)) }];
  }).sort((a, b) => b.potentialClicks - a.potentialClicks);
}

// ---- Relevance search query ↔ page (words of the query in the URL path) ----
const STOP = new Set('der die das und oder mit für fuer von aus auf in im am an zu zum zur ein eine einen kaufen online shop günstig guenstig bestellen the and for with to of a an'.split(' '));
export const tokens = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .split(/[^a-z0-9]+/).filter(w => w.length > 1 && !STOP.has(w));
/** Share of search words (without filler words) that occur in the path; a word stem of 4+ characters suffices ("vasen" ~ "vase"). */
export function relevance(query: string, url: string): number {
  const q = tokens(query); if (!q.length) return 1;
  let path = url; try { path = decodeURIComponent(new URL(url).pathname); } catch { /* relative path */ }
  const p = tokens(path);
  const hit = (w: string) => p.some(x => x === w || (Math.min(x.length, w.length) >= 4 && (x.startsWith(w.slice(0, Math.max(4, w.length - 2))) || w.startsWith(x.slice(0, Math.max(4, x.length - 2))))));
  return q.filter(hit).length / q.length;
}

export interface Gap { query: string; impressions: number; clicks: number; bestPosition: number; bestPage: string; pages: number; relevance: number; reason: 'keine Seite auf Seite 1' | 'beste Seite passt nicht' }
/** Content gaps from rows with dimensions [query, page]: queries with impressions for which no page ranks well or the best page doesn't match the topic. */
export function contentGaps(rows: Row[], o: { minImpressions?: number; goodPosition?: number; minRelevance?: number } = {}): Gap[] {
  const min = o.minImpressions ?? 50, good = o.goodPosition ?? 10, minRel = o.minRelevance ?? 0.5;
  const by = new Map<string, Row[]>();
  for (const r of rows) { const q = r.keys[0]; if (q) by.set(q, [...(by.get(q) ?? []), r]); }
  const out: Gap[] = [];
  for (const [query, rs] of by) {
    const m = aggregate(rs); if (m.impressions < min) continue;
    const best = [...rs].sort((a, b) => a.position - b.position || b.impressions - a.impressions)[0];
    const rel = relevance(query, best.keys[1] ?? '');
    const reason = best.position > good ? 'keine Seite auf Seite 1' : rel < minRel ? 'beste Seite passt nicht' : null;
    if (reason) out.push({ query, impressions: m.impressions, clicks: m.clicks, bestPosition: best.position, bestPage: best.keys[1] ?? '', pages: rs.length, relevance: round(rel, 2), reason });
  }
  return out.sort((a, b) => b.impressions - a.impressions || a.bestPosition - b.bestPosition); // demand first
}

// ---- Rankings: just short of page 1, cannibalization, losses ----
/** Page URL without parameters, anchor and trailing slash: so /vasen/?p=2 counts as the same page as /vasen */
export const pageKey = (u: string) => u.replace(/[?#].*$/, '').replace(/\/+$/, '');

export interface Striking { page: string; impressions: number; clicks: number; potentialClicks: number; queries: (Metrics & { query: string })[] }
/** Just short of page 1 or the top 3: queries at positions 4 to 15 with demand, grouped per page.
 *  Potential = clicks if the query were at position 3, minus today's. Rows with dimensions [query, page]. */
export function strikingDistance(rows: Row[], o: { minImpressions?: number; from?: number; to?: number } = {}): Striking[] {
  const min = o.minImpressions ?? 50, from = o.from ?? 4, to = o.to ?? 15, target = expectedCtr(3);
  const by = new Map<string, Striking>();
  for (const r of rows) {
    const [query, raw] = r.keys; if (!query || !raw || r.impressions < min || r.position < from || r.position > to) continue;
    const page = pageKey(raw), s = by.get(page) ?? { page: raw, impressions: 0, clicks: 0, potentialClicks: 0, queries: [] };
    s.impressions += r.impressions; s.clicks += r.clicks; s.potentialClicks += Math.max(0, Math.round(r.impressions * (target - r.ctr)));
    s.queries.push({ query, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    by.set(page, s);
  }
  return [...by.values()].map(s => ({ ...s, queries: s.queries.sort((a, b) => b.impressions - a.impressions) }))
    .filter(s => s.potentialClicks > 0).sort((a, b) => b.potentialClicks - a.potentialClicks);
}

export interface Cannibal { query: string; impressions: number; clicks: number; bestPosition: number; pages: (Metrics & { page: string; share: number })[] }
/** Cannibalization: for one query at least two own pages share the impressions significantly (each ≥ 15 %, position ≤ 30)
 *  and none is already clearly on top (best position > 3). Google then doesn't know which page is meant; both rank weaker. */
export function cannibalization(rows: Row[], o: { minImpressions?: number; minShare?: number } = {}): Cannibal[] {
  const min = o.minImpressions ?? 100, minShare = o.minShare ?? 0.15;
  const by = new Map<string, Map<string, Row[]>>();
  for (const r of rows) {
    const [query, raw] = r.keys; if (!query || !raw) continue;
    const pages = by.get(query) ?? new Map<string, Row[]>(), k = pageKey(raw);
    pages.set(k, [...(pages.get(k) ?? []), r]); by.set(query, pages);
  }
  const out: Cannibal[] = [];
  for (const [query, pages] of by) {
    const per = [...pages.values()].map(rs => ({ page: rs[0].keys[1], ...aggregate(rs) })), total = aggregate(per);
    if (total.impressions < min) continue;
    const strong = per.filter(p => p.impressions / total.impressions >= minShare && p.position <= 30).sort((a, b) => b.impressions - a.impressions);
    const best = Math.min(...per.map(p => p.position));
    if (strong.length < 2 || best <= 3) continue;
    out.push({ query, impressions: total.impressions, clicks: total.clicks, bestPosition: best, pages: strong.map(p => ({ ...p, share: round(p.impressions / total.impressions, 2) })) });
  }
  return out.sort((a, b) => b.impressions - a.impressions);
}

export interface Decline { page: string; before: Metrics; after: Metrics; change: number; vsSite: number }
/** Losses: pages with clearly fewer clicks in the current period than in the equally long period before,
 *  more than the whole shop (season, updates factored out). Rows with dimensions [page]. */
export function declines(before: Row[], after: Row[], o: { minClicks?: number; minDrop?: number; minLost?: number } = {}): Decline[] {
  const minClicks = o.minClicks ?? 20, minDrop = o.minDrop ?? 0.3, minLost = o.minLost ?? 10;
  const group = (rows: Row[]) => { const m = new Map<string, Row[]>(); for (const r of rows) { const k = pageKey(r.keys[0] ?? ''); if (k) m.set(k, [...(m.get(k) ?? []), r]); } return m; };
  const b = group(before), a = group(after), siteB = aggregate(before).clicks, siteA = aggregate(after).clicks;
  const site = siteB ? siteA / siteB : 1;
  const out: Decline[] = [];
  for (const [k, rs] of b) {
    const mb = aggregate(rs), ma = aggregate(a.get(k) ?? []);
    if (mb.clicks < minClicks || mb.clicks - ma.clicks < minLost) continue;
    const change = (ma.clicks - mb.clicks) / mb.clicks, vsSite = site ? ma.clicks / mb.clicks / site - 1 : change;
    if (change > -minDrop || vsSite > -minDrop) continue;
    out.push({ page: rs[0].keys[0], before: mb, after: ma, change: round(change, 2), vsSite: round(vsSite, 2) });
  }
  return out.sort((x, y) => (y.before.clicks - y.after.clicks) - (x.before.clicks - x.after.clicks));
}

// ---- Success measurement ----
export interface Baseline {
  id: string; entity: 'product' | 'category' | 'landing-page'; entityId: string; label: string; urls: string[]; pathRegex: string;
  fields: { field: string; before: string; after: string; afterRaw?: unknown }[];
  changedAt: string; changeSetId: string; chatId?: string;
  before: Metrics & { startDate: string; endDate: string; days: number };
  site?: Metrics;
  measured?: { at: string; verdict: string };
}

/** Measurement period after the change: from the following day, same length as the baseline; preliminary from 14 days of data. */
export function measureWindow(b: Pick<Baseline, 'changedAt' | 'before'>, now = new Date()) {
  const start = addDays(b.changedAt.slice(0, 10), 1), fullEnd = addDays(start, b.before.days - 1), last = lastDataDay(now);
  const avail = daysBetween(start, last) + 1;
  if (avail < MIN_DAYS) return { status: 'zu früh' as const, startDate: start, endDate: null, days: Math.max(0, avail), measurableFrom: addDays(start, MIN_DAYS - 1 + LAG_DAYS), completeFrom: addDays(fullEnd, LAG_DAYS) };
  const end = last < fullEnd ? last : fullEnd;
  return { status: (end === fullEnd ? 'vollständig' : 'vorläufig') as 'vollständig' | 'vorläufig', startDate: start, endDate: end, days: daysBetween(start, end) + 1, measurableFrom: addDays(start, MIN_DAYS - 1 + LAG_DAYS), completeFrom: addDays(fullEnd, LAG_DAYS) };
}

/** Two-sided test for a difference between two click rates (z-score) */
export function ctrZ(c1: number, i1: number, c2: number, i2: number): number {
  if (!i1 || !i2) return 0;
  const p = (c1 + c2) / (i1 + i2), se = Math.sqrt(p * (1 - p) * (1 / i1 + 1 / i2));
  return se ? (c2 / i2 - c1 / i1) / se : 0;
}

export function compareEffect(before: Metrics & { days: number }, after: Metrics & { days: number }, site?: { before: Metrics & { days: number }; after: Metrics & { days: number } }) {
  const perDay = (m: Metrics & { days: number }) => ({ clicks: m.clicks / m.days, impressions: m.impressions / m.days });
  const b = perDay(before), a = perDay(after), notes: string[] = [];
  const rel = (x: number, y: number) => (x ? (y - x) / x : null);
  const z = ctrZ(before.clicks, before.impressions, after.clicks, after.impressions);
  const posDelta = after.position - before.position;
  const expB = expectedCtr(before.position), expA = expectedCtr(after.position);
  let verdict: 'verbessert' | 'verschlechtert' | 'kein klarer Effekt' | 'zu wenig Daten';
  if (Math.min(before.impressions, after.impressions) < MIN_IMPRESSIONS) { verdict = 'zu wenig Daten'; notes.push(`Weniger als ${MIN_IMPRESSIONS} Impressionen in einem Zeitraum: Unterschiede sind Zufall, keine Aussage möglich.`); }
  else if (Math.abs(z) < 1.96) { verdict = 'kein klarer Effekt'; notes.push('Der Unterschied der Klickrate liegt im Rahmen normaler Schwankung (nicht signifikant).'); }
  else verdict = z > 0 ? 'verbessert' : 'verschlechtert';
  if (Math.abs(posDelta) >= 1) notes.push(`Die durchschnittliche Position hat sich um ${round(Math.abs(posDelta))} Plätze ${posDelta < 0 ? 'verbessert' : 'verschlechtert'}. Die Klickrate hängt stark von der Position ab; aussagekräftiger ist der Vergleich mit der erwarteten Klickrate (ctrVsExpected).`);
  let siteTrend: number | null = null;
  if (site) {
    siteTrend = rel(site.before.impressions / site.before.days, site.after.impressions / site.after.days);
    if (siteTrend != null && Math.abs(siteTrend) >= 0.15) notes.push(`Der ganze Shop hatte im Vergleichszeitraum ${siteTrend > 0 ? '+' : ''}${Math.round(siteTrend * 100)} % Impressionen pro Tag (Saison, Updates): Veränderungen bei Klicks/Impressionen nicht allein der Änderung zuschreiben.`);
  }
  notes.push('Saison, Google-Updates und Wettbewerber wirken mit. Eine Messung ist ein Hinweis, kein Beweis.');
  return {
    verdict, zScore: round(z, 2),
    before: { ...view(before), days: before.days, clicksPerDay: round(b.clicks, 2), impressionsPerDay: round(b.impressions, 1), ctrVsExpected: round(before.ctr / expB, 2) },
    after: { ...view(after), days: after.days, clicksPerDay: round(a.clicks, 2), impressionsPerDay: round(a.impressions, 1), ctrVsExpected: round(after.ctr / expA, 2) },
    change: { clicksPerDay: fmtRel(rel(b.clicks, a.clicks)), impressionsPerDay: fmtRel(rel(b.impressions, a.impressions)), ctr: fmtPp(after.ctr - before.ctr), position: round(posDelta), ...(siteTrend != null ? { shopImpressionsPerDay: fmtRel(siteTrend) } : {}) },
    notes,
  };
}
const fmtPp = (d: number) => `${d >= 0 ? '+' : ''}${round(d * 100, 2).toString().replace('.', ',')} Prozentpunkte`;
const fmtRel = (x: number | null) => (x == null ? 'n/a' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)} %`);

/** RE2 pattern for page URLs with these paths (any scheme/host, exact path).
 *  Search Console returns URLs percent-encoded (küche → k%C3%BCche); so per path both the raw and the encoded form apply. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const pathRegex = (paths: string[]) => `^https?://[^/]+/(${[...new Set(paths.flatMap(p => { const c = p.replace(/^\/+/, ''); return [c, encodeURI(c)]; }))].map(escapeRe).join('|')})$`;
