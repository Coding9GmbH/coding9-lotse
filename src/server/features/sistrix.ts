import 'server-only';
// Sistrix: Sichtbarkeit, Wettbewerber, Chancen, Keyword-Daten und OnPage-Probleme (Optimizer) zum Shop. Ergänzt die Search Console
// (eigene Daten) um Marktdaten (Konkurrenz, Suchvolumen, Sichtbarkeitsindex). Nur lesen; Änderungen am Shop laufen weiter über propose_*.
// Sistrix rechnet in Credits ab: jede Anfrage ist gedeckelt, Antworten nennen die verbrauchten Credits, wiederholte Anfragen kommen aus dem Cache.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CheckFinding } from '@/lib/protocol';
import { registerCheck } from '../checks';
import type { ShopLookup } from '../platform/types';
import { getPlatform } from '../platform';
import { ok, guard, type AnyTool } from '../tool-kit';
import type { Feature } from './types';
import { propose, refView } from './gsc';
import { addressParam, getSistrixConfig, normDomain, rowsOf, sistrixCached, type Row, type SistrixConfig } from './sistrix-api';

const NOT_CONNECTED = 'Sistrix ist nicht verbunden. Der Nutzer kann es unter Einstellungen → Sistrix einrichten (API-Schlüssel + Domain des Shops).';
const need = (): SistrixConfig => { const c = getSistrixConfig(); if (!c) throw new Error(NOT_CONNECTED); return c; };
const CREDIT_NOTE = 'Sistrix rechnet pro gelieferter Zeile in Credits ab; Anfragen sind gedeckelt und werden 10 Minuten zwischengespeichert.';
const clamp = (n: number | undefined, def: number, max: number) => Math.min(Math.max(Math.round(n ?? def), 1), max);

/** Ziel der Anfrage: angegebene Domain/Pfad oder die des Shops */
function target(cfg: SistrixConfig, d?: string): string {
  const t = d ? normDomain(d) : cfg.domain;
  if (!t) throw new Error('Keine Domain: bitte unter Einstellungen → Sistrix die Domain des Shops eintragen oder eine Domain angeben.');
  return t;
}
const urlOf = (r: Row): string | null => { for (const k of ['url', 'address', 'page']) { const v = r[k]; if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v; } return null; };
const dateOf = (r: Row): string => String(r.date ?? r.time ?? '');
const valueOf = (r: Row): number | null => { const v = r.value ?? r.sichtbarkeitsindex ?? r.visibilityindex; return typeof v === 'number' ? v : null; };
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Sichtbarkeitsindex als Reihe (älteste zuerst) mit Veränderung zum ersten Wert */
export function visibilitySeries(rows: Row[]) {
  const pts = rows.map(r => ({ date: dateOf(r), value: valueOf(r) })).filter((p): p is { date: string; value: number } => p.value !== null).sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length) return null;
  const first = pts[0], last = pts[pts.length - 1];
  return { series: pts, latest: last, first, change: round(last.value - first.value, 4), changePct: first.value ? round(((last.value - first.value) / first.value) * 100, 1) : null };
}

/** Optimizer-Projekt zur Domain: Name enthält die Domain; sonst das einzige Projekt; sonst Auswahl nötig */
export function pickProject(projects: Row[], domain: string, wanted?: string): { hash: string; name: string } | { choose: { hash: string; name: string }[] } | null {
  const list = projects.map(p => ({ hash: String(p.hash ?? ''), name: String(p.name ?? p.domain ?? '') })).filter(p => p.hash);
  if (!list.length) return null;
  if (wanted) { const w = wanted.trim().toLowerCase(), hit = list.find(p => p.hash === wanted.trim() || p.name.toLowerCase() === w) ?? list.find(p => p.name.toLowerCase().includes(w)); return hit ?? { choose: list }; }
  const host = domain.replace(/^www\./, '').split('/')[0];
  const byDomain = host ? list.filter(p => p.name.toLowerCase().includes(host)) : [];
  if (byDomain.length === 1) return byDomain[0];
  if (list.length === 1) return list[0];
  return { choose: byDomain.length ? byDomain : list };
}

