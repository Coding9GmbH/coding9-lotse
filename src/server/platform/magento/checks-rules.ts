// Magento-Shop-Check (rein → testbar): Befund-Definitionen mit Aufträgen (fixPrompt) für die Magento-Werkzeuge
// und Auswertung gelesener Produkte/Kategorien.
import type { FindingDef, Hit } from '../../features/shopcheck-rules';
import { duplicates, META, wordCount } from '../../features/seo-rules';
import { attr, attrStr, isActive, money, plain, priceState, type MRecord } from './map';

const P = 'Produkten', K = 'Kategorien', S = 'Seiten', PN: [string, string] = ['Produkt', 'Produkte'], KN: [string, string] = ['Kategorie', 'Kategorien'], SN: [string, string] = ['Seite', 'Seiten'];
export const M_DEFS = {
  metaDescMissing: { id: 'seo.product-meta-description-missing', area: 'SEO', title: 'Produkte ohne Meta-Description', severity: 'hoch', unit: P, noun: PN,
    hint: 'Ohne Meta-Description wählt Google selbst einen Textausschnitt. Eine gute Description bringt mehr Klicks.',
    fix: n => `Schreib Meta-Descriptions (120 bis 158 Zeichen, mit Nutzen und Handlungsaufforderung) für alle aktiven Produkte ohne Meta-Description (betrifft ${n}). Finde sie mit seo_audit (entity=product, Problem „Meta-Description fehlt“, mit nextOffset weiterblättern), nutze nur Fakten aus Name, Beschreibung und Attributen (get_product) und schlag die Texte gesammelt mit propose_product_changes (metaDescription) vor.` },
  metaTitleMissing: { id: 'seo.product-meta-title-missing', area: 'SEO', title: 'Produkte ohne Meta-Title', severity: 'mittel', unit: P, noun: PN,
    hint: 'Magento nimmt dann den Produktnamen. Ein eigener Title mit Suchbegriff und Shopname rankt und klickt besser.',
    fix: n => `Schreib Meta-Titles (höchstens 60 Zeichen: Produktart, wichtigstes Merkmal, Shopname) für alle aktiven Produkte ohne Meta-Title (betrifft ${n}). Finde sie mit seo_audit (entity=product, Problem „Meta-Title fehlt“) und schlag sie gesammelt mit propose_product_changes (metaTitle) vor.` },
  metaTitleLong: { id: 'seo.product-meta-title-long', area: 'SEO', title: `Meta-Title länger als ${META.titleMax} Zeichen`, severity: 'niedrig', unit: P, noun: PN,
    hint: `Google kürzt Titles ab etwa ${META.titleMax} Zeichen, der Rest wird abgeschnitten.`,
    fix: n => `Kürze alle Meta-Titles, die länger als ${META.titleMax} Zeichen sind (betrifft ${n}; seo_audit entity=product, Problem „Meta-Title über 60 Zeichen“). Wichtigsten Suchbegriff nach vorne, Aussage nicht verändern, Vorschlag mit propose_product_changes.` },
  metaTitleDup: { id: 'seo.product-meta-title-duplicate', area: 'SEO', title: 'Doppelte Meta-Titles', severity: 'mittel', unit: P, noun: PN,
    hint: 'Gleiche Titles konkurrieren in Google miteinander und wirken austauschbar.',
    fix: n => `Mach die doppelt vergebenen Meta-Titles eindeutig (betrifft ${n}; seo_audit entity=product, Problem „Meta-Title doppelt“). Schreib je Produkt einen eigenen Meta-Title mit unterscheidendem Merkmal (höchstens ${META.titleMax} Zeichen) und schlag sie mit propose_product_changes vor.` },
  thin: { id: 'seo.product-description-thin', area: 'SEO', title: `Beschreibung fehlt oder ist dünn (unter ${META.thinWords} Wörtern)`, severity: 'mittel', unit: P, noun: PN,
    hint: 'Kurze Texte ranken schlecht und beantworten die Fragen der Kunden nicht.',
    fix: n => `Erweitere alle Produktbeschreibungen mit weniger als ${META.thinWords} Wörtern (betrifft ${n}; seo_audit entity=product, Problem „Beschreibung unter 50 Wörtern“). Nur belegbare Fakten aus Produktdaten und Attributen (get_product), fehlende Angaben erst bei mir erfragen, Vorschlag mit propose_product_changes (description).` },
  noImage: { id: 'bilder.product-without-image', area: 'Bilder', title: 'Produkte ohne Bild', severity: 'hoch', unit: P, noun: PN,
    hint: 'Produkte ohne Bild verkaufen kaum und wirken in Listen leer.',
    fix: n => `Zeig mir alle aktiven Produkte ohne Bild (betrifft ${n}; find_image_gaps missing=images active=true) und frag mich, woher die Bilder kommen sollen (Anhang, vorhandenes Shop-Bild oder URL). Danach schlag die Bilder mit propose_product_images vor.` },
  altMissing: { id: 'bilder.alt-missing', area: 'Bilder', title: 'Bilder ohne Alt-Text', severity: 'mittel', unit: P, noun: PN,
    hint: 'Alt-Texte (in Magento: Bild-Label) helfen in der Google-Bildersuche und sind für die Barrierefreiheit Pflicht (BFSG, WCAG 1.1.1).',
    fix: n => `Ergänze die fehlenden Alt-Texte der Produktbilder (betrifft ${n}; find_image_gaps missing=alt). Sieh dir jedes Bild mit view_image an, beschreibe konkret, was zu sehen ist, und schlag die Texte mit propose_alt_texts vor.` },
  stockZero: { id: 'daten.stock-zero-orderable', area: 'Daten', title: 'Aktiv und als lieferbar markiert ohne Bestand', severity: 'mittel', unit: P, noun: PN,
    hint: 'Die Lagerquelle steht auf „auf Lager“, die Menge ist aber 0. Je nach Einstellung für Nachbestellungen können Kunden bestellen, obwohl nichts da ist.',
    fix: n => `Prüfe alle aktiven Produkte mit Bestand 0, deren Lagerquelle auf „auf Lager“ steht (betrifft ${n}; list_products active=true maxStock=0, der Bestandsfilter gilt je Seite: mit nextOffset alle Seiten durchgehen). Zeig sie mir und frag mich, ob ich Bestand nachtragen oder die Produkte deaktivieren will. Erst dann mit propose_product_changes (stock oder active) vorschlagen.` },
  priceZero: { id: 'preise.price-zero', area: 'Preise', title: 'Preis ist 0', severity: 'hoch', unit: P, noun: PN,
    hint: 'Ein Preis von 0 lädt zu Gratis-Bestellungen ein.',
    fix: n => `Prüfe alle aktiven Produkte mit Preis 0 (betrifft ${n}; list_products active=true maxPrice=0, der Preisfilter gilt je Seite: mit nextOffset alle Seiten durchgehen). Zeig sie mir mit SKU und frag mich nach dem richtigen Preis, bevor du mit propose_product_changes etwas vorschlägst. Preise nie schätzen.` },
  specialNotBelow: { id: 'preise.special-not-below', area: 'Preise', title: 'Sonderpreis nicht unter dem regulären Preis', severity: 'mittel', unit: P, noun: PN,
    hint: 'Magento zeigt einen Sonderpreis nur, wenn er niedriger ist. So ein Sonderpreis wirkt nicht und verwirrt bei der Pflege.',
    fix: n => `Bereinige alle Sonderpreise, die nicht unter dem regulären Preis liegen (betrifft ${n}; list_products zeigt regularPrice und specialPrice). Zeig sie mir mit beiden Preisen und frag, ob ich den Sonderpreis entfernen (listPrice null) oder einen echten Streichpreis setzen will. Dann propose_product_changes.` },
  descLinks: { id: 'links.product-description', area: 'Links', title: 'Produkttexte mit kaputten Links', severity: 'hoch', unit: P, noun: PN,
    hint: 'Links auf deaktivierte oder gelöschte Ziele führen Besucher auf Fehlerseiten.',
    fix: n => `Korrigiere alle Links in Produktbeschreibungen, die auf fehlende, deaktivierte oder nicht sichtbare Ziele zeigen (betrifft ${n}). Lies die Beschreibung mit get_product, such passende Ziele mit search_products/search_categories und get_seo_urls und schlag die korrigierte Beschreibung mit propose_product_changes vor.` },
  catMeta: { id: 'seo.category-meta-description-missing', area: 'SEO', title: 'Kategorien ohne Meta-Description', severity: 'mittel', unit: K, noun: KN,
    hint: 'Kategorieseiten ranken oft für die wichtigsten Suchbegriffe. Ohne Description entscheidet Google allein, was im Suchergebnis steht.',
    fix: n => `Schreib Meta-Descriptions (120 bis 158 Zeichen) für alle aktiven Kategorien ohne Meta-Description (betrifft ${n}; seo_audit entity=category, Problem „Meta-Description fehlt“). Nutze Kategoriename und enthaltene Produkte, keine erfundenen Versprechen, Vorschlag mit propose_category_changes.` },
  catDesc: { id: 'seo.category-description-missing', area: 'SEO', title: 'Kategorien ohne Beschreibung', severity: 'niedrig', unit: K, noun: KN,
    hint: 'Ein kurzer Einleitungstext gibt Kategorieseiten Inhalt für Google und Orientierung für Kunden.',
    fix: n => `Schreib kurze Einleitungstexte (2 bis 3 Sätze) für alle aktiven Kategorien ohne Beschreibung (betrifft ${n}; seo_audit entity=category). Frag vorher per ask_user, welche Kategorien Vorrang haben und welcher Ton passt, Vorschlag mit propose_category_changes (description). Für einen gestalteten Kategorie-Inhalt: draft_page (product_list) und publish_page target=category.` },
  cmsBroken: { id: 'links.cms-broken', area: 'Links', title: 'CMS-Seiten mit kaputten Links', severity: 'hoch', unit: S, noun: SN,
    hint: 'Besucher landen auf Fehlerseiten oder auf deaktivierten Produkten.',
    fix: n => `Prüfe alle aktiven CMS-Seiten mit kaputten Links (betrifft ${n}; list_cms_pages, get_cms_page). Zeig mir je Seite die Links und das Problem, such Ersatz mit search_products/search_categories und get_seo_urls und schlag den korrigierten Inhalt mit propose_cms_page_changes vor.` },
  translation: { id: 'sprachen.missing-translation', area: 'Sprachen', title: 'Produkte ohne eigene Übersetzung', severity: 'mittel', unit: P, noun: PN,
    hint: 'Kunden dieser Store-View sehen sonst die Texte der Standardsprache.',
    fix: n => `Übersetze alle aktiven Produkte ohne eigene Übersetzung (betrifft ${n}; get_translations entity=product zeigt je Store-View own=false). Name, Beschreibung und Meta-Daten, Fachbegriffe und Maße unverändert, Vorschlag mit propose_translations (store = Code der Store-View).` },
} satisfies Record<string, FindingDef>;

