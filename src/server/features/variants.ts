import 'server-only';
// Feature „Varianten & Stapelverarbeitung“: Varianten lesen/anlegen/ändern/löschen und Regeländerungen für beliebig viele Produkte.
import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { MAX_ITEMS, registerApplier } from '../changes';
import type { ChangeOutcome, Session } from '../sessions';
import type { SwEntity } from '../shopware';
import { ok, guard, type AnyTool } from '../tool-kit';
import type { Feature } from './types';
import { VARIANTS_KIND, applyVariants, buildVariantsChangeSet, loadFamily, variantsView, type VariantsPayload } from './variant-matrix';
import { BULK_KIND, BULK_MAX, applyBulk, bulkChangeSet, describeChange, effective, resolveProducts, validateChange, type BulkChange, type BulkFilter, type BulkPayload } from './bulk-edit';

registerApplier(VARIANTS_KIND, (swW, cs, payload, selected, ctx) => applyVariants(swW, cs, payload as VariantsPayload, selected, ctx));
registerApplier(BULK_KIND, (swW, cs, payload, selected, ctx) => applyBulk(swW, cs, payload as BulkPayload, selected, ctx));

const nameOf = (e: SwEntity | null | undefined) => String(e?.translated?.name ?? e?.name ?? '');
const priceRule = z.object({ percent: z.number().optional(), add: z.number().optional(), set: z.number().optional(), round: z.string().optional().describe('".99", ".95", ".00" oder "none"') });
const filterShape = {
  categoryId: z.string().optional(), term: z.string().optional().describe('Suchbegriff (Name, Nummer …)'),
  minPrice: z.number().optional(), maxPrice: z.number().optional().describe('Preisspanne brutto (wirksamer Preis, bei Varianten ggf. geerbt)'),
  active: z.boolean().optional(), minStock: z.number().optional(), maxStock: z.number().optional(),
  manufacturer: z.string().optional().describe('Hersteller: id oder exakter Name'),
  properties: z.array(z.string()).optional().describe('Eigenschafts-Ausprägungen (ids): Hauptprodukte mit mindestens einer davon'),
  includeVariants: z.boolean().optional().describe('true = Varianten der passenden Hauptprodukte mit einbeziehen'),
  variantOptions: z.array(z.string()).optional().describe('Nur Varianten mit einer dieser Ausprägungen (ids, z. B. Größe XL) – Hauptprodukte selbst dann nicht'),
};
/** Ergebnis für die KI kompakt halten (bei Tausenden Produkten keine Fehlerliste mit Tausenden Zeilen) */
const compact = (o: ChangeOutcome) => (o.failed && o.failed.length > 20 ? { ...o, failed: o.failed.slice(0, 20), failedTotal: o.failedTotal ?? o.failed.length } : o);

async function deliveryTimes(session: Session) {
  return (await session.sw.search('delivery-time', { limit: 100 })).data;
}

