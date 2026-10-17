import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import type { ChatEvent } from '@/lib/protocol';
import { GITHUB_TOKEN, sandboxForTests } from '../support/sandbox-task';

// Code chats (Sandbox Coding): the session mode, Claude and Codex options, the MCP route Codex uses (same tools as Claude),
// waking a paused container before the turn, and the chat route's task check.
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$|AI_|ANTHROPIC_)/.test(k)) delete process.env[k];
process.env.AI_PROVIDER = 'codex'; // not signed in: a turn ends right after the preparation, without an AI process
const S = await sandboxForTests();
const { J, T, E } = S;
const { getSession, peekSession, persist, sweepIdleSessions } = await import('../../src/server/sessions');
const { claudeOptions, startChat, WEB_TOOLS, CODE_MAX_TURNS } = await import('../../src/server/agent');
const { codexInstructions, codexThreadOptions, CODE_NOTE } = await import('../../src/server/agent-codex');
const { codexConfig, mcpTokenFor } = await import('../../src/server/codex');
const { buildTools, codeToolNames, toolsAllowedFor, allToolsFor } = await import('../../src/server/tools');
const { CODE_TOOL_NAMES } = await import('../../src/server/sandbox/workspace-tools');
const { chatGet, chatList, dataDir } = await import('../../src/server/db');
const { updateSettings } = await import('../../src/server/settings');
const mcp = await import('../../src/app/api/mcp/[chatId]/route');
const chatRoute = await import('../../src/app/api/chat/route');
after(S.close);

const task = await S.readyTask();
const chatId = task.chatId!;

test('a task gets its own chat: code mode, task id, persisted, listed with the task, survives a platform switch', () => {
  assert.match(chatId, /^[0-9a-f-]{36}$/);
  const s = getSession(chatId);
  assert.equal(s.mode, 'code');
  assert.equal(s.taskId, task.id);
  s.events.push({ t: 'user', text: 'Hallo' }); persist(s);
  assert.deepEqual([chatGet(chatId)?.mode, chatGet(chatId)?.taskId], ['code', task.id]);
  assert.deepEqual(chatList().find(c => c.id === chatId), { id: chatId, title: '', target: null, updatedAt: chatGet(chatId)!.updatedAt, published: 0, mode: 'code', taskId: task.id });
  assert.equal(chatList().find(c => c.id !== chatId)?.mode, undefined);

  updateSettings({ platform: 'shopify' }); // a shop session would be rebuilt for the new platform; a code chat is not
  assert.equal(getSession(chatId), s);
  updateSettings({ platform: 'shopware' });
  sweepIdleSessions(Date.now() + 60 * 60_000);
  assert.equal(peekSession(chatId), null);
  const again = getSession(chatId); // from the database
  assert.deepEqual([again.mode, again.taskId], ['code', task.id]);
  assert.equal(getSession('a-shop-chat').mode, 'shop');
});

test('tools: a code chat gets exactly the workspace tools (none while Sandbox Coding is off); shop chats never get them', () => {
  const s = getSession(chatId);
  assert.deepEqual(buildTools(s).map(t => t.name), [...CODE_TOOL_NAMES]);
  assert.deepEqual(codeToolNames(), [...CODE_TOOL_NAMES]);
  assert.deepEqual(toolsAllowedFor(s), CODE_TOOL_NAMES.map(n => `mcp__shop__${n}`));
  const shop = getSession('a-shop-chat');
  assert.deepEqual(toolsAllowedFor(shop), allToolsFor(shop.platform));
  assert.ok(!buildTools(shop).some(t => ['write_file', 'run_command', 'read_file'].includes(t.name)));
  E.saveSandbox({ enabled: false });
  assert.deepEqual(buildTools(s), []);
  E.saveSandbox({ enabled: true });
});

test('Claude options in code mode: no built-in tools, no settings, only the code tools, cwd outside the workspace, env without tokens', () => {
  const s = getSession(chatId);
  const o = claudeOptions(s, { web: false, ac: new AbortController() });
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.deepEqual(o.allowedTools, CODE_TOOL_NAMES.map(n => `mcp__shop__${n}`));
  assert.equal(o.maxTurns, CODE_MAX_TURNS);
  assert.equal(o.cwd, path.join(dataDir(), 'claude-work'));
  assert.deepEqual(fs.readdirSync(o.cwd!), [], 'empty working directory');
  const ws = T.taskPaths(task.id).workspace;
  assert.ok(path.relative(ws, o.cwd!).startsWith('..'), 'not inside the workspace');
  const env = JSON.stringify(o.env);
  assert.ok(!env.includes(GITHUB_TOKEN) && !/LOTSE_|GITHUB|SHOPWARE_/.test(Object.keys(o.env ?? {}).join(' ')));
  assert.match(String(o.systemPrompt), /Coding-Assistent von Lotse/);
  assert.match(String(o.systemPrompt), /Gratis Versand/, 'the task goal');
  assert.match(String(o.systemPrompt), /custom\/plugins\/AcmeTheme/);
  assert.doesNotMatch(String(o.systemPrompt), /Pattern-Katalog/, 'not the shop prompt');
  const web = claudeOptions(s, { web: true, ac: new AbortController() });
  assert.deepEqual(web.tools, WEB_TOOLS);
  assert.deepEqual(web.allowedTools, [...CODE_TOOL_NAMES.map(n => `mcp__shop__${n}`), ...WEB_TOOLS]);
  const shop = claudeOptions(getSession('a-shop-chat'), { web: false, ac: new AbortController() });
  assert.equal(shop.cwd, undefined);
  assert.equal(shop.maxTurns, 40);
});

