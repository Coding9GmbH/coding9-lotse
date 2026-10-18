import 'server-only';
// Preview of a task's sandbox storefront (/sbx/<id>.<key>/…). The upstream comes only from Lotse's own record of a container it started
// (alias on lotse-sandbox or the 127.0.0.1 port Docker reports), never from the request. Requests go out with Host: localhost
// (Dockware's domain); cookies the sandbox sets stay in a server-side jar per task and never reach the browser, so a cart or a
// customer login works inside the opaque-origin preview.
import crypto from 'node:crypto';
import http from 'node:http';
import { singleton } from '../state';
import { getTask, previewKey, previewPath, sandboxOrigin, TASK_ID, type CodeTask } from './tasks';

/** Dockware's storefront domain (APP_URL and sales channel domain stay http://localhost, see templates/dockware.ts). */
export const SANDBOX_HOST = 'localhost';
export const SANDBOX_BASE = `http://${SANDBOX_HOST}`;
export const sandboxPrefix = previewPath;
/** Task id of a preview segment <id>.<key>, or null (malformed, unknown id format, wrong key). */
export function taskOfSegment(segment: string): string | null {
  const m = /^(t_[a-z0-9]{12})\.([a-f0-9]{20})$/.exec(segment);
  if (!m || !TASK_ID.test(m[1])) return null;
  const want = Buffer.from(previewKey(m[1])), got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}
export const PREVIEW_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const MAX_REQUEST_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY = 30 * 1024 * 1024;
/** socket idle limit: a cold Shopware renders its first page in several seconds */
const IDLE_MS = 60_000;

export type PreviewState = { kind: 'proxy'; task: CodeTask } | { kind: 'wake'; task: CodeTask } | { kind: 'waking'; task: CodeTask } | { kind: 'stopped'; task: CodeTask } | { kind: 'unknown' };
/** What /sbx/<id> may do for this task: proxy (container runs), wake (paused or stopped outside Lotse), waking, stopped (410), unknown (404). */
export function previewState(id: string): PreviewState {
  const task = TASK_ID.test(id) ? getTask(id) : null;
  if (!task) return { kind: 'unknown' };
  if (task.status === 'waking') return { kind: 'waking', task };
  if (task.status === 'paused' || (task.status === 'ready' && !task.containerRunning)) return { kind: task.containerId ? 'wake' : 'stopped', task };
  if (task.status !== 'done' && task.containerId && task.containerRunning) return { kind: 'proxy', task };
  return { kind: 'stopped', task };
}
/** The task's last start (wake) failed: it is paused and keeps that error until the next start (beginWake clears it). */
export const wakeFailed = (t: CodeTask) => t.status === 'paused' && !!t.error;
/** Origin of the task's storefront, from the registry only (see tasks.sandboxOrigin). Cached per container, so the many asset
 *  requests of one page do not each ask Docker for the port; forgotten when Lotse starts or stops the container or a request fails. */
const origins = () => singleton<Map<string, string>>('sandboxOrigins', () => new Map());
export async function sandboxUpstream(t: CodeTask): Promise<string> {
  const hit = t.containerId ? origins().get(t.containerId) : undefined;
  if (hit) return hit;
  const origin = await sandboxOrigin(t);
  if (t.containerId) origins().set(t.containerId, origin);
  return origin;
}
export const forgetUpstream = (containerId: string | null) => { if (containerId) origins().delete(containerId); };

// ---- Cookie jar per task (memory only: a Lotse restart starts a new storefront session) ----
interface JarCookie { value: string; httpOnly: boolean }
type Jar = Map<string, JarCookie>;
const jars = () => singleton<Map<string, Jar>>('sandboxCookieJars', () => new Map());
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MAX_COOKIES = 50, MAX_COOKIE_VALUE = 4096;
/** Cookie header for the upstream request, or null. */
export function jarCookie(id: string): string | null {
  const j = jars().get(id);
  return j?.size ? [...j].map(([k, c]) => `${k}=${c.value}`).join('; ') : null;
}
/** Cookies the preview's scripts may read (document.cookie shim): not the HttpOnly ones (session). */
export const scriptCookies = (id: string): [string, string][] => [...(jars().get(id) ?? [])].filter(([, c]) => !c.httpOnly).map(([k, c]) => [k, c.value]);
/** Takes Set-Cookie lines into the jar: Max-Age<=0 or an Expires in the past removes the cookie. Path/Domain are ignored (one host).
 *  `fromScript`: written by the preview's document.cookie (no HttpOnly flag, and an HttpOnly cookie cannot be overwritten that way). */
export function storeCookies(id: string, setCookies: readonly string[], o: { now?: number; fromScript?: boolean } = {}) {
  if (!setCookies.length) return;
  let j = jars().get(id);
  if (!j) jars().set(id, (j = new Map()));
  for (const line of setCookies) {
    const [pair, ...attrs] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    if (!COOKIE_NAME.test(name) || value.length > MAX_COOKIE_VALUE || /[\r\n;]/.test(value)) continue;
    if (o.fromScript && j.get(name)?.httpOnly) continue;
    const flags = attrs.map(a => a.trim().toLowerCase());
    const attr = (k: string) => attrs.map(a => a.trim()).find(a => a.toLowerCase().startsWith(`${k}=`))?.slice(k.length + 1);
    const maxAge = attr('max-age'), expires = attr('expires');
    const gone = (maxAge !== undefined && Number(maxAge) <= 0) || (maxAge === undefined && expires !== undefined && Date.parse(expires) <= (o.now ?? Date.now()));
    j.delete(name);
    if (!gone) j.set(name, { value, httpOnly: !o.fromScript && flags.includes('httponly') });
    while (j.size > MAX_COOKIES) j.delete(j.keys().next().value!);
  }
}
/** Forget the storefront session (task finished or container recreated). */
export const clearJar = (id: string) => { jars().delete(id); };
/** Where the preview's document.cookie shim reports writes (POST, text body = the Set-Cookie-like string). Never forwarded. */
export const COOKIE_SYNC_PATH = '/__lotse/cookie';

