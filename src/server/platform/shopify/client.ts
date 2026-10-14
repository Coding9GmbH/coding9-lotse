import 'server-only';
// Shopify: privileged Admin GraphQL client. Stays in the adapter, is NEVER given to the AI.
// Access: static Admin API token (existing custom app from "Develop apps") or client ID + client secret of an app from the
// Dev Dashboard (client credentials grant: token valid approx. 24 h, cached, renewed before expiry and once on HTTP 401).
// Cost-based throttling (extensions.cost.throttleStatus, THROTTLED), HTTP 429 with Retry-After, retry on 5xx (reads only),
// timeout, error texts without token/secret.
import { activeAuthMode } from '@/lib/platforms';
import { getSettings, type Settings } from '../../settings';
import { log } from '../../log';
import { sleep as sleepReal } from '../../retry';

/** API version tested by Lotse (fake 2026-10, current stable version per shopify.dev) */
export const DEFAULT_API_VERSION = '2026-10';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const MYSHOPIFY = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export interface ShopifyConf {
  origin: string; domain: string; apiVersion: string; publicUrl: string; endpoint: string;
  /** token = static Admin API token; app = client credentials grant (default: token if one is present) */
  auth?: 'token' | 'app';
  token?: string; clientId?: string; clientSecret?: string;
}

