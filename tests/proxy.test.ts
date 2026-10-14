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
