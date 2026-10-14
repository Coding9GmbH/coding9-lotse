// Mandatory legal information: pure check logic without shop access (GPSR, PAngV base price, BFSG texts/contrast, legal pages).
// Technical check, not legal advice: findings name the rule, the case-by-case assessment stays with the human.

type Row = Record<string, unknown> & { translated?: Record<string, unknown> | null; customFields?: Record<string, unknown> | null };

export const plain = (t: unknown) => String(t ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const num = (v: number, d = 3) => v.toLocaleString('de-DE', { maximumFractionDigits: d });
export const eur = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

// ================= GPSR (Regulation (EU) 2023/988, since 2024-12-13) =================
export const GPSR_SET = 'lotse_gpsr';
export const MANUFACTURER_FIELDS = {
  lotse_gpsr_company: 'Firmenname (eingetragen)',
  lotse_gpsr_address: 'Postanschrift',
  lotse_gpsr_country: 'Land (ISO-Code)',
  lotse_gpsr_contact: 'Elektronischer Kontakt (E-Mail oder Kontakt-URL)',
  lotse_gpsr_eu_rp: 'Verantwortliche Person in der EU',
} as const;
export const PRODUCT_FIELDS = { lotse_gpsr_safety: 'Sicherheitshinweise und Warnungen' } as const;
export type ManufacturerField = keyof typeof MANUFACTURER_FIELDS;
export type ProductField = keyof typeof PRODUCT_FIELDS;

export const EU_COUNTRIES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const EEA_ONLY = new Set(['NO', 'IS', 'LI']);

/** Custom fields of a record (system language + translation merged) */
export const cfOf = (e: Row | null | undefined): Record<string, unknown> => ({ ...(e?.customFields ?? {}), ...((e?.translated?.customFields as Record<string, unknown> | undefined) ?? {}) });
const filled = (v: unknown) => typeof v === 'string' ? plain(v).length > 0 : v != null && v !== false;

export interface ManufacturerStatus { id: string; name: string; complete: boolean; missing: string[]; notes: string[]; euResponsibleNeeded: boolean | 'prüfen'; values: Partial<Record<ManufacturerField, string>> }
export function gpsrManufacturer(m: Row): ManufacturerStatus {
  const cf = cfOf(m), name = String(m.translated?.name ?? m.name ?? m.id);
  const values = Object.fromEntries(Object.keys(MANUFACTURER_FIELDS).filter(k => filled(cf[k])).map(k => [k, String(cf[k])])) as ManufacturerStatus['values'];
  const missing: string[] = [], notes: string[] = [];
  if (!values.lotse_gpsr_address) missing.push(MANUFACTURER_FIELDS.lotse_gpsr_address);
  if (!values.lotse_gpsr_contact) {
    if (filled(m.link)) notes.push(`Nur Website hinterlegt (${String(m.link)}); eine direkte Kontaktadresse (E-Mail/Kontaktformular) fehlt`);
    missing.push(MANUFACTURER_FIELDS.lotse_gpsr_contact);
  }
  if (!values.lotse_gpsr_company) notes.push(`Firmenname nicht hinterlegt; im Shop heißt der Hersteller „${name}“ (Marke ≠ eingetragener Name?)`);
  const cc = values.lotse_gpsr_country?.trim().toUpperCase();
  let euResponsibleNeeded: ManufacturerStatus['euResponsibleNeeded'] = false;
  if (!cc) { euResponsibleNeeded = 'prüfen'; missing.push(MANUFACTURER_FIELDS.lotse_gpsr_country); }
  else if (EEA_ONLY.has(cc)) { euResponsibleNeeded = 'prüfen'; notes.push(`Sitz in ${cc} (EWR, nicht EU): ob eine verantwortliche Person in der EU nötig ist, rechtlich prüfen lassen`); }
  else if (!EU_COUNTRIES.has(cc)) { euResponsibleNeeded = true; if (!values.lotse_gpsr_eu_rp) missing.push(MANUFACTURER_FIELDS.lotse_gpsr_eu_rp); }
  return { id: String(m.id), name, complete: !missing.length, missing, notes, euResponsibleNeeded, values };
}

// Products with elevated safety relevance (heuristic; the AI judges whether notices are needed)
const RISKY = /spielzeug|kinder|baby|kleinkind|elektr|akku|batterie|ladeger|netzteil|kabel|lampe|leuchte|led\b|kerze|teelicht|duftöl|ätherisch|feuer|grill|kamin|heiz|kocher|(?<!spül)maschine|(?<!durch)messer|klinge|schere|werkzeug|säge|chemi|reiniger|lösungsmittel|kosmetik|creme|magnet|laser|helm|fahrrad|sport|trampolin|leiter\b|\bglas(?!ur|iert)/i;
// GPSR does not apply to food (Art. 2(2)); LMIV mandatory information applies there. Categories like "Kaffee & Zubehör" also contain devices: the name is a deciding factor too.
const FOOD = /kaffee|espresso|cold brew|bohne|\btee\b|teemischung|schokolade|lebensmittel|gewürz|honig|\bwein\b|\bbier\b|sirup|müsli|nudeln|snack/i;
// Devices, containers and accessories are not food, even if the name contains "Kaffee" or "Tee"
const NON_FOOD = /mühle|kocher|maschine|becher|tasse|kanne|kännchen|karaffe|kerze|filter(?!kaffee)|dose\b|glas\b|gläser|löffel|sieb|presse|halter|zubehör|set aus|geschirr|teller|schale|brett|waage|thermo|automat|bereiter|aufschäumer|tamper|wachs/i;
// Unambiguous hazards in the name rule out food (unlike RISKY, without "feuer", "glas" …, which occur in variety names)
const HARD_RISK = /elektr|akku|batterie|ladeger|netzteil|kabel|lampe|leuchte|kerze|teelicht|grill|heiz|kocher|(?<!spül)maschine|messer|klinge|werkzeug|spielzeug|\bwatt\b|\d\s*w\b/i;
/** Food? The name sounds like it, or the category does and the name is not a device/accessory. byCategory = detected via the category only (verify). */
export function foodOf(name: string, categories = ''): { food: boolean; byCategory: boolean } {
  if (NON_FOOD.test(name) || HARD_RISK.test(name)) return { food: false, byCategory: false };
  if (FOOD.test(name)) return { food: true, byCategory: false };
  return FOOD.test(categories) ? { food: true, byCategory: true } : { food: false, byCategory: false };
}

/** Identifiers of the variants (EAN/manufacturer no. usually sit on the variants) */
export interface VariantIds { ean?: unknown; manufacturerNumber?: unknown }
export interface ProductStatus { id: string; label: string; manufacturerId: string | null; food: boolean; risky: boolean; missing: string[]; notes: string[] }
export function gpsrProduct(p: Row, categoryNames: string[] = [], manu?: ManufacturerStatus | null, variants: VariantIds[] = []): ProductStatus {
  const name = String(p.translated?.name ?? p.name ?? p.productNumber ?? p.id), cats = categoryNames.join(' ');
  const { food, byCategory } = foodOf(name, cats), risky = !food && RISKY.test(`${name} ${cats} ${plain(p.translated?.description ?? p.description).slice(0, 600)}`);
  const missing: string[] = [], notes: string[] = [];
  if (!p.manufacturerId) missing.push('Hersteller');
  else if (manu && !manu.complete) notes.push(`Herstellerangaben unvollständig: ${manu.missing.join(', ')}`);
  const hasId = (v: VariantIds) => filled(v.ean) || filled(v.manufacturerNumber);
  if (!hasId({ ean: p.ean, manufacturerNumber: p.manufacturerNumber })) {
    const without = variants.filter(v => !hasId(v)).length;
    if (!variants.length || without === variants.length) missing.push('Kennnummer (EAN oder Hersteller-Nr.)');
    else if (without && !food) { missing.push('Kennnummer (EAN oder Hersteller-Nr.)'); notes.push(`Kennnummer fehlt bei ${without} von ${variants.length} Varianten (an den Varianten ergänzen, nicht am Hauptprodukt)`); }
  }
  if (risky && !filled(cfOf(p).lotse_gpsr_safety)) missing.push('Sicherheitshinweise (prüfen)');
  if (food) notes.push(`${byCategory ? 'Laut Kategorie ein Lebensmittel (prüfen): ' : 'Wirkt wie ein Lebensmittel: '}GPSR gilt hier nicht, dafür die LMIV-Pflichtangaben (z. B. Lebensmittelunternehmer, Zutaten) prüfen`);
  return { id: String(p.id), label: `${name}${p.productNumber ? ` (${String(p.productNumber)})` : ''}`, manufacturerId: (p.manufacturerId as string) ?? null, food, risky, missing: food ? [] : missing, notes };
}

// Detect made-up sample data (never write placeholders into mandatory information)
const PLACEHOLDER = /muster(straße|strasse|stadt|mann|frau|firma|hersteller)|example\.(com|org|net)|lorem ipsum|\bxxx\b|\btbd\b|\btodo\b|\b12345\b|beispiel(straße|firma|adresse)/i;
// Source must be real information (user, document, knowledge base), not an assumption by the AI
export const WEAK_SOURCE = /schätz|vermut|annahme|angenommen|erfunden|ausgedacht|platzhalter|beispiel|generiert|ki-vorschlag/i;

export function validateGpsrValue(field: ManufacturerField | ProductField, raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw new Error('Text oder null erwartet');
  const v = raw.replace(/\r\n/g, '\n').trim();
  if (!v) throw new Error('leer (zum Entfernen null angeben)');
  if (PLACEHOLDER.test(v)) throw new Error('Platzhalter/Beispieldaten erkannt: nur echte Angaben des Nutzers oder aus Dokumenten übernehmen');
  switch (field) {
    case 'lotse_gpsr_country': { const c = v.toUpperCase(); if (!/^[A-Z]{2}$/.test(c)) throw new Error('Land als ISO-Code mit 2 Buchstaben (z. B. DE, CN)'); return c; }
    case 'lotse_gpsr_contact':
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v) && !/^https?:\/\/\S+\.\S+/i.test(v)) throw new Error('E-Mail-Adresse oder Kontakt-URL (https://…) erwartet');
      return v;
    case 'lotse_gpsr_address':
      if (v.length < 10 || !/\d/.test(v) || !/\n|,/.test(v)) throw new Error('vollständige Postanschrift erwartet (Straße Nr., PLZ Ort, Land; Zeilen mit Komma oder Umbruch getrennt)');
      if (v.length > 500) throw new Error('max. 500 Zeichen');
      return v;
    case 'lotse_gpsr_eu_rp':
      if (v.length < 15 || !/\d/.test(v)) throw new Error('Name, Postanschrift und Kontakt der verantwortlichen Person erwartet');
      if (v.length > 800) throw new Error('max. 800 Zeichen');
      return v;
    case 'lotse_gpsr_safety': if (v.length > 4000) throw new Error('max. 4000 Zeichen'); return v;
    default: if (v.length > 255) throw new Error('max. 255 Zeichen'); return v;
  }
}