/** Shop domain → base URL of the Admin API. Allowed: *.myshopify.com, for local tests also http://127.0.0.1:port */
export function shopifyOrigin(raw: string): string {
  const v = String(raw ?? '').trim().replace(/\/+$/, '');
  if (!v) throw new Error('Shopify: Shop-Domain fehlt (Einstellungen → Shop verbinden).');
  if (LOCAL.test(v)) return v;
  const host = v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (!MYSHOPIFY.test(host)) throw new Error(`Shopify: „${v.slice(0, 80)}“ ist keine myshopify.com-Adresse (z. B. mein-shop.myshopify.com).`);
  return `https://${host}`;
}
export function shopifyConf(g: Pick<Settings, 'shopify'> = getSettings()): ShopifyConf {
  const c = g.shopify, origin = shopifyOrigin(c.storeDomain ?? ''), apiVersion = (c.apiVersion || DEFAULT_API_VERSION).trim();
  if (!/^(\d{4}-(01|04|07|10)|unstable)$/.test(apiVersion)) throw new Error(`Shopify: API-Version „${apiVersion}“ ungültig (z. B. ${DEFAULT_API_VERSION}).`);
  const base = { origin, domain: origin.replace(/^https?:\/\//, ''), apiVersion, publicUrl: (c.publicUrl ?? '').replace(/\/+$/, ''), endpoint: `${origin}/admin/api/${apiVersion}/graphql.json` };
  if (activeAuthMode('shopify', c) === 'token' && c.accessToken) return { ...base, auth: 'token', token: c.accessToken };
  if (c.clientId?.trim() && c.clientSecret) return { ...base, auth: 'app', clientId: c.clientId.trim(), clientSecret: c.clientSecret };
  throw new Error('Shopify: Zugang fehlt: Client-ID und Client-Secret der App (Dev Dashboard) oder Admin-API-Zugriffstoken (Einstellungen → Shop verbinden).');
}

export class ShopifyError extends Error {
  constructor(msg: string, public status?: number, public code?: string) { super(msg); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;
interface Throttle { max: number; available: number; restoreRate: number; at: number }
export interface ClientOpts { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; maxRetries?: number }
/** Like Magento and OpenMage: LOTSE_SHOP_TIMEOUT_MS, at least 5s, otherwise 60s. */
export const shopTimeoutMs = (raw = process.env.LOTSE_SHOP_TIMEOUT_MS) => Math.max(5_000, parseInt(raw ?? '', 10) || 60_000);

const isMutation = (q: string) => /^\s*mutation\b/.test(q.replace(/#[^\n]*/g, ''));
const errText = (errors: { message?: string; extensions?: { code?: string } }[]) => errors.map(e => e.message ?? e.extensions?.code ?? 'Fehler').join('; ').slice(0, 600);

/** userErrors (or mediaUserErrors) of a mutation result → error text or null */
export function userErrorsOf(payload: Json | null | undefined): string | null {
  const list = [...(payload?.userErrors ?? []), ...(payload?.mediaUserErrors ?? [])] as { field?: string[] | null; message: string; code?: string }[];
  return list.length ? list.map(e => `${e.field?.length ? `${e.field.join('.')}: ` : ''}${e.message}`).join('; ') : null;
}

const authOf = (c: ShopifyConf): 'token' | 'app' => c.auth ?? (c.token ? 'token' : 'app');

export class ShopifyClient {
  private bucket: Throttle | null = null;
  private costs = new Map<string, number>(); // last requested cost per query (estimate for throttling)
  // Token from the client credentials grant: true private fields (never show up in any JSON/log of the object)
  #access: { key: string; token: string; until: number } | null = null;
  #pending: Promise<string> | null = null;
  #issued: string[] = []; // recently fetched tokens (for redaction in error texts)
  constructor(private conf: () => ShopifyConf, private opts: ClientOpts = {}) {}

  get base() { return this.conf().origin; }
  get apiVersion() { return this.conf().apiVersion; }
  /** Remove token and secret from texts (error messages) */
  private clean(t: string) { for (const v of this.secrets()) t = t.split(v).join('•••'); return t; }
  private secrets(): string[] {
    let c: Partial<ShopifyConf> = {}; try { c = this.conf(); } catch { /* not configured */ }
    return [c.token, c.clientSecret, ...this.#issued].filter((v): v is string => !!v && v.length > 3);
  }

  /** Access token: static or via client credentials grant (cached; force = fetch anew, e.g. after HTTP 401) */
  private async accessToken(c: ShopifyConf, force = false): Promise<string> {
    if (authOf(c) === 'token') return c.token ?? '';
    const key = `${c.origin}\n${c.clientId}\n${c.clientSecret}`; // change of shop/app/secret = new token
    if (force && this.#access?.key === key) this.#access = null;
    if (this.#access?.key === key && Date.now() < this.#access.until) return this.#access.token;
    this.#pending ??= this.fetchToken(c, key).finally(() => { this.#pending = null; });
    return this.#pending;
  }
  private async fetchToken(c: ShopifyConf, key: string): Promise<string> {
    const f = this.opts.fetch ?? fetch, sleep = this.opts.sleep ?? sleepReal, url = `${c.origin}/admin/oauth/access_token`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await f(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId ?? '', client_secret: c.clientSecret ?? '' }).toString(), signal: AbortSignal.timeout(this.opts.timeoutMs ?? shopTimeoutMs()) });
      } catch (e) {
        if (attempt < 2) { await sleep(500 * 2 ** attempt); continue; }
        throw new ShopifyError(this.clean(`Shopify nicht erreichbar (${c.domain}): ${e instanceof Error ? e.message : String(e)}`));
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { const ra = parseFloat(res.headers.get('retry-after') ?? ''); await sleep(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt); continue; }
      let body: Json = {}; try { body = JSON.parse(await res.text()); } catch { /* not JSON */ }
      if (!res.ok || typeof body.access_token !== 'string' || !body.access_token) throw new ShopifyError(this.clean(tokenMessage(res.status, body, c)), res.status, typeof body.error === 'string' ? body.error : 'TOKEN');
      const token: string = body.access_token, ttl = Number(body.expires_in) > 0 ? Number(body.expires_in) : 86_399;
      this.#issued = [token, ...this.#issued].slice(0, 4);
      this.#access = { key, token, until: Date.now() + Math.max(ttl / 2, ttl - 600) * 1000 }; // renew 10 minutes before expiry
      return token;
    }
  }

  /** Wait time in ms until the cost bucket (leaky bucket per throttleStatus) has `need` points */
  private budgetWait(need: number): number {
    const b = this.bucket; if (!b) return 0;
    const avail = Math.min(b.max, b.available + ((Date.now() - b.at) / 1000) * b.restoreRate);
    return avail >= need ? 0 : Math.min(20_000, Math.ceil(((need - avail) / Math.max(1, b.restoreRate)) * 1000));
  }
  private async waitForBudget(need: number) { const ms = this.budgetWait(need); if (ms) await (this.opts.sleep ?? sleepReal)(ms); }

  /** Run GraphQL; returns data, throws on HTTP errors and top-level errors */
  async gql<T = Json>(query: string, variables?: Json): Promise<T> {
    const c = this.conf(), f = this.opts.fetch ?? fetch, sleep = this.opts.sleep ?? sleepReal, max = this.opts.maxRetries ?? 5, write = isMutation(query);
    let throttled = 0, renewed = false; // throttled requests were not executed: retry generously (bucket refills at restoreRate)
    for (let attempt = 0; ; attempt++) {
      await this.waitForBudget(this.costs.get(query) ?? 50);
      const token = await this.accessToken(c);
      let res: Response;
      try {
        res = await f(c.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': token }, body: JSON.stringify({ query, variables: variables ?? {} }), signal: AbortSignal.timeout(this.opts.timeoutMs ?? shopTimeoutMs()) });
      } catch (e) {
        if (!write && attempt < 3) { log.info('Shop-Anfrage wird wiederholt', { shop: 'shopify', error: this.clean(e instanceof Error ? e.message : String(e)), attempt: attempt + 1 }); await sleep(500 * 2 ** attempt); continue; }
        log.warn('Shop nicht erreichbar', { shop: 'shopify', write, error: this.clean(e instanceof Error ? e.message : String(e)), attempts: attempt + 1 });
        throw new ShopifyError(this.clean(`Shopify nicht erreichbar (${c.domain}): ${e instanceof Error ? e.message : String(e)}`));
      }
      if (res.status === 429 && attempt < max) { // rate limit: wait for Retry-After (seconds, e.g. "2.0"): the request was not executed
        const ra = parseFloat(res.headers.get('retry-after') ?? ''); log.info('Shop-Anfrage wird wiederholt', { shop: 'shopify', status: 429, attempt: attempt + 1 }); await sleep(Number.isFinite(ra) ? ra * 1000 : 2000); continue;
      }
      if (res.status >= 500 && !write && attempt < 3) { log.info('Shop-Anfrage wird wiederholt', { shop: 'shopify', status: res.status, attempt: attempt + 1 }); await sleep(1000 * 2 ** attempt); continue; }
      if (res.status >= 500 || res.status === 429) log.warn('Shop-Anfrage fehlgeschlagen', { shop: 'shopify', write, status: res.status, attempts: attempt + 1 });
      // expired/revoked app token: fetch anew once (the request was not executed, so mutations may be retried too)
      if (res.status === 401 && authOf(c) === 'app' && !renewed) { renewed = true; attempt--; await this.accessToken(c, true); continue; }
      const text = await res.text();
      let body: Json = {}; try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (!res.ok) throw new ShopifyError(this.clean(httpMessage(res.status, body, c)), res.status);
      const cost = body.extensions?.cost;
      if (cost?.throttleStatus) { const t = cost.throttleStatus; this.bucket = { max: t.maximumAvailable, available: t.currentlyAvailable, restoreRate: t.restoreRate, at: Date.now() }; }
      if (cost?.requestedQueryCost != null) this.costs.set(query, Math.min(1000, cost.requestedQueryCost));
      const errors = Array.isArray(body.errors) ? body.errors : body.errors ? [{ message: String(body.errors) }] : [];
      if (errors.some((e: Json) => e.extensions?.code === 'THROTTLED') && throttled++ < 40) { attempt--; await sleep(Math.max(250, this.budgetWait(this.costs.get(query) ?? 100))); continue; }
      if (errors.length) {
        const denied = errors.find((e: Json) => e.extensions?.code === 'ACCESS_DENIED');
        throw new ShopifyError(this.clean(denied ? `Shopify verweigert den Zugriff: ${errText([denied])}: die App braucht die passende Admin-API-Berechtigung.` : `Shopify: ${errText(errors)}`), res.status, denied ? 'ACCESS_DENIED' : errors[0]?.extensions?.code);
      }
      return (body.data ?? {}) as T;
    }
  }

  /** Run a mutation and check userErrors; returns the payload object of the (first) root field */
  async mutate<T = Json>(query: string, variables: Json, root: string): Promise<T> {
    const data = await this.gql<Json>(query, variables);
    const payload = data[root];
    const err = userErrorsOf(payload);
    if (err) throw new ShopifyError(this.clean(err), 200, 'USER_ERROR');
    if (payload == null) throw new ShopifyError(`Shopify: ${root} lieferte kein Ergebnis`);
    return payload as T;
  }
}

/** Error while fetching the app token (client credentials grant) → readable text */
function tokenMessage(status: number, body: Json, c: ShopifyConf): string {
  const code = typeof body.error === 'string' ? body.error : '', desc = typeof body.error_description === 'string' ? body.error_description.slice(0, 200) : typeof body.errors === 'string' ? body.errors.slice(0, 200) : '';
  if (code === 'shop_not_permitted') return 'Shopify: Die App darf diesen Shop nicht nutzen (shop_not_permitted). App und Shop müssen zur selben Shopify-Organisation gehören, und die App muss im Shop installiert sein.';
  if (code === 'invalid_client' || code === 'unauthorized_client' || status === 401) return `Shopify: Client-ID oder Client-Secret ungültig (HTTP ${status}${code ? `, ${code}` : ''}). Bitte in den Einstellungen der App im Dev Dashboard prüfen.`;
  if (status === 404) return `Shopify: ${c.domain} nicht gefunden (HTTP 404). Stimmt die myshopify.com-Adresse?`;
  if (status === 402 || status === 423) return `Shopify: Shop ist nicht verfügbar (HTTP ${status}).`;
  if (status >= 200 && status < 300) return 'Shopify: Antwort ohne Zugriffstoken beim Anmelden der App.';
  return `Shopify: Anmeldung der App fehlgeschlagen (HTTP ${status}${code ? `, ${code}` : ''})${desc ? `: ${desc}` : ''}.`;
}

function httpMessage(status: number, body: Json, c: ShopifyConf): string {
  const raw = typeof body.errors === 'string' ? body.errors : Array.isArray(body.errors) ? errText(body.errors) : '';
  if (status === 401) return authOf(c) === 'app' ? 'Shopify: Das Zugriffstoken der App wird abgelehnt (HTTP 401), auch frisch geholt. Ist die App noch im Shop installiert?'
    : 'Shopify: Zugriffstoken ungültig oder widerrufen (HTTP 401). Bitte das Admin-API-Zugriffstoken der App prüfen.';
  if (status === 402) return 'Shopify: Shop ist nicht verfügbar (HTTP 402, z. B. pausiert oder Zahlung offen).';
  if (status === 403) return `Shopify: Zugriff verweigert (HTTP 403). ${raw}`.trim();
  if (status === 404) return `Shopify: ${c.domain} oder API-Version ${c.apiVersion} nicht gefunden (HTTP 404).`;
  if (status === 423) return 'Shopify: Shop ist gesperrt (HTTP 423).';
  if (status === 429) return 'Shopify: zu viele Anfragen (HTTP 429), bitte gleich noch einmal versuchen.';
  return `Shopify antwortet mit HTTP ${status}${raw ? `: ${raw}` : ''}`;
}

// ---- IDs: Lotse shows short numeric IDs (as in the Shopify admin), GIDs internally ----
/** "123" or "gid://shopify/Product/123" → GID of the expected type; other type or garbage → error */
export function toGid(type: string, id: string | number): string {
  const s = String(id ?? '').trim();
  if (/^\d+$/.test(s)) return `gid://shopify/${type}/${s}`;
  const m = /^gid:\/\/shopify\/(\w+)\/(\d+)(\?.*)?$/.exec(s);
  if (!m) throw new Error(`Ungültige ID „${s.slice(0, 60)}“ (erwartet: Zahl oder gid://shopify/${type}/…)`);
  if (m[1] !== type) throw new Error(`ID ${s} ist ein(e) ${m[1]}, erwartet ${type}`);
  return `gid://shopify/${type}/${m[2]}`;
}
/** GID → short ID (null stays null) */
export const shortId = (g: string | null | undefined): string => (g ? String(g).replace(/^gid:\/\/shopify\/\w+\//, '').replace(/\?.*$/, '') : '');
export const gidType = (g: string) => /^gid:\/\/shopify\/(\w+)\//.exec(g)?.[1] ?? null;
