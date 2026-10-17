import 'server-only';
// Shopify: the AI's protected read client. Allowlist of GraphQL root fields (not a denylist), scopes from settings
// (AI access), forbidden terms in fields/arguments, queries only (never mutations), scrubbing of sensitive fields, access log.
// The tools call fixed queries from the code; the AI never decides a query itself.
import type { ScopeKey } from '@/lib/protocol';
import { DENIED_TERMS, DEFAULT_SCOPES, DeniedError, SCOPES, scrubSensitive, type AccessEvent, type Scopes } from '../../policy';
import { gidType, type Json, type ShopifyClient } from './client';

/** Root fields the AI may read → scope. null = scope depends on the IDs (nodes, translatableResourcesByIds) */
export const ROOTS: Record<string, ScopeKey | null> = {
  shop: 'shop', shopLocales: 'shop', publications: 'shop', locations: 'shop',
  products: 'products', product: 'products', productsCount: 'products', productVariants: 'products', productVariant: 'products',
  collections: 'categories', collection: 'categories', collectionsCount: 'categories',
  files: 'media',
  pages: 'cms', page: 'cms', urlRedirects: 'cms',
  codeDiscountNodes: 'marketing', codeDiscountNode: 'marketing',
  nodes: null, translatableResourcesByIds: null,
};
/** Scope per GID type (for nodes/translatableResourcesByIds); all other types (Customer, Order, …) are blocked */
export const GID_SCOPE: Record<string, ScopeKey> = {
  Product: 'products', ProductVariant: 'products', ProductOption: 'products', ProductOptionValue: 'products',
  Collection: 'categories', MediaImage: 'media', Page: 'cms', DiscountCodeNode: 'marketing',
};
/** nested fields that additionally need a scope (e.g. products of a collection, images of a product) */
const NESTED: Record<string, ScopeKey> = { products: 'products', variants: 'products', productVariants: 'products', collections: 'categories', media: 'media', featuredMedia: 'media', files: 'media' };
/** harmless identifiers that DENIED_TERMS would otherwise hit (a collection's sort order, discount settings without customer reference) */
const BENIGN = new Set(['sortOrder', 'appliesOncePerCustomer', 'customerGets', 'orderDiscounts']);

const stripLiterals = (doc: string) => doc.replace(/"""[\s\S]*?"""/g, '""').replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/#[^\n]*/g, '');

/** Root fields of a document's (single) query; aliases are resolved. Throws on mutation/subscription/multiple operations. */
export function rootFields(doc: string): string[] {
  const s = stripLiterals(doc);
  let i = 0, depth = 0, ops = 0, start = -1;
  // Count top-level operations (fragments are allowed but yield no root fields)
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') { if (depth === 0) { const head = s.slice(s.lastIndexOf('}', i) + 1, i).trim(); if (/^(mutation|subscription)\b/.test(head)) throw new DeniedError('ZUGRIFF VERWEIGERT: Die KI darf nur lesen (keine Mutationen).'); if (!/^fragment\b/.test(head)) { ops++; if (start < 0) start = i; } } depth++; }
    else if (ch === '}') depth--;
  }
  if (ops !== 1 || start < 0) throw new DeniedError('ZUGRIFF VERWEIGERT: genau eine Query erwartet.');
  const out: string[] = [];
  depth = 0; let paren = 0;
  for (i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') paren++; else if (ch === ')') paren--;
    else if (ch === '{') depth++; else if (ch === '}') { if (depth === 0) break; depth--; }
    else if (depth === 0 && paren === 0 && /[A-Za-z_]/.test(ch)) {
      const m = /^([A-Za-z_]\w*)\s*(:\s*([A-Za-z_]\w*))?/.exec(s.slice(i))!;
      if (s.slice(i - 3, i) === '...') throw new DeniedError('ZUGRIFF VERWEIGERT: Fragmente auf oberster Ebene sind nicht erlaubt.');
      out.push(m[3] ?? m[1]); i += m[0].length - 1;
    }
  }
  return out;
}
/** all identifiers (fields, arguments, enum values, type names) without variable names and literals */
export const identifiers = (doc: string) => [...stripLiterals(doc).replace(/\$\w+/g, ' ').matchAll(/[A-Za-z_]\w*/g)].map(m => m[0]);