/** Help when reading manufacturer lists/data sheets: candidates for contact data, never adopted automatically */
export function contactCandidates(text: string) {
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 30);
  return {
    emails: uniq([...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map(m => m[0])),
    urls: uniq([...text.matchAll(/https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+/gi)].map(m => m[0].replace(/[.,;]$/, ''))),
    postalLines: uniq(text.split(/\n/).map(l => l.trim()).filter(l => /\b(\d{4,5}|[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})\b\s+\p{L}/u.test(l) && l.length < 160)),
  };
}

// ================= PAngV base price (§§ 4, 5 PAngV) =================
export type BaseUnit = 'kg' | 'l' | 'm' | 'm2';
export const UNIT_DEFS: Record<BaseUnit, { shortCode: string; name: string; aliases: string[] }> = {
  kg: { shortCode: 'kg', name: 'Kilogramm', aliases: ['kg', 'kilogramm', 'kilogram'] },
  l: { shortCode: 'l', name: 'Liter', aliases: ['l', 'ltr', 'liter', 'litre'] },
  m: { shortCode: 'm', name: 'Meter', aliases: ['m', 'meter', 'metre', 'lfm'] },
  m2: { shortCode: 'm²', name: 'Quadratmeter', aliases: ['m²', 'm2', 'qm', 'quadratmeter'] },
};
export const unitKeyOf = (u: Row | null | undefined): BaseUnit | null => {
  const s = String(u?.translated?.shortCode ?? u?.shortCode ?? '').trim().toLowerCase(), n = String(u?.translated?.name ?? u?.name ?? '').trim().toLowerCase();
  return (Object.keys(UNIT_DEFS) as BaseUnit[]).find(k => UNIT_DEFS[k].aliases.includes(s) || UNIT_DEFS[k].aliases.includes(n)) ?? null;
};

