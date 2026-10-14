import 'server-only';
// Google Search Console: access via service account (JSON key, encrypted in the DB), RS256 JWT → access token (cached),
// Search Analytics (searchanalytics.query, paged) and sites.list. The key never leaves the server (neither to the AI nor the browser).
// Base URLs can be overridden via env (tests with a local fake endpoint): LOTSE_GSC_API_BASE, LOTSE_GSC_TOKEN_URL.
import crypto from 'node:crypto';
import type { GscPublic } from '@/lib/protocol';
import { kvGet, kvSet, seal, unseal } from '../db';
import { fetchWithRetry } from '../retry';
import { singleton } from '../state';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const DEFAULT_API = 'https://www.googleapis.com/webmasters/v3';
const DEFAULT_TOKEN = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 30_000;
export const apiBase = () => (process.env.LOTSE_GSC_API_BASE || DEFAULT_API).replace(/\/+$/, '');
export const tokenUrl = () => process.env.LOTSE_GSC_TOKEN_URL || DEFAULT_TOKEN;

export interface ServiceKey { client_email: string; private_key: string; project_id?: string; private_key_id?: string }
interface StoredGsc { key?: string; clientEmail?: string; projectId?: string; property?: string; updatedAt?: string }
const KV = 'gsc';
const stored = () => kvGet<StoredGsc>(KV) ?? {};

/** Validate the JSON key (type, email, readable RSA private key). Throws with an understandable message. */
export function parseServiceKey(text: string): ServiceKey {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { throw new Error('Kein gültiges JSON – bitte die komplette Schlüsseldatei des Service-Kontos einfügen.'); }
  if (j.type !== 'service_account') throw new Error('Das ist kein Service-Konto-Schlüssel (erwartet "type": "service_account").');
  if (typeof j.client_email !== 'string' || !j.client_email.includes('@')) throw new Error('client_email fehlt im Schlüssel.');
  if (typeof j.private_key !== 'string') throw new Error('private_key fehlt im Schlüssel.');
  try { crypto.createPrivateKey(j.private_key); } catch { throw new Error('private_key ist nicht lesbar.'); }
  return { client_email: j.client_email, private_key: j.private_key, project_id: typeof j.project_id === 'string' ? j.project_id : undefined, private_key_id: typeof j.private_key_id === 'string' ? j.private_key_id : undefined };
}

/** Property: "sc-domain:shop.de" or URL prefix "https://www.shop.de/" (with trailing slash). */
export function normProperty(p: string): string {
  const s = p.trim();
  if (!s) return '';
  if (/^sc-domain:/i.test(s)) { const d = s.slice(10).trim().toLowerCase(); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error('Domain-Property: z. B. sc-domain:mein-shop.de'); return `sc-domain:${d}`; }
  if (!/^https?:\/\/[^/\s]+/i.test(s)) throw new Error('Property: sc-domain:mein-shop.de oder https://www.mein-shop.de/');
  return s.endsWith('/') ? s : s + '/';
}

export function getGscConfig(): { key: ServiceKey; property: string } | null {
  const s = stored(), raw = unseal(s.key);
  if (!raw || !s.property) return null;
  try { return { key: parseServiceKey(raw), property: s.property }; } catch { return null; }
}
export const gscConnected = () => !!getGscConfig();

export function gscPublic(): GscPublic {
  const s = stored();
  return { hasKey: !!s.key, clientEmail: s.clientEmail ?? '', projectId: s.projectId ?? '', property: s.property ?? '', connected: !!(s.key && s.property), updatedAt: s.updatedAt ?? null };
}

/** Save: key = complete JSON text (empty/undefined = unchanged, null = disconnect). */
export function saveGsc(p: { key?: string | null; property?: string }) {
  const s = stored(), out: StoredGsc = { ...s };
  if (p.key === null) { kvSet(KV, {}); tokens().clear(); clearGscCache(); return; }
  if (p.key) { const k = parseServiceKey(p.key); out.key = seal(p.key.trim()) ?? undefined; out.clientEmail = k.client_email; out.projectId = k.project_id; tokens().clear(); }
  if (p.property !== undefined) out.property = normProperty(p.property);
  out.updatedAt = new Date().toISOString();
  kvSet(KV, out); clearGscCache();
}

// ---- Sign-in: JWT (RS256) → access token ----
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function signJwt(key: ServiceKey, aud: string, now = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const claims = b64u(JSON.stringify({ iss: key.client_email, scope: GSC_SCOPE, aud, iat: now, exp: now + 3600 }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), key.private_key);
  return `${head}.${claims}.${b64u(sig)}`;
}

const tokens = () => singleton('gsc-tokens', () => new Map<string, { token: string; exp: number }>());
async function gfetch(url: string, init: RequestInit): Promise<Response> {
  // retry 429/5xx a limited number of times (max. 3 attempts, honors Retry-After); all calls are reads, the body is a string
  return fetchWithRetry(() => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }), { label: 'gsc' }).catch((e: Error & { cause?: { code?: string } }) => {
    throw new Error(e.name === 'TimeoutError' ? 'Google antwortet nicht (Timeout)' : `Google nicht erreichbar: ${e.cause?.code || e.message}`);
  });
}

