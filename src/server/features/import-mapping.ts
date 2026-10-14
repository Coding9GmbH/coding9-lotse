// Mapping supplier columns → Lotse/Shopware fields (pure → testable): fields, suggestion from the column names, check.
import { normHeader, type ColumnInfo } from './import-parse';

export interface PropertyColumn { group: string; column: string }
export interface ImportMapping {
  productNumber?: string; ean?: string; name?: string; description?: string;
  priceGross?: string; priceNet?: string; taxRate?: string; listPrice?: string; purchasePrice?: string;
  stock?: string; manufacturer?: string; manufacturerNumber?: string; category?: string;
  weight?: string; width?: string; height?: string; length?: string;
  images?: string[]; parentNumber?: string; deliveryTime?: string;
  metaTitle?: string; metaDescription?: string; keywords?: string;
  /** Properties (filters in the shop), e.g. material */
  properties?: PropertyColumn[];
  /** Variant axes (only with parentNumber), e.g. color, size */
  variantOptions?: PropertyColumn[];
  /** Units of the columns (Shopware: weight in kg, dimensions in mm) */
  units?: { weight?: 'kg' | 'g'; dimensions?: 'mm' | 'cm' | 'm' };
}
export type ScalarTarget = Exclude<keyof ImportMapping, 'images' | 'properties' | 'variantOptions' | 'units'>;

export const FIELD_LABELS: Record<ScalarTarget | 'images' | 'properties' | 'variantOptions', string> = {
  productNumber: 'Produktnummer', ean: 'EAN/GTIN', name: 'Name', description: 'Beschreibung', priceGross: 'Preis brutto', priceNet: 'Preis netto',
  taxRate: 'Steuersatz', listPrice: 'Streichpreis (brutto)', purchasePrice: 'Einkaufspreis (netto)', stock: 'Bestand', manufacturer: 'Hersteller',
  manufacturerNumber: 'Hersteller-Nr.', category: 'Kategorie (Pfad)', weight: 'Gewicht', width: 'Breite', height: 'Höhe', length: 'Länge',
  images: 'Bild-URLs', parentNumber: 'Hauptartikel-Nr. (Varianten)', deliveryTime: 'Lieferzeit', metaTitle: 'Meta-Title', metaDescription: 'Meta-Description',
  keywords: 'Keywords', properties: 'Eigenschaften', variantOptions: 'Varianten-Achsen',
};

// Synonyms (normalized, see normHeader). Order = priority; exact matches before partial matches.
const SYN: Record<ScalarTarget, string[]> = {
  productNumber: ['artikelnummer', 'artikelnr', 'artnr', 'produktnummer', 'sku', 'bestellnummer', 'bestellnr', 'itemnumber', 'articlenumber', 'productnumber', 'artikel', 'nummer'],
  ean: ['ean', 'gtin', 'ean13', 'barcode', 'eancode', 'gtin13'],
  name: ['name', 'bezeichnung', 'artikelbezeichnung', 'produktname', 'artikelname', 'titel', 'title', 'productname', 'kurzbezeichnung'],
  description: ['beschreibung', 'langtext', 'produktbeschreibung', 'artikelbeschreibung', 'description', 'langbeschreibung', 'text'],
  priceGross: ['vkbrutto', 'preisbrutto', 'bruttopreis', 'verkaufspreisbrutto', 'pricegross', 'grossprice', 'vkpreis', 'vk', 'verkaufspreis', 'preis', 'price'],
  priceNet: ['vknetto', 'preisnetto', 'nettopreis', 'verkaufspreisnetto', 'pricenet', 'netprice'],
  taxRate: ['mwst', 'mwstsatz', 'ust', 'ustsatz', 'steuersatz', 'steuer', 'vat', 'taxrate', 'tax', 'mehrwertsteuer'],
  listPrice: ['uvp', 'streichpreis', 'stattpreis', 'listenpreis', 'listprice', 'msrp', 'altpreis'],
  purchasePrice: ['ek', 'eknetto', 'einkaufspreis', 'haendlerpreis', 'purchaseprice', 'ekpreis', 'einkaufspreisnetto'],
  stock: ['bestand', 'lagerbestand', 'lager', 'verfuegbar', 'verfuegbarkeit', 'menge', 'stock', 'qty', 'quantity', 'anzahl'],
  manufacturer: ['hersteller', 'marke', 'brand', 'manufacturer', 'herstellername'],
  manufacturerNumber: ['herstellernummer', 'herstellerartikelnummer', 'herstellernr', 'mpn', 'manufacturernumber'],
  category: ['kategorie', 'kategoriepfad', 'kategorien', 'warengruppe', 'category', 'categories', 'rubrik'],
  weight: ['gewicht', 'gewichtkg', 'gewichting', 'nettogewicht', 'weight', 'bruttogewicht'],
  width: ['breite', 'breitemm', 'breitecm', 'width'],
  height: ['hoehe', 'hoehemm', 'hoehecm', 'height'],
  length: ['laenge', 'laengemm', 'laengecm', 'tiefe', 'length', 'depth'],
  parentNumber: ['hauptartikelnummer', 'hauptartikel', 'vaterartikel', 'vaterartikelnummer', 'stammartikel', 'parentnumber', 'parentsku', 'parent', 'masterartikel', 'master'],
  deliveryTime: ['lieferzeit', 'deliverytime', 'lieferzeitraum'],
  metaTitle: ['metatitle', 'metatitel', 'seotitel', 'seotitle'],
  metaDescription: ['metadescription', 'metabeschreibung', 'seobeschreibung', 'seodescription'],
  keywords: ['keywords', 'suchbegriffe', 'schlagworte', 'tags', 'schlagwoerter'],
};
// too generic for partial matches (e.g. "Artikelgewicht" is not an "Artikelnummer")
const NO_PREFIX = new Set(['artikel', 'nummer', 'text', 'tax', 'lager', 'vk', 'ek', 'name', 'titel', 'title', 'parent', 'master', 'tags', 'menge', 'ust', 'sku']);
const IMAGE = /^(bild|bilder|image|images|foto|fotos|picture|bildurl|imageurl|abbildung)(\d+|url\d*)?$/;
const PROPERTY = /^(farbe|color|colour|groesse|size|material|stoff|form|muster|oberflaeche|ausfuehrung|inhalt|volumen|geschmack|sorte|serie)$/;

