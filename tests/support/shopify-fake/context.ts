/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Request context and shared helpers for the resolvers.
 */
import { GraphQLError, type ResolveInfo } from './graphql';
import { compileSearch, type SearchSpec } from './search';
import { FakeShopifyState, digest, gid, type MediaRec, type MetafieldRec } from './state';

export interface FakeOptions {
  accessScopes: Set<string>;
  /** 'async' (default): new media is UPLOADED in the creating request and READY from the next request on */
  mediaProcessing: 'async' | 'immediate';
  /** 'all' (default) or 'unpublished-only' (simulates a missing theme-write exemption for the live theme) */
  themeWriteAccess: 'all' | 'unpublished-only';
  /** whether products/collections created via the API are published to the Online Store */
  autoPublish: boolean;
  /** app namespace used when metafield namespace is omitted */
  appNamespace: string;
}

export interface Ctx {
  state: FakeShopifyState;
  options: FakeOptions;
  /** bulk-operation execution: pagination arguments are optional and unlimited */
  bulk: boolean;
  searchExtensions: { path: (string | number)[]; query: string; warnings: { field: string; message: string }[] }[];
  /** the engine, injected so bulk operations can execute nested queries */
  runBulkQuery?: (query: string) => Promise<{ errors: string[]; data: Record<string, unknown> | null }>;
}

export const ONLINE_STORE_PUBLICATION_ID = 1_001_000_001;
export const MAX_PAGE_SIZE = 250;

/* ------------------------------------------------------------------ ids */

export function parseGid(value: unknown): { type: string; id: string; num: number } {
  const s = String(value ?? '');
  const m = /^gid:\/\/shopify\/([A-Za-z0-9]+)\/([^/?#]+)(\?.*)?$/.exec(s);
  if (!m) {
    throw new GraphQLError(`Invalid global id '${s}'`, { extensions: { code: 'argumentLiteralsIncompatible', typeName: 'CoercionError' } });
  }
  return { type: m[1], id: m[2], num: Number(m[2]) };
}

/** Returns the numeric id if the gid is of the expected type, otherwise null (malformed gids throw). */
export function idOf(value: unknown, type: string): number | null {
  const g = parseGid(value);
  if (g.type !== type || !Number.isFinite(g.num)) return null;
  return g.num;
}

/** Like idOf but never throws (used inside mutations that report userErrors). */
export function safeIdOf(value: unknown, type: string): number | null {
  try {
    return idOf(value, type);
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- user errors */

export interface UE {
  field: string[] | null;
  message: string;
  code?: string | null;
  [k: string]: unknown;
}

export function ue(field: (string | number)[] | null, message: string, code?: string | null, extra: Record<string, unknown> = {}): UE {
  return { field: field ? field.map(String) : null, message, code: code ?? null, ...extra };
}

/* ------------------------------------------------------------ pagination */

export interface ConnArgs {
  first?: number | null;
  last?: number | null;
  after?: string | null;
  before?: string | null;
  reverse?: boolean | null;
}

function encodeCursor(key: string | number, value: unknown): string {
  return Buffer.from(JSON.stringify({ last_id: key, last_value: value ?? key })).toString('base64');
}

function decodeCursor(cursor: string): { last_id: string | number } {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (obj && (typeof obj.last_id === 'number' || typeof obj.last_id === 'string')) return obj;
  } catch {
    /* fallthrough */
  }
  throw new GraphQLError('Invalid cursor for current pagination sort.', { extensions: { code: 'BAD_REQUEST' } });
}

export function paginate<T>(
  items: T[],
  args: ConnArgs,
  ctx: Ctx,
  key: (t: T) => string | number,
  sortValue?: (t: T) => unknown,
): { edges: { cursor: string; node: T }[]; nodes: T[]; pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } } {
  const { first, last, after, before } = args;
  if (!ctx.bulk) {
    if (first == null && last == null) throw new GraphQLError('you must provide one of first or last', { extensions: { code: 'BAD_REQUEST' } });
  }
  if ((first != null && first < 0) || (last != null && last < 0)) {
    throw new GraphQLError('first and last must be non-negative', { extensions: { code: 'BAD_REQUEST' } });
  }
  const list = args.reverse ? [...items].reverse() : items;
  let start = 0;
  let end = list.length;
  const position = (cursor: string) => {
    const c = decodeCursor(cursor);
    const idx = list.findIndex((t) => key(t) === c.last_id);
    if (idx >= 0) return { idx, found: true };
    // deleted record: continue after the next greater key
    const next = list.findIndex((t) => (args.reverse ? key(t) < c.last_id : key(t) > c.last_id));
    return { idx: next === -1 ? list.length : next, found: false };
  };
  if (after) {
    const p = position(after);
    start = p.found ? p.idx + 1 : p.idx;
  }
  if (before) {
    const p = position(before);
    end = Math.max(start, p.idx);
  }
  let slice = list.slice(start, end);
  let hasNextPage = end < list.length;
  let hasPreviousPage = start > 0;
  const cap = ctx.bulk ? Infinity : MAX_PAGE_SIZE;
  if (first != null) {
    const n = Math.min(first, cap);
    hasNextPage = slice.length > n || hasNextPage;
    slice = slice.slice(0, n);
  }
  if (last != null) {
    const n = Math.min(last, cap);
    hasPreviousPage = slice.length > n || hasPreviousPage;
    slice = slice.slice(Math.max(0, slice.length - n));
  }
  if (first == null && last == null && !ctx.bulk) slice = slice.slice(0, cap);
  const edges = slice.map((node) => ({ cursor: encodeCursor(key(node), sortValue ? sortValue(node) : key(node)), node }));
  return {
    edges,
    nodes: slice,
    pageInfo: { hasNextPage, hasPreviousPage, startCursor: edges[0]?.cursor ?? null, endCursor: edges[edges.length - 1]?.cursor ?? null },
  };
}

export function search<T>(items: T[], query: string | null | undefined, spec: SearchSpec<T>, ctx: Ctx, info: ResolveInfo): T[] {
  const { match, warnings } = compileSearch(query, spec);
  if (warnings.length && query) ctx.searchExtensions.push({ path: info.path, query, warnings });
  return items.filter(match);
}

export function sortBy<T>(items: T[], value: (t: T) => string | number, tie: (t: T) => number): T[] {
  return [...items].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (typeof va === 'number' && typeof vb === 'number' && va !== vb) return va - vb;
    if (typeof va === 'string' && typeof vb === 'string') {
      const c = va.localeCompare(vb, 'de', { sensitivity: 'base' });
      if (c !== 0) return c;
    }
    return tie(a) - tie(b);
  });
}

