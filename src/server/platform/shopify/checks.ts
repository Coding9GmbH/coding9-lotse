import 'server-only';
// Shopify: Shop-Check (Startseite). Liest NUR über den geschützten Reader des Durchlaufs (feste Queries), höchstens SCAN_MAX aktive
// Produkte („mindestens“, wenn der Katalog größer ist). Befunde mit Aufträgen (fixPrompt), die die Shopify-Werkzeuge nennen.
import type { CheckFinding } from '@/lib/protocol';
import { registerPlatformCheck } from '../../checks';
import { makeFinding, quoteLabel, type FindingDef, type Hit } from '../../features/shopcheck-rules';
import { duplicates, META, wordCount } from '../../features/seo-rules';
import type { LinkKind } from '../../seo-links';
import { shortId, type Json } from './client';
import { fmtMoney, qField, searchCollections, searchProducts, shopInfo, toNum, type Q } from './data';
import { readTranslations, shopLocales } from './content';
import { parseShopPath } from './lookup';
import type { ShopifyReader } from './reader';

export const SCAN_MAX = 1000, SCAN_PAGE = 20, PAGES_MAX = 100, TR_MAX = 250;

// Abfragekosten je Seite unter 1000: 20 Produkte × (Grunddaten + 10 Varianten + 10 Medien)
export const SCAN_SEL = `id title handle status descriptionHtml tracksInventory seo { title description }
  variants(first: 10) { nodes { price compareAtPrice inventoryPolicy inventoryQuantity } }
  media(first: 10) { nodes { id alt ... on MediaImage { image { altText } } } }`;

export interface ShopifyScanRow { id: string; label: string; handle: string; metaTitle: string; metaDescription: string; description: string; images: number; altMissing: number; tracks: boolean; variants: { price: number | null; compareAt: number | null; policy: string; qty: number | null }[] }
const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();
export function toRow(p: Json): ShopifyScanRow {
  const media: Json[] = p.media?.nodes ?? [];
  return {
    id: shortId(p.id), label: clean(p.title) || shortId(p.id), handle: p.handle, metaTitle: clean(p.seo?.title), metaDescription: clean(p.seo?.description), description: String(p.descriptionHtml ?? ''),
    images: media.length, altMissing: media.filter(m => !(m.alt || m.image?.altText)).length, tracks: !!p.tracksInventory,
    variants: (p.variants?.nodes ?? []).map((v: Json) => ({ price: toNum(v.price), compareAt: toNum(v.compareAtPrice), policy: String(v.inventoryPolicy ?? 'DENY'), qty: v.inventoryQuantity ?? null })),
  };
}

