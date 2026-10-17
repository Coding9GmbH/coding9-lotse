import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';

delete process.env.LOTSE_PASSWORD;
const req = (path: string, method = 'GET', headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3333${path}`, { method, headers: { host: 'localhost:3333', ...headers } });
const status = async (r: NextRequest) => (await proxy(r)).status;

test('writing calls need the UI identifier; a sandboxed preview (Origin "null") does not get through', async () => {
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'http://localhost:3333', 'x-lotse': '1' })), 200);
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'http://localhost:3333' })), 403, 'without identifier');
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'null', 'x-lotse': '1' })), 403, 'Origin null (sandbox)');
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'https://fremd.test', 'x-lotse': '1' })), 403, 'foreign origin');
  assert.equal(await status(req('/api/approve', 'POST')), 403, 'simple request without origin and identifier (e.g. form)');
  assert.equal(await status(req('/api/settings', 'PUT', { 'x-lotse': '1' })), 200);
  assert.equal(await status(req('/api/chats/x', 'DELETE')), 403);
});

test('reading calls, health check and MCP (own token per chat) stay reachable without identifier', async () => {
  assert.equal(await status(req('/api/chats')), 200);
  assert.equal(await status(req('/api/ping', 'POST')), 200);
  assert.equal(await status(req('/api/mcp/chat1', 'POST', { origin: 'http://localhost:3333' })), 200);
  assert.equal(await status(req('/api/chats', 'GET', { host: 'boese.test' })), 403, 'host check unchanged');
});

test('API calls from foreign pages (Sec-Fetch-Site: cross-site) are rejected, GET included; same-origin, none and missing header pass', async () => {
  for (const [path, method] of [['/api/shopcheck', 'GET'], ['/api/chat', 'GET'], ['/api/chats', 'GET'], ['/api/approve', 'POST'], ['/api/mcp/chat1', 'POST']])
    assert.equal(await status(req(path, method, { 'sec-fetch-site': 'cross-site', 'x-lotse': '1' })), 403, `${method} ${path}`);
  assert.equal(await status(req('/api/shopcheck', 'GET', { 'sec-fetch-site': 'Cross-Site' })), 403, 'case-insensitive');
  assert.equal(await status(req('/api/shopcheck', 'GET', { 'sec-fetch-site': 'same-origin' })), 200);
  assert.equal(await status(req('/api/shopcheck', 'GET', { 'sec-fetch-site': 'same-site' })), 200, 'only cross-site is blocked');
  assert.equal(await status(req('/api/shopcheck', 'GET', { 'sec-fetch-site': 'none' })), 200, 'typed into the address bar');
  assert.equal(await status(req('/api/shopcheck')), 200, 'curl/tests without the header');
  assert.equal(await status(req('/api/mcp/chat1', 'POST')), 200, 'MCP from the local agent process (no Sec-Fetch-Site)');
  assert.equal(await status(req('/api/ping', 'GET', { 'sec-fetch-site': 'cross-site' })), 200, 'health check unchanged');
  assert.equal(await status(req('/', 'GET', { 'sec-fetch-site': 'cross-site' })), 200, 'pages (links from elsewhere) stay reachable');
});

test('sandbox preview: root paths requested from a /sbx/<id>.<key>/ document go to that sandbox, otherwise to /shop or Lotse', async () => {
  const seg = 't_abcdefghijk1.0123456789abcdef0123', css = `http://localhost:3333/sbx/${seg}/theme/a.css`;
  const rewritten = async (r: NextRequest) => (await proxy(r)).headers.get('x-middleware-rewrite');
  assert.equal(await rewritten(req('/theme/font.woff2', 'GET', { referer: css })), `http://localhost:3333/sbx/${seg}/theme/font.woff2`);
  assert.equal(await rewritten(req('/api/chats', 'GET', { referer: css, 'sec-fetch-site': 'cross-site' })), `http://localhost:3333/sbx/${seg}/api/chats`, 'never reaches the Lotse API');
  assert.equal(await rewritten(req('/theme/a.css')), 'http://localhost:3333/shop/theme/a.css', 'without that Referer: live shop');
  assert.equal(await rewritten(req('/theme/a.css', 'GET', { referer: `http://fremd.test/sbx/${seg}/` })), 'http://localhost:3333/shop/theme/a.css', 'other host');
  assert.equal(await rewritten(req('/theme/a.css', 'GET', { referer: 'http://localhost:3333/sbx/t_abcdefghijk1/' })), 'http://localhost:3333/shop/theme/a.css', 'without key');
  assert.equal(await rewritten(req(`/sbx/${seg}/x`, 'GET', { referer: 'http://localhost:3333/sbx/t_other0000000.0123456789abcdef0123/' })), null, 'prefixed paths stay');
});

test('sandbox preview: the opaque-origin preview may write (the route checks the key); other methods 405; with a password the key stands in for the login', async () => {
  const seg = 't_abcdefghijk1.0123456789abcdef0123';
  assert.equal(await status(req(`/sbx/${seg}/checkout/line-item/add`, 'POST', { origin: 'null', 'sec-fetch-site': 'cross-site' })), 200, 'form of the opaque-origin preview');
  assert.equal(await status(req(`/sbx/${seg}/x`, 'PROPFIND')), 405);
  assert.equal(await status(req(`/sbx/${seg}/x`, 'GET', { 'sec-fetch-site': 'cross-site' })), 200, 'assets of the opaque-origin preview are cross-site');
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'null', referer: `http://localhost:3333/sbx/${seg}/` })), 200, 'from a preview page: rewritten into the sandbox, not Lotse');
  assert.equal((await proxy(req('/api/approve', 'POST', { origin: 'null', referer: `http://localhost:3333/sbx/${seg}/` }))).headers.get('x-middleware-rewrite'), `http://localhost:3333/sbx/${seg}/api/approve`);
  process.env.LOTSE_PASSWORD = 'geheim';
  try {
    // ajax of the opaque-origin preview carries no Basic credentials: passed on to the route (which checks the key)
    assert.equal(await status(req(`/sbx/${seg}/checkout/line-item/add`, 'POST', { origin: 'null', 'x-requested-with': 'XMLHttpRequest' })), 200);
    assert.equal((await proxy(req('/widgets/search', 'GET', { referer: `http://localhost:3333/sbx/${seg}/` }))).headers.get('x-middleware-rewrite'), `http://localhost:3333/sbx/${seg}/widgets/search`);
    assert.equal(await status(req('/api/chats')), 401, 'everything else still needs the login');
    assert.equal(await status(req('/sbx/t_abcdefghijk1/')), 401, 'without key no exception');
  } finally { delete process.env.LOTSE_PASSWORD; }
});