async function findProject(cfg: SistrixConfig, wanted?: string) {
  const r = await sistrixCached(cfg, 'project.overview');
  return pickProject(rowsOf(r.answer, 'project', 'projects'), cfg.domain, wanted);
}

const isIssueError = (r: Row) => String(r.type ?? '').toLowerCase() === 'error';
const NO_PROJECT = 'In Sistrix gibt es kein Optimizer-Projekt für diese Domain. Der Nutzer legt eines im Sistrix-Optimizer an (OnPage-Crawl), dann stehen die Daten hier bereit.';

/** Seiten der Antwort dem Shop zuordnen (Produkt/Kategorie/Landingpage); nicht zuordenbar = null */
async function mapped(lookup: ShopLookup, rows: Row[]) {
  const urls = [...new Set(rows.map(urlOf).filter((u): u is string => !!u))];
  const map = urls.length ? await lookup.mapUrls(urls, { metas: true }).catch(() => null) : null;
  return (r: Row) => { const u = urlOf(r); return map && u ? refView(map.get(u) ?? null) : null; };
}

/** Kompakte Sichtbarkeit für die Startseite (8 Wochen = 8 Credits, 6 Stunden zwischengespeichert, damit ein Seitenaufruf nicht jedes Mal Credits kostet) */
export async function visibilityOverview(cfg: SistrixConfig, weeks = 8) {
  const r = await sistrixCached(cfg, 'domain.visibilityindex', { ...addressParam(cfg.domain), history: true, limit: weeks }, 6 * 60 * 60_000);
  const s = visibilitySeries(rowsOf(r.answer, 'sichtbarkeitsindex', 'visibilityindex'));
  return { domain: cfg.domain, country: cfg.country, weeks, series: s?.series ?? [], latest: s?.latest ?? null, changePct: s?.changePct ?? null, creditsUsed: r.creditsUsed };
}

