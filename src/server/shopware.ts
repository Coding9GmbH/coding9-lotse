import 'server-only';
// Minimaler Shopware 6 Admin-API Client (Password-Grant für dockware, Client-Credentials für Integrationen)
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGuard, type Criteria, type Guard } from './policy';

/** Shopware-JSON ist je Entität dynamisch – bewusst lose typisiert. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SwEntity = Record<string, any>;
export interface SearchResult { data: SwEntity[]; total?: number }
/** Lesen in einer bestimmten Sprache (Header sw-language-id): Felder = eigener Wert dieser Sprache (null = geerbt), translated = mit Vererbung */
export interface ReadOpts { languageId?: string }
const langHeader = (o?: ReadOpts): Record<string, string> => (o?.languageId ? { 'sw-language-id': o.languageId } : {});
export interface ShopwareConfig { url: string; publicUrl: string; user: string; password: string; clientId: string; clientSecret: string }

// Shop-Schutz: jede Anfrage mit Timeout; bei Überlast (429/503) kurz warten und höchstens 2× erneut versuchen (Retry-After wird beachtet).
// So bleibt ein langsamer Shop nicht hängen und wird nicht mit Wiederholungen überrannt.
const TIMEOUT_MS = Math.max(5_000, parseInt(process.env.LOTSE_SHOP_TIMEOUT_MS ?? '', 10) || 60_000);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function shopFetch(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e: Error & { cause?: { code?: string } }) => {
      throw new Error(e.name === 'TimeoutError' ? `Shop antwortet nicht (Timeout nach ${TIMEOUT_MS / 1000}s)` : `Shop nicht erreichbar: ${e.cause?.code || e.message}`);
    });
    const retry = r.status === 429 || (r.status === 503 && (init.method ?? 'GET') === 'GET'); // Schreibzugriffe nur bei 429 (sicher nicht verarbeitet)
    if (!retry || attempt >= 2) return r;
    const ra = parseInt(r.headers.get('retry-after') ?? '', 10);
    await sleep(Math.min(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt, 10_000));
  }
}

// fetch() ignoriert einen eigenen Host-Header. Für die Storefront über die interne Adresse (Docker: http://shopware)
// muss Shopware aber die Domain des Verkaufskanals sehen → node:http mit gesetztem Host (nur GET/HEAD, ohne Weiterleitungen).
function fetchWithHost(url: string, host: string, init: RequestInit = {}): Promise<Response> {
  const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
  const headers = { ...((init.headers as Record<string, string>) ?? {}), host };
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: init.method ?? 'GET', headers, servername: u.hostname, timeout: TIMEOUT_MS }, res => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) for (const x of [v].flat()) h.append(k, x);
      const status = res.statusCode ?? 502, empty = [101, 204, 205, 304].includes(status) || init.method === 'HEAD';
      if (empty) res.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    req.on('timeout', () => req.destroy(new Error(`Shop antwortet nicht (Timeout nach ${TIMEOUT_MS / 1000}s)`)));
    req.on('error', e => reject(new Error(`Shop nicht erreichbar: ${(e as NodeJS.ErrnoException).code || e.message}`)));
    req.end();
  });
}

/** Was die KI-Tools und die Vorschlags-Schicht vom Shop brauchen (nur lesen). */
export interface ShopReader {
  readonly base: string;
  search(entity: string, criteria?: Criteria, opts?: ReadOpts): Promise<SearchResult>;
  get(entity: string, id: string, criteria?: Criteria, opts?: ReadOpts): Promise<SwEntity | null>;
  salesChannels(): Promise<SwEntity[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<any>;
}

export class Shopware implements ShopReader {
  cfg!: ShopwareConfig;
  base = '';
  publicUrl = '';
  sfDomain: string | null = null;
  private token: string | null = null;
  private expires = 0;

  constructor(cfg: ShopwareConfig) { this.configure(cfg); }

  // (Neu-)Konfiguration zur Laufzeit; base = intern erreichbare URL, publicUrl = so erreicht der Browser den Shop
  configure(cfg: ShopwareConfig) {
    this.cfg = cfg; this.base = (cfg.url || '').replace(/\/$/, ''); this.publicUrl = (cfg.publicUrl || cfg.url || '').replace(/\/$/, '');
    this.token = null; this.expires = 0;
  }

  // Storefront-Abruf: Die Domain des Verkaufskanals (öffentlich) wird intern über die API-URL mit passendem Host-Header geholt (Docker: localhost ≠ Container)
  async storefrontFetch(url: string, init: RequestInit = {}): Promise<Response> {
    try {
      const u = new URL(url), dom = this.sfDomain ? new URL(this.sfDomain) : null, internal = new URL(this.base);
      if (dom && u.origin === dom.origin && dom.origin !== internal.origin) return fetchWithHost(this.base + u.pathname + u.search, u.host, init);
    } catch {}
    return shopFetch(url, init);
  }

