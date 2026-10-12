// Läuft vor jeder Anfrage: Host-/Origin-Prüfung (Schutz vor DNS-Rebinding und CSRF), optionaler Login,
// und Weiterleitung der Storefront-Pfade an den Shop-Proxy.
import { NextResponse, type NextRequest } from 'next/server';
import { STOREFRONT_PREFIX_HEADER, storefrontPrefix } from '@/lib/platforms';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const allowedHosts = () => new Set([...LOCAL_HOSTS, ...(process.env.ALLOWED_HOSTS ?? '').split(',').map(h => h.trim()).filter(Boolean)]);

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
  const host = hostHeader.replace(/:\d+$/, '');
  if (!allowedHosts().has(host)) return new NextResponse('Host nicht erlaubt', { status: 403 });

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