/**
 * Start of <head> of every preview page (before the shop's scripts). The opaque origin forbids document.cookie and Web Storage
 * (Shopware's scripts throw on them), and root paths built by scripts would leave the prefix. So: document.cookie from the jar
 * (non-HttpOnly cookies) with writes reported to Lotse, in-memory storage, and fetch/XHR URLs on this host kept below the prefix.
 */
export function previewShim(prefix: string, cookies: [string, string][]): string {
  const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<script>(function(){var P=${json(prefix)},jar={};${json(cookies)}.forEach(function(c){jar[c[0]]=c[1]});
function fix(u){try{var a=new URL(String(u),location.href);if(a.host!==location.host||a.pathname===P||a.pathname.indexOf(P+'/')===0)return u;return P+a.pathname+a.search+a.hash}catch(e){return u}}
try{document.cookie}catch(e){try{Object.defineProperty(document,'cookie',{configurable:true,get:function(){var o=[];for(var k in jar)o.push(k+'='+jar[k]);return o.join('; ')},
set:function(v){v=String(v);var p=v.split(';')[0],i=p.indexOf('=');if(i<1)return;var k=p.slice(0,i).trim();
if(/;\\s*max-age\\s*=\\s*(0|-)/i.test(v)||/;\\s*expires\\s*=[^;]*1970/i.test(v))delete jar[k];else jar[k]=p.slice(i+1).trim();
try{navigator.sendBeacon(P+${json(COOKIE_SYNC_PATH)},v)}catch(x){}}})}catch(x){}}
function mem(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{configurable:true,value:mem()})}catch(x){}}});
var F=window.fetch;if(F)window.fetch=function(i,o){if(typeof i==='string'||i instanceof URL)i=fix(i);else if(i&&i.url&&fix(i.url)!==i.url)i=new Request(fix(i.url),i);return F.call(this,i,o)};
var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);a[1]=fix(u);return O.apply(this,a)};
})();</script>`;
}

/** Shopware's dev toolbar and cookie notice cover the bottom of the preview; the setup step "preview-tidy" switches both off,
 *  this hides them as well for sandboxes set up before that step existed (or when the step was skipped). */
export const PREVIEW_TIDY_CSS = '<style>.sf-toolbar,.sf-minitoolbar,.sf-toolbarreset,.cookie-permission-container{display:none!important}</style>';

// ---- Upstream request ----
export interface UpstreamReq { method: string; path: string; headers: Record<string, string>; body?: Buffer }
export interface Upstream { status: number; headers: Headers; setCookies: string[]; body: Buffer }
export type UpstreamFetch = (origin: string, r: UpstreamReq, signal?: AbortSignal) => Promise<Upstream>;

/** Error of fetchUpstream: `code` is the socket error (ECONNREFUSED …) or ETIMEDOUT, ETOOLARGE, EBADPATH; the route localizes it. */
const upstreamError = (code: string) => Object.assign(new Error(code), { code });
/** node:http (fetch cannot set Host): no redirects followed, no compression, body capped. */
export const fetchUpstream: UpstreamFetch = (origin, r, signal) => new Promise((resolve, reject) => {
  const u = new URL(r.path, origin);
  if (u.origin !== new URL(origin).origin) { reject(upstreamError('EBADPATH')); return; }
  const headers = { ...r.headers, host: SANDBOX_HOST, ...(r.body ? { 'content-length': String(r.body.length) } : {}) };
  const req = http.request(u, { method: r.method, headers, timeout: IDLE_MS, signal }, res => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_RESPONSE_BODY) { req.destroy(upstreamError('ETOOLARGE')); return; } chunks.push(c); });
    res.on('end', () => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && k !== 'set-cookie') for (const x of [v].flat()) h.append(k, x);
      resolve({ status: res.statusCode ?? 502, headers: h, setCookies: res.headers['set-cookie'] ?? [], body: Buffer.concat(chunks) });
    });
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(upstreamError('ETIMEDOUT')));
  req.on('error', e => reject((e as NodeJS.ErrnoException).code ? e : upstreamError(e.message)));
  req.end(r.body);
});

/** Request headers that go to the sandbox: content negotiation, form/ajax markers. No browser cookies, no auth, no Lotse headers. */
const PASS = ['accept', 'accept-language', 'content-type', 'x-requested-with', 'user-agent', 'cache-control', 'pragma', 'if-none-match', 'if-modified-since'];
export function upstreamHeaders(id: string, from: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PASS) { const v = from.get(k); if (v) out[k] = v; }
  out.accept ??= '*/*';
  const cookie = jarCookie(id);
  if (cookie) out.cookie = cookie;
  return out;
}

/** Location of an upstream redirect → path below /sbx/<id>, or null when it leaves the sandbox (another host, credentials, other scheme). */
export function sandboxLocation(loc: string, origin: string, id: string): string | null {
  try {
    const abs = new URL(loc, SANDBOX_BASE);
    if (abs.username || abs.password || !/^https?:$/.test(abs.protocol)) return null;
    const own = abs.hostname === SANDBOX_HOST || abs.origin === new URL(origin).origin;
    return own ? sandboxPrefix(id) + abs.pathname + abs.search + abs.hash : null;
  } catch { return null; }
}
