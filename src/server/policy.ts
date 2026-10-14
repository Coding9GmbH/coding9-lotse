import 'server-only';
// Privacy/access layer for the AI: allow-list instead of trust.
// The AI never knows credentials and may not read customer/order data, no matter what a prompt says.
import type { ScopeKey } from '@/lib/protocol';

export const SCOPES: Record<ScopeKey, { label: string; hint: string; entities: string[] }> = {
  products:   { label: 'Produkte', hint: 'Name, Nr., Preise, Bestand, Texte, Bilder, Eigenschaften, Varianten, Steuersätze, Lieferzeiten, Tags, Cross-Selling, Produktstreams', entities: ['product', 'product-media', 'tax', 'property-group', 'property-group-option', 'product-configurator-setting', 'product-visibility', 'product-cross-selling', 'product-cross-selling-assigned-products', 'product-stream', 'product-stream-filter', 'delivery-time', 'tag', 'unit'] },
  manufacturers: { label: 'Hersteller', hint: 'Marken mit Name, Beschreibung, Webseite, Logo und Pflichtangaben (GPSR)', entities: ['product-manufacturer'] },
  categories: { label: 'Kategorien', hint: 'Struktur, Texte, SEO-Felder', entities: ['category'] },
  cms:        { label: 'Einkaufswelten-Layouts', hint: 'Seiten, Sections, Blöcke, Slots, Landingpages, SEO-URLs', entities: ['cms-page', 'cms-section', 'cms-block', 'cms-slot', 'landing-page', 'seo-url'] },
  media:      { label: 'Medienbibliothek', hint: 'Dateinamen, URLs, Alt-Texte', entities: ['media', 'media-folder', 'media-default-folder'] },
  marketing:  { label: 'Marketing', hint: 'Promotionen, Rabatte, Gutscheincodes (ohne Bestell- und Kundendaten)', entities: ['promotion', 'promotion-discount', 'promotion-discount-prices', 'promotion-sales-channel', 'promotion-setgroup', 'promotion-individual-code', 'rule', 'rule-condition'] },
  shop:       { label: 'Shop-Grunddaten', hint: 'Verkaufskanäle & Domains, Sprachen, Währungen, Theme-Einstellungen (Farben, Schriften)', entities: ['sales-channel', 'sales-channel-domain', 'theme', 'language', 'locale', 'currency'] },
  // Integrations: not shop entities, but whether the AI may read the data (tools, shop checks, SEO overview)
  gsc:        { label: 'Search Console', hint: 'Klicks, Impressionen, Klickrate und Position deiner Seiten (Google Search Console)', entities: [] },
  sistrix:    { label: 'Sistrix', hint: 'Sichtbarkeitsindex, Wettbewerber, Keyword-Potenzial und OnPage-Crawl (Sistrix)', entities: [] },
  // Web research: web search and fetching public web pages by the AI (Claude: WebSearch/WebFetch, Codex: web_search); off by default
  web:        { label: 'Internetrecherche', hint: 'Websuche und Abruf öffentlicher Webseiten, z. B. Herstellerangaben, Datenblätter, Normen', entities: [] },
};
export type Scopes = Record<ScopeKey, boolean>;
export const SCOPE_KEYS = Object.keys(SCOPES) as ScopeKey[];
/** Everything on except web research: content from the web is third-party text the operator should allow deliberately */
export const DEFAULT_SCOPES = Object.fromEntries(SCOPE_KEYS.map(k => [k, k !== 'web'])) as Scopes;
const ENTITY_SCOPE: Record<string, ScopeKey> = Object.fromEntries(SCOPE_KEYS.flatMap(k => SCOPES[k].entities.map(e => [e, k])));
// Allowed associations per entity (name → target entity). Everything else (e.g. reviews, orderLineItems, customer …) is rejected.
const ASSOC: Record<string, Record<string, string>> = {
  product: { tax: 'tax', manufacturer: 'product-manufacturer', cover: 'product-media', media: 'product-media', categories: 'category', properties: 'property-group-option', cmsPage: 'cms-page',
    tags: 'tag', deliveryTime: 'delivery-time', visibilities: 'product-visibility', crossSellings: 'product-cross-selling',
    options: 'property-group-option', configuratorSettings: 'product-configurator-setting', children: 'product', parent: 'product' },
  'product-media': { media: 'media' }, 'property-group-option': { group: 'property-group' }, 'property-group': { options: 'property-group-option' },
  'product-cross-selling': { assignedProducts: 'product-cross-selling-assigned-products', product: 'product', productStream: 'product-stream' },
  'product-cross-selling-assigned-products': { product: 'product' },
  'product-configurator-setting': { option: 'property-group-option' },
  category: { cmsPage: 'cms-page', children: 'category', productStream: 'product-stream' },
  'product-stream': { filters: 'product-stream-filter', categories: 'category', productCrossSellings: 'product-cross-selling' },
  'cms-page': { sections: 'cms-section' }, 'cms-section': { blocks: 'cms-block' }, 'cms-block': { slots: 'cms-slot' }, 'landing-page': { cmsPage: 'cms-page' },
  promotion: { discounts: 'promotion-discount', salesChannels: 'promotion-sales-channel', setgroups: 'promotion-setgroup', cartRules: 'rule', personaRules: 'rule' },
  'promotion-discount': { discountRules: 'rule', promotionDiscountPrices: 'promotion-discount-prices' }, 'promotion-setgroup': { setGroupRules: 'rule' }, rule: { conditions: 'rule-condition' },
  'sales-channel': { domains: 'sales-channel-domain', languages: 'language' }, language: { locale: 'locale' }, theme: { salesChannels: 'sales-channel' }, 'media-default-folder': { folder: 'media-folder' },
};
// Allowed read-only non-search endpoints
export const GET_ALLOW = [/^\/_info\/version$/, /^\/_action\/theme\/[0-9a-f]{32}\/configuration$/];
// Read-only POST endpoints: the body is checked like a search on the entity (only these keys, associations/filters per allow-list)
const POST_READ: { re: RegExp; entity: string }[] = [{ re: /^\/_admin\/product-stream-preview\/[0-9a-f]{32}$/, entity: 'product' }];
const POST_KEYS = new Set(['filter', 'limit', 'page', 'total-count-mode', 'associations', 'sort']);
// Known keys of a Shopware search; everything else (future or unknown parameters) is rejected so the check stays complete
const CRITERIA_KEYS = new Set(['ids', 'limit', 'page', 'term', 'total-count-mode', 'includes', 'filter', 'post-filter', 'query', 'sort', 'fields', 'aggregations', 'associations', 'grouping']);
// Read-only GET endpoints with scope check + scrubbing (e.g. basic information settings: assigned legal pages; email and keys are removed)
const GET_READ: { re: RegExp; entity: string }[] = [{ re: /^\/_action\/system-config\?domain=core\.basicInformation(&salesChannelId=[0-9a-f]{32})?$/, entity: 'sales-channel' }];