const P = 'Produkten', K = 'Kollektionen', PN: [string, string] = ['Produkt', 'Produkte'], KN: [string, string] = ['Kollektion', 'Kollektionen'];
const SN: [string, string] = ['Seite', 'Seiten'];
export const SHOPIFY_DEFS = {
  metaDescMissing: { id: 'seo.product-meta-description-missing', area: 'SEO', title: 'Produkte ohne Meta-Description', severity: 'hoch', unit: P, noun: PN,
    hint: 'Ohne eigene Meta-Description nimmt Shopify den Anfang der Beschreibung, oft mit Maßen oder Pflegehinweisen statt Nutzen. Eine gute Description bringt mehr Klicks.',
    fix: n => `Schreib Meta-Descriptions (120 bis 158 Zeichen, mit Nutzen und Handlungsaufforderung) für alle aktiven Produkte ohne Meta-Description (betrifft ${n}). Finde sie mit seo_audit (entity=product), lies Details mit get_product, nutze nur Fakten aus Titel, Beschreibung und Varianten und schlag die Texte gesammelt mit propose_product_changes (metaDescription) vor.` },
  metaTitleMissing: { id: 'seo.product-meta-title-missing', area: 'SEO', title: 'Produkte ohne Meta-Title', severity: 'mittel', unit: P, noun: PN,
    hint: 'Shopify nimmt dann den Produkttitel. Ein eigener Title mit Suchbegriff und Shopname rankt und klickt besser.',
    fix: n => `Schreib Meta-Titles (höchstens 60 Zeichen: Produktart, wichtigstes Merkmal, Shopname) für alle aktiven Produkte ohne Meta-Title (betrifft ${n}). Finde sie mit seo_audit (entity=product) und schlag sie gesammelt mit propose_product_changes (metaTitle) vor.` },
  metaTitleLong: { id: 'seo.product-meta-title-long', area: 'SEO', title: `Meta-Title länger als ${META.titleMax} Zeichen`, severity: 'niedrig', unit: P, noun: PN,
    hint: `Google kürzt Titles ab etwa ${META.titleMax} Zeichen, der Rest wird abgeschnitten.`,
    fix: n => `Kürze alle Meta-Titles, die länger als ${META.titleMax} Zeichen sind (betrifft ${n}; seo_audit entity=product). Wichtigsten Suchbegriff nach vorne, Aussage nicht verändern, Vorschlag mit propose_product_changes.` },
  metaTitleDup: { id: 'seo.product-meta-title-duplicate', area: 'SEO', title: 'Doppelte Meta-Titles', severity: 'mittel', unit: P, noun: PN,
    hint: 'Gleiche Titles konkurrieren in Google miteinander und wirken austauschbar.',
    fix: n => `Mach die doppelt vergebenen Meta-Titles eindeutig (betrifft ${n}; seo_audit entity=product meldet „Meta-Title doppelt“). Schreib je Produkt einen eigenen Meta-Title mit unterscheidendem Merkmal (höchstens ${META.titleMax} Zeichen) und schlag sie mit propose_product_changes vor.` },
  thin: { id: 'seo.product-description-thin', area: 'SEO', title: `Beschreibung fehlt oder ist dünn (unter ${META.thinWords} Wörtern)`, severity: 'mittel', unit: P, noun: PN,
    hint: 'Kurze Texte ranken schlecht und beantworten die Fragen der Kunden nicht.',
    fix: n => `Erweitere alle Produktbeschreibungen mit weniger als ${META.thinWords} Wörtern (betrifft ${n}; seo_audit entity=product). Nur belegbare Fakten aus Produktdaten, Varianten und Metafeldern (get_product), fehlende Angaben erst bei mir erfragen, Vorschlag mit propose_product_changes (description).` },
  noImage: { id: 'bilder.product-without-image', area: 'Bilder', title: 'Produkte ohne Bild', severity: 'hoch', unit: P, noun: PN,
    hint: 'Produkte ohne Bild verkaufen kaum und wirken in Kollektionen leer.',
    fix: n => `Zeig mir alle aktiven Produkte ohne Bild (betrifft ${n}; find_image_gaps missing=images) und frag mich, woher die Bilder kommen sollen (Anhang, Inhalte → Dateien mit search_media oder URL). Danach schlag die Bilder mit propose_product_images vor.` },
  altMissing: { id: 'bilder.alt-missing', area: 'Bilder', title: 'Bilder ohne Alt-Text', severity: 'mittel', unit: P, noun: PN,
    hint: 'Alt-Texte helfen in der Google-Bildersuche und sind für die Barrierefreiheit Pflicht (BFSG, WCAG 1.1.1).',
    fix: n => `Ergänze die fehlenden Alt-Texte der Produktbilder (betrifft ${n}; find_image_gaps missing=alt). Sieh dir jedes Bild mit view_image an, beschreibe konkret, was zu sehen ist, und schlag die Texte mit propose_alt_texts vor.` },
  oversell: { id: 'daten.stock-zero-orderable', area: 'Daten', title: 'Aktiv und bestellbar ohne Bestand', severity: 'mittel', unit: P, noun: PN,
    hint: 'Bei diesen Varianten ist „Weiterverkaufen, wenn nicht vorrätig“ an und der Bestand 0 oder kleiner: Kunden bestellen, obwohl nichts da ist.',
    fix: n => `Zeig mir alle aktiven Produkte, die ohne Bestand weiter bestellbar sind (betrifft ${n}; list_products active=true maxStock=0, Details mit get_variants). Frag mich je Produkt, ob ich Bestand im Shopify-Admin nachtrage, den Weiterverkauf dort ausschalte oder das Produkt auf Entwurf setze. Nur das Letzte schlägst du mit propose_product_changes (active=false) vor; Bestände sind in Lotse nur lesbar.` },
  soldOut: { id: 'daten.active-sold-out', area: 'Daten', title: 'Aktiv, aber ausverkauft', severity: 'niedrig', unit: P, noun: PN,
    hint: 'Alle Varianten haben Bestand 0 und sind nicht bestellbar. Die Produktseite zeigt „Ausverkauft“; in Kollektionen stören solche Produkte.',
    fix: n => `Zeig mir die aktiven, ausverkauften Produkte (betrifft ${n}; list_products active=true maxStock=0) und frag mich, ob sie sichtbar bleiben, auf Entwurf gehen (propose_product_changes active=false) oder ob Nachschub kommt.` },
  priceZero: { id: 'preise.price-zero', area: 'Preise', title: 'Preis ist 0', severity: 'hoch', unit: P, noun: PN,
    hint: 'Ein Preis von 0 lädt zu Gratis-Bestellungen ein.',
    fix: n => `Prüfe alle aktiven Produkte mit einer Variante zum Preis 0 (betrifft ${n}; get_variants). Zeig sie mir und frag mich nach dem richtigen Preis, bevor du mit propose_variants oder propose_product_changes etwas vorschlägst. Preise nie schätzen.` },
  listBelow: { id: 'preise.list-price-not-above', area: 'Preise', title: 'Vergleichspreis nicht über dem Preis', severity: 'mittel', unit: P, noun: PN,
    hint: 'Shopify zeigt dann einen Streichpreis ohne echte Ersparnis. Das wirkt unseriös und kann irreführend sein.',
    fix: n => `Bereinige alle Vergleichspreise (Streichpreise), die nicht über dem Verkaufspreis liegen (betrifft ${n}; get_variants zeigt Preis und compareAtPrice je Variante). Zeig sie mir und frag, ob ich den Vergleichspreis entfernen oder korrigieren will. Dann propose_variants (listPrice null bzw. Wert).` },
  priceSpread: { id: 'preise.variant-price-spread', area: 'Preise', title: 'Auffällige Preisspanne zwischen Varianten', severity: 'niedrig', unit: P, noun: PN,
    hint: 'Eine Variante kostet mehr als das Fünffache einer anderen. Oft ist das ein Tippfehler (Komma, Nullen).',
    fix: n => `Prüfe die Produkte mit auffälliger Preisspanne zwischen Varianten (betrifft ${n}; get_variants). Zeig mir die Preise je Variante und frag, ob sie stimmen. Korrekturen nur nach meiner Antwort mit propose_variants.` },
  descLinks: { id: 'links.product-description', area: 'Links', title: 'Produkttexte mit kaputten Links', severity: 'hoch', unit: P, noun: PN,
    hint: 'Links auf gelöschte, ausgeblendete oder nicht veröffentlichte Ziele führen Besucher auf Fehlerseiten.',
    fix: n => `Korrigiere alle Links in Produktbeschreibungen, die auf fehlende oder nicht sichtbare Ziele zeigen (betrifft ${n}). Lies die Texte mit get_product, prüf Ziele mit get_seo_urls bzw. search_products/search_categories und schlag die korrigierte Beschreibung mit propose_product_changes vor.` },
  pageLinks: { id: 'links.pages', area: 'Links', title: 'Seiten oder Kollektionstexte mit kaputten Links', severity: 'hoch', unit: 'Seiten und Kollektionen', noun: SN,
    hint: 'Links auf gelöschte oder ausgeblendete Ziele führen Besucher auf Fehlerseiten.',
    fix: n => `Zeig mir die Seiten und Kollektionen mit kaputten Links (betrifft ${n}). Kollektionstexte korrigierst du mit propose_category_changes (description); bei Online-Store-Seiten nenn mir die betroffenen Links und such Ersatz mit search_products/search_categories, bevor du eine Seite neu entwirfst.` },
  catMeta: { id: 'seo.category-meta-description-missing', area: 'SEO', title: 'Kollektionen ohne Meta-Description', severity: 'mittel', unit: K, noun: KN,
    hint: 'Kollektionsseiten ranken oft für die wichtigsten Suchbegriffe. Ohne Description entscheidet Google allein, was im Suchergebnis steht.',
    fix: n => `Schreib Meta-Descriptions (120 bis 158 Zeichen) für alle Kollektionen ohne Meta-Description (betrifft ${n}; seo_audit entity=category). Nutze Kollektionsname und enthaltene Produkte (get_category), keine erfundenen Versprechen, Vorschlag mit propose_category_changes.` },
  catDesc: { id: 'seo.category-description-missing', area: 'SEO', title: 'Kollektionen ohne Beschreibung', severity: 'niedrig', unit: K, noun: KN,
    hint: 'Ein kurzer Einleitungstext gibt Kollektionsseiten Inhalt für Google und Orientierung für Kunden.',
    fix: n => `Schreib kurze Einleitungstexte (2 bis 3 Sätze) für alle Kollektionen ohne Beschreibung (betrifft ${n}; seo_audit entity=category). Frag vorher per ask_user, welche Kollektionen Vorrang haben und welcher Ton passt, Vorschlag mit propose_category_changes (description). Für mehr als einen Einleitungstext bietet sich eine Kollektionsvorlage mit draft_page (product_list) an.` },
  translation: { id: 'sprachen.missing-translation', area: 'Sprachen', title: 'Produkte ohne Übersetzung', severity: 'mittel', unit: P, noun: PN,
    hint: 'Kunden dieser Sprache sehen sonst die Texte der Hauptsprache.',
    fix: n => `Übersetze die aktiven Produkte ohne Übersetzung (betrifft ${n}; list_languages, dann get_translations entity=product mit full=true). Titel, Beschreibung und Meta-Daten, Fachbegriffe und Maße unverändert, Vorschlag mit propose_translations.` },
} satisfies Record<string, FindingDef>;