export const variants: Feature = {
  key: 'variants',
  platforms: ['shopware'],
  toolNames: ['get_variants', 'list_variant_properties', 'propose_variants', 'preview_bulk_filter', 'propose_bulk_product_change'],
  tools: session => {
    const { sw } = session;
    return [
      tool('get_variants', 'Liest die Varianten eines Produkts: Hauptprodukt (Preis, Bestand, Status), Varianten-Auswahl (Konfigurator: Eigenschaften und Ausprägungen) und alle Varianten mit Ausprägungen, Produktnummer, eigenem oder geerbtem Preis, Bestand und Status. Auch mit der id einer Variante aufrufbar (liefert dann die ganze Familie). Ändert nichts.',
        { productId: z.string().describe('id des Haupt- oder Variantenprodukts'), limit: z.number().optional().describe('max. 500, Standard 100'), offset: z.number().optional().describe('Vielfaches von limit; das Ergebnis nennt den wirksamen offset') },
        guard(async ({ productId, limit, offset }) => {
          const l = Math.min(Math.max(1, Math.floor(limit ?? 100)), 500);
          const { parent, children, total, offset: off } = await loadFamily(sw, productId, { limit: l, offset: offset ?? 0 });
          return ok({ ...variantsView(parent, children, total), offset: off });
        })),

      tool('list_variant_properties', 'Listet Eigenschaftsgruppen (z. B. Farbe, Größe) mit ihren Ausprägungen und ids – Grundlage für neue Varianten und für Filter nach Ausprägungen. Ändert nichts.',
        { term: z.string().optional().describe('Teil des Gruppennamens'), limit: z.number().optional() },
        guard(async ({ term, limit }) => {
          const r = await sw.search('property-group', { limit: Math.min(limit ?? 30, 100), ...(term ? { filter: [{ type: 'contains', field: 'name', value: term }] } : {}), associations: { options: {} }, 'total-count-mode': 1 });
          return ok({ total: r.total, groups: r.data.map(g => ({ id: g.id, name: nameOf(g), options: (g.options ?? []).map((o: SwEntity) => ({ id: o.id, name: nameOf(o) })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'de', { numeric: true })) })) });
        })),

      tool('propose_variants', `SCHLÄGT Varianten-Änderungen für EIN Hauptprodukt vor (Freigabe-Workflow, es wird erst nach Zustimmung geschrieben; der Aufruf wartet auf die Entscheidung).
- create: neue Varianten aus Eigenschaften × Ausprägungen (alle Kombinationen, max. ${MAX_ITEMS}). group/options als Name oder id; unbekannte Ausprägungen bzw. Gruppen werden mit angelegt. Produktnummern automatisch HAUPTNR.1, .2 … (nächste freie). defaults/overrides: price (brutto; weglassen/null = erbt vom Hauptprodukt), listPrice, stock (Standard 0), active (weglassen = erbt). overrides greifen auf Kombinationen, die ALLE genannten Ausprägungen enthalten. Bestehende Kombinationen werden übersprungen; die Varianten-Auswahl (Konfigurator) wird ergänzt.
- remove: Varianten-ids löschen (Rückgängig legt sie mit eigenen Werten, Texten, Bildern, Eigenschaften, Kategorien, Tags, Staffelpreisen und Sichtbarkeiten wieder an – NICHT wiederhergestellt werden SEO-URLs, Cross-Selling, Hauptkategorie und Bezüge aus Bestellungen); Ausprägungen ohne verbleibende Variante verschwinden aus der Auswahl.
- update: je Variante price/listPrice (Zahl, Regel {percent|add|set, round} – bei geerbtem Preis Basis = Preis des Hauptprodukts – oder null = wieder erben), stock, active (null = erben). updateAll: dieselben Felder für ALLE Varianten.
Ändert NICHT das Hauptprodukt selbst (dafür propose_product_changes).`,
        {
          title: z.string(), reason: z.string(), productId: z.string().describe('id des Hauptprodukts'),
          create: z.object({
            axes: z.array(z.object({ group: z.string().describe('Eigenschaftsgruppe: Name oder id'), options: z.array(z.string()).describe('Ausprägungen: Namen oder ids') })),
            defaults: z.object({ price: z.number().nullable().optional(), listPrice: z.number().nullable().optional(), stock: z.number().optional(), active: z.boolean().optional() }).optional(),
            overrides: z.array(z.object({ options: z.array(z.string()), price: z.number().nullable().optional(), listPrice: z.number().nullable().optional(), stock: z.number().optional(), active: z.boolean().optional(), productNumber: z.string().optional() })).optional(),
          }).optional(),
          remove: z.array(z.string()).optional().describe('Varianten-ids'),
          update: z.array(z.object({ id: z.string(), price: z.union([z.number(), priceRule]).nullable().optional(), listPrice: z.union([z.number(), priceRule]).nullable().optional(), stock: z.number().optional(), active: z.boolean().nullable().optional() })).optional(),
          updateAll: z.object({ price: z.union([z.number(), priceRule]).nullable().optional(), listPrice: z.union([z.number(), priceRule]).nullable().optional(), stock: z.number().optional(), active: z.boolean().nullable().optional() }).optional(),
        },
        guard(async a => { const { cs, payload } = await buildVariantsChangeSet(sw, a); return ok(await session.requestChange(cs, payload)); })),

      tool('preview_bulk_filter', 'Zählt, welche Produkte ein Stapel-Filter trifft (alle Seiten), und zeigt 10 Beispiele – um den Umfang VOR propose_bulk_product_change mit dem Nutzer abzustimmen. Ändert nichts.',
        filterShape, guard(async (f: BulkFilter) => {
          const { rows, parents, scanned } = await resolveProducts(sw, f);
          const variants = rows.filter(r => r.parentId).length;
          return ok({ matched: rows.length, mainProducts: rows.length - variants, variants, scanned, max: BULK_MAX, examples: rows.slice(0, 10).map(p => { const e = effective(p, parents[p.parentId]); return { id: p.id, number: p.productNumber, name: e.name, gross: e.gross, priceInherited: e.priceInherited, stock: p.stock, active: e.active }; }) });
        })),

      tool('propose_bulk_product_change', `STAPELVERARBEITUNG: SCHLÄGT EINE regelbasierte Änderung für ALLE Produkte eines Filters vor – auch Tausende (bis ${BULK_MAX.toLocaleString('de-DE')}), ohne sie einzeln aufzuzählen. Der Server liest alle passenden Produkte seitenweise, rechnet die Regel selbst und zeigt eine Zusammenfassung (Anzahl, Gruppen ohne/mit Warnungen – abwählbar –, Stichprobe der ersten 50 vorher/nachher). Nach Freigabe schreibt er in Blöcken à 50 mit Fortschrittsanzeige; Rückgängig stellt alle alten Werte exakt wieder her.
Filter wie list_products (zusätzlich minStock, manufacturer, properties, variantOptions). change (mind. ein Feld): price {percent|add|set, round?}, listPrice {percent|add|set, round?} | null (entfernen) | "currentPrice" (Streichpreis = bisheriger Preis, z. B. für Aktionen), active, stock {set} (absolut; schlägt fehl, wenn sich der Bestand bis zur Freigabe ändert, z. B. durch Verkäufe) | {add} (relativ auf den Bestand bei Freigabe), deliveryTime (id oder Name), shippingFree, markAsTopseller.
Geerbte Werte von Varianten folgen dem mitgeänderten Hauptprodukt. Für Einzelwerte je Produkt (Texte, individuelle Preise) stattdessen propose_product_changes.`,
        {
          title: z.string(), reason: z.string(), filter: z.object(filterShape),
          change: z.object({
            price: priceRule.optional(), listPrice: z.union([priceRule, z.null(), z.literal('currentPrice')]).optional(),
            active: z.boolean().optional(), stock: z.object({ set: z.number().optional(), add: z.number().optional() }).optional(),
            deliveryTime: z.string().optional(), shippingFree: z.boolean().optional(), markAsTopseller: z.boolean().optional(),
          }),
        },
        guard(async ({ title, reason, filter, change }) => {
          const c: BulkChange = { ...change };
          validateChange(c);
          let dtNames: Record<string, string> = {};
          if (c.deliveryTime !== undefined) {
            const dts = await deliveryTimes(session); dtNames = Object.fromEntries(dts.map(d => [d.id, nameOf(d)]));
            const hit = dts.find(d => d.id === c.deliveryTime || nameOf(d).toLocaleLowerCase('de-DE') === c.deliveryTime!.trim().toLocaleLowerCase('de-DE'));
            if (!hit) throw new Error(`Lieferzeit „${c.deliveryTime}“ nicht gefunden. Vorhanden: ${dts.map(nameOf).join(', ')}`);
            c.deliveryTime = hit.id;
          }
          const { rows, parents } = await resolveProducts(sw, filter);
          if (!rows.length) throw new Error('Kein Produkt passt auf den Filter');
          const hints: string[] = [];
          const withKids = rows.filter(r => !r.parentId && r.childCount > 0), kids = withKids.reduce((m, r) => m + r.childCount, 0);
          if (withKids.length && !filter.includeVariants && (c.price || c.listPrice !== undefined || c.active !== undefined || c.deliveryTime !== undefined || c.shippingFree !== undefined || c.markAsTopseller !== undefined))
            hints.push(`${withKids.length} Produkte haben zusammen ${kids.toLocaleString('de-DE')} Varianten (nicht mitgezählt): Varianten mit geerbten Werten folgen automatisch, Varianten mit eigenen Werten bleiben unverändert (includeVariants: true bezieht sie ein).`);
          const { cs, payload } = bulkChangeSet(title, reason, c, rows, parents, dtNames, hints);
          const out = compact(await session.requestChange(cs, payload));
          return ok({ ...out, rule: describeChange(c, c.deliveryTime ? dtNames[c.deliveryTime] : undefined), total: cs.total, unchanged: cs.unchanged, skipped: cs.skipped.length });
        })),
    ] as AnyTool[];
  },
};
