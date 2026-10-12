import 'server-only';
// Shop-Check (rein): Befund-Definitionen (Titel, Gewicht, Begründung, Auftrag an Lotse) und Auswertung der gelesenen Produktzeilen.
import type { CheckFinding, CheckSeverity } from '@/lib/protocol';
import { DEFAULT_CURRENCY } from '../changes';
import type { SwEntity } from '../shopware';
import { duplicates, META, wordCount } from './seo-rules';

export interface FindingDef { id: string; area: string; title: string; severity: CheckSeverity; unit: string; noun: [string, string]; hint: string; fix: (n: string) => string }
export interface Hit { id: string; label: string }

const P = 'Produkten', K = 'Kategorien', PN: [string, string] = ['Produkt', 'Produkte'], KN: [string, string] = ['Kategorie', 'Kategorien'], EN: [string, string] = ['Einkaufswelt', 'Einkaufswelten'];
export const DEFS = {
  metaDescMissing: { id: 'seo.product-meta-description-missing', area: 'SEO', title: 'Produkte ohne Meta-Description', severity: 'hoch', unit: P, noun: PN,
    hint: 'Ohne Meta-Description wählt Google selbst einen Textausschnitt. Eine gute Description bringt mehr Klicks.',
    fix: n => `Schreib Meta-Descriptions (120 bis 158 Zeichen, mit Nutzen und Handlungsaufforderung) für alle aktiven Produkte ohne Meta-Description (betrifft ${n}). Finde sie mit seo_audit (entity=product, Problem metaDescription.missing), nutze nur Fakten aus Name, Beschreibung und Eigenschaften und schlag die Texte gesammelt mit propose_product_changes vor.` },
  metaTitleMissing: { id: 'seo.product-meta-title-missing', area: 'SEO', title: 'Produkte ohne Meta-Title', severity: 'mittel', unit: P, noun: PN,
    hint: 'Shopware nimmt dann den Produktnamen. Ein eigener Title mit Suchbegriff und Shopname rankt und klickt besser.',
    fix: n => `Schreib Meta-Titles (höchstens 60 Zeichen: Produktart, wichtigstes Merkmal, Shopname) für alle aktiven Produkte ohne Meta-Title (betrifft ${n}). Finde sie mit seo_audit (entity=product, Problem metaTitle.missing) und schlag sie gesammelt mit propose_product_changes vor.` },
  metaTitleLong: { id: 'seo.product-meta-title-long', area: 'SEO', title: `Meta-Title länger als ${META.titleMax} Zeichen`, severity: 'niedrig', unit: P, noun: PN,
    hint: `Google kürzt Titles ab etwa ${META.titleMax} Zeichen, der Rest wird abgeschnitten.`,
    fix: n => `Kürze alle Meta-Titles, die länger als ${META.titleMax} Zeichen sind (betrifft ${n}; seo_audit entity=product, Problem metaTitle.long). Wichtigsten Suchbegriff nach vorne, Aussage nicht verändern, Vorschlag mit propose_product_changes.` },
  metaTitleDup: { id: 'seo.product-meta-title-duplicate', area: 'SEO', title: 'Doppelte Meta-Titles', severity: 'mittel', unit: P, noun: PN,
    hint: 'Gleiche Titles konkurrieren in Google miteinander und wirken austauschbar.',
    fix: n => `Mach die doppelt vergebenen Meta-Titles eindeutig (betrifft ${n}; seo_audit entity=product, duplicates). Schreib je Produkt einen eigenen Meta-Title mit unterscheidendem Merkmal (höchstens ${META.titleMax} Zeichen) und schlag sie mit propose_product_changes vor.` },
  thin: { id: 'seo.product-description-thin', area: 'SEO', title: `Beschreibung fehlt oder ist dünn (unter ${META.thinWords} Wörtern)`, severity: 'mittel', unit: P, noun: PN,
    hint: 'Kurze Texte ranken schlecht und beantworten die Fragen der Kunden nicht.',
    fix: n => `Erweitere alle Produktbeschreibungen mit weniger als ${META.thinWords} Wörtern (betrifft ${n}; seo_audit entity=product, Problem description.thin). Nur belegbare Fakten aus Produktdaten und Eigenschaften, fehlende Angaben erst bei mir erfragen, Vorschlag mit propose_product_changes.` },
  noImage: { id: 'bilder.product-without-image', area: 'Bilder', title: 'Produkte ohne Bild', severity: 'hoch', unit: P, noun: PN,
    hint: 'Produkte ohne Bild verkaufen kaum und wirken in Listen leer.',
    fix: n => `Zeig mir alle aktiven Produkte ohne Bild (betrifft ${n}; find_image_gaps missing=images) und frag mich, woher die Bilder kommen sollen (Anhang, Medienverwaltung oder URL). Danach schlag die Bilder mit propose_product_images vor.` },
  altMissing: { id: 'bilder.alt-missing', area: 'Bilder', title: 'Bilder ohne Alt-Text', severity: 'mittel', unit: P, noun: PN,
    hint: 'Alt-Texte helfen in der Google-Bildersuche und sind für die Barrierefreiheit Pflicht (BFSG, WCAG 1.1.1).',
    fix: n => `Ergänze die fehlenden Alt-Texte der Produktbilder (betrifft ${n}; find_image_gaps missing=alt). Sieh dir jedes Bild mit view_image an, beschreibe konkret, was zu sehen ist, und schlag die Texte mit propose_alt_texts vor.` },
  stockZero: { id: 'daten.stock-zero-orderable', area: 'Daten', title: 'Aktiv und bestellbar ohne Bestand', severity: 'mittel', unit: P, noun: PN,
    hint: 'Kunden können bestellen, obwohl nichts auf Lager ist (kein Abverkauf eingestellt). Das erzeugt Stornos und Ärger.',
    fix: n => `Prüfe alle aktiven Produkte mit Bestand 0, die weiter bestellbar sind (betrifft ${n}; find_products_by_data active=true, dann Bestand prüfen). Zeig sie mir und frag mich, ob ich Bestand nachtragen oder die Produkte deaktivieren will. Erst dann mit propose_product_changes vorschlagen.` },
  priceZero: { id: 'preise.price-zero', area: 'Preise', title: 'Preis ist 0', severity: 'hoch', unit: P, noun: PN,
    hint: 'Ein Preis von 0 lädt zu Gratis-Bestellungen ein.',
    fix: n => `Prüfe alle aktiven Produkte mit Preis 0 (betrifft ${n}). Zeig sie mir mit Nummer und frag mich nach dem richtigen Preis, bevor du mit propose_product_changes etwas vorschlägst. Preise nie schätzen.` },
  belowPurchase: { id: 'preise.below-purchase-price', area: 'Preise', title: 'Verkaufspreis unter Einkaufspreis', severity: 'hoch', unit: P, noun: PN,
    hint: 'Jeder Verkauf dieser Produkte macht Verlust.',
    fix: n => `Prüfe alle Produkte, deren Verkaufspreis unter dem Einkaufspreis liegt (betrifft ${n}). Zeig mir je Produkt Einkaufs- und Verkaufspreis (get_product_details) und frag mich, welchen Preis ich will. Erst dann mit propose_product_changes vorschlagen, Preise nie selbst festlegen.` },
  listBelow: { id: 'preise.list-price-not-above', area: 'Preise', title: 'Streichpreis nicht über dem Preis', severity: 'mittel', unit: P, noun: PN,
    hint: 'Die angezeigte Ersparnis stimmt dann nicht und wirkt unseriös.',
    fix: n => `Bereinige alle Streichpreise, die nicht über dem Verkaufspreis liegen (betrifft ${n}). Zeig sie mir mit beiden Preisen und frag, ob ich den Streichpreis entfernen oder korrigieren will. Dann propose_product_changes (listPrice).` },
  descLinks: { id: 'links.product-description', area: 'Links', title: 'Produkttexte mit kaputten Links', severity: 'hoch', unit: P, noun: PN,
    hint: 'Links auf inaktive oder gelöschte Ziele führen Besucher auf Fehlerseiten.',
    fix: n => `Korrigiere alle Links in Produktbeschreibungen, die auf inaktive, unsichtbare oder fehlende Ziele zeigen (betrifft ${n}; seo_audit entity=product, Problem links.broken). Ersatz mit suggest_internal_links suchen, Vorschlag mit propose_product_changes.` },
  catMeta: { id: 'seo.category-meta-description-missing', area: 'SEO', title: 'Kategorien ohne Meta-Description', severity: 'mittel', unit: K, noun: KN,
    hint: 'Kategorieseiten ranken oft für die wichtigsten Suchbegriffe. Ohne Description entscheidet Google allein, was im Suchergebnis steht.',
    fix: n => `Schreib Meta-Descriptions (120 bis 158 Zeichen) für alle Kategorien ohne Meta-Description (betrifft ${n}; seo_audit entity=category, Problem metaDescription.missing). Nutze Kategoriename und enthaltene Produkte, keine erfundenen Versprechen, Vorschlag mit propose_category_changes.` },
  catDesc: { id: 'seo.category-description-missing', area: 'SEO', title: 'Kategorien ohne Beschreibung', severity: 'niedrig', unit: K, noun: KN,
    hint: 'Ein kurzer Einleitungstext gibt Kategorieseiten Inhalt für Google und Orientierung für Kunden.',
    fix: n => `Schreib kurze Einleitungstexte (2 bis 3 Sätze) für alle Kategorien ohne Beschreibung (betrifft ${n}; seo_audit entity=category). Frag vorher per ask_user, welche Kategorien Vorrang haben und welcher Ton passt, Vorschlag mit propose_category_changes.` },
  cmsBroken: { id: 'links.cms-broken', area: 'Links', title: 'Einkaufswelten mit kaputten Links oder Produkten', severity: 'hoch', unit: 'Einkaufswelten', noun: EN,
    hint: 'Besucher landen auf Fehlerseiten oder sehen Slider mit inaktiven Produkten.',
    fix: n => `Prüfe alle Einkaufswelten mit kaputten Links oder inaktiven Produkten (betrifft ${n}; seo_audit entity=pages). Zeig mir je Seite die Probleme, such Ersatz mit suggest_internal_links und frag mich, bevor du eine Seite neu entwirfst.` },
  cmsTechnical: { id: 'links.cms-technical', area: 'Links', title: 'Technische Links in Einkaufswelten', severity: 'niedrig', unit: 'Einkaufswelten', noun: EN,
    hint: 'Links wie /detail/… funktionieren, verschenken aber SEO-Wert gegenüber der sprechenden SEO-URL.',
    fix: n => `Zeig mir alle Einkaufswelten mit technischen Links (betrifft ${n}; /detail/…, /navigation/…; seo_audit entity=pages) und schlag vor, sie beim nächsten Veröffentlichen durch die SEO-URLs zu ersetzen.` },
  translation: { id: 'sprachen.missing-translation', area: 'Sprachen', title: 'Produkte ohne eigene Übersetzung', severity: 'mittel', unit: P, noun: PN,
    hint: 'Kunden dieser Sprache sehen sonst die Texte der Standardsprache.',
    fix: n => `Übersetze alle aktiven Produkte ohne eigene Übersetzung (betrifft ${n}; get_translations entity=product, onlyMissing=true). Name, Beschreibung und Meta-Daten, Fachbegriffe und Maße unverändert, Vorschlag mit propose_translations.` },
} satisfies Record<string, FindingDef>;

