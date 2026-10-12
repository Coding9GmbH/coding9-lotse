import type { TargetKind } from './protocol';

/** Anzeigenamen der KI-Werkzeuge (Arbeitsschritte im Chat). */
export const TOOL_LABELS: Record<string, string> = {
  search_categories: 'Kategorien durchsuchen', search_products: 'Produkte durchsuchen', get_product: 'Produkt lesen',
  get_category: 'Kategorie lesen', search_media: 'Medien durchsuchen', import_image: 'Bild importieren',
  create_svg_image: 'Grafik (SVG) erstellen', generate_image: 'Bild per KI erzeugen', list_cms_pages: 'Layouts prüfen',
  get_cms_page: 'Einkaufswelt-Aufbau lesen', list_sales_channels: 'Verkaufskanäle lesen', get_styleguide: 'Styleguide lesen',
  get_brand_signals: 'Shop-Theme, CSS & Texte analysieren', save_styleguide: 'Styleguide speichern',
  draft_page: 'Seitenentwurf erstellen', publish_page: 'Veröffentlichung vorschlagen', ask_user: 'Rückfrage',
  view_image: 'Bild ansehen', read_page: 'Shop-Seite lesen', propose_new_products: 'Neue Produkte vorschlagen', propose_product_changes: 'Produktänderungen vorschlagen', propose_category_changes: 'Kategorieänderungen vorschlagen',
  list_products: 'Produkte analysieren',
  get_product_images: 'Produktbilder lesen', find_image_gaps: 'Bildlücken finden', propose_product_images: 'Bildänderungen vorschlagen', propose_alt_texts: 'Alt-Texte vorschlagen',
  get_seo_urls: 'SEO-URLs lesen', suggest_internal_links: 'Interne Links finden', propose_seo_urls: 'SEO-URLs vorschlagen', seo_audit: 'SEO-Check',
  list_property_groups: 'Eigenschaften lesen', list_manufacturers: 'Hersteller lesen', list_tags: 'Tags lesen', list_delivery_times: 'Lieferzeiten lesen', list_taxes: 'Steuersätze lesen',
  get_product_details: 'Produkt-Stammdaten lesen', find_products_by_data: 'Produkte nach Stammdaten finden', propose_product_data: 'Stammdaten-Änderungen vorschlagen',
  list_languages: 'Sprachen & Domains lesen', get_translations: 'Übersetzungen lesen', propose_translations: 'Übersetzungen vorschlagen',
  get_page_texts: 'Seitentexte lesen', propose_page_translation: 'Seitenübersetzung vorschlagen',
  get_variants: 'Varianten lesen', list_variant_properties: 'Varianten-Eigenschaften lesen', propose_variants: 'Varianten-Änderungen vorschlagen',
  preview_bulk_filter: 'Stapel-Auswahl zählen', propose_bulk_product_change: 'Stapeländerung vorschlagen',
  list_product_streams: 'Produktstreams lesen', get_product_stream: 'Produktstream lesen', preview_product_stream: 'Stream-Treffer prüfen',
  propose_product_stream: 'Produktstream vorschlagen', propose_stream_assignment: 'Stream-Zuordnung vorschlagen',
  read_supplier_file: 'Lieferantendatei lesen', save_import_mapping: 'Zuordnung speichern', preview_import: 'Import prüfen', propose_import: 'Import vorschlagen',
  gsc_performance: 'Search-Console-Daten lesen', gsc_opportunities: 'Search-Console-Chancen finden', gsc_content_gaps: 'Inhaltslücken finden', gsc_measure_effect: 'Erfolg messen',
  add_knowledge: 'Wissen aufnehmen', search_knowledge: 'Wissensbasis durchsuchen', get_product_knowledge: 'Produktwissen lesen', list_knowledge: 'Wissensbasis lesen',
  add_rule: 'Regel speichern', list_rules: 'Regeln lesen', remove_rule: 'Regel löschen',
  list_promotions: 'Promotionen lesen', get_promotion: 'Promotion lesen', propose_promotion: 'Promotion vorschlagen', propose_promotion_status: 'Promotion-Status vorschlagen',
  run_shop_check: 'Shop-Check',
  preview_collection_rules: 'Kollektionsregeln prüfen', propose_collection: 'Kollektion vorschlagen', propose_collection_products: 'Kollektions-Zuordnung vorschlagen',
  list_store_views: 'Store-Views lesen', list_product_attributes: 'Attribute lesen', propose_category_products: 'Kategorie-Zuordnung vorschlagen', propose_cms_page_changes: 'CMS-Seite ändern',
  get_legal_overview: 'Rechts-Check', get_gpsr_status: 'GPSR-Angaben prüfen', read_gpsr_document: 'Dokument lesen', propose_gpsr_data: 'GPSR-Angaben vorschlagen',
  find_baseprice_gaps: 'Grundpreise prüfen', propose_base_prices: 'Grundpreise vorschlagen', check_accessibility: 'Barrierefreiheit prüfen', check_legal_pages: 'Rechtstexte prüfen',
};
export const toolLabel = (name: string): string => TOOL_LABELS[name] ?? name;