const FACTOR: Record<string, [BaseUnit, number]> = { mg: ['kg', 1e-6], g: ['kg', 1e-3], gr: ['kg', 1e-3], kg: ['kg', 1], ml: ['l', 1e-3], cl: ['l', 1e-2], l: ['l', 1], ltr: ['l', 1], liter: ['l', 1], m: ['m', 1], cm: ['m', 1e-2], mm: ['m', 1e-3], 'm²': ['m2', 1], m2: ['m2', 1], qm: ['m2', 1] };
const N = '(\\d+(?:[.,]\\d+)?)', U = '(mg|kg|gr|g|ml|cl|ltr|liter|l|m²|m2|qm|mm|cm|m)(?![\\p{L}\\d])';
const toNum = (s: string) => parseFloat(s.replace(',', '.'));
const METERWARE = /meterware|laufmeter|\blfm\b|je meter|pro meter|von der rolle|rolle\b/i;
const CONTAINER = /becher|tasse|vase|kanne|karaffe|krug|topf|schüssel|schale|dose\b|eimer|gießkanne|thermos|behälter|box\b|flasche leer|trinkflasche|mühle|glas\b|gläser/i;
// Devices, bags, electronics, sports equipment, rugs: the quantity is capacity, own weight or size, not sale by quantity
const ITEM = /kocher|maschine|automat|gerät|rucksack|tasche|koffer|laptop|notebook|tablet|monitor|bildschirm|zoll\b|kühlschrank|staubsauger|akku|hantel|kettlebell|gewicht(?:s)?weste|teppich|matte|fahrrad|kinderwagen|zelt|schlafsack/i;

