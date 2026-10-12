/**
 * Local fake of the Shopify Admin GraphQL API.
 *
 *   npx tsx test-support/shopify-fake/server.ts --port 3601
 *
 * or in tests:
 *
 *   const fake = await startFakeShopify();
 *   fetch(`${fake.graphqlUrl}`, { headers: { 'X-Shopify-Access-Token': fake.token }, ... })
 *   await fake.close();
 *
 * See README.md in this directory for coverage and deviations.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { calculateRequestedCost, SINGLE_QUERY_MAX_COST, ThrottleBucket } from './cost';
import type { Ctx, FakeOptions } from './context';
import { buildSchema, Engine, GraphQLError, type ScalarCoercer } from './graphql';
import { buildResolvers, DEFAULT_ACCESS_SCOPES } from './resolvers';
import { SDL } from './schema';
import { FakeShopifyState } from './state';

export const LATEST_API_VERSION = '2026-10';
export const SUPPORTED_API_VERSIONS = ['2025-10', '2026-01', '2026-04', '2026-07', '2026-10', 'unstable'];
export const DEFAULT_TOKEN = 'shpat_fake_haus_holm_00000000000000000000';
/** Zugang einer Dev-Dashboard-App für den Client-Credentials-Grant (POST /admin/oauth/access_token) */
export const DEFAULT_CLIENT_ID = 'fake_client_id_haus_holm';
export const DEFAULT_CLIENT_SECRET = 'fake_client_secret_haus_holm_0000';

export interface StartFakeShopifyOptions {
  /** 0 (default) picks a free port */
  port?: number;
  host?: string;
  token?: string;
  /** seed the "Haus Holm" demo data (default true) */
  seed?: boolean;
  /** access scopes granted to the fake app (default: everything except customers/orders) */
  accessScopes?: string[];
  mediaProcessing?: FakeOptions['mediaProcessing'];
  themeWriteAccess?: FakeOptions['themeWriteAccess'];
  autoPublish?: boolean;
  throttle?: { maximumAvailable?: number; restoreRate?: number };
  /** log every request to stderr */
  log?: boolean;
  /** client credentials grant: app credentials, token lifetime in seconds (Shopify: 86399), shopPermitted=false → shop_not_permitted */
  clientCredentials?: { clientId?: string; clientSecret?: string; expiresIn?: number; shopPermitted?: boolean };
}

export interface FailNextOptions {
  status: number;
  /** seconds; sent as Retry-After header (Shopify sends e.g. "2.0") */
  retryAfter?: number;
  body?: unknown;
  /** how many subsequent GraphQL requests fail (default 1) */
  times?: number;
}

export interface FakeShopify {
  /** base URL, e.g. http://127.0.0.1:3601 */
  url: string;
  /** GraphQL endpoint for the latest API version */
  graphqlUrl: string;
  apiVersion: string;
  shopDomain: string;
  token: string;
  state: FakeShopifyState;
  throttle: ThrottleBucket;
  options: FakeOptions;
  clientId: string;
  clientSecret: string;
  /** tokens issued by the client credentials grant (token → expiry in ms) */
  appTokens: Map<string, number>;
  /** lets all issued app tokens expire (next request with one → HTTP 401) */
  expireAppTokens(): void;
  /** makes the next GraphQL request(s) fail with the given HTTP status */
  failNext(opts: FailNextOptions): void;
  /** re-seeds the store, clears the request log, failure queue and throttle */
  reset(opts?: { seed?: boolean }): void;
  /** convenience: POSTs a GraphQL request with the right token */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>, opts?: { apiVersion?: string; token?: string }): Promise<{ status: number; headers: Headers; body: T }>;
  close(): Promise<void>;
}

