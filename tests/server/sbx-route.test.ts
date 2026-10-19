import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { NextRequest } from 'next/server';
import '../isolate-data';
/* eslint-disable @typescript-eslint/no-explicit-any -- route context */

// /sbx/<id>.<key>/…: the preview of a task's sandbox storefront against FakeRunner's per-container node:http storefront.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const E = await import('../../src/server/sandbox/env');
const T = await import('../../src/server/sandbox/tasks');
const P = await import('../../src/server/sandbox/preview');
const R = await import('../../src/server/sandbox/reconcile');
const route = await import('../../src/app/sbx/[task]/[[...path]]/route');

const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
E.saveSandbox({ enabled: true });
after(async () => { R.resetReconcile(); await fake.close(); });

interface Seen { method: string; url: string; host: string; cookie: string; body: string; headers: http.IncomingHttpHeaders }
const seen: Seen[] = [];
type Answer = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
const DEFAULT: Answer = (_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'deny', 'set-cookie': ['session-=abc; path=/; HttpOnly', 'other=1; Max-Age=60'] });
  res.end('<!doctype html><html><head><link rel="stylesheet" href="http://localhost/theme/a.css"><script>var r="http:\\/\\/localhost\\/widgets\\/x"</script></head><body><h1>Sandbox-Shop</h1><form action="/checkout/line-item/add" method="post"></form><img src="/media/a.png" srcset="/media/a.png 1x, /media/b.png 2x"></body></html>');
};
let answer = DEFAULT;
fake.storefront = (req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    seen.push({ method: req.method ?? '', url: req.url ?? '', host: req.headers.host ?? '', cookie: req.headers.cookie ?? '', body, headers: req.headers });
    answer(req, res, body);
  });
  return true;
};

/** A task whose container runs (as after the setup), or with the given status. */
async function readyTask(status: 'ready' | 'paused' | 'failed' | 'done' = 'ready') {
  answer = DEFAULT;
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Vorschau', goal: '', repo: 'acme/shop-theme', baseBranch: 'main' });
  const spec = { name: `lotse-sbx-${t.id.replace(/_/g, '-')}`, Image: 'dockware/shopware:6.7.15.1', Labels: { 'lotse.managed': '1', 'lotse.task': t.id }, HostConfig: { NetworkMode: 'lotse-sandbox' } };
  t.containerId = await fake.create(spec);
  if (status !== 'paused') await fake.start(t.containerId);
  const wt = T.taskPaths(t.id).worktree;
  fs.mkdirSync(wt, { recursive: true }); fs.writeFileSync(path.join(wt, 'composer.json'), '{}');
  Object.assign(t, { status, containerRunning: status !== 'paused', mode: 'local', layout: { kind: 'theme', name: 'AcmeTheme', pluginDir: 'custom/plugins/AcmeTheme' } });
  T.saveTask(t, false);
  return t;
}
const call = (url: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}) => {
  const req = new NextRequest(`http://127.0.0.1:3333${url}`, { method: init.method ?? 'GET', headers: { host: '127.0.0.1:3333', ...init.headers }, body: init.body });
  const m = new URL(req.url).pathname.match(/^\/sbx\/([^/]*)/);
  const handler = (route as any)[req.method] as (r: NextRequest, c: any) => Promise<Response>;
  return handler(req, { params: Promise.resolve({ task: m?.[1] ?? '' }) });
};