export interface Quantity { amount: number; unit: BaseUnit; raw: string; source: 'name' | 'text' | 'option'; packs?: number }
// Pack count after the quantity: "250 ml, 3er-Pack", "250 ml x 3", "6 Stück à 50 g"
const PACK = /(\d+)\s*(?:er|-er)[- ]?(?:pack|packung|set|karton|kiste|träger)\b|(\d+)\s*(?:stück|stk\.?|dosen|flaschen|beutel|tüten|packungen)\s*(?:à|a|je|zu)\s/i;
/** Fill quantity from name/text: "500 g", "3 × 250 g", "0,75 l", "250 ml, 3er-Pack". Dimensions like "130 × 170 cm" or "22 cm" are NOT a base price case (only for goods sold by the meter). */
export function parseQuantity(name: string, text = '', source: Quantity['source'] = 'name'): Quantity | null {
  const scan = (s: string, source: Quantity['source']): Quantity | null => {
    const dims = /\d+(?:[.,]\d+)?\s*(?:cm|mm|m)?\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:[x×]\s*\d+(?:[.,]\d+)?\s*)?(?:cm|mm|m)(?![\p{L}\d])/giu;
    const clean = s.replace(dims, ' ');
    const multi = new RegExp(`(\\d+)\\s*[x×]\\s*${N}\\s*${U}`, 'iu').exec(clean);
    const single = multi ?? new RegExp(`${N}\\s*${U}`, 'iu').exec(clean);
    if (!single) return null;
    const [count, val, unit] = multi ? [toNum(multi[1]), toNum(multi[2]), multi[3].toLowerCase()] : [1, toNum(single[1]), single[2].toLowerCase()];
    const f = FACTOR[unit]; if (!f || !(val > 0)) return null;
    if (f[0] === 'm' && !METERWARE.test(`${name} ${text}`)) return null; // otherwise lengths are dimensions
    let packs = 1;
    if (!multi) {
      const after = clean.slice(single.index + single[0].length), pm = PACK.exec(clean), xm = /^\s*[x×]\s*(\d+)(?![\d.,]|\s*(?:cm|mm|m)\b)/i.exec(after);
      packs = xm ? Number(xm[1]) : pm ? Number(pm[1] ?? pm[2]) : 1;
      if (!(packs >= 1 && packs <= 1000)) packs = 1;
    }
    const n = count * packs;
    return { amount: Math.round(n * val * f[1] * 1e6) / 1e6, unit: f[0], raw: single[0].trim(), source, ...(packs > 1 ? { packs } : {}) };
  };
  return scan(name, source) ?? scan(plain(text).slice(0, 3000).split(/(?<=[.!?])\s/).filter(x => /inhalt|füllmenge|nettogewicht|netto|gewicht|menge|packung|beutel|dose|flasche/i.test(x)).join(' '), 'text');
}