export async function accessToken(key: ServiceKey): Promise<string> {
  const url = tokenUrl(), id = `${key.client_email}|${url}`, c = tokens().get(id);
  if (c && c.exp > Date.now() + 60_000) return c.token;
  const r = await gfetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(key, url) }).toString() });
  const j = await r.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google-Anmeldung fehlgeschlagen: ${j.error_description || j.error || `HTTP ${r.status}`} (Schlüssel gültig? Search Console API im Google-Cloud-Projekt aktiviert?)`);
  tokens().set(id, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

async function call<T>(cfg: { key: ServiceKey }, method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken(cfg.key);
  const r = await gfetch(`${apiBase()}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})) as { error?: { message?: string } };
  if (r.status === 401) tokens().delete(`${cfg.key.client_email}|${tokenUrl()}`);
  if (r.status === 403) throw new Error(`Kein Zugriff auf die Search-Console-Property. Das Service-Konto ${cfg.key.client_email} muss dort als Nutzer eingetragen sein (Einstellungen → Nutzer und Berechtigungen). ${j.error?.message ?? ''}`.trim());
  if (!r.ok) throw new Error(`Search Console: ${j.error?.message ?? `HTTP ${r.status}`}`);
  return j as T;
}

export interface Site { siteUrl: string; permissionLevel: string }
export async function listSites(cfg: { key: ServiceKey }): Promise<Site[]> {
  return (await call<{ siteEntry?: Site[] }>(cfg, 'GET', '/sites')).siteEntry ?? [];
}

// ---- Search Analytics ----
export type Dim = 'page' | 'query' | 'date' | 'device' | 'country';
export type Operator = 'equals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';
export interface DimFilter { dimension: Dim; operator: Operator; expression: string }
export interface QueryArgs { startDate: string; endDate: string; dimensions?: Dim[]; filters?: DimFilter[]; dataState?: 'final' | 'all'; maxRows?: number }
export interface Row { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }
export const PAGE_SIZE = 25_000;

/** searchanalytics.query with paging (startRow) until maxRows (default 25,000) is reached or no more rows come. */
const CACHE_MS = 10 * 60_000;
const cache = () => singleton('gsc-cache', () => new Map<string, { at: number; rows: Promise<Row[]> }>());
export const clearGscCache = () => cache().clear();
/** Like searchAnalytics, but cached for 10 minutes (shop check and several tools often ask the same). */
export function searchAnalyticsCached(cfg: { key: ServiceKey; property: string }, a: QueryArgs): Promise<Row[]> {
  const id = JSON.stringify([cfg.property, cfg.key.client_email, a]), c = cache().get(id);
  if (c && Date.now() - c.at < CACHE_MS) return c.rows;
  const rows = searchAnalytics(cfg, a); cache().set(id, { at: Date.now(), rows });
  rows.catch(() => cache().delete(id));
  if (cache().size > 200) cache().delete(cache().keys().next().value!);
  return rows;
}

export async function searchAnalytics(cfg: { key: ServiceKey; property: string }, a: QueryArgs): Promise<Row[]> {
  const max = Math.max(1, a.maxRows ?? PAGE_SIZE), out: Row[] = [];
  const path = `/sites/${encodeURIComponent(cfg.property)}/searchAnalytics/query`;
  for (let startRow = 0; out.length < max;) {
    const rowLimit = Math.min(PAGE_SIZE, max - out.length);
    const body = { startDate: a.startDate, endDate: a.endDate, type: 'web', dataState: a.dataState ?? 'final', rowLimit, startRow, ...(a.dimensions?.length ? { dimensions: a.dimensions } : {}),
      ...(a.filters?.length ? { dimensionFilterGroups: [{ groupType: 'and', filters: a.filters }] } : {}) };
    const rows = (await call<{ rows?: Row[] }>(cfg, 'POST', path, body)).rows ?? [];
    out.push(...rows.map(r => ({ keys: r.keys ?? [], clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: r.ctr ?? 0, position: r.position ?? 0 })));
    if (rows.length < rowLimit) break;
    startRow += rows.length;
  }
  return out;
}

/** Test the connection: fetch token, read properties, confirm access to the selected property. */
export async function testGsc(): Promise<{ ok: boolean; message: string; sites: string[] }> {
  const s = stored(), raw = unseal(s.key);
  if (!raw) return { ok: false, message: 'Noch kein Schlüssel gespeichert.', sites: [] };
  const key = parseServiceKey(raw);
  const sites = await listSites({ key });
  const names = sites.map(x => x.siteUrl);
  if (!sites.length) return { ok: false, message: `Angemeldet, aber das Service-Konto sieht keine Property. Trage ${key.client_email} in der Search Console als Nutzer ein.`, sites: names };
  if (!s.property) return { ok: true, message: `Angemeldet. ${sites.length} ${sites.length === 1 ? 'Property' : 'Properties'} gefunden, bitte eine auswählen und speichern.`, sites: names };
  const hit = sites.find(x => x.siteUrl === s.property);
  if (!hit) return { ok: false, message: `Property ${s.property} ist für das Service-Konto nicht freigegeben. Verfügbar: ${names.join(', ')}`, sites: names };
  if (hit.permissionLevel === 'siteUnverifiedUser') return { ok: false, message: `Property ${s.property}: Service-Konto ist nicht bestätigt (siteUnverifiedUser).`, sites: names };
  const level: Record<string, string> = { siteOwner: 'Inhaber', siteFullUser: 'Vollzugriff', siteRestrictedUser: 'eingeschränkter Zugriff' };
  return { ok: true, message: `Verbunden mit ${s.property} (${level[hit.permissionLevel] ?? hit.permissionLevel})`, sites: names };
}