const DENY_STRUCT = /(customer|order|invoice|document|newsletter|password|passwd|e-?mail|iban|\bbic\b|token|secret|payment|address|salutation|birthday|user|integration|api[-_]?key)/i;
const SENSITIVE_KEY = { test: (k: string) => /(e-?mail|password|passwd|iban|secret|token|api[-_]?key|phone|access[-_]?key)/i.test(k) || /^(bic|firstName|lastName|street|zipcode|city|birthday|vatIds?|customerNumber|username|ipAddress|customerId|customerName|orderId|ordersPerCustomerCount)$/i.test(k) };
// Rule conditions: values only for cart/product/time conditions; for everything else (customer group, email, customer number, address …) only the type
const RULE_VALUE_OK = /^(cartLineItem\w*|cartCartAmount|cartGoodsCount|cartGoodsPrice|cartPositionPrice|cartWeight|cartVolume|cartHasDeliveryFreeItem|cartLineItemsInCart\w*|dateRange|dayOfWeek|timeRange|salesChannel|currency|language|alwaysValid|(and|or|xor|not)Container)$/;

/** For other platforms (docs/platform.md): terms that must never appear in filters/fields/paths, and sensitive field names */
export const DENIED_TERMS = new RegExp(`${DENY_STRUCT.source}|staff|checkout|cart|gift.?card|abandon|refund|transaction|fulfil|shipment|credit.?memo|company.?contact|segment|marketing.?consent`, 'i');
export const isSensitiveKey = (k: string) => SENSITIVE_KEY.test(k);
/** Recursively removes sensitive fields (email, password, token, address, customer/order related …); returns the number of removed fields */
export function scrubSensitive(data: unknown): number {
  let n = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') for (const k of Object.keys(x)) { if (SENSITIVE_KEY.test(k)) { delete (x as Record<string, unknown>)[k]; n++; } else walk((x as Record<string, unknown>)[k]); }
  };
  walk(data); return n;
}

const keysDeep = (o: unknown, out: string[] = []): string[] => { if (Array.isArray(o)) o.forEach(x => keysDeep(x, out)); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { out.push(k); keysDeep(v, out); } return out; };

export type AssocTree = Record<string, { associations?: AssocTree; [k: string]: unknown } | undefined>;
export interface Criteria { associations?: AssocTree; filter?: unknown; sort?: unknown; fields?: unknown; aggregations?: unknown; [k: string]: unknown }
export interface AccessEvent { op: string; entity: string; n: number; scrubbed?: number; denied?: string }
export class DeniedError extends Error { denied = true as const; }

