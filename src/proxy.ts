// Runs before every request: host/origin check (protection against DNS rebinding and CSRF), optional login,
// and forwarding of storefront paths to the shop proxy.
import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, storefrontPrefix } from '@/lib/platforms';
import { LOCAL_HOSTS, PEER_HEADER, extraAllowedHosts, normalizeIp } from '@/server/access';

const LOOPBACK_HOPS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
/** Docker bridge/VM gateway (Docker Desktop, OrbStack, Linux bridge): private, never public. */
function privateHop(hop: string): boolean {
  const m = hop.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(hop);
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}
/** In a container with loopback publish (LOTSE_BIND) only the own machine reaches the port; Next sets X-Forwarded-For to the bridge gateway there. */
const dockerLoopbackPublish = () => process.env.AICB_DOCKER === '1' && LOOPBACK_HOPS.has((process.env.LOTSE_BIND ?? '').trim().toLowerCase());
const allowedHosts = () => new Set([...LOCAL_HOSTS, ...extraAllowedHosts(process.env.ALLOWED_HOSTS)]);

/** Host without port. [::1]:3333 stays [::1]; a bare ::1 does not lose its last group. */
function hostName(host: string): string {
  const value = host.trim();
  if (value.startsWith('[')) return value.replace(/]:\d+$/, ']');
  if ((value.match(/:/g) ?? []).length > 1) return value;
  return value.replace(/:\d+$/, '');
}

/** Sender is this machine (in a container with loopback publish also private gateway addresses, never public ones) */
const localHop = (hop: string) => LOOPBACK_HOPS.has(hop) || (dockerLoopbackPublish() && privateHop(hop));
const hopsOf = (forwardedFor: string | null) => (forwardedFor ?? '').split(',').map(normalizeIp).filter(Boolean);

/** Loopback names only from loopback: every hop in X-Forwarded-For and the socket address (peer, stamped by instrumentation.ts) must be local.
 *  X-Forwarded-For alone is not enough: Next passes a client-supplied value through unchanged. Allowed without both (tests). */
export function hostAllowed(host: string, forwardedFor: string | null, peer: string | null = null): boolean {
  const name = hostName(host);
  if (LOCAL_HOSTS.includes(name)) return [...hopsOf(forwardedFor), ...hopsOf(peer)].every(localHop);
  return allowedHosts().has(name);
}

// ---- Login throttle: after FAIL_MAX wrong passwords within FAIL_WINDOW the address is blocked for BLOCK_MS (429). Bounded memory. ----
const FAIL_MAX = 10, FAIL_WINDOW = 15 * 60_000, BLOCK_MS = 5 * 60_000, MAX_TRACKED = 5_000;
const failures = new Map<string, { n: number; since: number; until: number }>();
const ipv4 = (ip: string) => { const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); return m ? m.slice(1).reduce((n, x) => n * 256 + Number(x), 0) : null; };
/** LOTSE_TRUSTED_PROXIES: reverse proxy on another machine (IPs or IPv4 CIDR, comma-separated); its X-Forwarded-For counts for the login throttle */
export function trustedProxy(ip: string, list = process.env.LOTSE_TRUSTED_PROXIES ?? ''): boolean {
  return list.split(',').map(e => e.trim().toLowerCase()).filter(Boolean).some(e => {
    const [net, bits] = e.split('/'); if (bits === undefined) return normalizeIp(net) === ip;
    const a = ipv4(ip), b = ipv4(net), n = Number(bits);
    return a !== null && b !== null && n >= 0 && n <= 32 && (n === 0 || (a >>> (32 - n)) === (b >>> (32 - n)));
  });
}
/** Who counts: the socket address; if a local or trusted reverse proxy sits in front, the last X-Forwarded-For entry (appended by the proxy). */
export function clientKey(peer: string | null, forwardedFor: string | null): string {
  const p = normalizeIp(peer ?? ''), last = hopsOf(forwardedFor).at(-1);
  return (p && !localHop(p) && !trustedProxy(p) ? p : last || p) || 'unbekannt';
}
/** Remaining block time in ms (0 = not blocked) */
export function loginBlocked(key: string, now = Date.now()): number {
  const f = failures.get(key);
  return f && f.until > now ? f.until - now : 0;
}
export function loginFailed(key: string, now = Date.now()) {
  let f = failures.get(key);
  if (!f || now - f.since > FAIL_WINDOW) f = { n: 0, since: now, until: 0 };
  if (++f.n >= FAIL_MAX) { f.until = now + BLOCK_MS; f.n = 0; f.since = now; }
  failures.delete(key); failures.set(key, f); // newest last
  if (failures.size > MAX_TRACKED) {
    for (const [k, v] of failures) if (v.until <= now && now - v.since > FAIL_WINDOW) failures.delete(k);
    for (const k of failures.keys()) { if (failures.size <= MAX_TRACKED) break; failures.delete(k); } // oldest first
  }
}
export const loginOk = (key: string) => { failures.delete(key); };
export const loginLimitSize = () => failures.size;
export const resetLoginLimit = () => failures.clear(); // Tests