/** Auswertung der gelesenen Produktzeilen (rein, testbar) */
export function scanFindings(rows: ShopifyScanRow[], currency = 'EUR') {
  const hit = (r: ShopifyScanRow): Hit => ({ id: r.id, label: r.label });
  const prices = (r: ShopifyScanRow) => r.variants.map(v => v.price).filter((v): v is number => v != null);
  const dups = duplicates(rows.map(r => ({ id: r.id, value: r.metaTitle }))), dupIds = new Set([...dups.values()].flat()), byId = new Map(rows.map(r => [r.id, r]));
  return {
    metaDescMissing: rows.filter(r => !r.metaDescription).map(hit),
    metaTitleMissing: rows.filter(r => !r.metaTitle).map(hit),
    metaTitleLong: rows.filter(r => r.metaTitle.length > META.titleMax).map(r => ({ id: r.id, label: `${r.label}, ${r.metaTitle.length} Zeichen` })),
    metaTitleDup: { count: dupIds.size, sample: [...dups.values()].flat().map(id => byId.get(id)!).map(r => ({ id: r.id, label: `${r.label}: „${r.metaTitle.slice(0, 60)}“` })) },
    thin: rows.filter(r => wordCount(r.description) < META.thinWords).map(hit),
    noImage: rows.filter(r => !r.images).map(hit),
    altMissing: rows.filter(r => r.altMissing > 0).map(r => ({ id: r.id, label: `${r.label}: ${r.altMissing} Bild(er)` })),
    oversell: rows.filter(r => r.tracks && r.variants.some(v => v.policy === 'CONTINUE' && v.qty != null && v.qty <= 0)).map(hit),
    soldOut: rows.filter(r => r.tracks && r.variants.length > 0 && r.variants.every(v => v.policy !== 'CONTINUE' && v.qty != null && v.qty <= 0)).map(hit),
    priceZero: rows.filter(r => prices(r).some(p => p <= 0)).map(hit),
    listBelow: rows.filter(r => r.variants.some(v => v.compareAt != null && v.compareAt > 0 && v.price != null && v.compareAt <= v.price)).map(r => {
      const v = r.variants.find(x => x.compareAt != null && x.compareAt > 0 && x.price != null && x.compareAt <= x.price)!;
      return { id: r.id, label: `${r.label}: Vergleichspreis ${fmtMoney(v.compareAt, currency)}, Preis ${fmtMoney(v.price, currency)}` };
    }),
    priceSpread: rows.filter(r => { const p = prices(r).filter(x => x > 0); return p.length > 1 && Math.max(...p) > 5 * Math.min(...p); }).map(r => { const p = prices(r).filter(x => x > 0); return { id: r.id, label: `${r.label}: ${fmtMoney(Math.min(...p), currency)} bis ${fmtMoney(Math.max(...p), currency)}` }; }),
  };
}

