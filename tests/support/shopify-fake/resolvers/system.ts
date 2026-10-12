/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ResolveInfo } from '../graphql';
import { type ConnArgs, type Ctx, mediaView, metafieldResolvers, metafieldView, ONLINE_STORE_PUBLICATION_ID, paginate, parseGid, safeIdOf, search, sortBy, ue, type UE } from '../context';
import type { SearchSpec } from '../search';
import { gid, isoNow, type BulkOperationRec, type RedirectRec } from '../state';
import { productView } from './products';

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  read_products: 'Read products, variants, and collections',
  write_products: 'Modify products, variants, and collections',
  read_content: 'Read pages and blogs',
  write_content: 'Modify pages and blogs',
  read_themes: 'Read themes',
  write_themes: 'Modify themes',
  read_translations: 'Read translations',
  write_translations: 'Modify translations',
  read_locales: 'Read available locales',
  read_discounts: 'Read discounts',
  write_discounts: 'Modify discounts',
  read_files: 'Read files',
  write_files: 'Modify files',
  read_online_store_navigation: 'Read URL redirects and navigation',
  write_online_store_navigation: 'Modify URL redirects and navigation',
  read_publications: 'Read publications',
  write_publications: 'Modify publications',
  read_locations: 'Read locations',
};

export const systemTypes = {
  Shop: {
    id: (_: unknown, __: unknown, ctx: Ctx) => gid('Shop', ctx.state.shop.id),
    url: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.primaryDomainUrl,
    primaryDomain: (_: unknown, __: unknown, ctx: Ctx) => {
      const u = new URL(ctx.state.shop.primaryDomainUrl);
      return { id: gid('Domain', 98_765_432_101), host: u.host, url: ctx.state.shop.primaryDomainUrl, sslEnabled: u.protocol === 'https:' };
    },
    name: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.name,
    email: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.email,
    contactEmail: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.contactEmail,
    description: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.description,
    myshopifyDomain: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.myshopifyDomain,
    currencyCode: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.currencyCode,
    enabledPresentmentCurrencies: (_: unknown, __: unknown, ctx: Ctx) => [ctx.state.shop.currencyCode],
    currencyFormats: (_: unknown, __: unknown, ctx: Ctx) => ({
      moneyFormat: ctx.state.shop.currencyCode === 'EUR' ? '{{amount_with_comma_separator}} €' : '{{amount}}',
      moneyWithCurrencyFormat: `{{amount_with_comma_separator}} ${ctx.state.shop.currencyCode}`,
    }),
    ianaTimezone: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.ianaTimezone,
    timezoneAbbreviation: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.timezoneAbbreviation,
    weightUnit: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.weightUnit,
    taxesIncluded: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.taxesIncluded,
    plan: () => ({ displayName: 'Basic', partnerDevelopment: false, shopifyPlus: false, publicDisplayName: 'Basic' }),
    createdAt: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.createdAt,
    updatedAt: (_: unknown, __: unknown, ctx: Ctx) => ctx.state.shop.updatedAt,
    ...metafieldResolvers((_: unknown, ctx: Ctx) => gid('Shop', ctx.state.shop.id)),
  },
  UrlRedirect: {
    id: (r: RedirectRec) => gid('UrlRedirect', r.id),
  },
  BulkOperation: {
    id: (b: BulkOperationRec) => gid('BulkOperation', b.id),
    status: (b: BulkOperationRec, _: unknown, ctx: Ctx) => bulkStatus(b, ctx),
    type: () => 'QUERY',
    completedAt: (b: BulkOperationRec, _: unknown, ctx: Ctx) => (bulkStatus(b, ctx) === 'COMPLETED' ? b.completedAt : null),
    objectCount: (b: BulkOperationRec, _: unknown, ctx: Ctx) => String(bulkStatus(b, ctx) === 'COMPLETED' ? b.objectCount : 0),
    rootObjectCount: (b: BulkOperationRec, _: unknown, ctx: Ctx) => String(bulkStatus(b, ctx) === 'COMPLETED' ? b.rootObjectCount : 0),
    fileSize: (b: BulkOperationRec, _: unknown, ctx: Ctx) => (bulkStatus(b, ctx) === 'COMPLETED' && b.objectCount ? String(Buffer.byteLength(b.jsonl)) : null),
    url: (b: BulkOperationRec, _: unknown, ctx: Ctx) => (bulkStatus(b, ctx) === 'COMPLETED' && b.objectCount ? `${ctx.state.baseUrl}/__fake/bulk/${b.id}.jsonl` : null),
    partialDataUrl: () => null,
  },
  Job: {
    id: (j: { id: string }) => j.id,
    query: () => ({}),
  },
  Publication: {
    id: (p: { id: number }) => gid('Publication', p.id),
  },
  Location: {
    id: (l: { id: number }) => gid('Location', l.id),
  },
};