/* ------------------------------------------------------------- formatting */

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export function truncate(text: string, at?: number | null): string {
  if (!at || text.length <= at) return text;
  return `${text.slice(0, Math.max(0, at - 3)).trimEnd()}...`;
}

export function money(amount: string | number, currencyCode: string): { amount: string; currencyCode: string } {
  return { amount: String(Number(amount)), currencyCode };
}

export function isValidMoney(v: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(v);
}

/* ------------------------------------------------------------------ media */

export function mediaStatus(m: MediaRec, ctx: Ctx): 'UPLOADED' | 'READY' | 'FAILED' {
  const processed = ctx.options.mediaProcessing === 'immediate' || m.createdInRequest < ctx.state.requestSeq;
  if (!processed) return 'UPLOADED';
  return m.failed ? 'FAILED' : 'READY';
}

export function mediaView(m: MediaRec): MediaRec & { __typename: 'MediaImage' } {
  return { ...m, __typename: 'MediaImage' };
}

/* -------------------------------------------------------------- metafields */

export function metafieldOwnerType(ownerId: string): string {
  const t = parseGid(ownerId).type;
  return t === 'ProductVariant' ? 'PRODUCTVARIANT' : t === 'DiscountCodeNode' ? 'DISCOUNT' : t.toUpperCase();
}

export function metafieldJsonValue(m: MetafieldRec): unknown {
  const t = m.type;
  try {
    if (t === 'number_integer') return Number(m.value);
    if (t === 'boolean') return m.value === 'true';
    if (t === 'json' || t === 'rich_text_field' || t === 'money' || t === 'rating' || t === 'link' || t === 'weight' || t === 'volume' || t === 'dimension' || t.startsWith('list.')) {
      return JSON.parse(m.value);
    }
  } catch {
    return m.value;
  }
  return m.value;
}

export function metafieldView(m: MetafieldRec) {
  return {
    id: gid('Metafield', m.id),
    namespace: m.namespace,
    key: m.key,
    value: m.value,
    type: m.type,
    jsonValue: metafieldJsonValue(m),
    ownerType: metafieldOwnerType(m.ownerId),
    compareDigest: digest(m.value),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    __typename: 'Metafield',
    __rec: m,
  };
}

/** Resolvers for `metafield` / `metafields` on any HasMetafields owner. */
export function metafieldResolvers(ownerGid: (parent: any, ctx: Ctx) => string) {
  return {
    metafield: (p: any, args: { namespace?: string | null; key: string }, ctx: Ctx) => {
      let ns = args.namespace ?? null;
      let key = args.key;
      if (ns === null && key.includes('.')) {
        const i = key.lastIndexOf('.');
        ns = key.slice(0, i);
        key = key.slice(i + 1);
      }
      const m = ctx.state.findMetafield(ownerGid(p, ctx), ns ?? ctx.options.appNamespace, key);
      return m ? metafieldView(m) : null;
    },
    metafields: (p: any, args: ConnArgs & { namespace?: string | null; keys?: string[] | null }, ctx: Ctx) => {
      let list = ctx.state.ownerMetafields(ownerGid(p, ctx));
      if (args.namespace) list = list.filter((m) => m.namespace === args.namespace);
      if (args.keys?.length) list = list.filter((m) => args.keys!.includes(`${m.namespace}.${m.key}`));
      list.sort((a, b) => a.id - b.id);
      const conn = paginate(list, args, ctx, (m) => m.id);
      return { ...conn, nodes: conn.nodes.map(metafieldView), edges: conn.edges.map((e) => ({ cursor: e.cursor, node: metafieldView(e.node) })) };
    },
  };
}

/** maps a paginated connection's nodes through a view function */
export function mapConn<T, U>(conn: ReturnType<typeof paginate<T>>, f: (t: T) => U) {
  return { pageInfo: conn.pageInfo, nodes: conn.nodes.map(f), edges: conn.edges.map((e) => ({ cursor: e.cursor, node: f(e.node) })) };
}

export function accessDenied(field: string, scope: string): GraphQLError {
  return new GraphQLError(`Access denied for ${field} field. Required access: \`${scope}\` access scope.`, {
    extensions: { code: 'ACCESS_DENIED', documentation: 'https://shopify.dev/api/usage/access-scopes', requiredAccess: `\`${scope}\` access scope.` },
  });
}