export const productLabel = (p: MRecord) => `${plain(p.name) || p.sku} (${p.sku})`;
const SIMPLE = new Set(['simple', 'virtual', 'downloadable']);

/** Auswertung der gelesenen aktiven, sichtbaren Produkte (Store-View der Einstellungen) */
export function productHits(rows: MRecord[], stock?: Map<string, { qty: number; inStock: boolean }>) {
  const hit = (p: MRecord): Hit => ({ id: String(p.id), label: productLabel(p) });
  const mt = (p: MRecord) => plain(attrStr(p, 'meta_title'));
  const dups = duplicates(rows.map(p => ({ id: String(p.id), value: mt(p) })));
  const dupIds = new Set([...dups.values()].flat()), byId = new Map(rows.map(p => [String(p.id), p]));
  return {
    metaDescMissing: rows.filter(p => !plain(attrStr(p, 'meta_description'))).map(hit),
    metaTitleMissing: rows.filter(p => !mt(p)).map(hit),
    metaTitleLong: rows.filter(p => mt(p).length > META.titleMax).map(p => ({ id: String(p.id), label: `${productLabel(p)}, ${mt(p).length} Zeichen` })),
    metaTitleDup: { count: dupIds.size, sample: [...dups.values()].flat().map(id => byId.get(id)!).map(p => ({ id: String(p.id), label: `${productLabel(p)}: „${mt(p).slice(0, 60)}“` })) },
    thin: rows.filter(p => wordCount(attr(p, 'description')) < META.thinWords).map(hit),
    noImage: rows.filter(p => p.type_id !== 'configurable' && !(p.media_gallery_entries ?? []).some((e: MRecord) => !e.disabled)).map(hit),
    altMissing: rows.filter(p => (p.media_gallery_entries ?? []).some((e: MRecord) => !e.disabled && !plain(e.label))).map(hit),
    priceZero: rows.filter(p => SIMPLE.has(String(p.type_id)) && isActive(p) && (priceState(p).selling ?? 1) <= 0).map(hit),
    specialNotBelow: rows.filter(p => { const s = priceState(p); return SIMPLE.has(String(p.type_id)) && s.special != null && s.regular != null && s.special >= s.regular && (!s.to || s.to >= new Date().toISOString().slice(0, 10)); })
      .map(p => { const s = priceState(p); return { id: String(p.id), label: `${productLabel(p)}: Sonderpreis ${money(s.special)}, Preis ${money(s.regular)}` }; }),
    stockZero: stock ? rows.filter(p => SIMPLE.has(String(p.type_id)) && stock.has(p.sku) && stock.get(p.sku)!.inStock && stock.get(p.sku)!.qty <= 0).map(hit) : [],
  };
}

/** Kategorien (aktiv, ab Ebene 2) ohne Meta-Description bzw. Beschreibung (Inhalt aus einem CMS-Block zählt als Beschreibung) */
export function categoryHits(rows: MRecord[]) {
  const hit = (c: MRecord): Hit => ({ id: String(c.id), label: plain(c.name) || String(c.id) });
  return { meta: rows.filter(c => !plain(attrStr(c, 'meta_description'))).map(hit), desc: rows.filter(c => !plain(attr(c, 'description')) && !(attrStr(c, 'landing_page') && ['PAGE', 'PRODUCTS_AND_PAGE'].includes(attrStr(c, 'display_mode') ?? ''))).map(hit) };
}

/** Produkte ohne eigene Übersetzung: Name UND Beschreibung der Store-View gleich den globalen Werten */
export function untranslated(global: MRecord[], view: MRecord[]): Hit[] {
  const g = new Map(global.map(p => [String(p.id), p]));
  return view.filter(p => { const o = g.get(String(p.id)); return o && plain(p.name) === plain(o.name) && plain(attr(p, 'description')) === plain(attr(o, 'description')); }).map(p => ({ id: String(p.id), label: productLabel(p) }));
}