export interface BasePriceCandidate { quantity: Quantity; confidence: 'sicher' | 'prüfen'; reasons: string[]; exempt: string | null }
/** options = a variant's options (e.g. "250 g"): take precedence over the name */
export function basePriceCandidate(name: string, text = '', options: string[] = []): BasePriceCandidate | null {
  const q = (options.length ? parseQuantity(options.join(' · '), '', 'option') : null) ?? parseQuantity(name, text); if (!q) return null;
  const reasons: string[] = [];
  if (CONTAINER.test(name)) reasons.push(`„${q.raw}“ ist vermutlich das Fassungsvermögen eines Gefäßes, kein Verkauf nach Menge`);
  else if (ITEM.test(name)) reasons.push(`„${q.raw}“ beschreibt vermutlich Fassungsvermögen, Eigengewicht oder Größe eines Gegenstands, keinen Verkauf nach Menge`);
  if (q.source === 'text') reasons.push('Menge stammt aus der Beschreibung, nicht aus dem Namen');
  if (q.packs) reasons.push(`Packungsanzahl ${q.packs} eingerechnet (${q.packs} × ${q.raw})`);
  const exempt = q.amount === 1 ? 'Grundpreis entspricht dem Preis (genau 1 kg/1 l/1 m/1 m²): Angabe nicht nötig'
    : (q.unit === 'kg' || q.unit === 'l') && q.amount <= 0.01 ? 'Kleinstmenge bis 10 g/10 ml: Angabe in der Regel nicht nötig' : null;
  return { quantity: q, confidence: reasons.some(r => !r.startsWith('Packungsanzahl')) ? 'prüfen' : 'sicher', reasons, exempt };
}