const DEFAULT_FAIL_BODIES: Record<number, unknown> = {
  401: { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' },
  402: { errors: 'Unavailable Shop' },
  403: { errors: 'Forbidden' },
  404: { errors: 'Not Found' },
  423: { errors: 'Locked' },
  429: { errors: 'Exceeded 2 calls per second for api client. Reduce request rates to resume uninterrupted service.' },
  500: { errors: 'Internal Server Error' },
  502: { errors: 'Bad Gateway' },
  503: { errors: 'Service Unavailable' },
};

function fmtDate(v: unknown): string {
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new Error(`Could not coerce value ${JSON.stringify(v)} to DateTime`);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const SCALARS: Record<string, ScalarCoercer> = {
  Money: {
    input: (v) => {
      if ((typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) || (typeof v === 'number' && Number.isFinite(v))) return String(v).trim();
      throw new Error(`Could not coerce value ${JSON.stringify(v)} to Money`);
    },
    output: (v) => Number(v).toFixed(2),
  },
  Decimal: {
    input: (v) => {
      if ((typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) || (typeof v === 'number' && Number.isFinite(v))) return String(v).trim();
      throw new Error(`Could not coerce value ${JSON.stringify(v)} to Decimal`);
    },
    output: (v) => {
      const n = Number(v);
      return Number.isInteger(n) ? `${n}.0` : String(n);
    },
  },
  DateTime: {
    input: (v) => {
      if (typeof v !== 'string') throw new Error(`Could not coerce value ${JSON.stringify(v)} to DateTime`);
      return fmtDate(v);
    },
    output: (v) => String(v),
  },
  Date: {
    input: (v) => {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`Could not coerce value ${JSON.stringify(v)} to Date`);
      return v;
    },
    output: (v) => String(v),
  },
  UnsignedInt64: {
    input: (v) => {
      const s = String(v);
      if (!/^\d+$/.test(s)) throw new Error(`Could not coerce value ${JSON.stringify(v)} to UnsignedInt64`);
      return s;
    },
    output: (v) => String(v),
  },
  URL: {
    input: (v) => {
      if (typeof v !== 'string') throw new Error(`Could not coerce value ${JSON.stringify(v)} to URL`);
      return v;
    },
    output: (v) => String(v),
  },
  HTML: {
    input: (v) => {
      if (typeof v !== 'string') throw new Error(`Could not coerce value ${JSON.stringify(v)} to HTML`);
      return v;
    },
    output: (v) => String(v),
  },
  FormattedString: { input: (v) => String(v), output: (v) => String(v) },
  Color: { input: (v) => String(v), output: (v) => String(v) },
  JSON: { input: (v) => v, output: (v) => v },
};

let cachedSchema: ReturnType<typeof buildSchema> | null = null;

export function createEngine(): Engine {
  cachedSchema ??= buildSchema(SDL);
  return new Engine({
    schema: cachedSchema,
    resolvers: buildResolvers(cachedSchema),
    scalars: SCALARS,
    opaqueDirective: 'opaque',
    formatInternalError: (err, path) => {
      const requestId = randomUUID();
      return new GraphQLError(`Internal error. Looks like something went wrong on our end.\nRequest ID: ${requestId} (include this in support requests).`, {
        path,
        extensions: { code: 'INTERNAL_SERVER_ERROR', requestId, fakeDetail: err instanceof Error ? err.message : String(err) },
      });
    },
    onObject: (typeName, context) => {
      const c = context as Ctx & { actualCost?: number };
      if (typeName.endsWith('Edge') || typeName === 'PageInfo') return;
      c.actualCost = (c.actualCost ?? 0) + (typeName.endsWith('Connection') ? 2 : 1);
    },
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'X-Request-Id': randomUUID(), ...headers });
  res.end(payload);
}

/** Extracts the "file" part of a multipart/form-data body. */
function multipartFile(body: Buffer, contentType: string): { data: Buffer; contentType: string | null } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from(`--${m[1] ?? m[2]}`);
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = body.subarray(start + boundary.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      if (/name="file"/i.test(headers)) {
        const ct = /content-type:\s*([^\r\n]+)/i.exec(headers);
        return { data: part.subarray(headerEnd + 4), contentType: ct ? ct[1].trim() : null };
      }
    }
    start = next;
  }
  return null;
}

