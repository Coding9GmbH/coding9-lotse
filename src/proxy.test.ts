import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

delete process.env.LOTSE_PASSWORD;
const req = (path: string, method = 'GET', headers: Record<string, string> = {}) => new NextRequest(`http://localhost:3333${path}`, { method, headers: { host: 'localhost:3333', ...headers } });
const status = async (r: NextRequest) => (await proxy(r)).status;

test('Schreibende Aufrufe brauchen die Kennung der Oberfläche; eine sandboxed Vorschau (Origin "null") kommt nicht durch', async () => {
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'http://localhost:3333', 'x-lotse': '1' })), 200);
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'http://localhost:3333' })), 403, 'ohne Kennung');
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'null', 'x-lotse': '1' })), 403, 'Origin null (sandbox)');
  assert.equal(await status(req('/api/approve', 'POST', { origin: 'https://fremd.test', 'x-lotse': '1' })), 403, 'fremde Herkunft');
  assert.equal(await status(req('/api/approve', 'POST')), 403, 'Simple-Request ohne Origin und Kennung (z. B. Formular)');
  assert.equal(await status(req('/api/settings', 'PUT', { 'x-lotse': '1' })), 200);
  assert.equal(await status(req('/api/chats/x', 'DELETE')), 403);
});

test('Lesende Aufrufe, Healthcheck und MCP (eigenes Token je Chat) bleiben ohne Kennung erreichbar', async () => {
  assert.equal(await status(req('/api/chats')), 200);
  assert.equal(await status(req('/api/ping', 'POST')), 200);
  assert.equal(await status(req('/api/mcp/chat1', 'POST', { origin: 'http://localhost:3333' })), 200);
  assert.equal(await status(req('/api/chats', 'GET', { host: 'boese.test' })), 403, 'Host-Prüfung unverändert');
});