// Shop JS calls widget/asset paths without the /shop prefix → also forwarded to the shop proxy (GET only).
// Prefixes per platform: PLATFORM_SETTINGS[kind].storefrontPaths; the /shop route only lets through those of the active platform.

const encoder = new TextEncoder();
async function sha256(text: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))); }
function constantTimeEqual(a: Uint8Array, b: Uint8Array) { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i % b.length]; return d === 0; }

/** Basic auth: Base64 → UTF-8 (atob alone yields Latin-1, umlauts in the password failed). null = no credentials sent (not a failed attempt). */
export async function passwordOk(authorization: string | null, password: string): Promise<boolean | null> {
  const [scheme, b64 = ''] = (authorization ?? '').trim().split(/\s+/);
  if (!authorization || scheme.toLowerCase() !== 'basic') return null;
  let given = ''; try { given = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))).split(':').slice(1).join(':'); } catch { return false; }
  return constantTimeEqual(await sha256(given), await sha256(password));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/api/ping') return NextResponse.next(); // Healthcheck

  const hostHeader = req.headers.get('host') ?? '', forwardedFor = req.headers.get('x-forwarded-for'), peer = req.headers.get(PEER_HEADER);
  if (!hostAllowed(hostHeader, forwardedFor, peer)) return new NextResponse('Host nicht erlaubt', { status: 403 });

  // Foreign pages may fire no-cors GETs at localhost (img/script/fetch), and some GETs have side effects (crawl, preview refresh).
  // The browser marks these as cross-site; only that is rejected. Without the header (curl, MCP agent process, tests) allowed.
  if (pathname.startsWith('/api/') && req.headers.get('sec-fetch-site')?.trim().toLowerCase() === 'cross-site') return new NextResponse('Aufruf von fremder Seite nicht erlaubt', { status: 403 });

  const origin = req.headers.get('origin');
  const writes = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (writes && origin) {
    let ok = false; try { ok = new URL(origin).host === hostHeader; } catch {} // Origin "null" (sandboxed preview) fails here
    if (!ok) return new NextResponse('Origin nicht erlaubt', { status: 403 });
  }
  // Double safeguard: writing calls only with the UI's marker (lib/api.ts); a simple request from an embedded
  // preview or a foreign page doesn't have it. MCP (Codex) has its own token per chat.
  if (writes && !pathname.startsWith('/api/mcp/') && req.headers.get('x-lotse') !== '1') return new NextResponse('Kennung der Oberfläche fehlt', { status: 403 });

  // MCP endpoint for Codex: own token per chat instead of browser login
  const password = process.env.LOTSE_PASSWORD;
  if (password && !pathname.startsWith('/api/mcp/')) {
    const key = clientKey(peer, forwardedFor), wait = loginBlocked(key);
    if (wait) return new NextResponse('Zu viele Fehlversuche, bitte später erneut versuchen', { status: 429, headers: { 'retry-after': String(Math.ceil(wait / 1000)) } });
    const ok = await passwordOk(req.headers.get('authorization'), password);
    if (!ok) {
      if (ok === false) loginFailed(key); // without credentials (the browser's first request) it doesn't count
      return new NextResponse('Login erforderlich', { status: 401, headers: { 'www-authenticate': 'Basic realm="Lotse", charset="UTF-8"' } });
    }
    loginOk(key);
  }

  const prefix = storefrontPrefix(pathname);
  if (prefix) {
    if (req.method !== 'GET') return new NextResponse(null, { status: 405 });
    const url = req.nextUrl.clone(); url.pathname = '/shop' + pathname;
    const headers = new Headers(req.headers); headers.set(STOREFRONT_PREFIX_HEADER, prefix);
    return NextResponse.rewrite(url, { request: { headers } });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