/** interne Links eines HTML-Texts (relativ oder auf eine eigene Domain) → { kind, handle } */
export function internalLinks(html: string, hosts: string[]): { href: string; kind: LinkKind; handle: string }[] {
  const out: { href: string; kind: LinkKind; handle: string }[] = [];
  for (const m of String(html ?? '').matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)[^"']*["']/gi)) {
    const href = m[1].trim(); let u: URL;
    try { u = new URL(href, 'https://shop.invalid'); } catch { continue; }
    if (u.host !== 'shop.invalid' && !hosts.includes(u.host.toLowerCase())) continue;
    const p = parseShopPath(`https://x${u.pathname}`);
    if (p?.handle && p.kind !== 'home') out.push({ href, kind: p.kind as LinkKind, handle: p.handle.toLowerCase() });
  }
  return out;
}

// ---------------- Lesen (je Durchlauf über den Reader, zwischengespeichert) ----------------
const qOf = (r: ShopifyReader): Q => (d, v) => r.query(d, v);
const shop = (r: ShopifyReader) => r.memo('shop', () => shopInfo(qOf(r)));
async function scan(r: ShopifyReader): Promise<{ rows: ShopifyScanRow[]; total: number; capped: boolean }> {
  return r.memo('check-scan', async () => {
    const q = qOf(r), rows: ShopifyScanRow[] = []; let after: string | null = null;
    const total = (await q<Json>('query ActiveCount { productsCount(query: "status:active", limit: 10000) { count } }')).productsCount?.count ?? 0;
    while (rows.length < SCAN_MAX) {
      const page = await searchProducts(q, 'status:active', { first: SCAN_PAGE, after, sortKey: 'ID', sel: SCAN_SEL });
      rows.push(...page.nodes.map(toRow));
      if (!page.pageInfo.hasNextPage) break; after = page.pageInfo.endCursor;
    }
    return { rows, total: Math.max(total, rows.length), capped: rows.length < total };
  });
}
type DefKey = keyof typeof SHOPIFY_DEFS;
const fromScan = (key: Exclude<DefKey, 'descLinks' | 'pageLinks' | 'catMeta' | 'catDesc' | 'translation'>) => async (r: ShopifyReader) => {
  const [s, info] = await Promise.all([scan(r), shop(r)]), h = scanFindings(s.rows, info.currency)[key], list = Array.isArray(h) ? { count: h.length, sample: h } : h;
  return makeFinding(SHOPIFY_DEFS[key], list.count, s.total, list.sample, { atLeast: s.capped });
};

