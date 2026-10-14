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

test('MCP for Codex: rejected without valid token, with token exactly the shop tools', async () => {
  const { POST } = await import('../../src/app/api/mcp/[chatId]/route');
  const { mcpTokenFor } = await import('../../src/server/codex');
  const { TOOL_NAMES } = await import('../../src/server/tools');
  assert.deepEqual(TOOL_NAMES.filter((n, i) => TOOL_NAMES.indexOf(n) !== i), [], 'duplicate tool names');

  assert.equal((await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), ctx)).status, 401);
  const token = mcpTokenFor('chat-1');
  assert.equal((await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'falsch'), ctx)).status, 401);

  const init = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, token), ctx);
  assert.equal(init.status, 200);
  const list = await POST(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token), ctx);
  const body = await list.json() as { result: { tools: { name: string; inputSchema: { type: string } }[] } };
  assert.deepEqual(body.result.tools.map(t => t.name).sort(), [...TOOL_NAMES].sort());
  assert.ok(body.result.tools.every(t => t.inputSchema.type === 'object'));

  // Real tool call via MCP (without shop): reads the (empty) style guide
  const call = await POST(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_styleguide', arguments: {} } }, token), ctx);
  const res = await call.json() as { result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(res.result.isError ?? false, false);
  assert.match(res.result.content[0].text, /Kein Styleguide/);
});

test('deleting a chat invalidates the MCP token', async () => {
  const { mcpTokenFor, mcpTokenValid } = await import('../../src/server/codex');
  const { DELETE } = await import('../../src/app/api/chats/[id]/route');
  const alt = mcpTokenFor('chat-1');
  const old = mcpTokenFor('chat-weg');
  assert.equal(mcpTokenValid('chat-weg', `Bearer ${old}`), true);
  const r = await DELETE(new Request('http://127.0.0.1/api/chats/chat-weg', { method: 'DELETE' }), { params: Promise.resolve({ id: 'chat-weg' }) });
  assert.equal(r.status, 200);
  assert.equal(mcpTokenValid('chat-weg', `Bearer ${old}`), false);
  assert.notEqual(mcpTokenFor('chat-weg'), old);
  assert.equal(mcpTokenValid('chat-1', `Bearer ${alt}`), true, 'other chat token stays');
});

test('MCP token is valid during the turn and gone afterwards', async () => {
  const { bindRoundToken, mcpTokenFor, mcpTokenValid } = await import('../../src/server/codex');
  const id = 'chat-round';
  const token = await bindRoundToken(id, async () => {
    const t = mcpTokenFor(id);
    assert.equal(mcpTokenValid(id, `Bearer ${t}`), true, 'during the turn');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(mcpTokenValid(id, `Bearer ${t}`), true, 'also while waiting for approval');
    return t;
  });
  assert.equal(mcpTokenValid(id, `Bearer ${token}`), false);

  const other = mcpTokenFor('chat-bleibt');
  let thrown = '';
  await assert.rejects(bindRoundToken('chat-fail', async () => {
    thrown = mcpTokenFor('chat-fail');
    throw new Error('Runde abgebrochen');
  }));
  assert.equal(mcpTokenValid('chat-fail', `Bearer ${thrown}`), false);
  assert.equal(mcpTokenValid('chat-bleibt', `Bearer ${other}`), true, 'other chat token stays');
});

test('dropSession does not delete the MCP token', async () => {
  const { mcpTokenFor, mcpTokenValid } = await import('../../src/server/codex');
  const { dropSession } = await import('../../src/server/sessions');
  const t = mcpTokenFor('chat-reset');
  dropSession('chat-reset');
  assert.equal(mcpTokenValid('chat-reset', `Bearer ${t}`), true);
});

test('shop check: checks from shop check, legal and Search Console are registered (alt texts only once)', async () => {
  await import('../../src/server/features');
  const { listChecks } = await import('../../src/server/checks');
  const ids = listChecks().map(c => c.id);
  for (const id of ['shopcheck.alt-missing', 'recht.gpsr', 'recht.grundpreis', 'recht.rechtstexte', 'bfsg.kontrast', 'gsc.low-ctr', 'gsc.measure-due']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('bfsg.alt'));
  assert.equal(new Set(ids).size, ids.length);
});
