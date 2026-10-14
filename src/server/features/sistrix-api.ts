import 'server-only';
// Sistrix: access via API key (encrypted in the DB), calls via POST (the key never appears in a URL), responses as JSON.
// The key never leaves the server (neither to the AI nor to the browser). Credits are reported with each response.
// Base URL can be overridden via environment (tests with a local fake endpoint): LOTSE_SISTRIX_API_BASE.
import type { SistrixPublic } from '@/lib/protocol';
import { kvGet, kvSet, seal, unseal } from '../db';
import { fetchWithRetry } from '../retry';
import { singleton } from '../state';

const DEFAULT_API = 'https://api.sistrix.com';
const TIMEOUT_MS = 30_000;
export const apiBase = () => (process.env.LOTSE_SISTRIX_API_BASE || DEFAULT_API).replace(/\/+$/, '');

interface StoredSistrix { key?: string; domain?: string; country?: string; /** Optimizer project (hash), empty = automatic for the domain */ project?: string; updatedAt?: string }
const KV = 'sistrix';
const stored = () => kvGet<StoredSistrix>(KV) ?? {};

export interface SistrixConfig { key: string; domain: string; country: string; project?: string }

/** Rough API key check (length/characters); Sistrix doesn't guarantee the format. */
export function normKey(k: string): string {
  const s = k.trim();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(s)) throw new Error('Das sieht nicht wie ein Sistrix-API-Schlüssel aus (16 bis 128 Zeichen, Buchstaben und Ziffern).');
  return s;
}

/** Domain, host or path without scheme: "shop.de", "www.shop.de", "shop.de/kategorie/". Empty = none. */
export function normDomain(d: string | undefined): string {
  let s = (d ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[?#].*$/, '');
  if (/^[^/]+\/+$/.test(s)) s = s.replace(/\/+$/, ''); // "shop.de/" is the host, not a path
  if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/.test(s)) throw new Error('Domain: z. B. mein-shop.de (ohne https://), optional mit Pfad.');
  return s;
}

/** Country code (Sistrix: two letters, e.g. de, at, ch). Empty = country of the Sistrix account. */
export function normCountry(c: string | undefined): string {
  const s = (c ?? '').trim().toLowerCase();
  if (!s) return '';
  if (!/^[a-z]{2}$/.test(s)) throw new Error('Land: zweistelliger Code, z. B. de, at, ch.');
  return s;
}

/** Sistrix knows the "address_object" only as a placeholder: the real parameter is domain (whole domain incl. subdomains), host (one host),
 *  path (directory) or url (single page). The matching parameter is chosen from the input. */
export function addressParam(target: string): Record<string, string> {
  const t = target.trim().toLowerCase(), slash = t.indexOf('/');
  if (slash > -1) {
    const rest = t.slice(slash + 1);
    return rest === '' ? addressParam(t.slice(0, slash)) : { [/\/$/.test(t) ? 'path' : 'url']: t };
  }
  const labels = t.split('.'), twoLevel = /\.(co|com|org|net|ac|gov|or)\.[a-z]{2}$/.test(t);
  return labels.length > (twoLevel ? 3 : 2) ? { host: t } : { domain: t };
}

export function getSistrixConfig(): SistrixConfig | null {
  const s = stored(), key = unseal(s.key);
  return key ? { key, domain: (s.domain ?? '').replace(/^([^/]+)\/+$/, '$1'), country: s.country ?? '', ...(s.project ? { project: s.project } : {}) } : null; // "shop.de/" from older inputs is the host
}
export const sistrixConnected = () => !!getSistrixConfig();

export function sistrixPublic(): SistrixPublic {
  const s = stored();
  return { hasKey: !!s.key, domain: s.domain ?? '', country: s.country ?? '', project: s.project ?? '', connected: !!(s.key && s.domain), updatedAt: s.updatedAt ?? null };
}

/** Save: key empty/undefined = unchanged, null = disconnect. */
export function saveSistrix(p: { key?: string | null; domain?: string; country?: string; project?: string }) {
  if (p.key === null) { kvSet(KV, {}); clearSistrixCache(); return; }
  const out: StoredSistrix = { ...stored() };
  if (p.key) out.key = seal(normKey(p.key)) ?? undefined;
  if (p.domain !== undefined) out.domain = normDomain(p.domain);
  if (p.country !== undefined) out.country = normCountry(p.country);
  if (p.domain !== undefined && out.domain !== stored().domain) delete out.project; // different domain: reassign the project
  if (p.project !== undefined) { const h = p.project.trim(); if (h && !/^[A-Za-z0-9._-]{1,100}$/.test(h)) throw new Error('Ungültiges Optimizer-Projekt.'); if (h) out.project = h; else delete out.project; }
  out.updatedAt = new Date().toISOString();
  kvSet(KV, out); clearSistrixCache();
}

// ---- Calls ----
export type Row = Record<string, string | number | boolean | null>;
export interface Reply { answer: Record<string, unknown>; creditsUsed: number | null }

/** Sistrix often returns numbers as text; numeric text becomes a number, nested values are dropped. */
export function cleanRow(r: unknown): Row {
  const out: Row = {};
  if (!r || typeof r !== 'object') return out;
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v.trim() !== '' && /^-?\d+([.,]\d+)?$/.test(v.trim()) && !/^0\d/.test(v.trim()) ? Number(v.trim().replace(',', '.')) : v;
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
  }
  return out;
}