/** Suggestion from column names (+ types): at most one column per target field, each column at most once */
export function suggestMapping(columns: ColumnInfo[]): ImportMapping {
  const m: ImportMapping = {}, used = new Set<string>();
  const norm = columns.map(c => ({ c, n: normHeader(c.name) }));
  const take = (t: ScalarTarget, pred: (n: string) => boolean) => {
    const hit = norm.find(x => !used.has(x.c.name) && x.c.type !== 'leer' && pred(x.n));
    if (hit) { m[t] = hit.c.name; used.add(hit.c.name); }
  };
  // Net/purchase prices and manufacturer no. first (otherwise "Preis" or "Artikelnummer" would swallow them)
  const order: ScalarTarget[] = ['parentNumber', 'manufacturerNumber', 'purchasePrice', 'priceNet', 'listPrice', 'ean', 'productNumber', 'priceGross', 'taxRate', 'metaTitle', 'metaDescription', 'keywords', 'name', 'description', 'stock', 'manufacturer', 'category', 'weight', 'width', 'height', 'length', 'deliveryTime'];
  for (const t of order) take(t, n => SYN[t].includes(n));
  for (const t of order) if (!m[t]) take(t, n => SYN[t].some(s => !NO_PREFIX.has(s) && n.startsWith(s)));
  const images = norm.filter(x => !used.has(x.c.name) && (IMAGE.test(x.n) || (x.c.type === 'url' && /bild|image|foto|pic/.test(x.n)))).map(x => x.c.name);
  if (images.length) { m.images = images; images.forEach(i => used.add(i)); }
  const props = norm.filter(x => !used.has(x.c.name) && x.c.type !== 'leer' && PROPERTY.test(x.n));
  if (props.length) {
    const list = props.map(x => ({ group: x.c.name.replace(/\s*\(.*\)$/, ''), column: x.c.name }));
    if (m.parentNumber) m.variantOptions = list.filter(p => /farbe|color|colour|groesse|size/.test(normHeader(p.column)));
    const rest = list.filter(p => !m.variantOptions?.includes(p));
    if (rest.length) m.properties = rest;
    if (!m.variantOptions?.length) delete m.variantOptions;
  }
  const wcol = (m.weight ?? '').toLowerCase(), dcol = [m.width, m.height, m.length].filter(Boolean).join(' ').toLowerCase();
  const units: ImportMapping['units'] = {};
  if (wcol && !/kg/.test(wcol) && /\(g\)|\[g\]|\sg$|gramm|\bin g\b/.test(wcol)) units.weight = 'g';
  if (/\bcm\b|\(cm\)/.test(dcol)) units.dimensions = 'cm';
  if (Object.keys(units).length) m.units = units;
  return m;
}

/** All columns named in the mapping must exist; check required fields for new products */
export function checkMapping(m: ImportMapping, headers: string[]): string[] {
  const errs: string[] = [], has = new Set(headers);
  const cols: [string, string | undefined][] = [
    ...(Object.keys(SYN) as ScalarTarget[]).map(t => [FIELD_LABELS[t], m[t]] as [string, string | undefined]),
    ...(m.images ?? []).map(c => ['Bild-URLs', c] as [string, string]),
    ...[...(m.properties ?? []), ...(m.variantOptions ?? [])].map(p => [`Eigenschaft ${p.group}`, p.column] as [string, string]),
  ];
  for (const [label, c] of cols) if (c && !has.has(c)) errs.push(`${label}: Spalte „${c}“ gibt es nicht`);
  if (!m.productNumber && !m.ean) errs.push('Produktnummer oder EAN muss zugeordnet sein (sonst kein Abgleich möglich)');
  if (m.variantOptions?.length && !m.parentNumber) errs.push('Varianten-Achsen brauchen eine Spalte für die Hauptartikel-Nr. (parentNumber)');
  if (m.parentNumber && !m.productNumber) errs.push('Varianten brauchen eine Produktnummer-Spalte');
  return errs;
}

/** Mapping in readable form for the follow-up question: "Artikelnummer → Produktnummer" */
export function describeMapping(m: ImportMapping): string[] {
  const out: string[] = [];
  for (const t of Object.keys(SYN) as ScalarTarget[]) if (m[t]) out.push(`${m[t]} → ${FIELD_LABELS[t]}`);
  if (m.images?.length) out.push(`${m.images.join(', ')} → Bilder`);
  for (const p of m.properties ?? []) out.push(`${p.column} → Eigenschaft „${p.group}“`);
  for (const p of m.variantOptions ?? []) out.push(`${p.column} → Varianten-Achse „${p.group}“`);
  if (m.units?.weight === 'g') out.push('Gewicht in Gramm (wird in kg umgerechnet)');
  if (m.units?.dimensions && m.units.dimensions !== 'mm') out.push(`Maße in ${m.units.dimensions} (werden in mm umgerechnet)`);
  return out;
}