  async auth(): Promise<string> {
    if (!this.base) throw new Error('Shopware ist noch nicht verbunden (Einstellungen).');
    if (this.token && Date.now() < this.expires - 10_000) return this.token;
    const c = this.cfg;
    const body = c.clientId && c.clientSecret
      ? { grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret }
      : { grant_type: 'password', client_id: 'administration', scopes: 'write', username: c.user, password: c.password };
    const r = await shopFetch(`${this.base}/api/oauth/token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Shopware-Login fehlgeschlagen (${r.status}): ${await r.text()}`);
    const j = await r.json() as { access_token: string; expires_in: number };
    this.token = j.access_token;
    this.expires = Date.now() + j.expires_in * 1000;
    return this.token;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
    const token = await this.auth();
    const r = await shopFetch(`${this.base}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!r.ok) {
      const errs = (json?.errors as { code?: string; detail?: string; source?: { pointer?: string } }[] | undefined)?.map(e => `${e.code}: ${e.detail}${e.source?.pointer ? ` (${e.source.pointer})` : ''}`).join('; ');
      throw Object.assign(new Error(`Shopware ${method} ${path} → ${r.status}: ${errs || text.slice(0, 500)}`), { status: r.status });
    }
    return json;
  }

  search(entity: string, criteria?: Criteria, opts?: ReadOpts): Promise<SearchResult> { return this.req('POST', `/search/${entity}`, criteria, langHeader(opts)); }
  get(entity: string, id: string, criteria?: Criteria, opts?: ReadOpts): Promise<SwEntity | null> { return this.search(entity, { ...criteria, ids: [id], limit: 1 }, opts).then(r => r.data?.[0] ?? null); }
  create(entity: string, data: unknown) { return this.req('POST', `/${entity}`, data); }
  update(entity: string, id: string, data: unknown) { return this.req('PATCH', `/${entity}/${id}`, data); }

  async salesChannels(): Promise<SwEntity[]> {
    const r = await this.search('sales-channel', { limit: 25, associations: { domains: {} } });
    return r.data;
  }

  // Rohdaten-Upload (Download passiert im Server – der Shopware-Container braucht kein Internet)
  async uploadMediaBinary(buf: Buffer, { ext, mime, fileName, folderId }: { ext: string; mime: string; fileName: string; folderId?: string | null }): Promise<string> {
    const id = newId();
    await this.create('media', { id, mediaFolderId: folderId ?? null, private: false });
    const token = await this.auth();
    const r = await shopFetch(`${this.base}/api/_action/media/${id}/upload?extension=${ext}&fileName=${encodeURIComponent(fileName)}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': mime, accept: 'application/json' }, body: new Uint8Array(buf),
    });
    if (!r.ok) { await this.req('DELETE', `/media/${id}`).catch(() => {}); throw new Error(`Medien-Upload fehlgeschlagen (${r.status}): ${(await r.text()).slice(0, 300)}`); }
    return id;
  }

  async uploadMediaFromUrl(url: string, fileName: string, folderId?: string | null): Promise<string> {
    const id = newId();
    await this.create('media', { id, mediaFolderId: folderId ?? null, private: false });
    const clean = fileName.replace(/\.[a-z0-9]+$/i, '');
    const ext = (url.split('?')[0].match(/\.([a-z0-9]+)$/i)?.[1] ?? 'jpg').toLowerCase();
    await this.req('POST', `/_action/media/${id}/upload?extension=${ext}&fileName=${encodeURIComponent(clean + '-' + id.slice(0, 6))}`, { url });
    return id;
  }
}

export const newId = () => crypto.randomUUID().replace(/-/g, '');
/** Shopware-ID: 32 Hex-Zeichen (UUID ohne Bindestriche) */
export const HEX32 = /^[0-9a-f]{32}$/;
/** Shopware Defaults::LANGUAGE_SYSTEM: Rückfallsprache aller Übersetzungen */
export const SYSTEM_LANGUAGE = '2fbb5fe2e29a4d70aa5854ce7ce3e20b';

// Lese-Schicht für die KI: kein create/update/upload, nur freigegebene Entitäten/Beziehungen (policy.ts), sensible Felder werden entfernt,
// jeder Zugriff wird protokolliert. Zugangsdaten sind hier nicht erreichbar (nur im privilegierten Client des Servers).
export class ReadOnlyShopware implements ShopReader {
  readonly #sw: ShopReader;
  readonly #g: Guard;
  constructor(sw: ShopReader, guard?: Guard) { this.#sw = sw; this.#g = guard ?? createGuard(); }
  get base() { return this.#sw.base; }
  // Sprache nur als geprüfte ID (Header) – die Freigabeprüfung der Suche gilt unverändert
  async search(entity: string, criteria?: Criteria, opts?: ReadOpts) { this.#g.checkSearch(entity, criteria); this.#g.checkLanguage(opts?.languageId); return this.#g.afterRead('search', entity, await this.#sw.search(entity, criteria, opts)); }
  async get(entity: string, id: string, criteria?: Criteria, opts?: ReadOpts) {
    this.#g.checkSearch(entity, criteria); this.#g.checkLanguage(opts?.languageId);
    const r = await this.#sw.get(entity, id, criteria, opts); this.#g.afterRead('get', entity, { data: r ? [r] : [] }); return r;
  }
  async salesChannels() { return (await this.search('sales-channel', { limit: 25, associations: { domains: {} } })).data; }
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
    const entity = this.#g.checkReq(method, path, body); // wirft synchron bei Verbot
    const r = this.#sw.req(method, path, body, headers);
    return entity ? r.then(x => this.#g.afterRead('preview', entity, x)) : r;
  }
}
