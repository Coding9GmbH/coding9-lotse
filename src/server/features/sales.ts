import 'server-only';
// Sales without personal data: sums per product (quantity, revenue, orders) from the platform adapter (PlatformAdapter.sales,
// fixed query, never criteria from the AI). The AI sees top sellers, slow movers and top sellers with weak content,
// combined with the neutral product rows (name, texts, stock, price). Customers, addresses and single orders never leave the adapter.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CheckFinding } from '@/lib/protocol';
import type { NeutralScan } from '@/lib/custom-checks';
import { registerCheck } from '../checks';
import { accessAdd } from '../db';
import { getPlatform } from '../platform';
import type { PlatformKind, SalesReport } from '../platform/types';
import { getSettings, platformConfig, shopOrigin } from '../settings';
import { singleton } from '../state';
import { guard, lim, ok, type AnyTool } from '../tool-kit';
import { DEFAULT_DAYS, MAX_DAYS, mergeRows, money, PROBLEM_TEXT, salesRange, slowMovers, topSellers, weakTopSellers, type SortBy } from './sales-logic';
import type { Feature } from './types';

const BLOCKED = 'Der Zugriff der KI auf Abverkaufsdaten ist ausgeschaltet. Der Nutzer kann ihn unter Einstellungen → KI-Zugriff → Abverkauf einschalten (nur Summen je Produkt, keine Kunden- oder Bestelldaten).';
export const salesAllowed = () => getSettings().scopes.sales === true;
const HOUR = 60 * 60_000;

/** The connected shop (platform, address, store view): another shop on the same platform must never get the cached sums */
const connectionKey = (platform: PlatformKind) => { const c = platformConfig(platform); return [platform, shopOrigin(c.url || c.storeDomain), c.storeCode ?? ''].join('|'); };

/** Sales of a period from the adapter, cached for an hour per platform and period (several checks and tool calls share one read) */
export async function salesReport(platform: PlatformKind, days = DEFAULT_DAYS, now = new Date(), chat = 'sales'): Promise<SalesReport & { from: string; to: string; days: number }> {
  const r = salesRange(days, now), key = `${connectionKey(platform)}:${r.from}:${r.to}`;
  const cache = singleton('sales-cache', () => new Map<string, { at: number; p: Promise<SalesReport> }>());
  let hit = cache.get(key);
  if (!hit || now.getTime() - hit.at > HOUR) {
    hit = { at: now.getTime(), p: getPlatform(platform).sales({ from: r.from, to: r.to }).then(rep => ({ ...rep, rows: mergeRows(rep.rows) })) };
    cache.set(key, hit);
    hit.p.then(rep => accessAdd({ chat, op: 'sales', entity: 'sales', n: rep.rows.length }), () => cache.delete(key));
  }
  return { ...(await hit.p), ...r };
}
export const clearSalesCache = () => singleton('sales-cache', () => new Map()).clear();

// One product scan per read client (shop check run or chat session), like the custom checks; in a chat at most 5 minutes old,
// so texts improved in the same chat count when asked again
const SCAN_TTL = 5 * 60_000;
const scans = new WeakMap<object, { at: number; p: Promise<NeutralScan> }>();
export function scanOf(platform: PlatformKind, reader: unknown, now = Date.now()): Promise<NeutralScan> {
  const k = reader as object, hit = scans.get(k);
  if (hit && now - hit.at < SCAN_TTL) return hit.p;
  const p = getPlatform(platform).scanProducts(reader);
  scans.set(k, { at: now, p });
  p.catch(() => { if (scans.get(k)?.p === p) scans.delete(k); }); // a failed read is not remembered
  return p;
}

const label = (p: { label: string } | null, id: string) => p?.label ?? `Produkt ${id}`;
const notesOf = (rep: SalesReport, scan: NeutralScan) => [
  'Nur Summen je Produkt aus Bestellungen des Zeitraums (ohne stornierte); keine Kunden- oder Bestelldaten.',
  ...(rep.capped ? ['Mehr Bestellungen als Lotse liest: Werte sind Untergrenzen.'] : []),
  ...(scan.capped ? [`Katalog größer als gelesen (${scan.rows.length} von ${scan.total} aktiven Produkten): Ladenhüter und Texte nur für die gelesenen.`] : []),
  ...(rep.notes ?? []),
];