/** Rows of a response: the response itself, a named or the first list key (Sistrix names it differently per method). */
export function rowsOf(answer: unknown, ...names: string[]): Row[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object').map(cleanRow) : null);
  if (Array.isArray(answer)) return list(answer) ?? [];
  if (!answer || typeof answer !== 'object') return [];
  const o = answer as Record<string, unknown>;
  for (const n of names) { const l = list(o[n]); if (l) return l; }
  for (const v of Object.values(o)) { const l = list(v); if (l?.length) return l; }
  // Single record instead of a list
  const single = cleanRow(o);
  return Object.keys(single).length ? [single] : [];
}

/** Unwrap the response envelope. Errors from Sistrix (status fail / error) become understandable messages. */
export function unwrap(json: unknown): Reply {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const err = Array.isArray(j.error) ? j.error[0] : j.error;
  if (j.status === 'fail' || err) {
    const e = (err && typeof err === 'object' ? err : {}) as Record<string, unknown>;
    const msg = String(e.error_message ?? e.message ?? (typeof err === 'string' ? err : '') ?? '').trim();
    throw new Error(`Sistrix: ${msg || 'Anfrage abgelehnt'}${e.error_code ? ` (${String(e.error_code)})` : ''}`);
  }
  const a = Array.isArray(j.answer) ? j.answer[0] : j.answer;
  const c = Array.isArray(j.credits) ? j.credits[0] : j.credits;
  const used = c && typeof c === 'object' ? Number((c as Record<string, unknown>).used) : NaN;
  return { answer: (a && typeof a === 'object' ? a : {}) as Record<string, unknown>, creditsUsed: Number.isFinite(used) ? used : null };
}

const CACHE_MS = 10 * 60_000;
const cache = () => singleton('sistrix-cache', () => new Map<string, { at: number; reply: Promise<Reply> }>());
export const clearSistrixCache = () => cache().clear();

/** One call, cached for 10 minutes (shop check and several tools often ask the same; saves credits). */
export function sistrixCached(cfg: SistrixConfig, method: string, params: Record<string, string | number | boolean | undefined> = {}, ttlMs = CACHE_MS): Promise<Reply> {
  const id = JSON.stringify([cfg.domain, method, params]), c = cache().get(id);
  if (c && Date.now() - c.at < ttlMs) return c.reply;
  const reply = sistrixCall(cfg, method, params); cache().set(id, { at: Date.now(), reply });
  reply.catch(() => cache().delete(id));
  if (cache().size > 200) cache().delete(cache().keys().next().value!);
  return reply;
}