export interface ReaderOpts { chat?: string; getScopes?: () => Scopes; onAccess?: (a: AccessEvent & { chat?: string }) => void }

/** Roughly counts records read (connection nodes or 1 per object) */
function countOf(data: Json): number {
  let n = 0;
  for (const v of Object.values(data ?? {})) n += Array.isArray(v) ? v.length : v && typeof v === 'object' ? (Array.isArray(v.nodes) ? v.nodes.length : Array.isArray(v.edges) ? v.edges.length : 'count' in v ? 1 : 1) : 0;
  return n;
}

export class ShopifyReader {
  readonly platform = 'shopify' as const;
  readonly #client: ShopifyClient;
  readonly #o: ReaderOpts;
  /** Cache per reader (session or shop check run), e.g. basic shop data */
  readonly cache = new Map<string, Promise<unknown>>();
  constructor(client: ShopifyClient, o: ReaderOpts = {}) { this.#client = client; this.#o = o; }
  /** Log a read the adapter made on the session's behalf with a fixed query (e.g. theme settings for the onboarding) */
  noteRead(entity: string, n = 1) { try { this.#o.onAccess?.({ chat: this.#o.chat, op: 'read', entity, n }); } catch { /* logging must never interfere */ } }

  #deny(entity: string, msg: string): DeniedError {
    try { this.#o.onAccess?.({ chat: this.#o.chat, op: 'deny', entity, n: 0, denied: msg.slice(0, 160) }); } catch { /* logging must never interfere */ }
    return new DeniedError('ZUGRIFF VERWEIGERT: ' + msg);
  }
  #enabled(entity: string, sc: ScopeKey) {
    if (!(this.#o.getScopes ?? (() => DEFAULT_SCOPES))()[sc]) throw this.#deny(entity, `Zugriff auf „${SCOPES[sc].label}“ ist vom Betreiber nicht freigegeben (Einstellungen → KI-Zugriff).`);
  }

  /** Checks a query document against the allowlist; returns the root fields */
  check(doc: string, vars: Json = {}): string[] {
    let roots: string[];
    try { roots = rootFields(doc); } catch (e) { if (e instanceof DeniedError) throw this.#deny('graphql', e.message.replace(/^ZUGRIFF VERWEIGERT: /, '')); throw e; }
    for (const r of roots) {
      if (!(r in ROOTS)) throw this.#deny(r, `„${r}“ ist für die KI gesperrt (Kunden, Bestellungen, Entwürfe, Checkouts, Mitarbeiter, Zahlungen und Zugangsdaten sind grundsätzlich ausgeschlossen).`);
      const sc = ROOTS[r];
      if (sc) this.#enabled(r, sc);
      else {
        const ids = ([] as unknown[]).concat(vars.ids ?? [], vars.resourceIds ?? []).map(String);
        if (!ids.length) throw this.#deny(r, `${r}: IDs nur als Variablen (ids/resourceIds).`);
        for (const id of ids) { const t = gidType(id); if (!t || !GID_SCOPE[t]) throw this.#deny(r, `ID-Typ „${t ?? id.slice(0, 40)}“ ist für die KI gesperrt.`); this.#enabled(r, GID_SCOPE[t]); }
      }
    }
    const idents = identifiers(doc);
    const bad = idents.find(k => !BENIGN.has(k) && DENIED_TERMS.test(k));
    if (bad) throw this.#deny(roots.join(','), `Feld/Argument „${bad}“ hat Kunden-, Bestell-, Mitarbeiter- oder Zugangsbezug und ist gesperrt.`);
    for (const k of new Set(idents)) if (NESTED[k]) this.#enabled(k, NESTED[k]);
    return roots;
  }

  /** run a fixed query (after the check), scrub the result, log the access */
  async query<T = Json>(doc: string, vars: Json = {}): Promise<T> {
    const roots = this.check(doc, vars);
    const data = await this.#client.gql<Json>(doc, vars);
    const scrubbed = scrubSensitive(data);
    try { this.#o.onAccess?.({ chat: this.#o.chat, op: 'read', entity: roots.join(','), n: countOf(data), scrubbed }); } catch { /* logging must never interfere */ }
    return data as T;
  }

  /** once per reader: cache the result */
  memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) { p = fn(); this.cache.set(key, p); p.catch(() => this.cache.delete(key)); }
    return p;
  }
}