// ---- Shop checks (only with AI access "Abverkauf") ----
registerCheck({ id: 'sales.weak-top-sellers', area: 'Abverkauf', scopes: ['sales'], platforms: 'all', run: async (_sw, ctx) => {
  if (!ctx || !salesAllowed()) return null;
  const [rep, scan] = await Promise.all([salesReport(ctx.platform), scanOf(ctx.platform, ctx.reader)]);
  if (!rep.rows.length) return null;
  const w = weakTopSellers(rep, scan.rows, { top: 5 });
  const f: CheckFinding = { id: 'sales.weak-top-sellers', area: 'Abverkauf', severity: w.total >= 5 ? 'hoch' : 'mittel', count: w.total, total: Math.min(50, rep.rows.length),
    title: w.total ? `${w.total} ${w.total === 1 ? 'Top-Seller hat' : 'Top-Seller haben'} schwache Texte` : 'Die Top-Seller haben ordentliche Texte',
    sample: w.items.map(x => ({ id: x.productId, label: `${label(x.product, x.productId)}: ${x.problems.map(p => PROBLEM_TEXT[p]).join(', ')} (${money(x.revenue, rep.currency)} in ${rep.days} Tagen)` })),
    hint: `Unter den 50 umsatzstärksten Produkten der letzten ${rep.days} Tage: dünne Beschreibung, fehlende Metas oder kein Bild. Hier lohnt sich jede Verbesserung am meisten.`,
    fixPrompt: 'Welche meiner Top-Seller haben schwache Texte (sales_report mit view weak-content)? Schlage für die umsatzstärksten bessere Beschreibungen und Meta-Daten als Änderungsset vor, nur mit belegten Fakten.' };
  return f;
} });
registerCheck({ id: 'sales.slow-movers', area: 'Abverkauf', scopes: ['sales'], platforms: 'all', run: async (_sw, ctx) => {
  if (!ctx || !salesAllowed()) return null;
  const [rep, scan] = await Promise.all([salesReport(ctx.platform, 90), scanOf(ctx.platform, ctx.reader)]);
  if (!rep.orders) return null; // no orders at all (new shop, missing permission): no statement about slow movers
  const s = slowMovers(rep, scan.rows, 5);
  return { id: 'sales.slow-movers', area: 'Abverkauf', severity: 'niedrig', count: s.total, total: scan.rows.length,
    title: s.total ? `${s.total} ${s.total === 1 ? 'Produkt' : 'Produkte'} mit Bestand und ohne Verkauf in 90 Tagen` : 'Jedes Produkt mit Bestand hat sich in 90 Tagen verkauft',
    sample: s.items.map(x => ({ id: x.product.id, label: `${x.product.label} (${x.product.stock} Stück${x.stockValue != null ? `, ≈ ${money(x.stockValue, rep.currency)}` : ''})` })),
    hint: 'Ladenhüter binden Kapital. Häufige Hebel: bessere Texte und Bilder, Sichtbarkeit in Kategorien, ein Bundle oder eine Aktion.',
    fixPrompt: 'Zeige mir die Ladenhüter (sales_report mit view slow, 90 Tage) und schlage je Produkt eine passende Maßnahme vor (Texte, Bilder, Kategorie, Aktion), ohne Preise eigenmächtig zu senken.' };
} });

// ---- Tool ----
export const sales: Feature = {
  key: 'sales',
  platforms: 'all',
  toolNames: ['sales_report'],
  tools: session => [
    tool('sales_report', 'Abverkauf ohne Personenbezug: Summen je Produkt (Stückzahl, Umsatz, Anzahl Bestellungen) aus den Bestellungen eines Zeitraums, ohne stornierte. view top: Top-Seller nach Umsatz oder Stückzahl mit Anteil. view slow: Ladenhüter (aktive Produkte mit Bestand ohne einen Verkauf, nach gebundenem Kapital). view weak-content: Top-Seller mit dünner Beschreibung, fehlenden Metas oder ohne Bild (lohnendste Text-Verbesserungen). Für Prioritäten nutzen („wichtigste Produkte zuerst“). Liefert nie Kunden, Adressen oder einzelne Bestellungen. Ändert nichts.',
      { view: z.enum(['top', 'slow', 'weak-content']).optional().describe('Standard top'), days: z.number().optional().describe(`Zeitraum in Tagen bis gestern, Standard ${DEFAULT_DAYS}, max. ${MAX_DAYS}`), sortBy: z.enum(['revenue', 'quantity']).optional().describe('nur top, Standard revenue'), top: z.number().optional().describe('Standard 20, max. 100') },
      guard(async a => {
        if (!salesAllowed()) throw new Error(BLOCKED);
        const [rep, scan] = await Promise.all([salesReport(session.platform, a.days ?? (a.view === 'slow' ? 90 : DEFAULT_DAYS), new Date(), session.id), scanOf(session.platform, session.reader)]);
        const n = lim(a.top, 20, 100), head = { period: `${rep.from} bis ${rep.to} (${rep.days} Tage)`, orders: rep.orders, productsSold: rep.rows.length, currency: rep.currency, notes: notesOf(rep, scan) };
        const view = (p: typeof scan.rows[number] | null) => (p ? { name: p.name, ...(p.label !== p.name ? { label: p.label } : {}), stock: p.stock, price: p.price } : { note: 'nicht unter den aktiven Produkten (inaktiv, gelöscht oder nicht gelesen)' });
        if (a.view === 'slow') {
          const s = slowMovers(rep, scan.rows, n);
          return ok({ ...head, slowMovers: s.total, items: s.items.map(x => ({ productId: x.product.id, ...view(x.product), stockValue: x.stockValue })) });
        }
        if (a.view === 'weak-content') {
          const w = weakTopSellers(rep, scan.rows, { top: n });
          return ok({ ...head, weakTopSellers: w.total, items: w.items.map(x => ({ productId: x.productId, ...view(x.product), revenue: x.revenue, quantity: x.quantity, share: x.share, problems: x.problems.map(p => PROBLEM_TEXT[p]), descriptionWords: x.descriptionWords })) });
        }
        const totals = { revenue: Math.round(rep.rows.reduce((s, r) => s + r.revenue, 0) * 100) / 100, quantity: rep.rows.reduce((s, r) => s + r.quantity, 0) };
        return ok({ ...head, totals, items: topSellers(rep, scan.rows, { sortBy: a.sortBy as SortBy | undefined, top: n }).map(x => ({ productId: x.productId, ...view(x.product), quantity: x.quantity, revenue: x.revenue, orders: x.orders, share: x.share })) });
      })),
  ] as AnyTool[],
};