export async function sistrixCall(cfg: { key: string; country?: string }, method: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<Reply> {
  if (!/^[a-z]+(\.[a-z]+)*$/.test(method)) throw new Error('Ungültige Sistrix-Methode');
  const body = new URLSearchParams({ api_key: cfg.key, format: 'json' });
  for (const [k, v] of Object.entries({ ...(cfg.country ? { country: cfg.country } : {}), ...params })) if (v !== undefined && v !== '') body.set(k, String(v));
  const r = await fetchWithRetry(() => fetch(`${apiBase()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) }), { label: 'sistrix' })
    .catch((e: Error & { cause?: { code?: string } }) => { throw new Error(e.name === 'TimeoutError' ? 'Sistrix antwortet nicht (Timeout)' : `Sistrix nicht erreichbar: ${e.cause?.code || e.message}`); });
  const text = await r.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error(r.ok ? 'Sistrix: unerwartete Antwort (kein JSON)' : `Sistrix: HTTP ${r.status}`); }
  if (r.status === 401 || r.status === 403) throw new Error('Sistrix lehnt den API-Schlüssel ab. Schlüssel prüfen (Sistrix-Konto → API).');
  const reply = unwrap(json); // also reports errors in the body
  if (!r.ok) throw new Error(`Sistrix: HTTP ${r.status}`);
  return reply;
}

/** Number behind the first matching key, at any depth (credits returns {"credits":[{"value":20000}]}). */
export function findNumber(v: unknown, keys: string[]): number | null {
  if (Array.isArray(v)) { for (const x of v) { const n = findNumber(x, keys); if (n !== null) return n; } return null; }
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (keys.includes(k) && (typeof x === 'number' || typeof x === 'string') && x !== '' && Number.isFinite(Number(x))) return Number(x);
  }
  for (const x of Object.values(v as Record<string, unknown>)) { const n = findNumber(x, keys); if (n !== null) return n; }
  return null;
}

/** Check the connection: `credits` is free and confirms the key. */
export async function testSistrix(): Promise<{ ok: boolean; message: string; credits: number | null }> {
  const cfg = getSistrixConfig();
  if (!cfg) return { ok: false, message: 'Noch kein Schlüssel gespeichert.', credits: null };
  const r = await sistrixCall(cfg, 'credits');
  const credits = findNumber(r.answer, ['value', 'credits', 'remaining', 'balance']);
  const shape = credits === null ? ` (Credits nicht lesbar, Antwort: ${JSON.stringify(r.answer).slice(0, 200)})` : '';
  const left = credits !== null ? `, ${credits} Credits übrig` : '';
  if (!cfg.domain) return { ok: true, message: `Schlüssel gültig${left}. Bitte noch die Domain des Shops eintragen.${shape}`, credits };
  // Check the domain (1 credit): this shows immediately if Sistrix doesn't know the domain. The reference domain separates "domain unknown" from "request wrong".
  let probe: Row[] = [];
  try {
    probe = rowsOf((await sistrixCall(cfg, 'domain.visibilityindex', { ...addressParam(cfg.domain), history: true, limit: 1 })).answer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/\(2000\)|not found/i.test(msg)) return { ok: false, message: `Schlüssel gültig${left}, aber die Domain-Abfrage für ${cfg.domain} scheiterte: ${msg}`, credits };
    const ref = await sistrixCall(cfg, 'domain.visibilityindex', { ...addressParam('sistrix.de'), history: true, limit: 1 }).then(() => true, () => false);
    return { ok: false, credits, message: ref
      ? `Schlüssel gültig${left}, aber ${cfg.domain} ist bei Sistrix nicht erfasst (Referenzdomain funktioniert). Domain ohne www. oder die Schreibweise aus der Sistrix-Toolbox verwenden; sehr kleine oder neue Shops fehlen oft in der Datenbank.`
      : `Schlüssel gültig${left}, aber die Domain-Abfrage scheitert auch für eine Referenzdomain: ${msg}` };
  }
  const sample = probe.length ? ` Sichtbarkeit: ${JSON.stringify(probe[0]).slice(0, 160)}` : ' Sistrix liefert für die Domain noch keine Sichtbarkeitsdaten (zu klein oder neu).';
  return { ok: true, message: `Verbunden für ${cfg.domain}${left}.${sample}${shape}`, credits };
}