export interface Guard {
  scopes: () => Scopes;
  checkSearch(entity: string, criteria?: Criteria): void;
  checkGet(method: string, p: string): void;
  /** Language ID for the sw-language-id header: only a 32-digit hex ID (no header injection) */
  checkLanguage(languageId?: string): void;
  /** Direct API call: GET per GET_ALLOW or read-only POST per POST_READ (body checked); returns the entity for afterRead */
  checkReq(method: string, p: string, body?: unknown): string | null;
  afterRead<T extends { data?: unknown } | null | undefined>(op: string, entity: string, res: T): T;
}

export function createGuard({ getScopes = () => DEFAULT_SCOPES, onAccess = () => {} }: { getScopes?: () => Scopes; onAccess?: (a: AccessEvent) => void } = {}): Guard {
  const deny = (entity: string, msg: string) => { const e = new DeniedError('ZUGRIFF VERWEIGERT: ' + msg); try { onAccess({ op: 'deny', entity, n: 0, denied: msg.slice(0, 160) }); } catch {} return e; };
  const enabled = (entity: string) => {
    const sc = ENTITY_SCOPE[entity];
    if (!sc) throw deny(entity, `„${entity}“ ist für die KI gesperrt (Kunden-, Bestell-, Rechnungs-, Newsletter-, Benutzer- und Zahlungsdaten sind grundsätzlich ausgeschlossen).`);
    if (!getScopes()[sc]) throw deny(entity, `Zugriff auf „${SCOPES[sc].label}“ ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).`);
  };

  function checkAssociations(entity: string, assoc: AssocTree | undefined) {
    for (const [name, sub] of Object.entries(assoc ?? {})) {
      const target = ASSOC[entity]?.[name];
      if (!target) throw deny(entity, `Beziehung „${entity}.${name}“ ist nicht freigegeben.`);
      enabled(target); checkAssociations(target, sub?.associations);
    }
  }
  const scrub = (data: unknown) => {
    let n = 0;
    const walk = (x: unknown) => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (typeof o.type === 'string' && 'ruleId' in o && 'value' in o && o.value != null && !RULE_VALUE_OK.test(o.type)) { delete o.value; n++; }
        for (const k of Object.keys(o)) { if (SENSITIVE_KEY.test(k)) { delete o[k]; n++; } else walk(o[k]); }
      }
    };
    walk(data); return n;
  };
  function checkSearch(entity: string, criteria: Criteria = {}) {
    enabled(entity);
    const extra = Object.keys(criteria).filter(k => !CRITERIA_KEYS.has(k));
    if (extra.length) throw deny(entity, `Suchparameter ${extra.join(', ')} sind nicht erlaubt.`);
    checkAssociations(entity, criteria.associations);
    // all places where field names can appear: filter, post-filter, query (score queries), sort, fields, aggregations, grouping, associations
    const fields = { filter: criteria.filter, pf: criteria['post-filter'], q: criteria.query, sort: criteria.sort, fields: criteria.fields, aggregations: criteria.aggregations, grouping: criteria.grouping };
    const structural = keysDeep({ ...fields, associations: criteria.associations }).filter(k => k !== 'order');
    const fieldVals = JSON.stringify(fields).match(/"field":"[^"]*"|"fields":\[[^\]]*\]/g) ?? [];
    const plain = Array.isArray(criteria.grouping) ? criteria.grouping.map(String) : [];
    if ([...structural, ...fieldVals, ...plain].some(s => DENY_STRUCT.test(s))) throw deny(entity, 'Filter/Sortierung/Felder mit Kunden-, Bestell- oder Zugangsbezug sind gesperrt.');
  }
  const checkGet = (method: string, p: string) => { if (method !== 'GET' || !GET_ALLOW.some(r => r.test(p))) throw deny('http', `Direkter API-Zugriff ${method} ${p} ist für die KI nicht erlaubt.`); };
  return {
    scopes: getScopes,
    checkSearch,
    checkGet,
    checkReq(method, p, body) {
      const get = method === 'GET' ? GET_READ.find(x => x.re.test(p)) : undefined;
      if (get) { enabled(get.entity); return get.entity; }
      const post = method === 'POST' ? POST_READ.find(x => x.re.test(p)) : undefined;
      if (!post) { checkGet(method, p); return null; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw deny(post.entity, `${p}: Suchkriterien als Objekt erwartet.`);
      const extra = Object.keys(body).filter(k => !POST_KEYS.has(k));
      if (extra.length) throw deny(post.entity, `${p}: Parameter ${extra.join(', ')} sind nicht erlaubt.`);
      checkSearch(post.entity, body as Criteria);
      return post.entity;
    },
    checkLanguage(languageId) { if (languageId !== undefined && !/^[0-9a-f]{32}$/.test(languageId)) throw deny('language', `Ungültige Sprach-ID „${String(languageId).slice(0, 40)}“.`); },
    afterRead(op, entity, res) {
      const scrubbed = scrub(res);
      const data = res?.data;
      onAccess({ op, entity, n: Array.isArray(data) ? data.length : (data ? 1 : 0), scrubbed });
      return res;
    },
  };
}