export const KIND_LABEL: Record<TargetKind, string> = { category: 'Kategorie', product: 'Produkt', landing: 'Landingpage' };

export type ExampleTag = 'Produkte' | 'Layout' | 'Preise' | 'Daten' | 'Inhalt' | 'SEO' | 'Analyse';
export interface Example { tag: ExampleTag; title: string; text: string }

// KI-first: Produkte, Inhalte und SEO zuerst – Seiten und Layouts kommen obendrauf
export const examples = (p: string, c: string): Example[] => [
  { tag: 'Produkte', title: 'Produkt aus Foto anlegen', text: 'Lege aus den angehängten Fotos neue Produkte an, mit Beschreibung und SEO-Daten. Erst einmal inaktiv.' },
  { tag: 'Produkte', title: 'Lieferantenliste importieren', text: 'Importiere die angehängte Lieferantenliste: neue Produkte als Entwurf anlegen, vorhandene aktualisieren.' },
  { tag: 'SEO', title: 'Texte & Meta-Daten', text: 'Schreibe für alle Produkte ohne Beschreibung einen SEO-Text samt Meta-Daten' },
  { tag: 'SEO', title: 'Search-Console-Chancen', text: 'Welche Seiten haben laut Search Console viele Impressionen, aber kaum Klicks? Schlage bessere Meta-Daten vor.' },
  { tag: 'Preise', title: 'Preise massenhaft ändern', text: `Senke alle Preise in der Kategorie „${c}“ um 20 % und runde auf .99` },
  { tag: 'Inhalt', title: 'FAQ bei allen Produkten', text: 'Füge bei allen Produkten den Block FAQ hinzu und fülle ihn sinnvoll aus' },
  { tag: 'Daten', title: 'Bestand & Status', text: 'Deaktiviere alle Produkte, die keinen Bestand mehr haben' },
  { tag: 'Layout', title: 'Kategorie als Landingpage', text: `Baue die Kategorie „${c}“ zu einer SEO- und conversion-optimierten Landingpage um` },
  { tag: 'Layout', title: 'Produktseite neu gestalten', text: `Ändere das Layout der Produktseite von „${p}“: modern, mit USPs und FAQ` },
];

/** Vorschlags-Chips je Kontext. */
export const SUGGESTIONS: Record<TargetKind, string[]> = {
  category: ['Hero, 3 USPs, Produkt-Slider und Ratgeber-Text', 'Bestehende Inhalte übernehmen und modern aufbauen', 'Seite mit FAQ-Akkordeon (Custom-HTML)'],
  product: ['Hochwertige Storytelling-Seite mit USPs', 'Vorhandene Beschreibung übernehmen und aufwerten', 'Schreibe zusätzlich Beschreibung und SEO-Meta'],
  landing: ['Sommer-Aktion mit Hero, USPs und Produkt-Slider', 'Ratgeber-Landingpage zu einem Thema meiner Wahl'],
};

export const DEFAULT_PLACEHOLDER = 'Was soll im Shop passieren?';
export const placeholderFor = (kind: TargetKind, name = ''): string =>
  ({ category: `Was soll auf der Kategorie „${name}“ entstehen?`, product: `Wie soll die Produktseite „${name}“ aussehen?`, landing: 'Thema und Ziel der Landingpage?' })[kind];