/** "45,43 € / 1 l" from gross price, content and reference quantity */
export function basePriceText(gross: number | null | undefined, purchaseUnit: number | null | undefined, referenceUnit: number | null | undefined, shortCode: string | null | undefined): string {
  if (!purchaseUnit || !referenceUnit || !shortCode) return 'fehlt';
  const per = `${num(referenceUnit)} ${shortCode}`;
  return gross == null ? `? € / ${per} (Inhalt ${num(purchaseUnit)} ${shortCode})` : `${eur((gross / purchaseUnit) * referenceUnit)} / ${per} (Inhalt ${num(purchaseUnit)} ${shortCode})`;
}

// ================= BFSG: texts (links, headings, buttons, images) =================
const VAGUE = new Set(['hier', 'hier klicken', 'klick hier', 'klicken sie hier', 'hier entlang', 'mehr', 'mehr erfahren', 'mehr lesen', 'mehr infos', 'mehr info', 'mehr dazu', 'weiter', 'weiterlesen', 'link', 'details', 'jetzt', 'los', 'click here', 'here', 'more', 'read more', 'learn more']);
export type A11yIssueType = 'link-vague' | 'link-empty' | 'heading-skip' | 'heading-h1' | 'no-headings' | 'button-empty' | 'img-alt';
export interface A11yIssue { type: A11yIssueType; detail: string }
export const A11Y_LABEL: Record<A11yIssueType, string> = {
  'link-vague': 'Nichtssagender Linktext', 'link-empty': 'Link ohne Text', 'heading-skip': 'Überschriften-Ebene übersprungen', 'heading-h1': 'Zweite H1 im Text',
  'no-headings': 'Langer Text ohne Zwischenüberschriften', 'button-empty': 'Button ohne Text', 'img-alt': 'Bild ohne alt-Attribut',
};
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'))?.slice(2).find(x => x != null) ?? null;

/** embedded = text sits in a page with its own H1 (product/category description) */
export function htmlA11y(html: string, { embedded = true } = {}): A11yIssue[] {
  const out: A11yIssue[] = [], h = String(html ?? '');
  for (const m of h.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const imgAlt = [...m[2].matchAll(/<img\b[^>]*>/gi)].map(i => attr(i[0], 'alt') ?? '').join(' ');
    const label = (attr(m[1], 'aria-label') ?? '').trim(), text = plain(m[2]);
    const name = (label || text || imgAlt).trim();
    if (!name) out.push({ type: 'link-empty', detail: `Link ${attr(m[1], 'href') ?? ''}`.trim() });
    else if (VAGUE.has(name.toLowerCase().replace(/[.:!…»›→>]+$/g, '').trim())) out.push({ type: 'link-vague', detail: `„${name}“ → ${attr(m[1], 'href') ?? '?'}` });
  }
  for (const m of h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const imgAlt = [...m[2].matchAll(/<img\b[^>]*>/gi)].map(i => attr(i[0], 'alt') ?? '').join('');
    if (!plain(m[2]) && !attr(m[1], 'aria-label')?.trim() && !attr(m[1], 'title')?.trim() && !imgAlt.trim()) out.push({ type: 'button-empty', detail: '<button> ohne sichtbaren Text oder aria-label' });
  }
  for (const m of h.matchAll(/<input\b[^>]*>/gi)) if (/type\s*=\s*["']?(submit|button)/i.test(m[0]) && !attr(m[0], 'value')?.trim() && !attr(m[0], 'aria-label')?.trim()) out.push({ type: 'button-empty', detail: '<input type=submit/button> ohne value' });
  for (const m of h.matchAll(/<img\b[^>]*>/gi)) if (attr(m[0], 'alt') === null) out.push({ type: 'img-alt', detail: `Bild ${(attr(m[0], 'src') ?? '').split('/').pop()?.slice(0, 60) ?? ''}` });
  const levels = [...h.matchAll(/<h([1-6])\b/gi)].map(m => Number(m[1]));
  let prev = embedded ? 1 : 0;
  for (const l of levels) {
    if (l === 1 && embedded) out.push({ type: 'heading-h1', detail: 'Die Seite hat schon eine H1 (Produkt-/Kategoriename); im Text mit H2 beginnen' });
    else if (prev && l > prev + 1) out.push({ type: 'heading-skip', detail: `H${prev} → H${l}` });
    prev = l;
  }
  if (!levels.length && plain(h).split(' ').length > 300) out.push({ type: 'no-headings', detail: `${plain(h).split(' ').length} Wörter ohne Überschrift` });
  return out;
}

// ================= BFSG: color contrast (WCAG 2.1 AA) =================
const NAMED: Record<string, string> = { white: '#ffffff', black: '#000000', transparent: '' };
export function parseColor(c: unknown): [number, number, number] | null {
  let s = String(c ?? '').trim().toLowerCase(); s = NAMED[s] ?? s;
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) { let h = m[1]; if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split('').map(x => x + x).join(''); if (h.length < 6) return null; return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]; }
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export function contrastRatio(fg: unknown, bg: unknown): number | null {
  const a = parseColor(fg), b = parseColor(bg); if (!a || !b) return null;
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}
const hex = (rgb: number[]) => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
/** Nearest foreground color with sufficient contrast (same hue, darker or lighter) */
export function suggestColor(fg: unknown, bg: unknown, target = 4.5): string | null {
  const a = parseColor(fg), b = parseColor(bg); if (!a || !b) return null;
  const towards = lum(b) > 0.18 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.02; t <= 1; t += 0.02) { const c = a.map((v, i) => v + (towards[i] - v) * t); if ((contrastRatio(hex(c), hex(b)) ?? 0) >= target) return hex(c); }
  return hex(towards);
}