// ---- Shop-Check (nur, wenn verbunden) ----
const DROP_PCT = 10, DROP_HIGH_PCT = 25, DROP_WEEKS = 5;
registerCheck({ id: 'sistrix.visibility-drop', area: 'Sistrix', platforms: 'all', run: async () => {
  const cfg = getSistrixConfig(); if (!cfg?.domain) return null;
  const r = await sistrixCached(cfg, 'domain.visibilityindex', { ...addressParam(cfg.domain), history: true, limit: DROP_WEEKS });
  const s = visibilitySeries(rowsOf(r.answer, 'sichtbarkeitsindex', 'visibilityindex'));
  if (!s || s.series.length < 2 || s.first.value <= 0) {
    // Keine Reihe oder Ausgangswert 0: nichts zu vergleichen. Das ist kein Fehler, soll aber sichtbar sein statt still zu fehlen.
    return { id: 'sistrix.visibility-drop', area: 'Sistrix', severity: 'niedrig', count: 0, title: 'Noch keine vergleichbare Sistrix-Sichtbarkeit',
      sample: [{ id: cfg.domain, label: s ? `${cfg.domain}: Index ${String(round(s.latest.value)).replace('.', ',')} (${s.latest.date})` : `${cfg.domain}: keine Daten` }],
      hint: 'Sistrix hat für die Domain noch keine Wochenreihe mit Wert über 0 (kleine oder neue Domains haben oft keinen Index). Sobald Daten da sind, vergleicht Lotse die letzten Wochen.',
      fixPrompt: 'Zeige mir die Sichtbarkeit aus Sistrix und erkläre, was die Daten für die Domain aussagen.' };
  }
  const drop = s.changePct !== null && s.changePct <= -DROP_PCT;
  const f: CheckFinding = { id: 'sistrix.visibility-drop', area: 'Sistrix', severity: drop ? (s.changePct! <= -DROP_HIGH_PCT ? 'hoch' : 'mittel') : 'niedrig', count: drop ? 1 : 0,
    title: drop ? `Sichtbarkeitsindex ${String(Math.abs(s.changePct!)).replace('.', ',')} % niedriger als vor ${s.series.length - 1} Wochen` : 'Sichtbarkeitsindex stabil oder steigend',
    sample: [{ id: cfg.domain, label: `${cfg.domain}: ${String(round(s.first.value)).replace('.', ',')} (${s.first.date}) → ${String(round(s.latest.value)).replace('.', ',')} (${s.latest.date})` }],
    hint: 'Der Sistrix-Sichtbarkeitsindex fasst Rankings und Suchvolumen zusammen. Ein Rückgang kann Wettbewerb, ein Google-Update oder technische Probleme anzeigen.',
    fixPrompt: 'Zeige mir die Sichtbarkeits-Entwicklung aus Sistrix und finde mögliche Ursachen (Konkurrenz, OnPage-Fehler, Chancen).' };
  return f;
} });
registerCheck({ id: 'sistrix.onpage-errors', area: 'Sistrix', platforms: 'all', run: async () => {
  const cfg = getSistrixConfig(); if (!cfg?.domain) return null;
  const p = await findProject(cfg);
  if (!p || 'choose' in p) return null;
  const crawl = rowsOf((await sistrixCached(cfg, 'project.onpage.crawl', { project: p.hash })).answer, 'issue', 'issues', 'crawl');
  const errors = crawl.filter(isIssueError).filter(x => typeof x.count === 'number' && x.count > 0);
  if (!crawl.length) return null;
  const total = errors.reduce((n, x) => n + (x.count as number), 0);
  const f: CheckFinding = { id: 'sistrix.onpage-errors', area: 'Sistrix', severity: errors.length >= 5 ? 'hoch' : 'mittel', count: errors.length,
    title: errors.length ? `${errors.length} OnPage-${errors.length === 1 ? 'Fehlerart' : 'Fehlerarten'} im Sistrix-Crawl (${total} Fundstellen)` : 'Keine OnPage-Fehler im letzten Sistrix-Crawl',
    sample: errors.slice(0, 5).map(x => ({ id: String(x.name), label: `${String(x.name)} (${x.count})` })),
    hint: 'Aus dem letzten OnPage-Crawl des Sistrix-Optimizers. Betroffene Seiten lassen sich per Chat ansehen und, wo es Texte betrifft, über Änderungssets beheben.',
    fixPrompt: 'Zeige mir die OnPage-Fehler aus dem Sistrix-Crawl und schlage vor, was ich zuerst beheben sollte.' };
  return f;
} });