function bulkStatus(b: BulkOperationRec, ctx: Ctx): BulkOperationRec['status'] {
  if (b.status === 'CREATED' && b.createdInRequest < ctx.state.requestSeq) return 'COMPLETED';
  return b.status;
}

const redirectSearchSpec: SearchSpec<RedirectRec> = {
  fields: {
    path: { kind: 'keyword', get: (r) => r.path },
    target: { kind: 'keyword', get: (r) => r.target },
    id: { kind: 'number', get: (r) => r.id },
  },
  freeText: (r) => [r.path, r.target],
};

const publications = () => [{ id: ONLINE_STORE_PUBLICATION_ID, name: 'Online Store', autoPublish: false, supportsFuturePublishing: true }];

/** node(id) lookup across all modelled types. */
export function lookupNode(raw: string, ctx: Ctx): any {
  const g = parseGid(raw);
  const s = ctx.state;
  const n = g.num;
  switch (g.type) {
    case 'Product':
      return s.products.has(n) ? productView(s.products.get(n)!) : null;
    case 'ProductVariant':
      return s.variants.has(n) ? { ...s.variants.get(n)!, __typename: 'ProductVariant' } : null;
    case 'Collection':
      return s.collections.has(n) ? { ...s.collections.get(n)!, __typename: 'Collection' } : null;
    case 'Page':
      return s.pages.has(n) ? { ...s.pages.get(n)!, __typename: 'Page' } : null;
    case 'MediaImage':
      return s.media.has(n) ? mediaView(s.media.get(n)!) : null;
    case 'Metafield':
      return s.metafields.has(n) ? metafieldView(s.metafields.get(n)!) : null;
    case 'DiscountCodeNode':
      return s.discounts.has(n) ? { __rec: s.discounts.get(n)!, __typename: 'DiscountCodeNode' } : null;
    case 'OnlineStoreTheme':
      return s.themes.has(n) ? { ...s.themes.get(n)!, files: s.themes.get(n)!.files, __typename: 'OnlineStoreTheme' } : null;
    case 'UrlRedirect':
      return s.redirects.has(n) ? { ...s.redirects.get(n)!, __typename: 'UrlRedirect' } : null;
    case 'BulkOperation':
      return s.bulkOperations.has(n) ? { ...s.bulkOperations.get(n)!, __typename: 'BulkOperation' } : null;
    case 'Shop':
      return n === s.shop.id ? { __typename: 'Shop' } : null;
    case 'Location': {
      const l = s.locations.find((x) => x.id === n);
      return l ? { ...l, __typename: 'Location' } : null;
    }
    case 'Publication': {
      const p = publications().find((x) => x.id === n);
      return p ? { ...p, __typename: 'Publication' } : null;
    }
    case 'ProductOption':
      for (const p of s.products.values()) {
        const idx = p.options.findIndex((o) => o.id === n);
        if (idx >= 0) return { ...p.options[idx], __product: p, __position: idx + 1, __typename: 'ProductOption' };
      }
      return null;
    default:
      return null;
  }
}