export interface ContrastPair { key: string; label: string; fg: string; bg: string; min: number; rule: string }
export const CONTRAST_PAIRS: ContrastPair[] = [
  { key: 'text', label: 'Fließtext auf Hintergrund', fg: 'sw-text-color', bg: 'sw-background-color', min: 4.5, rule: 'WCAG 1.4.3' },
  { key: 'headline', label: 'Überschriften auf Hintergrund (große Schrift)', fg: 'sw-headline-color', bg: 'sw-background-color', min: 3, rule: 'WCAG 1.4.3' },
  { key: 'price', label: 'Preise auf Hintergrund', fg: 'sw-color-price', bg: 'sw-background-color', min: 4.5, rule: 'WCAG 1.4.3' },
  { key: 'primary', label: 'Primärfarbe (Links) auf Hintergrund', fg: 'sw-color-brand-primary', bg: 'sw-background-color', min: 4.5, rule: 'WCAG 1.4.3' },
  { key: 'buy', label: 'Text auf Kaufen-Button', fg: 'sw-color-buy-button-text', bg: 'sw-color-buy-button', min: 4.5, rule: 'WCAG 1.4.3' },
  { key: 'danger', label: 'Fehlermeldungen auf Hintergrund', fg: 'sw-color-danger', bg: 'sw-background-color', min: 4.5, rule: 'WCAG 1.4.3' },
  { key: 'success', label: 'Erfolgsmeldungen auf Hintergrund', fg: 'sw-color-success', bg: 'sw-background-color', min: 4.5, rule: 'WCAG 1.4.3' },
  { key: 'border', label: 'Rahmen von Formularfeldern', fg: 'sw-border-color', bg: 'sw-background-color', min: 3, rule: 'WCAG 1.4.11' },
];
/** Resolve theme fields (values can reference other fields, e.g. "$sw-color-brand-primary") */
export function resolveTheme(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const get = (k: string, depth = 0): string => { const v = String(fields[k] ?? '').trim(); const ref = v.match(/^\$?(sw-[\w-]+)$/); return ref && depth < 5 && ref[1] !== k ? get(ref[1], depth + 1) : v; };
  for (const k of Object.keys(fields)) out[k] = get(k);
  return out;
}
export interface ContrastResult extends ContrastPair { fgColor: string; bgColor: string; ratio: number | null; ok: boolean; suggestion?: string }
export function themeContrast(fields: Record<string, unknown>): ContrastResult[] {
  const t = resolveTheme(fields);
  return CONTRAST_PAIRS.filter(p => t[p.fg] && t[p.bg]).map(p => {
    const ratio = contrastRatio(t[p.fg], t[p.bg]), ok = ratio == null || ratio >= p.min;
    return { ...p, fgColor: t[p.fg], bgColor: t[p.bg], ratio, ok, ...(ok ? {} : { suggestion: suggestColor(t[p.fg], t[p.bg], p.min) ?? undefined }) };
  });
}