/** Links prüfen: Handles je Art gesammelt nachschlagen; Ziel fehlt oder ist nicht sichtbar = kaputt */
async function brokenTargets(r: ShopifyReader, links: { kind: LinkKind; handle: string }[]): Promise<Set<string>> {
  const q = qOf(r), bad = new Set<string>();
  const ROOT: Record<LinkKind, [string, string]> = { product: ['products', 'handle status'], category: ['collections', 'handle'], landing: ['pages', 'handle isPublished'] };
  for (const kind of ['product', 'category', 'landing'] as LinkKind[]) {
    const handles = [...new Set(links.filter(l => l.kind === kind).map(l => l.handle))];
    for (let i = 0; i < handles.length; i += 50) {
      const chunk = handles.slice(i, i + 50), [root, sel] = ROOT[kind];
      const res = await q<Json>(`query LinkTargets($first: Int!, $query: String) { ${root}(first: $first, query: $query) { nodes { ${sel} } } }`, { first: chunk.length, query: chunk.map(h => qField('handle', h)).join(' OR ') });
      const found = new Map<string, Json>((res[root].nodes as Json[]).map(n => [String(n.handle).toLowerCase(), n]));
      for (const h of chunk) { const n = found.get(h); if (!n || (kind === 'product' && n.status !== 'ACTIVE') || (kind === 'landing' && n.isPublished === false)) bad.add(`${kind}:${h}`); }
    }
  }
  return bad;
}
const hostsOf = async (r: ShopifyReader) => { const s = await shop(r); return [s.myshopifyDomain, (() => { try { return new URL(s.primaryUrl).host; } catch { return ''; } })()].filter(Boolean).map(h => h.toLowerCase()); };