test('Codex in code mode: code prompt with CODE_NOTE, still read-only, network off, all features off', () => {
  const s = getSession(chatId);
  const instr = codexInstructions(s);
  assert.ok(instr.endsWith(CODE_NOTE));
  assert.match(instr, /Gratis Versand/);
  const cfg = codexConfig({ mcpUrl: 'http://127.0.0.1:3333/api/mcp/x', instructions: instr });
  assert.ok(Object.values(cfg.config.features as Record<string, boolean>).every(v => v === false));
  assert.equal(cfg.config.project_doc_max_bytes, 0);
  assert.deepEqual(cfg.configOverrides, ['permissions.lotse.filesystem={":root"="deny"}']);
  const opts = codexThreadOptions(cfg.workingDirectory);
  assert.deepEqual([opts.sandboxMode, opts.networkAccessEnabled, opts.webSearchMode], ['read-only', false, 'disabled']);
  assert.doesNotMatch(codexInstructions(getSession('a-shop-chat')), /CODE_NOTE|Coding-Assistent/);
});

const rpc = (id: string, body: unknown, token: string) => mcp.POST(new Request(`http://127.0.0.1:3333/api/mcp/${id}`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
}), { params: Promise.resolve({ chatId: id }) });

test('MCP route (Codex): a code chat lists the same workspace tools as Claude and a call edits the worktree and emits the card', async () => {
  const token = mcpTokenFor(chatId);
  const list = await (await rpc(chatId, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)).json() as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map(t => t.name), [...CODE_TOOL_NAMES]);
  const s = getSession(chatId), seen: ChatEvent[] = [];
  s.emit = ev => { seen.push(ev); };
  const content = "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}Codex war hier{{ parent() }}{% endblock %}\n";
  const call = await (await rpc(chatId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write_file', arguments: { path: 'src/Resources/views/storefront/layout/header/header.html.twig', content } } }, token)).json() as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(call.result.isError ?? false, false, call.result.content[0].text);
  assert.ok(fs.readFileSync(path.join(T.taskPaths(task.id).worktree, 'src/Resources/views/storefront/layout/header/header.html.twig'), 'utf8').includes('Codex war hier'));
  assert.equal(seen[0]?.t, 'file_change');
  const shopToken = mcpTokenFor('a-shop-chat');
  const shop = await (await rpc('a-shop-chat', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, shopToken)).json() as { result: { tools: { name: string }[] } };
  assert.ok(!shop.result.tools.some(t => t.name === 'write_file'), 'the MCP route serves code tools only for code chats');
});

test('a turn wakes a paused container first (no new setup); a Codex turn without login then ends cleanly', async () => {
  await J.pauseTask(task.id);
  const s = getSession(chatId), seen: ChatEvent[] = [];
  s.listeners.add(ev => seen.push(ev));
  const { started, done } = startChat({ chatId, message: 'Mach den Header grün', taskId: task.id });
  assert.equal(started, true);
  await done;
  assert.deepEqual(seen.filter(e => e.t === 'sandbox_status').map(e => e.t === 'sandbox_status' && e.state), ['waking', 'ready']);
  assert.equal(T.getTask(task.id)!.status, 'ready');
  const last = seen.at(-1);
  assert.ok(last?.t === 'done' && /Codex ist nicht mit ChatGPT angemeldet/.test(last.error ?? ''), JSON.stringify(last));
  assert.equal(s.running, false);
  assert.equal(s.title, 'Header anpassen', 'the task title');
  assert.ok(chatGet(chatId)!.events.some(e => e.t === 'sandbox_status'), 'status persisted');
});

test('no turn while Sandbox Coding is off or the task is not ready', async () => {
  E.saveSandbox({ enabled: false });
  const off = startChat({ chatId, message: 'x' });
  await off.done;
  const s = getSession(chatId);
  assert.match((s.events.at(-1) as { error?: string }).error ?? '', /ausgeschaltet/);
  E.saveSandbox({ enabled: true });
  const other = T.createTask({ title: 'Noch nicht bereit', goal: '', repo: 'acme/shop-theme', baseBranch: 'main' });
  const r = startChat({ chatId: other.chatId!, message: 'x' });
  await r.done;
  assert.match((getSession(other.chatId!).events.at(-1) as { error?: string }).error ?? '', /noch nicht bereit/);
});

test('POST /api/chat with taskId: the chat must be the task\'s own, and Sandbox Coding on', async () => {
  const post = (body: unknown) => chatRoute.POST(new Request('http://127.0.0.1:3333/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  const wrong = await post({ chatId: 'a-shop-chat', message: 'x', taskId: task.id });
  assert.equal(wrong.status, 403);
  E.saveSandbox({ enabled: false });
  assert.equal((await post({ chatId, message: 'x', taskId: task.id })).status, 403);
  E.saveSandbox({ enabled: true });
  await J.finishTask(task.id); // the chat stays readable; the next turn is refused with a clear message
  assert.equal(chatGet(chatId)?.mode, 'code');
});

test('deleting the task removes its chat', async () => {
  await J.deleteTask(task.id);
  assert.equal(chatGet(chatId), null);
  assert.equal(peekSession(chatId), null);
});
