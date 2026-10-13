// Läuft vor jeder Anfrage: Host-/Origin-Prüfung (Schutz vor DNS-Rebinding und CSRF), optionaler Login,
// und Weiterleitung der Storefront-Pfade an den Shop-Proxy.
import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, storefrontPrefix } from '@/lib/platforms';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
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
const allowedHosts = () => new Set([...LOCAL_HOSTS, ...(process.env.ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean)]);

/** Host ohne Port. [::1]:3333 bleibt [::1]; nacktes ::1 verliert nicht die letzte Gruppe. */
function hostName(host: string): string {
  const value = host.trim();
  if (value.startsWith('[')) return value.replace(/]:\d+$/, ']');
  if ((value.match(/:/g) ?? []).length > 1) return value;
  return value.replace(/:\d+$/, '');
}

/** Loopback-Namen nur von Loopback: ohne X-Forwarded-For (lokales dev, Smoke) oder wenn jeder Hop selbst Loopback ist
 *  (im Container mit Loopback-Publish zusätzlich private Gateway-Adressen, nie öffentliche). */
export function hostAllowed(host: string, forwardedFor: string | null): boolean {
  const name = hostName(host);
  if (LOCAL_HOSTS.includes(name)) {
    if (forwardedFor == null || forwardedFor.trim() === '') return true;
    const hops = forwardedFor.split(',').map(hop => hop.trim().toLowerCase()).filter(Boolean);
    const docker = dockerLoopbackPublish();
    return hops.every(hop => LOOPBACK_HOPS.has(hop) || (docker && privateHop(hop)));
  }
  return allowedHosts().has(name);
}

// Shop-JS ruft Widget-/Asset-Pfade ohne /shop-Präfix auf → ebenfalls an den Shop-Proxy (nur GET).
// Präfixe je Plattform: PLATFORM_SETTINGS[kind].storefrontPaths; die /shop-Route lässt nur die der aktiven Plattform durch.

const encoder = new TextEncoder();
async function sha256(text: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))); }
function constantTimeEqual(a: Uint8Array, b: Uint8Array) { let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i % b.length]; return d === 0; }

async function passwordOk(req: NextRequest, password: string) {
  const [scheme, b64 = ''] = (req.headers.get('authorization') ?? '').split(' ');
  if (scheme !== 'Basic') return false;
  let given = ''; try { given = atob(b64).split(':').slice(1).join(':'); } catch { return false; }
  return constantTimeEqual(await sha256(given), await sha256(password));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/api/ping') return NextResponse.next(); // Healthcheck

  const hostHeader = req.headers.get('host') ?? '';
  if (!hostAllowed(hostHeader, req.headers.get('x-forwarded-for'))) return new NextResponse('Host nicht erlaubt', { status: 403 });

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
  if (password && !pathname.startsWith('/api/mcp/') && !(await passwordOk(req, password)))
    return new NextResponse('Login erforderlich', { status: 401, headers: { 'www-authenticate': 'Basic realm="Lotse", charset="UTF-8"' } });

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