// ---------------- Registrierung ----------------
const reg = (id: string, area: string, scopes: ('products' | 'categories' | 'cms' | 'media' | 'shop')[], run: (r: ShopifyReader) => Promise<CheckFinding | CheckFinding[] | null>) =>
  registerPlatformCheck<ShopifyReader>('shopify', { id: `shopify.${id}`, area, scopes, run });

reg('meta-description', 'SEO', ['products'], fromScan('metaDescMissing'));
reg('meta-title', 'SEO', ['products'], fromScan('metaTitleMissing'));
reg('meta-title-long', 'SEO', ['products'], fromScan('metaTitleLong'));
reg('meta-title-duplicate', 'SEO', ['products'], fromScan('metaTitleDup'));
reg('description-thin', 'SEO', ['products'], fromScan('thin'));
reg('no-image', 'Bilder', ['products', 'media'], fromScan('noImage'));
reg('alt-missing', 'Bilder', ['products', 'media'], fromScan('altMissing'));
reg('stock-oversell', 'Daten', ['products'], fromScan('oversell'));
reg('sold-out', 'Daten', ['products'], fromScan('soldOut'));
reg('price-zero', 'Preise', ['products'], fromScan('priceZero'));
reg('list-price', 'Preise', ['products'], fromScan('listBelow'));
reg('price-spread', 'Preise', ['products'], fromScan('priceSpread'));

reg('collections', 'SEO', ['categories'], async r => {
  const q = qOf(r), all: Json[] = []; let after: string | null = null;
  for (let i = 0; i < 10; i++) { const p = await searchCollections(q, undefined, 100, after); all.push(...p.nodes); if (!p.pageInfo.hasNextPage) break; after = p.pageInfo.endCursor; }
  const hit = (c: Json): Hit => ({ id: shortId(c.id), label: clean(c.title) });
  return [makeFinding(SHOPIFY_DEFS.catMeta, all.filter(c => !clean(c.seo?.description)).length, all.length, all.filter(c => !clean(c.seo?.description)).map(hit)),
    makeFinding(SHOPIFY_DEFS.catDesc, all.filter(c => !wordCount(c.descriptionHtml)).length, all.length, all.filter(c => !wordCount(c.descriptionHtml)).map(hit))].filter((f): f is CheckFinding => !!f);
});

