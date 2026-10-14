// Läuft vor jeder Anfrage: Host-/Origin-Prüfung (Schutz vor DNS-Rebinding und CSRF), optionaler Login,
// und Weiterleitung der Storefront-Pfade an den Shop-Proxy.
import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, storefrontPrefix } from '@/lib/platforms';
import { LOCAL_HOSTS, PEER_HEADER, extraAllowedHosts, normalizeIp } from '@/server/access';

const LOOPBACK_HOPS = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);
/** Docker-Bridge/VM-Gateway (Docker Desktop, OrbStack, Linux-Bridge): privat, nie öffentlich. */
function privateHop(hop: string): boolean {
  const m = hop.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return /^f[cd][0-9a-f]{2}:/.test(hop);
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}
/** Im Container mit Loopback-Publish (LOTSE_BIND) erreicht nur der eigene Rechner den Port; Next setzt dort X-Forwarded-For auf das Bridge-Gateway. */
const dockerLoopbackPublish = () => process.env.AICB_DOCKER === '1' && LOOPBACK_HOPS.has((process.env.LOTSE_BIND ?? '').toLowerCase());
const allowedHosts = () => new Set([...LOCAL_HOSTS, ...extraAllowedHosts(process.env.ALLOWED_HOSTS)]);

/** Host ohne Port. [::1]:3333 bleibt [::1]; nacktes ::1 verliert nicht die letzte Gruppe. */
function hostName(host: string): string {
  const value = host.trim();
  if (value.startsWith('[')) return value.replace(/]:\d+$/, ']');
  if ((value.match(/:/g) ?? []).length > 1) return value;
  return value.replace(/:\d+$/, '');
}

/** Absender ist dieser Rechner (im Container mit Loopback-Publish zusätzlich private Gateway-Adressen, nie öffentliche) */
const localHop = (hop: string) => LOOPBACK_HOPS.has(hop) || (dockerLoopbackPublish() && privateHop(hop));
const hopsOf = (forwardedFor: string | null) => (forwardedFor ?? '').split(',').map(normalizeIp).filter(Boolean);

/** Loopback-Namen nur von Loopback: jeder Hop in X-Forwarded-For und die Socket-Adresse (peer, von instrumentation.ts gestempelt) müssen lokal sein.
 *  X-Forwarded-For allein reicht nicht: Next übernimmt einen vom Client mitgeschickten Wert unverändert. Ohne beides (Tests) erlaubt. */
export function hostAllowed(host: string, forwardedFor: string | null, peer: string | null = null): boolean {
  const name = hostName(host);
  if (LOCAL_HOSTS.includes(name)) return [...hopsOf(forwardedFor), ...hopsOf(peer)].every(localHop);
  return allowedHosts().has(name);
}

// ---- Login-Bremse: nach FAIL_MAX falschen Passwörtern in FAIL_WINDOW sperrt die Adresse für BLOCK_MS (429). Speicher begrenzt. ----
const FAIL_MAX = 10, FAIL_WINDOW = 15 * 60_000, BLOCK_MS = 5 * 60_000, MAX_TRACKED = 5_000;
const failures = new Map<string, { n: number; since: number; until: number }>();
/** Wer zählt: die Socket-Adresse; steht davor ein lokaler Reverse-Proxy, der letzte Eintrag in X-Forwarded-For (den hat der Proxy angehängt). */
export function clientKey(peer: string | null, forwardedFor: string | null): string {
  const p = normalizeIp(peer ?? ''), last = hopsOf(forwardedFor).at(-1);
  return (p && !localHop(p) ? p : last || p) || 'unbekannt';
}
/** Restliche Sperrzeit in ms (0 = nicht gesperrt) */
export function loginBlocked(key: string, now = Date.now()): number {
  const f = failures.get(key);
  return f && f.until > now ? f.until - now : 0;
}
export function loginFailed(key: string, now = Date.now()) {
  let f = failures.get(key);
  if (!f || now - f.since > FAIL_WINDOW) f = { n: 0, since: now, until: 0 };
  if (++f.n >= FAIL_MAX) { f.until = now + BLOCK_MS; f.n = 0; f.since = now; }
  failures.delete(key); failures.set(key, f); // neueste zuletzt
  if (failures.size > MAX_TRACKED) {
    for (const [k, v] of failures) if (v.until <= now && now - v.since > FAIL_WINDOW) failures.delete(k);
    for (const k of failures.keys()) { if (failures.size <= MAX_TRACKED) break; failures.delete(k); } // älteste zuerst
  }
}
export const loginOk = (key: string) => { failures.delete(key); };
export const loginLimitSize = () => failures.size;
export const resetLoginLimit = () => failures.clear(); // Tests

// Shop-JS ruft Widget-/Asset-Pfade ohne /shop-Präfix auf → ebenfalls an den Shop-Proxy (nur GET).
// Präfixe je Plattform: PLATFORM_SETTINGS[kind].storefrontPaths; die /shop-Route lässt nur die der aktiven Plattform durch.

const encoder = new TextEncoder();
async function sha256(text: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))); }
function constantTimeEqual(a: Uint8Array, b: Uint8Array) { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i % b.length]; return d === 0; }

/** Basic-Auth: Base64 → UTF-8 (atob allein liefert Latin-1, Umlaute im Passwort scheiterten). null = keine Zugangsdaten gesendet (kein Fehlversuch). */
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

  const origin = req.headers.get('origin');
  const writes = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  if (writes && origin) {
    let ok = false; try { ok = new URL(origin).host === hostHeader; } catch {} // Origin "null" (sandboxed Vorschau) fällt hier durch
    if (!ok) return new NextResponse('Origin nicht erlaubt', { status: 403 });
  }
  // Doppelboden: schreibende Aufrufe nur mit der Kennung der Oberfläche (lib/api.ts); ein Simple-Request aus einer eingebetteten
  // Vorschau oder fremden Seite hat sie nicht. MCP (Codex) hat sein eigenes Token je Chat.
  if (writes && !pathname.startsWith('/api/mcp/') && req.headers.get('x-lotse') !== '1') return new NextResponse('Kennung der Oberfläche fehlt', { status: 403 });

  // MCP-Endpunkt für Codex: eigenes Token je Chat statt Browser-Login
  const password = process.env.LOTSE_PASSWORD;
  if (password && !pathname.startsWith('/api/mcp/')) {
    const key = clientKey(peer, forwardedFor), wait = loginBlocked(key);
    if (wait) return new NextResponse('Zu viele Fehlversuche, bitte später erneut versuchen', { status: 429, headers: { 'retry-after': String(Math.ceil(wait / 1000)) } });
    const ok = await passwordOk(req.headers.get('authorization'), password);
    if (!ok) {
      if (ok === false) loginFailed(key); // ohne Zugangsdaten (erste Anfrage des Browsers) zählt nicht
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