// ================= Legal pages (imprint, privacy, terms, withdrawal, shipping/payment) =================
export interface LegalPageDef { key: string; label: string; rule: string; words: RegExp; severity: 'hoch' | 'mittel' }
export const LEGAL_PAGES: LegalPageDef[] = [
  { key: 'imprintPage', label: 'Impressum', rule: '§ 5 DDG', words: /impressum|imprint/i, severity: 'hoch' },
  { key: 'privacyPage', label: 'Datenschutzerklärung', rule: 'Art. 13 DSGVO', words: /datenschutz|privacy/i, severity: 'hoch' },
  { key: 'tosPage', label: 'AGB', rule: '§ 305 BGB (falls AGB verwendet werden)', words: /\bagb\b|geschäftsbedingungen|terms/i, severity: 'mittel' },
  { key: 'revocationPage', label: 'Widerrufsbelehrung', rule: '§ 312g BGB, Art. 246a EGBGB', words: /widerruf|rescission|revocation|cancellation/i, severity: 'hoch' },
  { key: 'shippingPaymentInfoPage', label: 'Versand- und Zahlungsinformationen', rule: '§ 6 PAngV, Art. 246a EGBGB', words: /versand|zahlung|lieferung|shipping|payment/i, severity: 'mittel' },
];
export interface LegalPageInput { cmsPageId: string | null; exists: boolean; name?: string | null; text: string; linked: boolean; reachable: boolean | null }
export interface LegalPageStatus { key: string; label: string; rule: string; cmsPageId: string | null; problems: string[]; severity: 'hoch' | 'mittel' }
export function evaluateLegalPage(def: LegalPageDef, i: LegalPageInput): LegalPageStatus {
  const problems: string[] = [];
  if (!i.cmsPageId) problems.push('Keine Seite zugeordnet (Einstellungen › Stammdaten)');
  else if (!i.exists) problems.push('Zugeordnete Seite existiert nicht mehr');
  else {
    const t = plain(i.text);
    if (/lorem ipsum|dolor sit amet/i.test(t)) problems.push('Enthält Platzhaltertext (Lorem ipsum)');
    else if (t.length < 200) problems.push(`Kaum Inhalt (${t.length} Zeichen)`);
    if (i.reachable === false) problems.push('Im Shop nicht erreichbar');
    if (!i.linked) problems.push('Nicht im Footer der Startseite verlinkt');
  }
  return { key: def.key, label: def.label, rule: def.rule, cmsPageId: i.cmsPageId, problems, severity: def.severity };
}
/** Links in the footer (or whole page if there is no footer): href + text */
export function footerLinks(html: string): { href: string; text: string }[] {
  const i = html.search(/<footer\b/i), part = i >= 0 ? html.slice(i) : html;
  return [...part.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map(m => ({ href: attr(m[1], 'href') ?? '', text: plain(m[2]) || (attr(m[1], 'title') ?? '') }));
}
export const isLinked = (def: LegalPageDef, cmsPageId: string | null, links: { href: string; text: string }[]) =>
  links.some(l => (cmsPageId && l.href.includes(cmsPageId)) || def.words.test(l.text));
