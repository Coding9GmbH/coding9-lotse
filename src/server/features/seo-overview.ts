import 'server-only';
// SEO-Übersicht („SEO“ in der Navigation): bündelt die besten Hebel aus Search Console (Chancen, Inhaltslücken) und Sistrix (Chancen, OnPage)
// zu fertigen Aufträgen, die der Nutzer mit einem Klick in einen neuen Chat legt. Nur lesen; geschrieben wird erst nach Freigabe im Chat.
import type { SeoItem, SeoOverview } from '@/lib/protocol';
import type { ShopLookup } from '../platform/types';
import { BASE_DAYS, contentGaps, MIN_IMPRESSIONS, pct, range, round } from './gsc-logic';
import { getGscConfig, searchAnalyticsCached } from './gsc-google';
import { findOpportunities } from './gsc';
import { addressParam, getSistrixConfig, rowsOf, sistrixCached, type Row } from './sistrix-api';
import { pickProject } from './sistrix';

const HOURS6 = 6 * 60 * 60_000;
const KIND_LABEL: Record<string, string> = { product: 'Produkt', category: 'Kategorie', landing: 'Landingpage', home: 'Startseite' };
const TOOL_FOR: Record<string, string> = { product: 'get_product', category: 'get_category', landing: 'read_page' };
const num = (n: number) => String(round(n)).replace('.', ',');
const META_RULES = 'Meta-Title höchstens 60 Zeichen, Meta-Description 120 bis 158 Zeichen, mit Nutzen und der Suchanfrage, nur belegte Fakten';

async function gscItems(lookup: ShopLookup): Promise<SeoItem[]> {
  const cfg = getGscConfig(); if (!cfg) return [];
  const out: SeoItem[] = [];
  const opp = await findOpportunities(cfg, lookup, { top: 8, queries: true, minImpressions: Math.max(MIN_IMPRESSIONS, 20) });
  for (const { o, ref, queries } of opp.items) {
    if (!ref || ref.kind === 'home' || !ref.id) continue; // nicht zuordenbar oder nur im Admin änderbar: kein Auftrag
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
  return out;
}

const kwOf = (r: Row, domain: string): string => { for (const k of ['kw', 'keyword', 'term']) if (typeof r[k] === 'string') return r[k] as string; const d = r.domain; return typeof d === 'string' && d !== domain ? d : ''; };
const urlOf = (r: Row): string | null => { for (const k of ['url', 'address', 'page']) { const v = r[k]; if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v; } return null; };

async function sistrixItems(lookup: ShopLookup): Promise<SeoItem[]> {
  const cfg = getSistrixConfig(); if (!cfg?.domain) return [];
  const out: SeoItem[] = [];
  const opp = rowsOf((await sistrixCached(cfg, 'domain.opportunities', { ...addressParam(cfg.domain), limit: 10 }, HOURS6)).answer, 'opportunity', 'opportunities');
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
  // OnPage-Crawl des Optimizers (nur wenn es ein Projekt zur Domain gibt)
  const pr = pickProject(rowsOf((await sistrixCached(cfg, 'project.overview', {}, HOURS6)).answer, 'project', 'projects'), cfg.domain);
  if (pr && !('choose' in pr)) {
    const crawl = rowsOf((await sistrixCached(cfg, 'project.onpage.crawl', { project: pr.hash }, HOURS6)).answer, 'issue', 'issues', 'crawl');
    for (const c of crawl.filter(x => typeof x.count === 'number' && x.count > 0).sort((a, b) => (String(a.type) === 'error' ? 0 : 1) - (String(b.type) === 'error' ? 0 : 1) || (Number(b.count) || 0) - (Number(a.count) || 0)).slice(0, 5)) {
      const name = String(c.name ?? ''); if (!name) continue;
      out.push({
        id: `sistrix:onpage:${name}`, source: 'sistrix', kind: 'onpage', impact: (String(c.type) === 'error' ? 10_000 : 0) + (Number(c.count) || 0), // Fehler vor Warnungen
        title: `OnPage: ${name}`, detail: `${String(c.type) === 'error' ? 'Fehler' : 'Warnung'} im letzten Sistrix-Crawl`,
        metrics: [{ label: 'Fundstellen', value: String(c.count) }],
        prompt: `Der Sistrix-OnPage-Crawl meldet „${name}“ (${String(c.type) === 'error' ? 'Fehler' : 'Warnung'}, ${c.count} Fundstellen). Rufe sistrix_onpage mit issue="${name}" auf, ordne die URLs dem Shop zu und behebe, was über Texte lösbar ist (Meta-Daten, Überschriften, Alt-Texte), als Änderungsset. Technische Ursachen (Server, Weiterleitungen, Canonical) nur benennen, nicht behaupten, sie zu beheben.`,
      });
    }
  }
  return out;
}

/** Alle Hebel, je Quelle nach Wirkung sortiert; ein Ausfall einer Quelle blockiert die andere nicht */
export async function seoOverview(lookup: ShopLookup): Promise<SeoOverview> {
  const gsc = !!getGscConfig(), sistrix = !!getSistrixConfig()?.domain;
  const errors: SeoOverview['errors'] = [];
  const [g, s] = await Promise.all([
    gsc ? gscItems(lookup).catch(e => { errors.push({ source: 'gsc', error: e instanceof Error ? e.message : String(e) }); return [] as SeoItem[]; }) : [],
    sistrix ? sistrixItems(lookup).catch(e => { errors.push({ source: 'sistrix', error: e instanceof Error ? e.message : String(e) }); return [] as SeoItem[]; }) : [],
  ]);
  const byImpact = (a: SeoItem, b: SeoItem) => b.impact - a.impact;
  return { gsc, sistrix, items: [...g.sort(byImpact), ...s.sort(byImpact)], errors, generatedAt: new Date().toISOString() };
}