// ---- Werkzeuge ----
export const sistrix: Feature = {
  key: 'sistrix',
  platforms: 'all',
  toolNames: ['sistrix_visibility', 'sistrix_top_pages', 'sistrix_opportunities', 'sistrix_competitors', 'sistrix_keyword_metrics', 'sistrix_onpage'],
  tools: session => {
    const { lookup } = session, PROPOSE = propose(getPlatform(session.platform).label);
    const domainArg = z.string().optional().describe('Domain, Host oder Pfad ohne https://, z. B. wettbewerber.de; Standard: die Domain des Shops');
    return [
      tool('sistrix_visibility', 'Liest den Sistrix-Sichtbarkeitsindex (Rankings gewichtet mit Suchvolumen) einer Domain als wöchentliche Reihe mit Veränderung. Für Entwicklung, Vergleich mit Wettbewerbern und Einordnung von Google-Updates. Ändert nichts.',
        { domain: domainArg, weeks: z.number().optional().describe('Anzahl Wochen, Standard 12, max. 52 (1 Credit je Woche)') },
        guard(async a => {
          const cfg = need(), t = target(cfg, a.domain), weeks = clamp(a.weeks, 12, 52);
          const r = await sistrixCached(cfg, 'domain.visibilityindex', { ...addressParam(t), history: true, limit: weeks });
          const s = visibilitySeries(rowsOf(r.answer, 'sichtbarkeitsindex', 'visibilityindex'));
          return ok({ domain: t, country: cfg.country || 'Land des Sistrix-Kontos', weeks, creditsUsed: r.creditsUsed, ...(s ?? { series: [], message: 'Keine Sichtbarkeitsdaten: Domain zu klein oder im Land nicht erfasst.' }),
            notes: [CREDIT_NOTE, 'Der Index ist eine relative Zahl: nur Verläufe und Vergleiche zählen, nicht der absolute Wert.'] });
        })),

      tool('sistrix_top_pages', 'Liefert die URLs einer Domain mit den meisten Top-10- und Top-100-Rankings und ihrem Anteil am Sichtbarkeitsindex (Sistrix domain.urls). Jede URL ist dem Shop zugeordnet (Produkt/Kategorie/Landingpage mit ID und aktuellen Metas). Zeigt, welche Seiten die Sichtbarkeit tragen. Ändert nichts.',
        { domain: domainArg, limit: z.number().optional().describe('Standard 25, max. 100 (1 Credit je Zeile)'), regexUrl: z.string().max(200).optional().describe('Nur URLs, die auf diesen regulären Ausdruck passen, z. B. "/wohnen/"') },
        guard(async a => {
          const cfg = need(), t = target(cfg, a.domain), limit = clamp(a.limit, 25, 100);
          const r = await sistrixCached(cfg, 'domain.urls', { ...addressParam(t), limit, regex_url: a.regexUrl });
          const rows = rowsOf(r.answer, 'url', 'urls'), shop = await mapped(lookup, rows);
          return ok({ domain: t, count: rows.length, creditsUsed: r.creditsUsed, items: rows.map(x => ({ ...x, shop: shop(x) })),
            notes: [CREDIT_NOTE, ...(rows.length ? [] : ['Keine Treffer: Filter lockern oder Domain prüfen.'])] });
        })),

      tool('sistrix_opportunities', 'Findet Keywords, bei denen die Domain mit wenig Aufwand mehr Traffic gewinnen kann (Sistrix domain.opportunities: Gewinn 0 bis 100, aktuelle Position, rankende URL, Wettbewerb). Jede URL ist dem Shop zugeordnet. Grundlage für bessere Metas und Texte via propose_product_changes/propose_category_changes. Ändert nichts.',
        { domain: domainArg, limit: z.number().optional().describe('Standard 20, max. 50 (1 Credit je Zeile)') },
        guard(async a => {
          const cfg = need(), t = target(cfg, a.domain), limit = clamp(a.limit, 20, 50);
          const r = await sistrixCached(cfg, 'domain.opportunities', { ...addressParam(t), limit });
          const rows = rowsOf(r.answer, 'opportunity', 'opportunities'), shop = await mapped(lookup, rows);
          return ok({ domain: t, count: rows.length, creditsUsed: r.creditsUsed,
            items: rows.map(x => { const ref = shop(x); return { ...x, shop: ref, change: PROPOSE[ref?.kind ?? ''] ?? 'Seite nicht im Shop gefunden: nicht ändern, dem Nutzer nennen' }; }),
            notes: [CREDIT_NOTE, 'Gewinn ist eine Schätzung von Sistrix, kein Versprechen. Vor einem Vorschlag die Seite ansehen (get_product/get_category/read_page).'] });
        })),

      tool('sistrix_competitors', 'Liefert die organischen Wettbewerber einer Domain nach Ähnlichkeit der Rankings (Sistrix domain.competitors.seo, Übereinstimmung in Prozent). Danach lassen sich Wettbewerber mit sistrix_visibility und sistrix_top_pages vergleichen. Ändert nichts.',
        { domain: domainArg, limit: z.number().optional().describe('Standard 10, max. 30 (1 Credit je Zeile)') },
        guard(async a => {
          const cfg = need(), t = target(cfg, a.domain), limit = clamp(a.limit, 10, 30);
          const r = await sistrixCached(cfg, 'domain.competitors.seo', { ...addressParam(t), limit });
          const rows = rowsOf(r.answer, 'competitor', 'competitors');
          return ok({ domain: t, count: rows.length, creditsUsed: r.creditsUsed, competitors: rows,
            notes: [CREDIT_NOTE, 'Die Domain selbst steht mit 100 % in der Liste. Reine Marktplätze und Vergleichsportale sind keine direkten Wettbewerber.'] });
        })),

      tool('sistrix_keyword_metrics', 'Liefert Kennzahlen zu Keywords (Sistrix keyword.seo.metrics): Wettbewerb, Klickpreis, geschätzter Traffic und Klicks, Geräteverteilung. Für Priorisierung von Themen vor neuen Seiten oder Texten. Kostet 5 Credits je Keyword, deshalb höchstens 10 je Aufruf. Ändert nichts.',
        { keywords: z.array(z.string().min(1).max(100)).min(1).max(10).describe('Keywords, höchstens 10') },
        guard(async a => {
          const cfg = need(), kws = [...new Set(a.keywords.map(k => k.trim()).filter(Boolean))].slice(0, 10);
          if (!kws.length) throw new Error('Keine Keywords angegeben.');
          const r = await sistrixCached(cfg, 'keyword.seo.metrics', { kw: kws.length === 1 ? kws[0] : JSON.stringify(kws) });
          return ok({ requested: kws.length, creditsUsed: r.creditsUsed, keywords: rowsOf(r.answer, 'kw', 'keyword', 'keywords'),
            notes: [CREDIT_NOTE, 'Traffic und Klicks sind Schätzungen. Das Suchvolumen selbst liefert diese Methode nicht; für Mengenvergleiche den geschätzten Traffic nutzen.'] });
        })),

      tool('sistrix_onpage', 'Liest die OnPage-Ergebnisse des Sistrix-Optimizers (Crawl). Ohne issue: Zusammenfassung des letzten Crawls (Fehler, Warnungen, Hinweise mit Anzahl). Mit issue: die betroffenen URLs dieses Problems, dem Shop zugeordnet. Ändert nichts und startet keinen Crawl.',
        { project: z.string().optional().describe('Projektname oder -hash; nötig, wenn mehrere Projekte existieren und keines zur Domain passt'), issue: z.string().max(120).optional().describe('Name einer Fehlerart aus der Zusammenfassung'), limit: z.number().optional().describe('Standard 25, max. 100') },
        guard(async a => {
          const cfg = need(), p = await findProject(cfg, a.project);
          if (!p) return ok({ projects: [], message: NO_PROJECT });
          if ('choose' in p) return ok({ message: 'Mehrere Projekte: bitte eines per project wählen.', projects: p.choose });
          const crawl = rowsOf((await sistrixCached(cfg, 'project.onpage.crawl', { project: p.hash })).answer, 'issue', 'issues', 'crawl');
          if (!a.issue) {
            const overview = rowsOf((await sistrixCached(cfg, 'project.onpage.overview', { project: p.hash })).answer, 'crawl', 'crawls');
            return ok({ project: p.name, lastCrawl: overview.sort((x, y) => dateOf(y).localeCompare(dateOf(x)))[0] ?? null, issues: crawl.sort((x, y) => (Number(y.count) || 0) - (Number(x.count) || 0)),
              notes: ['Mit issue=<name> die betroffenen URLs ansehen. Fehler vor Warnungen vor Hinweisen abarbeiten.'] });
          }
          if (crawl.length && !crawl.some(x => x.name === a.issue)) return ok({ project: p.name, message: `Unbekannte Fehlerart. Verfügbar: ${crawl.map(x => String(x.name)).join(', ')}` });
          const limit = clamp(a.limit, 25, 100);
          const r = await sistrixCached(cfg, 'project.onpage.issue', { project: p.hash, issue: a.issue, limit });
          const rows = rowsOf(r.answer, 'issue', 'issues', 'url', 'urls'), shop = await mapped(lookup, rows);
          return ok({ project: p.name, issue: a.issue, count: rows.length, creditsUsed: r.creditsUsed, items: rows.map(x => ({ ...x, shop: shop(x) })), notes: [CREDIT_NOTE] });
        })),
    ] as AnyTool[];
  },
};
