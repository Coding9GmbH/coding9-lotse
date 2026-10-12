import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-mcp-'));

const rpc = (body: unknown, token?: string) => new Request('http://127.0.0.1:3333/api/mcp/chat-1', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const ctx = { params: Promise.resolve({ chatId: 'chat-1' }) };

test('MCP für Codex: ohne gültiges Token abgewiesen, mit Token genau die Shop-Tools', async () => {
  const { POST } = await import('../app/api/mcp/[chatId]/route');
  const { mcpTokenFor } = await import('./codex');
  const { TOOL_NAMES } = await import('./tools');
  assert.deepEqual(TOOL_NAMES.filter((n, i) => TOOL_NAMES.indexOf(n) !== i), [], 'Werkzeugnamen doppelt');

  assert.equal((await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ctx)).status, 401);
  const token = mcpTokenFor('chat-1');
  assert.equal((await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'falsch'), ctx)).status, 401);

  const init = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, token), ctx);
  assert.equal(init.status, 200);
  const list = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token), ctx);
  const body = await list.json() as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
  assert.deepEqual(body.result.tools.map(t => t.name).sort(), [...TOOL_NAMES].sort());
  assert.ok(body.result.tools.every(t => t.inputSchema.type === 'object'));

  // Echter Tool-Aufruf über MCP (ohne Shop): liest den (leeren) Styleguide
  const call = await POST(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_styleguide', arguments: {} } }, token), ctx);
  const res = await call.json() as { result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(res.result.isError ?? false, false);
  assert.match(res.result.content[0].text, /Kein Styleguide/);
});

test('Chat löschen invalidiert das MCP-Token', async () => {
  const { mcpTokenFor, mcpTokenValid } = await import('./codex');
  const { DELETE } = await import('../app/api/chats/[id]/route');
  const alt = mcpTokenFor('chat-1');
  const old = mcpTokenFor('chat-weg');
  assert.equal(mcpTokenValid('chat-weg', `Bearer ${old}`), true);
  const r = await DELETE(new Request('http://127.0.0.1/api/chats/chat-weg', { method: 'DELETE' }), { params: Promise.resolve({ id: 'chat-weg' }) });
  assert.equal(r.status, 200);
  assert.equal(mcpTokenValid('chat-weg', `Bearer ${old}`), false);
  assert.notEqual(mcpTokenFor('chat-weg'), old);
  assert.equal(mcpTokenValid('chat-1', `Bearer ${alt}`), true, 'anderes Chat-Token bleibt');
});

test('Shop-Check: Prüfungen aus Shop-Check, Recht und Search Console sind registriert (Alt-Texte nur einmal)', async () => {
  await import('./features');
  const { listChecks } = await import('./checks');
  const ids = listChecks().map(c => c.id);
  for (const id of ['shopcheck.alt-missing', 'recht.gpsr', 'recht.grundpreis', 'recht.rechtstexte', 'bfsg.kontrast', 'gsc.low-ctr', 'gsc.measure-due']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('bfsg.alt'));
  assert.equal(new Set(ids).size, ids.length);
});
