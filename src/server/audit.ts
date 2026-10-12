import 'server-only';
// Automatischer SEO-/Conversion-/UX-Check eines (expandierten) Seitenentwurfs
import type { AuditCheck, DraftAudit } from '@/lib/protocol';
import type { BlockSpec, ImageRef, PageSpec } from './cms';
import { AI_CREDIT, aiImagesIn } from './media';
import { findingText, type LinkReport } from './seo-links';

const strip = (h: unknown) => String(h ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t: string) => (t.match(/[\p{L}\p{N}-]+/gu) ?? []).length;
const TEXT_FIELDS = ['html', 'leftHtml', 'centerHtml', 'rightHtml'] as const;
/** Sichtbarer Text (ohne FAQ) je Seite: Prüfung und Meldung nutzen denselben Wert */
export const VISIBLE_MAX = 700;
type Area = 'SEO' | 'CRO' | 'UX';
/** Prüfpunkt: area/w/msg (intern, wie bisher) + label/weight/level laut protocol.ts */
export type Check = AuditCheck & { area: Area; w: number; msg: string };
export type Audit = Omit<DraftAudit, 'checks'> & { checks: Check[] };
interface Flow { b: BlockSpec; type: string; html: string; text: string }

// Typische KI-Floskeln („Slop“): machen Seiten austauschbar – siehe prompts/06-gestaltung.md
const FLOSKELN: [RegExp, string][] = [
  [/entdecken? sie (unsere|die)|entdecke (unsere|die)|jetzt entdecken!/i, 'Entdecken Sie …'],
  [/willkommen in der welt/i, 'Willkommen in der Welt …'], [/tauchen? sie ein|tauch ein/i, 'Tauchen Sie ein'],
  [/mehr als nur/i, 'Mehr als nur …'], [/qualität,? die überzeugt|höchste qualität|erstklassige qualität/i, 'Qualität, die überzeugt'],
  [/für jeden geschmack|für jeden anlass|perfekt für jeden/i, 'für jeden Geschmack/Anlass'], [/lassen sie sich inspirieren|lass dich inspirieren/i, 'Lassen Sie sich inspirieren'],
  [/ihr (zuverlässiger )?partner für|dein partner für/i, 'Ihr Partner für'], [/in einer welt, in der/i, 'In einer Welt, in der'],
  [/erleben sie|erlebe die/i, 'Erleben Sie'], [/vielfältige auswahl|große auswahl an/i, 'vielfältige Auswahl'], [/ganz egal, ob/i, 'Ganz egal, ob …'],
];
export const findFloskeln = (text: string) => FLOSKELN.filter(([re]) => re.test(text)).map(([, label]) => label);

// Link-Prüfung (seo-links.ts): kaputte/inaktive Ziele = wichtig, Rest (SEO-URL, rel/target, Linktext) = empfohlen
function linkChecks(C: Check[], r: LinkReport) {
  const hint = (fs: LinkReport['findings']) => fs.slice(0, 6).map(findingText).join(' · ') + (fs.length > 6 ? ` · … (+${fs.length - 6})` : '');
  const bad = r.findings.filter(f => f.level === 'wichtig'), minor = r.findings.filter(f => f.level !== 'wichtig');
  const msg1 = bad.length ? `${bad.length} Link(s) mit kaputtem, inaktivem oder unsichtbarem Ziel` : 'Alle Linkziele existieren und sind aktiv';
  C.push({ area: 'SEO', w: 3, ok: !bad.length, msg: msg1, label: msg1, weight: 3, level: 'wichtig', ...(bad.length ? { hint: hint(bad) } : {}) });
  const msg2 = minor.length ? `${minor.length} Link-Hinweis(e): SEO-URL, rel/target oder Linktext` : 'Links sauber (SEO-URLs, rel/target, Linktexte)';
  C.push({ area: 'SEO', w: 1, ok: !minor.length, msg: msg2, label: msg2, weight: 1, level: 'empfohlen', ...(minor.length ? { hint: hint(minor) } : {}) });
}

/**
 * links: Ergebnis der Link-Prüfung gegen den Shop (optional – ohne Shop-Zugriff entfällt sie).
 * format: 'html' = Plattform ohne Einkaufswelten (Shopify, Magento): Kategorie-/Produktinhalt ist nur ein Abschnitt der Seite,
 * H1, Produktliste bzw. Galerie und Kaufbox liefert das Theme – die Prüfungen richten sich danach.
 */