export const systemQueries = {
  shop: () => ({}),
  currentAppInstallation: (_: unknown, __: unknown, ctx: Ctx) => ({
    id: gid('AppInstallation', 555_000_000_001),
    accessScopes: [...ctx.options.accessScopes].sort().map((handle) => ({ handle, description: SCOPE_DESCRIPTIONS[handle] ?? handle })),
  }),
  locations: (_: unknown, a: ConnArgs, ctx: Ctx) => paginate(ctx.state.locations, a, ctx, (l) => l.id),
  publications: (_: unknown, a: ConnArgs, ctx: Ctx) => paginate(publications(), a, ctx, (p) => p.id),
  node: (_: unknown, a: { id: string }, ctx: Ctx) => lookupNode(a.id, ctx),
  nodes: (_: unknown, a: { ids: string[] }, ctx: Ctx) => {
    if (a.ids.length > 250) throw new Error('nodes: too many ids (maximum is 250)');
    return a.ids.map((id) => lookupNode(id, ctx));
  },
  job: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const g = parseGid(a.id);
    return ctx.state.jobs.has(g.id) ? { id: a.id, done: ctx.state.jobs.get(g.id)!.createdInRequest < ctx.state.requestSeq } : null;
  },
  urlRedirects: (_: unknown, a: ConnArgs & { query?: string; sortKey?: string }, ctx: Ctx, info: ResolveInfo) => {
    let list = [...ctx.state.redirects.values()];
    list = a.sortKey === 'PATH' ? sortBy(list, (r) => r.path, (r) => r.id) : sortBy(list, (r) => r.id, (r) => r.id);
    return paginate(search(list, a.query, redirectSearchSpec, ctx, info), a, ctx, (r) => r.id);
  },
  urlRedirect: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'UrlRedirect');
    parseGid(a.id);
    return id !== null ? (ctx.state.redirects.get(id) ?? null) : null;
  },
  currentBulkOperation: (_: unknown, __: unknown, ctx: Ctx) => {
    const list = [...ctx.state.bulkOperations.values()];
    return list.length ? list[list.length - 1] : null;
  },
  bulkOperation: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'BulkOperation');
    parseGid(a.id);
    return id !== null ? (ctx.state.bulkOperations.get(id) ?? null) : null;
  },
};

function validateRedirect(input: { path?: string | null; target?: string | null }, ctx: Ctx, exceptId: number | null, create: boolean): UE[] {
  const errors: UE[] = [];
  const failCode = create ? 'CREATE_FAILED' : 'UPDATE_FAILED';
  if (create || input.path !== undefined) {
    if (!input.path) errors.push(ue(['urlRedirect', 'path'], "Path can't be blank", failCode));
    else if (!input.path.startsWith('/')) errors.push(ue(['urlRedirect', 'path'], 'Path must start with /', failCode));
    else if ([...ctx.state.redirects.values()].some((r) => r.path === input.path && r.id !== exceptId)) errors.push(ue(['urlRedirect', 'path'], 'Path has already been taken', failCode));
  }
  if (create || input.target !== undefined) {
    if (!input.target) errors.push(ue(['urlRedirect', 'target'], "Target can't be blank", failCode));
    else if (input.path && input.target === input.path) errors.push(ue(['urlRedirect', 'target'], "Target can't be the same as path", failCode));
  }
  return errors;
}

/** Turns the result of a bulk query into Shopify's JSONL format (nested connections become lines with __parentId). */
export function toJsonl(data: Record<string, unknown>): { lines: string[]; roots: number } {
  const lines: string[] = [];
  let roots = 0;
  const isConn = (v: unknown): v is { edges?: { node: unknown }[]; nodes?: unknown[] } =>
    Boolean(v && typeof v === 'object' && (Array.isArray((v as any).edges) || Array.isArray((v as any).nodes)));
  const nodesOf = (c: { edges?: { node: unknown }[]; nodes?: unknown[] }) => (c.nodes ?? c.edges!.map((e) => e.node)) as Record<string, unknown>[];
  const emit = (node: Record<string, unknown>, parentId: unknown) => {
    const copy: Record<string, unknown> = {};
    const children: Record<string, unknown>[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (isConn(v)) children.push(...nodesOf(v));
      else copy[k] = v;
    }
    if (parentId !== undefined) copy.__parentId = parentId;
    lines.push(JSON.stringify(copy));
    for (const c of children) if (c && typeof c === 'object') emit(c, node.id);
  };
  for (const v of Object.values(data)) {
    if (isConn(v)) {
      for (const n of nodesOf(v)) {
        roots++;
        emit(n, undefined);
      }
    } else if (v && typeof v === 'object') {
      roots++;
      emit(v as Record<string, unknown>, undefined);
    }
  }
  return { lines, roots };
}