export async function startFakeShopify(opts: StartFakeShopifyOptions = {}): Promise<FakeShopify> {
  const token = opts.token ?? DEFAULT_TOKEN;
  const state = new FakeShopifyState({ seed: opts.seed ?? true });
  const options: FakeOptions = {
    accessScopes: new Set(opts.accessScopes ?? DEFAULT_ACCESS_SCOPES),
    mediaProcessing: opts.mediaProcessing ?? 'async',
    themeWriteAccess: opts.themeWriteAccess ?? 'all',
    autoPublish: opts.autoPublish ?? false,
    appNamespace: 'app--5550001',
  };
  const throttle = new ThrottleBucket(opts.throttle);
  const engine = createEngine();
  let failQueue: FailNextOptions[] = [];
  const cc = { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET, expiresIn: 86399, shopPermitted: true, ...opts.clientCredentials };
  const appTokens = new Map<string, number>();
  const tokenValid = (t: unknown) => typeof t === 'string' && (t === token || (appTokens.get(t) ?? 0) > Date.now());

  const runGraphQL = async (body: { query?: unknown; variables?: unknown; operationName?: unknown }, apiVersion: string): Promise<{ status: number; json: unknown }> => {
    if (typeof body.query !== 'string' || !body.query.trim()) return { status: 400, json: { errors: { query: 'Required parameter missing or invalid' } } };
    const prep = engine.prepare(body.query, body.variables, typeof body.operationName === 'string' ? body.operationName : null);
    if (!prep.ok) return { status: 200, json: { errors: prep.errors.map((e) => e.toJSON()) } };
    const requestedQueryCost = calculateRequestedCost(engine, prep.prepared);
    if (requestedQueryCost > SINGLE_QUERY_MAX_COST) {
      return {
        status: 200,
        json: {
          errors: [
            {
              message: `Query cost is ${requestedQueryCost}, which exceeds the single query max cost limit (${SINGLE_QUERY_MAX_COST}).\n\nSee https://shopify.dev/concepts/about-apis/rate-limits for more information on how the\ncost of a query is calculated.\n\nTo query larger amounts of data with fewer limits, bulk operations should be used instead.\nSee https://shopify.dev/tutorials/perform-bulk-operations-with-admin-api for usage details.\n`,
              extensions: { code: 'MAX_COST_EXCEEDED', cost: requestedQueryCost, maxCost: SINGLE_QUERY_MAX_COST },
            },
          ],
          extensions: { cost: { requestedQueryCost, actualQueryCost: null, throttleStatus: throttle.status() } },
        },
      };
    }
    if (!throttle.tryConsume(requestedQueryCost)) {
      return {
        status: 200,
        json: {
          errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED', documentation: 'https://shopify.dev/api/usage/rate-limits' } }],
          extensions: { cost: { requestedQueryCost, actualQueryCost: null, throttleStatus: throttle.status() } },
        },
      };
    }
    const ctx: Ctx & { actualCost?: number } = {
      state,
      options,
      bulk: false,
      searchExtensions: [],
      runBulkQuery: async (query: string) => {
        const p = engine.prepare(query, {}, null);
        if (!p.ok) return { errors: p.errors.map((e) => e.message), data: null };
        if (p.prepared.operation.operation !== 'query') return { errors: ['Bulk operations only support queries.'], data: null };
        const inner = await engine.execute(p.prepared, { ...ctx, bulk: true, searchExtensions: [] });
        return { errors: inner.errors.map((e) => e.message), data: inner.data };
      },
    };
    const result = await engine.execute(prep.prepared, ctx);
    const actual = prep.prepared.operation.operation === 'mutation' ? requestedQueryCost : Math.min(requestedQueryCost, ctx.actualCost ?? 0);
    throttle.refund(requestedQueryCost - actual);
    const json: Record<string, unknown> = {};
    if (result.errors.length) json.errors = result.errors.map((e) => e.toJSON());
    json.data = result.data;
    const extensions: Record<string, unknown> = { cost: { requestedQueryCost, actualQueryCost: actual, throttleStatus: throttle.status() } };
    if (ctx.searchExtensions.length) extensions.search = ctx.searchExtensions;
    json.extensions = extensions;
    void apiVersion;
    return { status: 200, json };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ---- fake control endpoints (unauthenticated, local only)
    if (path === '/__fake/health') return sendJson(res, 200, { ok: true });
    if (path === '/__fake/state' && method === 'GET') return sendJson(res, 200, state.snapshot());
    if (path === '/__fake/requests' && method === 'GET') return sendJson(res, 200, state.requestLog);
    if (path === '/__fake/reset' && method === 'POST') {
      const body = await readBody(req);
      const o = body.length ? JSON.parse(body.toString('utf8')) : {};
      fake.reset({ seed: o.seed ?? true });
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/__fake/fail' && method === 'POST') {
      const o = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      fake.failNext(o);
      return sendJson(res, 200, { ok: true, queued: failQueue.length });
    }
    if (path === '/__fake/throttle' && method === 'POST') {
      const o = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (typeof o.maximumAvailable === 'number') throttle.maximumAvailable = o.maximumAvailable;
      if (typeof o.restoreRate === 'number') throttle.restoreRate = o.restoreRate;
      if (typeof o.currentlyAvailable === 'number') throttle.currentlyAvailable = o.currentlyAvailable;
      return sendJson(res, 200, throttle.status());
    }

    // ---- staged uploads (stand-in for Google Cloud Storage)
    const staged = /^\/__fake\/staged-uploads\/([0-9a-f-]+)$/.exec(path);
    if (staged) {
      const rec = state.stagedUploads.get(staged[1]);
      if (!rec) return sendJson(res, 404, { errors: 'NoSuchUpload' });
      if (method === 'PUT') {
        rec.body = await readBody(req);
        rec.contentType = req.headers['content-type'] ?? null;
        res.writeHead(200).end();
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const file = multipartFile(body, String(req.headers['content-type'] ?? ''));
        if (!file) return sendJson(res, 400, { errors: 'multipart/form-data with a "file" field expected' });
        rec.body = file.data;
        rec.contentType = file.contentType;
        res.writeHead(201, { 'Content-Type': 'application/xml' }).end(`<?xml version='1.0' encoding='UTF-8'?><PostResponse><Location>${state.baseUrl}${path}</Location><Key>${rec.filename}</Key></PostResponse>`);
        return;
      }
      if (method === 'GET' && rec.body) {
        res.writeHead(200, { 'Content-Type': rec.mimeType }).end(rec.body);
        return;
      }
      return sendJson(res, 405, { errors: 'Method Not Allowed' });
    }
    const cdn = /^\/__fake\/cdn\/([0-9a-f-]+)\/[^/]+$/.exec(path);
    if (cdn && method === 'GET') {
      const rec = state.stagedUploads.get(cdn[1]);
      if (!rec?.body) return sendJson(res, 404, { errors: 'Not Found' });
      res.writeHead(200, { 'Content-Type': rec.mimeType, 'Content-Length': rec.body.length }).end(rec.body);
      return;
    }
    const bulk = /^\/__fake\/bulk\/(\d+)\.jsonl$/.exec(path);
    if (bulk && method === 'GET') {
      const rec = state.bulkOperations.get(Number(bulk[1]));
      if (!rec) return sendJson(res, 404, { errors: 'Not Found' });
      res.writeHead(200, { 'Content-Type': 'application/jsonl' }).end(rec.jsonl);
      return;
    }

    // ---- Admin API
    const isAdmin = path.startsWith('/admin/');
    if (isAdmin && failQueue.length) {
      const f = failQueue[0];
      f.times = (f.times ?? 1) - 1;
      if (f.times <= 0) failQueue.shift();
      const headers: Record<string, string> = {};
      if (f.retryAfter !== undefined) headers['Retry-After'] = Number(f.retryAfter).toFixed(1);
      return sendJson(res, f.status, f.body ?? DEFAULT_FAIL_BODIES[f.status] ?? { errors: `HTTP ${f.status}` }, headers);
    }
    if (path === '/admin/oauth/access_token' && method === 'POST') {
      // Client-Credentials-Grant (Apps aus dem Dev Dashboard). Form-urlencoded wie in der Shopify-Doku, JSON wird auch angenommen.
      const raw = (await readBody(req)).toString('utf8');
      const ctype = String(req.headers['content-type'] ?? '');
      let p: Record<string, unknown> = {};
      try {
        p = ctype.includes('application/json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        return sendJson(res, 400, { error: 'invalid_request', error_description: 'Malformed request body' });
      }
      if (p.grant_type !== 'client_credentials') return sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'grant_type must be client_credentials' });
      if (p.client_id !== cc.clientId || p.client_secret !== cc.clientSecret) return sendJson(res, 400, { error: 'invalid_client', error_description: 'Client authentication failed' });
      if (!cc.shopPermitted) return sendJson(res, 400, { error: 'shop_not_permitted', error_description: 'The app and the shop must belong to the same organization' });
      const issued = randomUUID().replace(/-/g, '');
      appTokens.set(issued, Date.now() + cc.expiresIn * 1000);
      return sendJson(res, 200, { access_token: issued, scope: [...options.accessScopes].sort().join(','), expires_in: cc.expiresIn });
    }
    if (isAdmin && !tokenValid(req.headers['x-shopify-access-token'])) {
      return sendJson(res, 401, DEFAULT_FAIL_BODIES[401]);
    }
    if (path === '/admin/oauth/access_scopes.json' && method === 'GET') {
      return sendJson(res, 200, { access_scopes: [...options.accessScopes].sort().map((handle) => ({ handle })) });
    }
    const gql = /^\/admin\/api\/([^/]+)\/graphql\.json$/.exec(path);
    if (!gql) return sendJson(res, 404, { errors: 'Not Found' });
    if (method !== 'POST') return sendJson(res, 405, { errors: 'Method Not Allowed' }, { Allow: 'POST' });
    const requested = gql[1];
    if (!/^(\d{4}-\d{2}|unstable)$/.test(requested)) return sendJson(res, 404, { errors: 'Not Found' });
    const served = SUPPORTED_API_VERSIONS.includes(requested) ? requested : SUPPORTED_API_VERSIONS[0];

    const raw = await readBody(req);
    let body: { query?: unknown; variables?: unknown; operationName?: unknown };
    const ctype = String(req.headers['content-type'] ?? '');
    if (ctype.includes('application/graphql')) body = { query: raw.toString('utf8') };
    else {
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { errors: { query: 'Required parameter missing or invalid' } }, { 'X-Shopify-API-Version': served });
      }
    }
    state.requestSeq++;
    const seq = state.requestSeq;
    const { status, json } = await runGraphQL(body, served);
    state.requestLog.push({
      seq,
      at: new Date().toISOString(),
      apiVersion: served,
      operationName: typeof body.operationName === 'string' ? body.operationName : null,
      query: typeof body.query === 'string' ? body.query : '',
      variables: body.variables ?? null,
      status,
      response: json,
    });
    if (opts.log) console.error(`[shopify-fake] #${seq} ${status} ${typeof body.query === 'string' ? body.query.replace(/\s+/g, ' ').slice(0, 120) : ''}`);
    return sendJson(res, status, json, { 'X-Shopify-API-Version': served });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[shopify-fake] unhandled error', err);
      if (!res.headersSent) sendJson(res, 500, { errors: 'Internal Server Error' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  const url = `http://${host}:${addr.port}`;
  state.baseUrl = url;

  const fake: FakeShopify = {
    url,
    graphqlUrl: `${url}/admin/api/${LATEST_API_VERSION}/graphql.json`,
    apiVersion: LATEST_API_VERSION,
    shopDomain: state.shop.myshopifyDomain,
    token,
    clientId: cc.clientId,
    clientSecret: cc.clientSecret,
    appTokens,
    expireAppTokens() {
      for (const k of appTokens.keys()) appTokens.set(k, 0);
    },
    state,
    throttle,
    options,
    failNext(o) {
      failQueue.push({ ...o, times: o.times ?? 1 });
    },
    reset(o = {}) {
      state.reset(o.seed ?? true);
      failQueue = [];
      appTokens.clear();
      throttle.reset();
    },
    async graphql<T>(query: string, variables?: Record<string, unknown>, o: { apiVersion?: string; token?: string } = {}) {
      const res = await fetch(`${url}/admin/api/${o.apiVersion ?? LATEST_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': o.token ?? token },
        body: JSON.stringify({ query, variables }),
      });
      return { status: res.status, headers: res.headers, body: (await res.json()) as T };
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
  return fake;
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv: string[]): StartFakeShopifyOptions {
  const out: StartFakeShopifyOptions = { port: 3601, log: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--port') out.port = Number(val());
    else if (a === '--host') out.host = val();
    else if (a === '--token') out.token = val();
    else if (a === '--no-seed') out.seed = false;
    else if (a === '--scopes') out.accessScopes = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--media-immediate') out.mediaProcessing = 'immediate';
    else if (a === '--auto-publish') out.autoPublish = true;
    else if (a === '--quiet') out.log = false;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: npx tsx test-support/shopify-fake/server.ts [--port 3601] [--host 127.0.0.1] [--token shpat_...] [--no-seed] [--scopes a,b] [--media-immediate] [--auto-publish] [--quiet]');
      process.exit(0);
    }
  }
  return out;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  const fake = await startFakeShopify(parseArgs(process.argv.slice(2)));
  console.log(`Shopify fake (Admin GraphQL ${fake.apiVersion}) listening on ${fake.url}`);
  console.log(`  GraphQL:  POST ${fake.graphqlUrl}`);
  console.log(`  Header:   X-Shopify-Access-Token: ${fake.token}`);
  console.log(`  Shop:     ${fake.state.shop.name} (${fake.shopDomain})`);
  console.log(`  Control:  GET ${fake.url}/__fake/state · POST ${fake.url}/__fake/reset · POST ${fake.url}/__fake/fail`);
  const stop = () => {
    void fake.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