export function auditSpec(spec: PageSpec, links?: LinkReport | null, { format = 'cms' }: { format?: 'cms' | 'html' } = {}): Audit {
  const seo: NonNullable<PageSpec['seo']> = spec.seo ?? {}, kw = (seo.keyword ?? '').toLowerCase().trim();
  const flow: Flow[] = []; // geordnete Blöcke mit Inhalt
  for (const s of spec.sections ?? []) for (const b of s.blocks ?? []) {
    if (!b?.type) continue;
    const html = TEXT_FIELDS.map(f => b[f] ?? '').join(' ') + (b.title ? ` <h2>${b.title}</h2>` : '');
    flow.push({ b, type: b.pattern ?? b._pattern ?? (b.type === 'reuse' ? `reuse:${b.cmsType ?? '?'}` : b.type), html, text: strip(html) });
  }
  // Theme-Inhalt (theme-main, HTML-Plattformen mit Theme): zählt bei Kollektionen wie die Produktliste, bei Produkten wie Galerie/Kaufbox + Beschreibung
  const themed = flow.some(f => f.b.type === 'theme-main');
  const THEME_LIKE: Record<string, string[]> = { product_list: ['product-listing'], product_detail: ['pdp-gallery-buybox', 'pdp-description-reviews', 'pdp-heading'] };
  const isLike = (f: Flow, t: string) => f.b.type === t || f.type === t || f.b.like === t || (f.b.type === 'theme-main' && (THEME_LIKE[spec.type] ?? []).includes(t)); // übernommene Blöcke zählen wie ihr Katalog-Gegenstück
  const all = flow.map(f => f.html).join('\n'), allText = strip(all), nWords = words(allText);
  const heads = [...all.matchAll(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(m => ({ l: +m[1], t: strip(m[2]).toLowerCase() }));
  // Überschrift aus dem Shop: pdp-heading bzw. das Theme (Produkt- oder Kollektionstitel als H1 neben theme-main)
  const hasPdpHeading = flow.some(f => f.b.type === 'pdp-heading') || themed;
  const h1s = heads.filter(h => h.l === 1), h1Count = h1s.length + (hasPdpHeading ? 1 : 0);
  const h2s = heads.filter(h => h.l === 2);
  const firstWords = allText.split(/\s+/).slice(0, 100).join(' ').toLowerCase();
  const kwCount = kw ? (allText.toLowerCase().split(kw).length - 1) : 0;
  const linkList = [...all.matchAll(/<a\s[^>]*href="([^"]*)"/gi)].map(m => m[1]);
  const internal = links ? links.internal : linkList.filter(l => l.startsWith('/') && !l.startsWith('//')).length;
  const hasCta = (f: Flow) => /class="[^"]*\bbtn\b|<button|<a\s[^>]*href=/i.test(f.html) || f.type === 'cta-banner';
  const listingIdx = flow.findIndex(f => isLike(f, 'product-listing'));
  const imgs = flow.flatMap(f => (['image', 'image2'] as const).map(k => f.b[k]).filter((i): i is ImageRef => !!i));
  const noAlt = imgs.filter(i => typeof i === 'string' || !i.alt).length;
  // HTML-Plattform ohne theme-main-Marker (Magento): der Inhalt ist nur ein Abschnitt, H1/Produktliste/Kaufbox liefert das Theme drumherum.
  // Mit theme-main (Shopify) markiert der Block selbst die Stelle des Theme-Inhalts, es gelten die Regeln mit themed.
  const html = format === 'html' && !themed, themeH1 = html && spec.type !== 'landingpage'; // H1 = Kategorie-/Produktname des Themes
  const target = ({ product_list: html ? 150 : 250, landingpage: 450, product_detail: 120 } as Record<string, number>)[spec.type] ?? 200;
  const wordsBeforeListing = listingIdx < 0 ? 0 : words(flow.slice(0, listingIdx).map(f => f.text).join(' '));
  const maxTextBlock = Math.max(0, ...flow.filter(f => ['text', 'text-two-column', 'text-three-column'].includes(f.type)).map(f => words(f.text)));

  const pdp = spec.type === 'product_detail';
  const C: Check[] = [];
  const h1Ok = themeH1 ? h1Count === 0 : h1Count === 1, h1Msg = themeH1 ? `Keine eigene H1 im Inhalt (die H1 ist der ${spec.type === 'product_list' ? 'Kategoriename' : 'Produktname'} des Themes; aktuell ${h1Count})` : `Es muss genau EINE H1 geben (aktuell ${h1Count})`;
  const add = (area: Area, w: number, ok: unknown, ok_msg: string, bad_msg: string) => { const msg = ok ? ok_msg : bad_msg; C.push({ area, w, ok: !!ok, msg, label: msg, weight: w, level: w >= 3 ? 'wichtig' : 'empfohlen' }); };
  if (pdp && html) {  // Produktbeschreibung (HTML-Plattform): Galerie, Preis, Warenkorb liefert das Theme
    const has = (t: string) => flow.some(f => isLike(f, t));
    add('SEO', 4, h1Ok, 'Keine eigene H1 (Produktname kommt vom Theme)', h1Msg);
    add('SEO', 3, has('faq'), 'FAQ mit FAQPage-Schema vorhanden', 'FAQ-Block (pattern faq) ergänzen');
    add('SEO', 2, nWords >= target, `Textumfang ok (${nWords} Wörter)`, `Zu wenig Inhalt: ${nWords} von ≥${target} Wörtern`);
    add('CRO', 3, flow.some(f => ['usp-bar', 'benefits'].includes(f.type) || f.b.type === 'text-three-column'), 'Vorteile/USPs sichtbar', 'USP-/Vorteils-Block (usp-bar oder benefits) fehlt');
    add('CRO', 2, /versand|lieferung|rückgabe|retoure|garantie|zahlung|widerruf|shipping|delivery|returns?\b/i.test(allText), 'Einwandbehandlung (Versand/Rückgabe/FAQ)', 'Einwände adressieren (Versand, Rückgabe, Zahlung), per FAQ oder USP-Leiste');
    add('UX', 2, maxTextBlock <= 220, 'Keine Textwüsten', `Ein Textblock hat ${maxTextBlock} Wörter: aufteilen`);
    add('UX', 1, new Set(flow.map(f => f.type)).size >= 3, 'Abwechslungsreicher Aufbau', 'Mehr Abwechslung im Aufbau');
    if (links) linkChecks(C, links);
    const total = C.reduce((n, c) => n + c.w, 0), got = C.filter(c => c.ok).reduce((n, c) => n + c.w, 0);
    return { score: Math.round((got / total) * 100), checks: C, warnings: [], stats: { words: nWords, h1: h1Count, internalLinks: internal } };
  }
  if (pdp) {  // Produktseiten-Layout: gilt für viele Produkte → Qualität = Struktur, FAQ, Vertrauen, Lesbarkeit
    const has = (t: string) => flow.some(f => isLike(f, t));
    add('SEO', 4, h1Count === 1, 'Genau eine H1 (Produktname)', themed ? `Das Theme setzt den Produktnamen als H1: im eigenen Inhalt keine H1 verwenden (aktuell ${h1Count} H1 insgesamt)` : `Es muss genau EINE H1 geben (aktuell ${h1Count})`);
    add('SEO', 3, has('pdp-faq') || has('faq'), 'FAQ mit FAQPage-Schema vorhanden', themed ? 'FAQ-Block (pattern faq) ergänzen' : 'FAQ-Block (pdp-faq oder pattern faq) ergänzen');
    add('SEO', 2, has('pdp-description-reviews'), 'Beschreibung & Bewertungen eingebunden', 'pdp-description-reviews fehlt');
    add('CRO', 4, has('pdp-gallery-buybox') && (!themed || flow.findIndex(f => f.b.type === 'theme-main') <= 1), 'Galerie + Kaufbox im ersten Sichtbereich', themed ? 'theme-main (Galerie + Kaufbox) gehört an den Anfang: höchstens ein kurzer Block davor' : 'pdp-gallery-buybox fehlt');
    add('CRO', 3, flow.some(f => ['usp-bar', 'benefits'].includes(f.type) || f.b.type === 'text-three-column'), 'Vorteile/USPs sichtbar', 'USP-/Vorteils-Block (usp-bar oder benefits) fehlt');
    add('CRO', 2, has('pdp-cross-selling') || (themed && has('product-slider')), 'Cross-Selling vorhanden', themed ? 'product-slider mit passenden Produkten ergänzen (Zusatzverkauf)' : 'pdp-cross-selling ergänzen (Zusatzverkauf)');
    add('CRO', 2, /versand|lieferung|rückgabe|retoure|garantie|zahlung|widerruf|shipping|delivery|returns?\b/i.test(allText) || has('pdp-faq'), 'Einwandbehandlung (Versand/Rückgabe/FAQ)', 'Einwände adressieren (Versand, Rückgabe, Zahlung), per FAQ oder USP-Leiste');
    add('UX', 2, maxTextBlock <= 220, 'Keine Textwüsten', `Ein Textblock hat ${maxTextBlock} Wörter: aufteilen`);
    add('UX', 1, new Set(flow.map(f => f.type)).size >= 4, 'Abwechslungsreicher Aufbau', 'Mehr Abwechslung im Aufbau');
    if (links) linkChecks(C, links);
    const total = C.reduce((n, c) => n + c.w, 0), got = C.filter(c => c.ok).reduce((n, c) => n + c.w, 0);
    return { score: Math.round((got / total) * 100), checks: C, warnings: [], stats: { words: nWords, h1: h1Count, internalLinks: internal } };
  }
  // SEO
  add('SEO', 2, kw, `Fokus-Keyword: „${seo.keyword}“`, 'seo.keyword fehlt (Fokus-Keyword mit Suchintention festlegen)');
  const mt = seo.metaTitle ?? '';
  add('SEO', 3, mt.length >= 30 && mt.length <= 60 && (!kw || mt.toLowerCase().includes(kw)), `Meta-Title ok (${mt.length} Z.)`, `Meta-Title 30 bis 60 Zeichen inkl. Keyword nötig (aktuell ${mt.length})`);
  const md = seo.metaDescription ?? '';
  add('SEO', 3, md.length >= 120 && md.length <= 158 && (!kw || md.toLowerCase().includes(kw)), `Meta-Description ok (${md.length} Z.)`, `Meta-Description 120 bis 158 Zeichen inkl. Keyword nötig (aktuell ${md.length})`);
  if (themeH1) add('SEO', 4, h1Ok, 'Keine eigene H1 (Kategoriename kommt vom Theme)', h1Msg);
  else add('SEO', 4, h1Count === 1, 'Genau eine H1', themed ? `Das Theme setzt den Kollektionstitel als H1: im eigenen Inhalt keine H1 verwenden (aktuell ${h1Count} H1 insgesamt)` : `Es muss genau EINE H1 geben (aktuell ${h1Count})`);
  const h1 = h1s[0]?.t ?? '';
  if (!themeH1) add('SEO', 3, !kw || hasPdpHeading || h1.includes(kw), 'Keyword in der H1', 'Fokus-Keyword gehört in die H1');
  if (!themeH1) add('SEO', 1, hasPdpHeading || (h1.length >= 20 && h1.length <= 70), 'H1-Länge ok', 'H1 sollte 20 bis 70 Zeichen lang sein');
  add('SEO', 2, !kw || firstWords.includes(kw), 'Keyword in den ersten 100 Wörtern', 'Keyword in den ersten 100 Wörtern verwenden');
  add('SEO', 2, !kw || h2s.some(h => h.t.includes(kw.split(' ')[0])), 'Keyword (-bestandteil) in einer H2', 'Mindestens eine H2 mit Keyword-Bezug');
  add('SEO', 1, !heads.some((h, i) => h.l > 2 && !heads.slice(0, i).some(x => x.l === h.l - 1)), 'Überschriften-Hierarchie sauber', 'H3/H4 ohne übergeordnete H2');
  add('SEO', 3, nWords >= target, `Textumfang ok (${nWords} Wörter)`, `Zu wenig Text für ${spec.type}: ${nWords} von ≥${target} Wörtern`);
  add('SEO', 1, !kw || nWords === 0 || kwCount / nWords <= 0.03, 'Keyword-Dichte unauffällig', 'Keyword-Dichte >3 % (Keyword-Stuffing vermeiden)');
  add('SEO', 2, noAlt === 0, imgs.length ? 'Alle Bilder mit Alt-Text' : 'Keine Bilder im Layout', `${noAlt} Bild(er) ohne Alt-Text`);
  add('SEO', 2, internal >= 2, `${internal} interne Links`, `Mindestens 2 interne Links (Unterkategorien, Ratgeber, Produkte) einbauen (aktuell ${internal})`);
  if (links) linkChecks(C, links);
  add('SEO', 2, /application\/ld\+json/.test(all) && /FAQPage/.test(all), 'FAQ mit Schema.org-JSON-LD', 'FAQ-Block (pattern faq) mit FAQPage-Schema ergänzen');
  // Conversion
  const themeList = html && spec.type === 'product_list'; // Produktliste des Themes folgt unter dem Inhalt
  add('CRO', 4, themeList || flow.slice(0, 2).some(hasCta) || flow.slice(0, 2).some(f => ['product-slider', 'product-listing', 'pdp-gallery-buybox'].some(t => isLike(f, t))), 'Handlungsaufforderung/Produkte im ersten Sichtbereich', 'Im ersten Sichtbereich fehlt ein klarer CTA oder Produktzugang');
  add('CRO', 2, themeList || flow.slice(-3).some(hasCta) || flow.slice(-3).some(f => isLike(f, 'product-listing')), 'Abschluss mit CTA/Produkten', 'Am Seitenende fehlt ein abschließender CTA (pattern cta-banner)');
  add('CRO', 3, flow.some(f => ['usp-bar', 'benefits'].includes(f.type) || f.b.type === 'text-three-column'), 'Vorteile/USPs sichtbar', 'USP-/Vorteils-Block (usp-bar oder benefits) fehlt');
  if (themeList) add('CRO', 4, nWords <= 300, 'Produkte früh erreichbar (Inhalt über der Produktliste kurz)', `Zu viel Inhalt über der Produktliste (${nWords} Wörter): das Theme zeigt den Inhalt über den Produkten, auf höchstens 300 Wörter kürzen`);
  else if (spec.type === 'product_list') add('CRO', 4, listingIdx >= 0 && listingIdx <= 4 && wordsBeforeListing <= 200, 'Produkte früh erreichbar', `Produktliste zu spät/zu viel Text davor (${wordsBeforeListing} Wörter): ${themed ? 'theme-main' : 'Listing'} nach Hero+USPs, SEO-Text darunter`);
  if (spec.type === 'landingpage') add('CRO', 3, flow.some(f => isLike(f, 'product-slider')), 'Produkte eingebunden', 'Landingpage braucht Produkt-Slider oder CTAs zu Kategorien/Produkten');
  add('CRO', 2, /versand|lieferung|rückgabe|retoure|garantie|zahlung|kauf auf rechnung|widerruf|shipping|delivery|returns?\b/i.test(allText), 'Einwandbehandlung (Versand/Rückgabe/Zahlung)', 'Einwände adressieren: Versand, Rückgabe, Zahlung, Garantie erwähnen (nur belegte Fakten)');
  // UX / Design
  add('UX', 2, maxTextBlock <= 160, 'Keine Textwüsten', `Ein Textblock hat ${maxTextBlock} Wörter, höchstens ~160: kürzen oder als Bild-Text-Split (split) mit dem passenden Produktfoto zeigen`);
  add('UX', 1, new Set(flow.map(f => f.type)).size >= 3, 'Abwechslungsreicher Seitenaufbau', 'Mehr Abwechslung: mind. 3 verschiedene Blocktypen/Patterns');
  // Gestaltung (Art Direction, siehe prompts/06-gestaltung.md)
  // Wirkung: erster Bildschirm mit Bild, ein großer Bild-Moment, nicht zu textlastig (FAQ zählt nicht – sie ist zugeklappt)
  const hasImg = (f: Flow) => /<img\b/i.test(f.html) || !!f.b.mediaId;
  const pageHasImages = flow.some(hasImg) || /imageUrl|mediaId|<img\b/i.test(JSON.stringify(spec.sections ?? []));
  if (pageHasImages && flow[0]?.type === 'hero') add('UX', 2, hasImg(flow[0]), 'Erster Eindruck mit starkem Bild', 'Hero ohne Bild, obwohl der Shop Fotos hat: stärkstes Foto groß in den Hero (variant „image“ für Stimmung, „split“ für Produkt)');
  add('UX', 1, flow.some(f => f.type === 'band' || /class="hero image/.test(f.html)), 'Ein großer Bild-Moment', 'Ein großes, atmosphärisches Bild als Signatur-Moment fehlt (Muster band oder Hero „image“)');
  const visibleWords = words(flow.filter(f => f.type !== 'faq').map(f => f.text).join(' '));
  add('UX', 2, visibleWords <= VISIBLE_MAX, 'Bild vor Text', `Zu textlastig: ${visibleWords} Wörter sichtbarer Text (ohne FAQ), auf höchstens ${VISIBLE_MAX} kürzen, Details in FAQ/Vergleich, Bilder statt Absätze`);
  // KI-Bilder müssen sichtbar gekennzeichnet sein (Transparenz, AI Act Art. 50)
  const aiImgs = aiImagesIn(JSON.stringify(spec.sections ?? []));
  if (aiImgs.length) add('UX', 3, flow.some(f => f.html.includes(AI_CREDIT)), 'KI-Bilder gekennzeichnet', `KI-generierte Bilder sichtbar kennzeichnen: Bildzeile „${AI_CREDIT}“ ergänzen (Muster hero/split/band machen das automatisch)`);
  const floskeln = findFloskeln(allText);
  add('UX', 3, !floskeln.length, 'Keine generischen Floskeln', `Generische Floskeln ersetzen (konkret, nur für diesen Shop): ${floskeln.map(f => `„${f}“`).join(', ')}`);
  const triple = flow.findIndex((f, i) => i >= 2 && f.type === flow[i - 1].type && f.type === flow[i - 2].type && !['text', 'product-listing'].includes(f.type));
  add('UX', 2, triple < 0, 'Abwechslungsreiche Abfolge', `Drei gleich gebaute Abschnitte hintereinander (${triple >= 0 ? flow[triple].type : ''}): Komposition variieren (split, band, Raster, Text)`);
  const solids = (all.match(/class="(hero|ctab) solid"/g) ?? []).length;
  add('UX', 2, solids <= 1, 'Höchstens ein farbiger Vollflächen-Abschnitt', `${solids} farbige Vollflächen, nur eine als Signatur-Moment verwenden`);
  add('UX', 1, !/\p{Extended_Pictographic}/u.test(allText), 'Keine Emojis als Gestaltungsmittel', 'Emojis entfernen (Icons/Typografie statt Emojis)');
  add('UX', 1, (allText.match(/!/g) ?? []).length <= 2, 'Ruhiger Ton (kaum Ausrufezeichen)', 'Zu viele Ausrufezeichen, sachlich-konkret formulieren');

  const warnings: string[] = [];
  if (/\b\d{1,3}\s?%|testsieger|bestbewertet|marktführer|nr\.?\s?1|\d[.,]\d\s?(sterne|von 5)|garantiert|rekord/i.test(allText)) warnings.push('Enthält Zahlen/Superlative/Garantien: nur mit Beleg verwenden (UWG-Irreführung).');
  if (/nur noch \d+|letzte chance|nur heute|läuft ab/i.test(allText)) warnings.push('Verknappung/Dringlichkeit nur verwenden, wenn sie real stimmt (Dark Patterns vermeiden).');

  const total = C.reduce((n, c) => n + c.w, 0), got = C.filter(c => c.ok).reduce((n, c) => n + c.w, 0);
  return { score: Math.round((got / total) * 100), checks: C, warnings, stats: { words: nWords, h1: h1Count, internalLinks: internal } };
}

export const auditSummary = (a: Audit) => `Qualitäts-Check ${a.score}/100 (${a.stats.words} Wörter, ${a.stats.internalLinks} interne Links).\nOffen:\n${a.checks.filter(c => !c.ok).sort((x, y) => y.w - x.w).map(c => `- [${c.area}${c.w >= 3 ? ', wichtig' : ''}] ${c.msg}${c.hint ? `: ${c.hint}` : ''}`).join('\n') || '- nichts'}${a.warnings.length ? '\nHinweise:\n' + a.warnings.map(w => '- ' + w).join('\n') : ''}`;