export const systemMutations = {
  urlRedirectCreate: (_: unknown, a: { urlRedirect: { path?: string; target?: string } }, ctx: Ctx) => {
    const errors = validateRedirect(a.urlRedirect, ctx, null, true);
    if (errors.length) return { urlRedirect: null, userErrors: errors };
    const id = ctx.state.nextId('UrlRedirect');
    const rec = { id, path: a.urlRedirect.path!, target: a.urlRedirect.target! };
    ctx.state.redirects.set(id, rec);
    return { urlRedirect: rec, userErrors: [] };
  },
  urlRedirectUpdate: (_: unknown, a: { id: string; urlRedirect: { path?: string; target?: string } }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'UrlRedirect');
    const rec = id !== null ? ctx.state.redirects.get(id) : undefined;
    if (!rec) return { urlRedirect: null, userErrors: [ue(['id'], 'Redirect does not exist', 'DOES_NOT_EXIST')] };
    const errors = validateRedirect({ path: a.urlRedirect.path, target: a.urlRedirect.target ?? (a.urlRedirect.path !== undefined ? rec.target : undefined) }, ctx, rec.id, false);
    if (errors.length) return { urlRedirect: null, userErrors: errors };
    if (a.urlRedirect.path) rec.path = a.urlRedirect.path;
    if (a.urlRedirect.target) rec.target = a.urlRedirect.target;
    return { urlRedirect: rec, userErrors: [] };
  },
  urlRedirectDelete: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'UrlRedirect');
    if (id === null || !ctx.state.redirects.has(id)) return { deletedUrlRedirectId: null, userErrors: [ue(['id'], 'Redirect does not exist', 'DOES_NOT_EXIST')] };
    ctx.state.redirects.delete(id);
    return { deletedUrlRedirectId: gid('UrlRedirect', id), userErrors: [] };
  },

  bulkOperationRunQuery: async (_: unknown, a: { query: string }, ctx: Ctx) => {
    const running = [...ctx.state.bulkOperations.values()].find((b) => bulkStatus(b, ctx) === 'CREATED' || bulkStatus(b, ctx) === 'RUNNING');
    if (running) return { bulkOperation: null, userErrors: [ue(null, `A bulk query operation for this app and shop is already in progress: ${gid('BulkOperation', running.id)}.`, 'OPERATION_IN_PROGRESS')] };
    if (!ctx.runBulkQuery) throw new Error('bulk operations are not wired');
    const res = await ctx.runBulkQuery(a.query);
    if (res.errors.length || !res.data) {
      return { bulkOperation: null, userErrors: res.errors.map((m) => ue(['query'], m, 'INVALID')) };
    }
    const top = Object.values(res.data);
    if (!top.some((v) => v && typeof v === 'object' && ('edges' in (v as object) || 'nodes' in (v as object)))) {
      return { bulkOperation: null, userErrors: [ue(['query'], 'Bulk queries must contain at least one connection.', 'INVALID')] };
    }
    const { lines, roots } = toJsonl(res.data);
    const now = isoNow();
    const rec: BulkOperationRec = {
      id: ctx.state.nextId('BulkOperation'),
      query: a.query,
      status: 'CREATED',
      createdAt: now,
      completedAt: now,
      createdInRequest: ctx.state.requestSeq,
      jsonl: lines.length ? `${lines.join('\n')}\n` : '',
      objectCount: lines.length,
      rootObjectCount: roots,
      errorCode: null,
    };
    ctx.state.bulkOperations.set(rec.id, rec);
    return { bulkOperation: rec, userErrors: [] };
  },
  bulkOperationCancel: (_: unknown, a: { id: string }, ctx: Ctx) => {
    const id = safeIdOf(a.id, 'BulkOperation');
    const b = id !== null ? ctx.state.bulkOperations.get(id) : undefined;
    if (!b) return { bulkOperation: null, userErrors: [ue(['id'], 'Bulk operation does not exist', 'INVALID')] };
    const st = bulkStatus(b, ctx);
    if (st !== 'CREATED' && st !== 'RUNNING') return { bulkOperation: b, userErrors: [ue(null, `A bulk operation cannot be canceled when it is ${st.toLowerCase()}`, 'INVALID')] };
    b.status = 'CANCELED';
    return { bulkOperation: b, userErrors: [] };
  },
};