/** Befund aus Definition + Treffern. count = Anzahl (bei gedeckelten Prüfungen eine Untergrenze). */
export function makeFinding(d: FindingDef, count: number, total: number | undefined, sample: Hit[], o: { atLeast?: boolean; title?: string; idSuffix?: string; fixExtra?: string } = {}): CheckFinding | null {
  if (!count) return null;
  const n = `${o.atLeast ? 'mindestens ' : ''}${count.toLocaleString('de-DE')} ${d.noun[count === 1 ? 0 : 1]}`;
  // Shop-Texte (Namen) nur gekürzt und in Anführungszeichen, damit sie im Auftrag als Daten erkennbar bleiben
  const named = count <= sample.length ? ` Betroffen: ${sample.slice(0, 5).map(s => quoteLabel(s.label)).join(', ')}.` : '';
  return {
    id: d.id + (o.idSuffix ? `.${o.idSuffix}` : ''), area: d.area, title: o.title ?? d.title, severity: d.severity, count, total, unit: d.unit,
    ...(o.atLeast ? { atLeast: true } : {}), sample: sample.slice(0, 5), hint: d.hint, fixPrompt: d.fix(n) + (o.fixExtra ?? '') + named,
  };
}

export const quoteLabel = (t: string, max = 80) => { const c = clean(t).replace(/[„“"]/g, "'"); return `„${c.length > max ? c.slice(0, max - 1) + '…' : c}“`; };

// ---- Produktzeilen (gelesen mit includes, siehe SCAN_INCLUDES) ----
export const SCAN_INCLUDES = { product: ['id', 'productNumber', 'name', 'translated', 'price', 'purchasePrices'] };
export interface ScanRow { id: string; label: string; metaTitle: string; description: string; price: number | null; listPrice: number | null; purchase: number | null }
const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();
// Nur die Standardwährung (Pflichtpreis in Shopware); andere Währungen nicht mischen
const inCurrency = (prices: unknown) => (Array.isArray(prices) ? (prices as SwEntity[]) : []).find(p => p?.currencyId === DEFAULT_CURRENCY) ?? null;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const productLabel = (p: SwEntity) => { const name = clean(p.translated?.name ?? p.name) || p.productNumber || p.id; return p.productNumber ? `${name} (${p.productNumber})` : name; };

export function toScanRow(p: SwEntity): ScanRow {
  const pr = inCurrency(p.price), pu = inCurrency(p.purchasePrices);
  return { id: p.id, label: productLabel(p), metaTitle: clean(p.translated?.metaTitle ?? p.metaTitle), description: String(p.translated?.description ?? p.description ?? ''),
    price: num(pr?.gross), listPrice: num(pr?.listPrice?.gross), purchase: num(pu?.gross) };
}

/** Auswertung der gelesenen Produkte: Länge/Dubletten der Titles, dünne Texte, Preisprobleme */
export function scanHits(rows: ScanRow[], currency = '€') {
  const money = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
  const hit = (r: ScanRow): Hit => ({ id: r.id, label: r.label });
  const dups = duplicates(rows.map(r => ({ id: r.id, value: r.metaTitle })));
  const dupIds = new Set([...dups.values()].flat());
  const byId = new Map(rows.map(r => [r.id, r]));
  // Beispiele für Dubletten: je Gruppe nebeneinander, mit dem doppelten Title
  const dupSample = [...dups.entries()].flatMap(([, ids]) => ids.map(id => byId.get(id)!)).map(r => ({ id: r.id, label: `${r.label}: „${r.metaTitle.slice(0, 60)}“` }));
  return {
    metaTitleLong: rows.filter(r => r.metaTitle.length > META.titleMax).map(r => ({ id: r.id, label: `${r.label}, ${r.metaTitle.length} Zeichen` })),
    metaTitleDup: { count: dupIds.size, groups: dups.size, sample: dupSample },
    thin: rows.filter(r => wordCount(r.description) < META.thinWords).map(hit),
    priceZero: rows.filter(r => r.price != null && r.price <= 0).map(hit),
    belowPurchase: rows.filter(r => r.price != null && r.price > 0 && r.purchase != null && r.purchase > r.price).map(r => ({ id: r.id, label: `${r.label}: ${money(r.price!)} statt EK ${money(r.purchase!)}` })),
    listBelow: rows.filter(r => r.listPrice != null && r.listPrice > 0 && r.price != null && r.listPrice <= r.price).map(r => ({ id: r.id, label: `${r.label}: Streichpreis ${money(r.listPrice!)}, Preis ${money(r.price!)}` })),
  };
}
