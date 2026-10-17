import type { NextRequest } from 'next/server';
import { messages } from '@/lib/i18n';
import { requestLocale } from '@/lib/i18n/locales';
import { errMsg } from '@/server/http';
import { injectAtHeadStart } from '@/server/real-page';
import { storefrontRewrite } from '@/server/runtime';
import { sandboxForbidden } from '@/server/sandbox/env';
import { getTask } from '@/server/sandbox/tasks';
import { startWake, touchTask } from '@/server/sandbox/jobs';
import { COOKIE_SYNC_PATH, MAX_REQUEST_BODY, PREVIEW_METHODS, PREVIEW_TIDY_CSS, SANDBOX_BASE, forgetUpstream, fetchUpstream, previewShim, previewState, sandboxLocation, sandboxPrefix, sandboxUpstream, scriptCookies, storeCookies, taskOfSegment, upstreamHeaders } from '@/server/sandbox/preview';
import { ensureReconciled } from '@/server/sandbox/reconcile';
import { NO_BODY, relayResponse, rewriteRootRelative, textResponse } from '@/server/storefront-proxy';

export const dynamic = 'force-dynamic';

/** On top of the /shop CSP: sandbox scripts talk only to Lotse (which forwards to this sandbox only), forms only to Lotse, no foreign framing. */
const SBX_CSP = "connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'self'";
const PAGE_CSP = "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'";
/** Ajax of the opaque-origin preview arrives with Origin "null" and needs CORS. The key in the path already proves the page is ours. */
const corsFor = (req: Request): Record<string, string> => (req.headers.get('origin') === 'null' ? { 'access-control-allow-origin': 'null', vary: 'Origin' } : { vary: 'Origin' });
const CORS_HEADER = /^[a-z0-9-]{1,64}$/;

type Ctx = { params: Promise<{ task: string; path?: string[] }> };

/** Small status page (starting, stopped, not found); `refresh` = reload after n seconds (the environment is starting). */
function page(status: number, lang: string, title: string, text: string, refresh?: number): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title>`
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;color:#2e2e38;background:#f6f4ef}main{max-width:420px;padding:24px;text-align:center}h1{font-size:18px;margin:0 0 6px}p{margin:0;color:#6b6b76}</style>'
    + `</head><body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, ...(refresh ? { 'retry-after': String(refresh) } : {}) } });
}

const codeOf = (e: unknown) => String((e as { code?: unknown }).code ?? '');
const isUnreachable = (e: unknown) => ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ENOTRUNNING'].includes(codeOf(e));

// Preview of a task's sandbox storefront: /sbx/<id>.<key>/… Only the task's own container is ever contacted (preview.ts), the browser
// never sees its cookies or headers, and every HTML answer runs in an opaque origin (CSP sandbox). A request without the right key is
// treated like an unknown task. Opening the preview of a paused task wakes it ("Umgebung startet …", the page reloads itself).
async function handle(req: NextRequest, { params }: Ctx): Promise<Response> {
  const segment = (await params).task, id = taskOfSegment(segment);
  const lang = requestLocale(req), L = messages(lang).sandbox.preview;
  if (!PREVIEW_METHODS.has(req.method)) return textResponse(L.method, 405, { allow: [...PREVIEW_METHODS].join(', ') });
  const off = sandboxForbidden();
  if (off) return off;
  if (!id) return page(404, lang, L.unknown, L.unknownText);
  await ensureReconciled();
  const st = previewState(id);
  if (st.kind === 'unknown') return page(404, lang, L.unknown, L.unknownText);
  if (st.kind === 'stopped') return page(410, lang, L.stopped, L.stoppedText);
  const starting = () => page(503, lang, L.starting, L.startingText, 3);
  if (st.kind === 'waking') return starting();
  if (st.kind === 'wake') {
    try { await startWake(id); } catch { return page(409, lang, L.stopped, L.stoppedText); } // conflicts (finishing …): the task view tells why
    return starting();
  }
  touchTask(id);

  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_REQUEST_BODY) return textResponse(L.tooLarge, 413);
    body = Buffer.from(await req.arrayBuffer());
    if (body.length > MAX_REQUEST_BODY) return textResponse(L.tooLarge, 413);
  }
  const prefix = sandboxPrefix(id), { pathname, search } = req.nextUrl;
  const rel = pathname === prefix || pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) || '/' : pathname;
  // document.cookie written by the preview's scripts (see previewShim): into the jar, never to the sandbox as a request
  if (rel === COOKIE_SYNC_PATH) {
    if (req.method === 'POST' && body && body.length <= 4096) storeCookies(id, [body.toString('utf8')], { fromScript: true });
    return new Response(null, { status: 204, headers: corsFor(req) });
  }
  try {
    const origin = await sandboxUpstream(st.task);
    const r = await fetchUpstream(origin, { method: req.method, path: rel + search, headers: upstreamHeaders(id, req.headers), body }, req.signal);
    storeCookies(id, r.setCookies);
    const loc = r.headers.get('location');
    if (loc && r.status >= 300 && r.status < 400) {
      const target = sandboxLocation(loc, origin, id);
      if (!target) return textResponse(L.redirectOutside, 502);
      return new Response(null, { status: r.status, headers: { location: target, 'cache-control': 'no-store', ...corsFor(req) } });
    }
    const upstream = new Response(NO_BODY.has(r.status) || req.method === 'HEAD' ? null : new Uint8Array(r.body), { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' } });
    const rewrite = (text: string, mime: string) => {
      const out = storefrontRewrite(mime === 'text/html' || mime === 'text/css' ? rewriteRootRelative(text, prefix, mime) : text, SANDBOX_BASE, prefix);
      return mime === 'text/html' ? injectAtHeadStart(out, previewShim(prefix, scriptCookies(id)) + PREVIEW_TIDY_CSS) : out;
    };
    return await relayResponse(upstream, { rewrite, allText: true, extraCsp: SBX_CSP, headers: corsFor(req) });
  } catch (e) {
    if (!req.signal.aborted && isUnreachable(e)) {
      forgetUpstream(st.task.containerId);
      // The container may have stopped outside Lotse (OOM, docker stop): startWake checks with Docker and wakes it. Not when Lotse
      // itself paused it meanwhile (pause, room for another task): the request was in flight while the container stopped.
      if (getTask(id)?.status === 'ready') {
        const t = await startWake(id).catch(() => null);
        if (t?.status === 'waking') return starting();
      }
    }
    const code = codeOf(e);
    return textResponse(L.unreachable(L.upstream[code] ?? (code || errMsg(e))), 502);
  }
}

/** CORS preflight of the preview's ajax (e.g. X-Requested-With): answered here for a valid key, nothing goes to the sandbox. */
export async function OPTIONS(req: NextRequest, { params }: Ctx): Promise<Response> {
  if (!taskOfSegment((await params).task)) return new Response(null, { status: 404 });
  const asked = (req.headers.get('access-control-request-headers') ?? '').split(',').map(h => h.trim().toLowerCase()).filter(h => CORS_HEADER.test(h) && h !== 'cookie' && h !== 'authorization');
  return new Response(null, { status: 204, headers: { ...corsFor(req), 'access-control-allow-methods': [...PREVIEW_METHODS].join(', '), ...(asked.length ? { 'access-control-allow-headers': asked.join(', ') } : {}), 'access-control-max-age': '600' } });
}

export const GET = handle, HEAD = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