const pre = (t: { id: string }) => T.previewPath(t.id);
const esc = (t: { id: string }) => pre(t).replace(/\//g, '\\/');

test('HTML: shim at the head start, frame script, URLs below the prefix, sandbox CSP with form-action self; upstream gets Host: localhost', async () => {
  const t = await readyTask();
  assert.match(pre(t), new RegExp(`^/sbx/${t.id}\\.[a-f0-9]{20}$`));
  const r = await call(`${pre(t)}/navigation/abc?p=2`, { headers: { cookie: 'lotse_lang=de; secret=1', authorization: 'Basic eDp5' } });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /^<!doctype html><html><head><script>\(function\(\)\{var P="\/sbx\//, 'shim before the shop scripts');
  assert.match(body, /<script>\(function\(\)\{var P=window\.parent/, 'frame script for marking/scrolling');
  assert.match(body, /<style>\.sf-toolbar,[^<]*\.cookie-permission-container\{display:none!important\}<\/style>/, 'debug toolbar and cookie notice hidden in the preview');
  assert.ok(body.includes(`href="${pre(t)}/theme/a.css"`), 'absolute origin rewritten');
  assert.ok(body.includes(`var r="${esc(t)}\\/widgets\\/x"`), 'JSON-escaped origin rewritten');
  assert.ok(body.includes(`action="${pre(t)}/checkout/line-item/add"`), 'root-relative form action rewritten');
  assert.ok(body.includes(`srcset="${pre(t)}/media/a.png 1x, ${pre(t)}/media/b.png 2x"`));
  const csp = r.headers.get('content-security-policy') ?? '';
  assert.match(csp, /^sandbox allow-scripts allow-forms;/);
  assert.doesNotMatch(csp, /allow-same-origin/);
  for (const d of ["connect-src 'self'", "form-action 'self'", "frame-ancestors 'self'"]) assert.ok(csp.includes(d), d);
  assert.equal(r.headers.get('set-cookie'), null, 'upstream cookies never reach the browser');
  assert.equal(r.headers.get('x-frame-options'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const up = seen.at(-1)!;
  assert.equal(up.url, '/navigation/abc?p=2');
  assert.equal(up.host, 'localhost');
  assert.equal(up.cookie, '', 'browser cookies do not go to the sandbox');
  assert.equal(up.headers.authorization, undefined);
  // the next page: jar cookies go upstream, the shim only gets the non-HttpOnly ones
  const again = await (await call(`${pre(t)}/`)).text();
  assert.equal(seen.at(-1)!.cookie, 'session-=abc; other=1');
  assert.ok(again.includes('[["other","1"]]'), 'readable cookie for document.cookie');
  assert.ok(!again.includes('"abc"'), 'HttpOnly session not exposed to scripts');
});

test('cookie jar: the sandbox session is kept server-side and sent along; POST body forwarded (add to cart); script cookies synced', async () => {
  const t = await readyTask();
  const cart: string[] = [];
  answer = (req, res, body) => {
    if (req.method === 'POST' && req.url === '/checkout/line-item/add') { cart.push(body); res.writeHead(302, { location: 'http://localhost/checkout/cart', 'set-cookie': 'session-=cart1; path=/; HttpOnly' }); res.end(); return; }
    if (req.url === '/checkout/cart') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<p>${req.headers.cookie?.includes('session-=cart1') ? cart.join(',') : 'leer'}</p>`); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session-=s1; path=/; HttpOnly' }); res.end('<p>home</p>');
  };
  await call(`${pre(t)}/`);
  const add = await call(`${pre(t)}/checkout/line-item/add`, { method: 'POST', headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded', cookie: 'session-=browser' }, body: 'lineItems[x][id]=x&lineItems[x][quantity]=1' });
  assert.equal(add.status, 302);
  assert.equal(add.headers.get('location'), `${pre(t)}/checkout/cart`, 'redirect stays in the prefix, not followed server-side');
  assert.equal(seen.at(-1)!.cookie, 'session-=s1', 'jar cookie, not the browser one');
  assert.equal(seen.at(-1)!.headers['content-type'], 'application/x-www-form-urlencoded');
  const page = await call(`${pre(t)}/checkout/cart`);
  assert.match(await page.text(), /<p>lineItems\[x\]\[id\]=x&lineItems\[x\]\[quantity\]=1<\/p>/);
  // document.cookie of the preview (shim → sendBeacon): stored, sent upstream, but cannot replace the HttpOnly session
  const n = seen.length;
  for (const c of ['cookie-preference=1; path=/; max-age=3600', 'session-=evil']) assert.equal((await call(`${pre(t)}/__lotse/cookie`, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: c })).status, 204);
  assert.equal(seen.length, n, 'never forwarded');
  assert.equal(P.jarCookie(t.id), 'session-=cart1; cookie-preference=1');
  P.storeCookies(t.id, ['cookie-preference=; Max-Age=0']);
  assert.equal(P.jarCookie(t.id), 'session-=cart1', 'Max-Age=0 removes the cookie');
  const other = await readyTask();
  assert.equal(P.jarCookie(other.id), null, 'one jar per task');
});

test('redirects: to the live domain or a foreign host not followed (502); relative ones stay in the prefix', async () => {
  const t = await readyTask();
  for (const loc of ['https://shop.example/x', 'http://169.254.169.254/latest', 'http://user:pw@localhost/x', 'javascript:alert(1)']) {
    answer = (_q, res) => { res.writeHead(302, { location: loc }); res.end(); };
    const n = seen.length;
    const r = await call(`${pre(t)}/alt`);
    assert.equal(r.status, 502, loc);
    assert.equal(r.headers.get('location'), null);
    assert.equal(seen.length, n + 1, 'only the one sandbox request');
  }
  answer = (_q, res) => { res.writeHead(301, { location: '/neu?x=1' }); res.end(); };
  assert.equal((await call(`${pre(t)}/alt`)).headers.get('location'), `${pre(t)}/neu?x=1`);
});

test('unknown, malformed, traversal ids or a wrong key 404; a stopped or finished task 410; a base from query or header is ignored', async () => {
  const t = await readyTask();
  const wrong = `${t.id}.${'0'.repeat(20)}`;
  for (const seg of [t.id, wrong, `${t.id}.${T.previewKey(t.id).toUpperCase()}`, 't_aaaaaaaaaaaa.0123456789abcdef0123', 'x', '..', '%2e%2e']) {
    const n = seen.length;
    assert.equal((await call(`/sbx/${seg}/`)).status, 404, seg);
    assert.equal((await call(`/sbx/${seg}/x`, { method: 'POST', body: 'a=1' })).status, 404, `POST ${seg}`);
    assert.equal(seen.length, n);
  }
  for (const s of ['failed', 'done'] as const) {
    const x = await readyTask(s);
    if (s === 'failed') { const y = T.getTask(x.id)!; y.containerRunning = false; T.saveTask(y, false); }
    assert.equal((await call(`${pre(x)}/`)).status, 410, s);
  }
  answer = (_q, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); };
  const n = seen.length;
  const r = await call(`${pre(t)}/x?base=http://169.254.169.254&upstream=http://evil.test`, { headers: { 'x-forwarded-host': 'evil.test', 'x-sandbox-base': 'http://evil.test', referer: 'http://evil.test/' } });
  assert.equal(r.status, 200);
  assert.equal(seen.length, n + 1);
  assert.equal(seen.at(-1)!.url, '/x?base=http://169.254.169.254&upstream=http://evil.test', 'query only goes to the sandbox as part of the path');
  assert.equal(seen.at(-1)!.host, 'localhost');
  assert.equal((await call(`${pre(t)}//evil.test/x`)).status, 502, 'a path cannot name another host');
  assert.equal(seen.length, n + 1);
});

test('limits and CORS: body above 2 MB 413; ajax of the opaque-origin preview (Origin null) allowed, preflight only with the key', async () => {
  const t = await readyTask();
  answer = (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"url":"http:\\/\\/localhost\\/x"}'); };
  assert.equal((await call(`${pre(t)}/x`, { method: 'POST', body: 'x'.repeat(P.MAX_REQUEST_BODY + 1) })).status, 413);
  const json = await call(`${pre(t)}/widgets/x`, { headers: { origin: 'null' } });
  assert.equal(json.headers.get('access-control-allow-origin'), 'null');
  assert.equal(await json.text(), `{"url":"${esc(t)}\\/x"}`, 'JSON answers rewritten too');
  assert.equal((await call(`${pre(t)}/widgets/x`, { headers: { origin: 'https://evil.test' } })).headers.get('access-control-allow-origin'), null);
  const pf = await call(`${pre(t)}/widgets/x`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-headers': 'X-Requested-With, Cookie' } });
  assert.equal(pf.status, 204);
  assert.equal(pf.headers.get('access-control-allow-origin'), 'null');
  assert.equal(pf.headers.get('access-control-allow-headers'), 'x-requested-with');
  assert.equal((await call(`/sbx/${t.id}.${'0'.repeat(20)}/widgets/x`, { method: 'OPTIONS', headers: { origin: 'null' } })).status, 404);
});

test('a paused task wakes on preview access ("Umgebung startet …", reloads itself); a wrong key does not wake it', async () => {
  const t = await readyTask('paused');
  assert.equal((await call(`/sbx/${t.id}.${'f'.repeat(20)}/`)).status, 404);
  assert.equal(T.getTask(t.id)!.status, 'paused');
  const r = await call(`${pre(t)}/`, { headers: { 'accept-language': 'de' } });
  assert.equal(r.status, 503);
  const html = await r.text();
  assert.match(html, /Umgebung startet …/);
  assert.match(html, /http-equiv="refresh" content="3"/);
  assert.ok(['waking', 'ready'].includes(T.getTask(t.id)!.status));
  const end = Date.now() + 10_000;
  while (T.getTask(t.id)!.status !== 'ready') { if (Date.now() > end) throw new Error(`still ${T.getTask(t.id)!.status}: ${T.getTask(t.id)!.error}`); await new Promise(res => setTimeout(res, 20)); }
  answer = (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>wach</p>'); };
  const again = await call(`${pre(t)}/`);
  assert.equal(again.status, 200);
  assert.match(await again.text(), /<p>wach<\/p>/);
  assert.match((await (await call(`${pre(t)}/`, { headers: { 'accept-language': 'en' } })).text()), /wach/);
});

test('a start that failed is not retried by the preview itself (no endless reloads): error page with one explicit "Erneut starten"', async () => {
  const t = await readyTask('paused');
  const failing = fake.start.bind(fake);
  let starts = 0;
  fake.start = async id => { if (id === t.containerId) { starts++; throw new Error('Container starten: Docker meldet HTTP 500 – kaputt'); } return failing(id); };
  try {
    assert.equal((await call(`${pre(t)}/checkout/cart`, { headers: { 'accept-language': 'de' } })).status, 503);
    const end = Date.now() + 10_000;
    while (T.getTask(t.id)!.status !== 'paused' || !T.getTask(t.id)!.error) { if (Date.now() > end) throw new Error('wake did not fail'); await new Promise(res => setTimeout(res, 20)); }
    assert.equal(starts, 1);
    assert.equal(P.wakeFailed(T.getTask(t.id)!), true);
    // the reload of "Umgebung startet …" (and a preview in its own tab) only shows the error now
    for (let i = 0; i < 3; i++) {
      const r = await call(`${pre(t)}/checkout/cart`, { headers: { 'accept-language': 'de' } });
      assert.equal(r.status, 503);
      const html = await r.text();
      assert.match(html, /Start fehlgeschlagen/);
      assert.match(html, /Fortsetzen fehlgeschlagen: Container starten: Docker meldet HTTP 500/);
      assert.doesNotMatch(html, /http-equiv="refresh"/, 'no automatic reload');
      assert.ok(html.includes(`href="${pre(t)}/__lotse/wake?to=%2Fcheckout%2Fcart">Erneut starten</a>`));
    }
    assert.equal(starts, 1, 'no further start without a click');
    assert.match(await (await call(`${pre(t)}/`, { headers: { 'accept-language': 'en' } })).text(), /Start failed[\s\S]*Start again/);
    // the click: one more start, then on to the page that was asked for (only below the prefix)
    const click = await call(`${pre(t)}/__lotse/wake?to=%2Fcheckout%2Fcart`);
    assert.equal(click.status, 303);
    assert.equal(click.headers.get('location'), `${pre(t)}/checkout/cart`);
    while (T.getTask(t.id)!.status === 'waking') await new Promise(res => setTimeout(res, 20));
    assert.equal(starts, 2);
  } finally { fake.start = failing; }
  // works again: the wake path starts it, then only redirects
  const ok = await call(`${pre(t)}/__lotse/wake?to=%2F`);
  assert.equal(ok.status, 303);
  await waitReady(t.id);
  assert.equal(T.getTask(t.id)!.error, null);
  assert.equal((await call(`${pre(t)}/__lotse/wake?to=%2Fx`)).headers.get('location'), `${pre(t)}/x`);
  for (const bad of ['%2F%2Fevil.example', 'https%3A%2F%2Fevil.example', '%2F__lotse%2Fwake', '%2F%5Cevil']) assert.equal((await call(`${pre(t)}/__lotse/wake?to=${bad}`)).headers.get('location'), `${pre(t)}/`, bad);
});

const waitReady = async (id: string) => {
  const end = Date.now() + 10_000;
  while (T.getTask(id)!.status !== 'ready') { if (Date.now() > end) throw new Error(`still ${T.getTask(id)!.status}: ${T.getTask(id)!.error}`); await new Promise(res => setTimeout(res, 20)); }
};

test('container stopped outside Lotse (local mode): the preview wakes it, with or without a cached port', async () => {
  for (const warm of [true, false]) {
    const t = await readyTask();
    if (warm) assert.equal((await call(`${pre(t)}/`)).status, 200);
    await fake.stop(t.containerId!); // docker stop / OOM behind Lotse's back; the task still says ready
    const r = await call(`${pre(t)}/`, { headers: { 'accept-language': 'de' } });
    assert.equal(r.status, 503, `warm=${warm}`);
    assert.match(await r.text(), /Umgebung startet …/);
    await waitReady(t.id);
    answer = (_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>wieder da</p>'); };
    assert.match(await (await call(`${pre(t)}/`)).text(), /wieder da/, 'new port after the restart');
  }
});

test('a request in flight while Lotse pauses the task does not wake it again; errors localized, not doubled', async () => {
  const t = await readyTask();
  answer = (req, res) => { const x = T.getTask(t.id)!; x.status = 'paused'; T.saveTask(x, false); res.socket?.destroy(); };
  const r = await call(`${pre(t)}/`, { headers: { 'accept-language': 'en' } });
  assert.equal(r.status, 502);
  assert.equal(await r.text(), 'Sandbox not reachable: ECONNRESET');
  assert.equal(T.getTask(t.id)!.status, 'paused', 'no wake');
  const u = await readyTask();
  answer = (_q, res) => { res.socket?.destroy(); }; // Apache down, container running: nothing to wake
  const e = await call(`${pre(u)}/`, { headers: { 'accept-language': 'en' } });
  assert.equal(e.status, 502);
  assert.equal(await e.text(), 'Sandbox not reachable: ECONNRESET');
  assert.equal(T.getTask(u.id)!.status, 'ready');
});

test('Sandbox Coding switched off: 403, nothing contacted', async () => {
  const t = await readyTask();
  E.saveSandbox({ enabled: false });
  try {
    const n = seen.length;
    assert.equal((await call(`${pre(t)}/`)).status, 403);
    assert.equal(seen.length, n);
  } finally { E.saveSandbox({ enabled: true }); }
});

test('"Bilder vom Live-Shop": a media file missing in the sandbox (404) comes from the live shop, server side; nothing else does', async () => {
  const M = await import('../../src/server/media');
  const live: string[] = [];
  M.setTrustedOrigins(async () => ['https://live.example']);
  M.setFetcher((async (u: string) => {
    live.push(String(u));
    if (String(u).endsWith('.svg')) return new Response('<svg onload="x()"/>', { headers: { 'content-type': 'image/svg+xml' } });
    if (String(u).includes('missing')) return new Response('nope', { status: 404 });
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
  }) as any);
  const t = await readyTask();
  answer = (_q, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('not found'); };
  // without a live shop set: the sandbox's 404 stands
  assert.equal((await call(`${pre(t)}/media/ab/cd/bild.png`)).status, 404);
  assert.equal(live.length, 0);
  T.saveTask({ ...T.getTask(t.id)!, setup: { source: 'repo', mode: 'auto', commands: [], env: [], mediaOrigin: 'https://live.example' } }, false);
  const r = await call(`${pre(t)}/media/ab/cd/bild.png?ts=1`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(live.at(-1), 'https://live.example/media/ab/cd/bild.png', 'the path only, no query');
  assert.equal((await call(`${pre(t)}/thumbnail/ab/bild_400x400.png`)).status, 200);
  // other paths, SVG and what the live shop lacks: the sandbox's 404
  const n = live.length;
  assert.equal((await call(`${pre(t)}/account/login`)).status, 404);
  assert.equal((await call(`${pre(t)}/theme/abc/app.css`)).status, 404);
  assert.equal(live.length, n, 'only /media/ and /thumbnail/ fall back');
  assert.equal((await call(`${pre(t)}/media/logo.svg`)).status, 404);
  assert.equal((await call(`${pre(t)}/media/missing.png`)).status, 404);
  // the sandbox's own file wins
  answer = (_q, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end('own'); };
  const own = await call(`${pre(t)}/media/ab/cd/bild.png`);
  assert.equal(await own.text(), 'own');
  M.setTrustedOrigins(async () => []);
});