reg('description-links', 'Links', ['products'], async r => {
  const [s, hosts] = await Promise.all([scan(r), hostsOf(r)]);
  const per = s.rows.map(row => ({ row, links: internalLinks(row.description, hosts) })).filter(x => x.links.length);
  if (!per.length) return null;
  const bad = await brokenTargets(r, per.flatMap(x => x.links));
  const hits = per.filter(x => x.links.some(l => bad.has(`${l.kind}:${l.handle}`))).map(x => ({ id: x.row.id, label: `${x.row.label}: ${x.links.filter(l => bad.has(`${l.kind}:${l.handle}`)).map(l => l.href).slice(0, 2).join(', ')}` }));
  return makeFinding(SHOPIFY_DEFS.descLinks, hits.length, s.total, hits, { atLeast: s.capped });
});

reg('page-links', 'Links', ['cms', 'categories'], async r => {
  const q = qOf(r), hosts = await hostsOf(r), items: { id: string; label: string; html: string }[] = [];
  // seitenweise bis 10 × PAGES_MAX; bleibt danach noch etwas, gilt das Ergebnis als „mindestens“
  let capped = false, after: string | null = null;
  for (let i = 0; i < 10; i++) {
    const pg: Json = (await q<Json>('query PagesForLinks($first: Int!, $after: String) { pages(first: $first, after: $after) { nodes { id title body } pageInfo { hasNextPage endCursor } } }', { first: PAGES_MAX, after })).pages;
    items.push(...(pg.nodes as Json[]).map(p => ({ id: shortId(p.id), label: `Seite ${quoteLabel(p.title, 60)}`, html: p.body })));
    if (!pg.pageInfo.hasNextPage) break; after = pg.pageInfo.endCursor; if (i === 9) capped = true;
  }
  after = null;
  for (let i = 0; i < 10; i++) {
    const cols = await searchCollections(q, undefined, 100, after);
    items.push(...cols.nodes.map(c => ({ id: shortId(c.id), label: `Kollektion ${quoteLabel(c.title, 60)}`, html: c.descriptionHtml })));
    if (!cols.pageInfo.hasNextPage) break; after = cols.pageInfo.endCursor; if (i === 9) capped = true;
  }
  const per = items.map(it => ({ it, links: internalLinks(it.html, hosts) })).filter(x => x.links.length);
  if (!per.length) return null;
  const bad = await brokenTargets(r, per.flatMap(x => x.links));
  const hits = per.filter(x => x.links.some(l => bad.has(`${l.kind}:${l.handle}`))).map(x => ({ id: x.it.id, label: `${x.it.label}: ${x.links.filter(l => bad.has(`${l.kind}:${l.handle}`)).map(l => l.href).slice(0, 2).join(', ')}` }));
  return makeFinding(SHOPIFY_DEFS.pageLinks, hits.length, items.length, hits, { atLeast: capped });
});

reg('translations', 'Sprachen', ['products', 'shop'], async r => {
  const q = qOf(r), locales = (await shopLocales(q)).filter(l => !l.primary && l.published);
  if (!locales.length) return null;
  const s = await scan(r), rows = s.rows.slice(0, TR_MAX), out: CheckFinding[] = [];
  for (const l of locales) {
    const tr = await readTranslations(q, rows.map(x => `gid://shopify/Product/${x.id}`), l.locale);
    const missing = rows.filter(x => { const n = tr.get(`gid://shopify/Product/${x.id}`); return !n || !(n.translations as Json[]).some(t => t.key === 'title' && t.value); });
    const f = makeFinding(SHOPIFY_DEFS.translation, missing.length, s.total, missing.map(x => ({ id: x.id, label: x.label })), { atLeast: s.capped || s.rows.length > TR_MAX, idSuffix: l.locale, title: `Produkte ohne Übersetzung (${l.name})`, fixExtra: ` Sprache: ${l.locale}.` });
    if (f) out.push(f);
  }
  return out;
});
