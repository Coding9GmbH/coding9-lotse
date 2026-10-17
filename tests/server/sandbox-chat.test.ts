import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEvent } from '@/lib/protocol';
import { GITHUB_TOKEN, PLUGIN_DIR, sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK option shapes and hook inputs as loose JSON */

// A sandbox attached to a normal chat (Sandbox Coding): attaching via the API, the chat's tools (only sandbox tools, no live shop),
// Claude's own file tools guarded per call (hook + canUseTool), Codex' patches inside the worktree only, waking/waiting before a turn,
// a new AI session after attaching (recap), detaching on finish, and the migration of the former separate code chats.
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$|AI_|ANTHROPIC_)/.test(k)) delete process.env[k];
process.env.AI_PROVIDER = 'codex'; // not signed in: a turn ends right after the preparation, without an AI process
const S = await sandboxForTests();
const { J, T, E } = S;
const { getSession, peekSession, persist, stopChat, sweepIdleSessions } = await import('../../src/server/sessions');
const { claudeOptions, startChat, WEB_TOOLS, CODE_MAX_TURNS, recapOf } = await import('../../src/server/agent');
const { codexInstructions, codexThreadOptions, onCodexItem, CODE_NOTE } = await import('../../src/server/agent-codex');
const { codexConfig, mcpTokenFor } = await import('../../src/server/codex');
const { buildTools, toolsAllowedFor, toolNamesFor } = await import('../../src/server/tools');
const { SANDBOX_TOOL_NAMES, sandboxToolNames } = await import('../../src/server/sandbox/workspace-tools');
const { NATIVE_TOOLS } = await import('../../src/server/sandbox/native-tools');
const { chatGet, chatList, chatPut } = await import('../../src/server/db');
const mcp = await import('../../src/app/api/mcp/[chatId]/route');
const tasksRoute = await import('../../src/app/api/sandbox/tasks/route');
const chatsRoute = await import('../../src/app/api/chats/[id]/route');
after(S.close);

const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const post = (body: unknown) => tasksRoute.POST(new Request('http://127.0.0.1:3333/api/sandbox/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lotse': '1' }, body: JSON.stringify(body) }));

// A normal chat with history, then a sandbox attached to it through the API
const chatId = crypto.randomUUID();
const shopChat = getSession(chatId);
shopChat.events.push({ t: 'user', text: 'Wie viele Produkte haben wir?' }, { t: 'text', text: 'Es sind 42 Produkte.' }, { t: 'done', error: null });
shopChat.sdkSessionId = 'sdk-shop-session'; shopChat.title = 'Produkte';
persist(shopChat);
const created = await post({ chatId, repo: 'acme/shop-theme', baseBranch: 'main', title: 'Header anpassen' });
assert.equal(created.status, 201, await created.clone().text());
const taskId = ((await created.json()) as { task: { id: string } }).task.id;
await S.until(() => !J.setupRunning(taskId) && T.getTask(taskId)!.status !== 'setting_up');
assert.equal(T.getTask(taskId)!.status, 'ready', T.getTask(taskId)!.error ?? '');
const worktree = T.taskPaths(taskId).worktree;

test('attaching: the task is bound to the chat, the chat lists it, a history line, one sandbox per chat', async () => {
  assert.equal(T.attachedTask(chatId)?.id, taskId);
  assert.equal(T.getTask(taskId)!.chatId, chatId);
  assert.equal(chatList().find(c => c.id === chatId)?.taskId, taskId);
  assert.equal(chatList().find(c => c.id !== chatId)?.taskId, undefined);
  assert.deepEqual(chatGet(chatId)!.events.at(-1), { t: 'sandbox_attached', taskId, repo: 'acme/shop-theme', baseBranch: 'main' });
  assert.equal(getSession(chatId).taskId, taskId);
  const again = await post({ chatId, repo: 'acme/shop-theme', baseBranch: 'main' });
  assert.equal(again.status, 409);
  assert.equal((await post({ repo: 'acme/shop-theme', baseBranch: 'main' })).status, 400, 'chatId is required');
  // survives a restart of the session (from the database)
  sweepIdleSessions(Date.now() + 60 * 60_000);
  assert.equal(peekSession(chatId), null);
  assert.equal(getSession(chatId).taskId, taskId);
});

test('tools: a sandbox chat gets ONLY the sandbox tools (no live-shop tool), none while off; a shop chat gets start_sandbox while on', () => {
  const s = getSession(chatId);
  assert.deepEqual(buildTools(s, 'claude').map(t => t.name), [...SANDBOX_TOOL_NAMES]);
  assert.deepEqual(buildTools(s, 'codex').map(t => t.name), sandboxToolNames('codex'));
  assert.deepEqual(toolsAllowedFor(s, 'claude'), SANDBOX_TOOL_NAMES.map(n => `mcp__shop__${n}`));
  const shopNames = toolNamesFor(s.platform);
  assert.ok(!buildTools(s, 'claude').some(t => t.name !== 'ask_user' && shopNames.includes(t.name)), 'no shop tool at all');
  const shop = getSession('a-shop-chat');
  assert.deepEqual(toolsAllowedFor(shop, 'claude'), [...shopNames, 'start_sandbox'].map(n => `mcp__shop__${n}`));
  assert.equal(buildTools(shop).at(-1)?.name, 'start_sandbox');
  assert.ok(!buildTools(shop).some(t => t.name !== 'ask_user' && (SANDBOX_TOOL_NAMES as readonly string[]).includes(t.name)));
  E.saveSandbox({ enabled: false });
  assert.deepEqual(buildTools(s), []);
  assert.ok(!buildTools(shop).some(t => t.name === 'start_sandbox'));
  E.saveSandbox({ enabled: true });
});

test('start_sandbox only shows a card (preset from the environment); nothing is created', async () => {
  E.saveSandbox({ defaultRepo: 'acme/shop-theme', defaultBranch: 'main' });
  const shop = getSession('offer-chat'), seen: ChatEvent[] = [];
  shop.emit = ev => { seen.push(ev); };
  const before = T.listTasks().length;
  const tool = buildTools(shop).find(t => t.name === 'start_sandbox')!;
  const r = await tool.handler({ reason: 'Header-Hinweis im Theme' } as any, {});
  assert.equal(r.isError ?? false, false);
  assert.ok(seen[0]?.t === 'sandbox_offer' && seen[0].repo === 'acme/shop-theme' && seen[0].baseBranch === 'main' && seen[0].reason === 'Header-Hinweis im Theme');
  assert.equal(T.listTasks().length, before, 'no task without the user’s click');
  assert.equal((await tool.handler({ reason: 'x', repo: '../evil' } as any, {})).isError, true);
  E.saveSandbox({ defaultRepo: '', defaultBranch: '' });
});

test('Claude options: native file tools in the worktree (not pre-allowed), sandbox MCP tools, no Bash, no settings, env without tokens', () => {
  const s = getSession(chatId);
  const o = claudeOptions(s, { web: false, ac: new AbortController() });
  assert.equal(o.cwd, worktree);
  assert.deepEqual(o.tools, [...NATIVE_TOOLS]);
  assert.ok(!(o.tools as string[]).some(t => ['Bash', 'Task', 'NotebookEdit', 'WebFetch', 'WebSearch'].includes(t)));
  assert.deepEqual(o.allowedTools, SANDBOX_TOOL_NAMES.map(n => `mcp__shop__${n}`), 'native tools are checked on every call');
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.maxTurns, CODE_MAX_TURNS);
  assert.ok(o.hooks?.PreToolUse?.length && o.hooks?.PostToolUse?.length);
  const env = JSON.stringify(o.env);
  assert.ok(!env.includes(GITHUB_TOKEN) && !/LOTSE_|GITHUB|SHOPWARE_/.test(Object.keys(o.env ?? {}).join(' ')));
  const sys = String(o.systemPrompt);
  assert.match(sys, /Coding-Assistent von Lotse/);
  assert.ok(sys.includes(`Arbeitsverzeichnis (Repository-Wurzel): ${worktree}`));
  assert.match(sys, /Live-Shop ist von hier nicht erreichbar/);
  assert.match(sys, /sandbox_bash/);
  assert.doesNotMatch(sys, /Pattern-Katalog|run_command|edit_file/, 'not the shop prompt, no removed tools');
  const web = claudeOptions(s, { web: true, ac: new AbortController() });
  assert.deepEqual(web.tools, [...NATIVE_TOOLS, ...WEB_TOOLS]);
  const shop = claudeOptions(getSession('a-shop-chat'), { web: false, ac: new AbortController() });
  assert.equal(shop.cwd, undefined);
  assert.deepEqual(shop.tools, []);
  assert.equal(shop.hooks, undefined);
  assert.equal(shop.maxTurns, 40);
});

const pre = async (o: any, tool_name: string, tool_input: Record<string, unknown>, id = 'tu1') =>
  (await o.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: worktree } as HookInput, id, { signal: new AbortController().signal })) as any;
const post2 = async (o: any, tool_name: string, tool_input: Record<string, unknown>, id = 'tu1') =>
  o.hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response: {}, tool_use_id: id, session_id: 's', transcript_path: '', cwd: worktree } as HookInput, id, { signal: new AbortController().signal });
const denied = (r: any) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('native tools: every call is checked (hook and canUseTool) – inside the worktree only, never .git, secrets or outside', async () => {
  const s = getSession(chatId);
  const o = claudeOptions(s, { web: false, ac: new AbortController() }) as any;
  const ok = [
    ['Read', { file_path: path.join(worktree, 'composer.json') }], ['Read', { file_path: 'README.md' }], ['Glob', { pattern: '**/*.twig' }],
    ['Grep', { pattern: 'theme', glob: '*.json' }], ['Edit', { file_path: path.join(worktree, 'README.md'), old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: path.join(worktree, 'src/new.txt'), content: 'x' }], ['TodoWrite', { todos: [] }],
  ] as const;
  for (const [tool, input] of ok) {
    assert.ok(!denied(await pre(o, tool, input)), `${tool} ${JSON.stringify(input)}`);
    assert.equal((await o.canUseTool(tool, input, {})).behavior, 'allow', tool);
  }
  const bad = [
    ['Read', { file_path: path.join(worktree, '.env') }], ['Read', { file_path: path.join(worktree, '.git') }], ['Read', { file_path: '/etc/passwd' }],
    ['Read', { file_path: path.join(worktree, '..', '..', 'git', taskId, 'config') }], ['Read', { file_path: path.join(worktree, 'outside-link') }],
    ['Read', { file_path: path.join(worktree, 'keys/deploy.pem') }], ['Write', { file_path: path.join(worktree, 'vendor/x.php'), content: 'x' }],
    ['Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }], ['Glob', { pattern: '../**' }], ['Glob', { pattern: '*', path: '/etc' }],
    ['Grep', { pattern: 'x', path: '/' }], ['Grep', { pattern: 'SECRET', glob: '.env*' }], ['Grep', { pattern: 'x', glob: '!*.php' }],
    ['Bash', { command: 'id' }], ['Task', { prompt: 'x' }], ['NotebookEdit', {}], ['WebFetch', { url: 'https://example.com' }],
  ] as const;
  for (const [tool, input] of bad) {
    assert.ok(denied(await pre(o, tool, input)), `${tool} ${JSON.stringify(input)}`);
    assert.equal((await o.canUseTool(tool, input, {})).behavior, 'deny', tool);
  }
  // a search over the whole repository never reads the secret files: they are excluded from Grep
  const g = await pre(o, 'Grep', { pattern: 'APP_SECRET' });
  assert.equal(g.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(g.hookSpecificOutput.updatedInput.glob, /^!\{.*\.env.*\}$/);
  assert.match(g.hookSpecificOutput.updatedInput.glob, /deploy\.pem/);
});

test('after a native Write/Edit the file is mirrored into the container and shown as a card', async () => {
  const s = getSession(chatId), seen: ChatEvent[] = [];
  s.emit = ev => { seen.push(ev); };
  const o = claudeOptions(s, { web: false, ac: new AbortController() }) as any;
  const file = path.join(worktree, HEADER);
  await pre(o, 'Write', { file_path: file, content: '' }, 'w1');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div class=\"x\">Original</div>{{ parent() }}{% endblock %}\n"); // what Claude Code's Write does
  await post2(o, 'Write', { file_path: file }, 'w1');
  assert.deepEqual(seen.at(-1), { t: 'file_change', path: HEADER, kind: 'create', added: 2, removed: 0 });
  assert.ok(S.fake.archives.at(-1)!.entries.some(e => e.path === `AcmeTheme/${HEADER}`));
  await pre(o, 'Edit', { file_path: file, old_string: 'Original', new_string: 'Gratis Versand' }, 'e1');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Original', 'Gratis Versand'));
  await post2(o, 'Edit', { file_path: file }, 'e1');
  assert.deepEqual(seen.at(-1), { t: 'file_change', path: HEADER, kind: 'edit', added: 1, removed: 1 });
  const inContainer = [...S.fake.containers.get(T.getTask(taskId)!.containerId!)!.files].find(([k]) => k === `${PLUGIN_DIR}/${HEADER}`)?.[1].toString();
  assert.match(inContainer ?? '', /Gratis Versand/);
});

test('Codex: code prompt with CODE_NOTE, workspace-write in the worktree only, network off, patches outside abort the turn', () => {
  const s = getSession(chatId);
  const instr = codexInstructions(s);
  assert.ok(instr.endsWith(CODE_NOTE));
  assert.ok(instr.includes(worktree));
  const cfg = codexConfig({ mcpUrl: 'http://127.0.0.1:3333/api/mcp/x', instructions: instr, workspace: worktree });
  assert.equal(cfg.workingDirectory, worktree);
  assert.deepEqual(cfg.configOverrides, [`permissions.lotse.filesystem={":root"="deny",${JSON.stringify(worktree)}="write",${JSON.stringify(`${worktree}/.git`)}="deny"}`]);
  assert.ok(Object.values(cfg.config.features as Record<string, boolean>).every(v => v === false), 'own shell etc. stay off');
  assert.deepEqual(codexConfig({ mcpUrl: 'x', instructions: '' }).configOverrides, ['permissions.lotse.filesystem={":root"="deny"}']);
  const opts = codexThreadOptions(cfg.workingDirectory, undefined, false, true);
  assert.deepEqual([opts.sandboxMode, opts.networkAccessEnabled, opts.webSearchMode], ['workspace-write', false, 'disabled']);
  assert.equal(codexThreadOptions('x').sandboxMode, 'read-only');

  const seen: ChatEvent[] = [];
  const state = { texts: new Map<string, number>(), tools: new Set<string>(), sandbox: worktree };
  const change = (p: string, kind: 'add' | 'update' | 'delete' = 'update') => ({ id: 'p1', type: 'file_change' as const, status: 'completed' as const, changes: [{ path: p, kind }] });
  assert.deepEqual(onCodexItem(change(path.join(worktree, HEADER)), 'item.completed', state, ev => seen.push(ev)), { files: [HEADER] });
  assert.deepEqual(seen.at(-1), { t: 'file_change', path: HEADER, kind: 'edit', added: 0, removed: 0 });
  for (const p of ['/etc/passwd', path.join(worktree, '.env'), path.join(worktree, '.git/config'), path.join(worktree, '../x')]) assert.match(onCodexItem(change(p), 'item.completed', state, () => {}).abort ?? '', /außerhalb des Repositorys/, p);
  assert.match(onCodexItem({ id: 'c', type: 'command_execution', command: 'id', aggregated_output: '', status: 'in_progress' } as any, 'item.started', state, () => {}).abort ?? '', /gesperrtes Werkzeug/, 'no own shell');
  assert.match(onCodexItem(change(path.join(worktree, HEADER)), 'item.completed', { texts: new Map(), tools: new Set() }, () => {}).abort ?? '', /gesperrtes Werkzeug/, 'no patches in a shop chat');
  assert.doesNotMatch(codexInstructions(getSession('a-shop-chat')), /Coding-Assistent/);
});

const rpc = (id: string, body: unknown, token: string) => mcp.POST(new Request(`http://127.0.0.1:3333/api/mcp/${id}`, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
}), { params: Promise.resolve({ chatId: id }) });

test('MCP route (Codex): the sandbox tools incl. the read tools; sandbox_bash runs inside the container', async () => {
  const token = mcpTokenFor(chatId);
  const list = await (await rpc(chatId, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, token)).json() as { result: { tools: { name: string }[] } };
  assert.deepEqual(list.result.tools.map(t => t.name), sandboxToolNames('codex'));
  const s = getSession(chatId), seen: ChatEvent[] = [];
  s.emit = ev => { seen.push(ev); };
  const call = await (await rpc(chatId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sandbox_bash', arguments: { command: 'bin/console theme:compile' } } }, token)).json() as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(call.result.isError ?? false, false, call.result.content[0].text);
  assert.deepEqual(S.fake.calls.filter(c => c.op === 'exec').at(-1)!.argv, ['bash', '-lc', 'bin/console theme:compile']);
  assert.deepEqual(seen.map(e => e.t), ['command', 'command', 'preview_reload']);
  const shop = await (await rpc('a-shop-chat', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, mcpTokenFor('a-shop-chat'))).json() as { result: { tools: { name: string }[] } };
  assert.ok(!shop.result.tools.some(t => t.name === 'sandbox_bash'), 'only sandbox chats get sandbox tools');
});

test('recapOf: user and AI texts, newest last, quoted as data', () => {
  const r = recapOf([{ t: 'user', text: 'Frage ```x```' }, { t: 'text', text: 'Ant' }, { t: 'text', text: 'wort' }, { t: 'done', error: null }]);
  assert.match(r, /^\[Bisheriger Verlauf dieses Chats/);
  assert.match(r, /Nutzer: Frage '''x'''\nKI: Antwort\n\[Ende des Verlaufs\]/);
  assert.equal(recapOf([]), '');
});

test('the first turn after attaching starts a new AI session; a paused container is woken first (no new setup)', async () => {
  await J.pauseTask(taskId);
  const s = getSession(chatId), seen: ChatEvent[] = [];
  assert.equal(s.sdkSessionId, 'sdk-shop-session');
  s.listeners.add(ev => seen.push(ev));
  const { started, done } = startChat({ chatId, message: 'Mach den Header grün' });
  assert.equal(started, true);
  await done;
  assert.equal(s.sdkSessionId, null, 'the shop session is not resumed in the worktree');
  assert.equal(s.agentScope, taskId);
  assert.equal(chatGet(chatId)!.agentScope, taskId);
  assert.deepEqual(seen.filter(e => e.t === 'sandbox_status').map(e => e.t === 'sandbox_status' && e.state), ['waking', 'ready']);
  assert.equal(T.getTask(taskId)!.status, 'ready');
  const last = seen.at(-1);
  assert.ok(last?.t === 'done' && /Codex ist nicht mit ChatGPT angemeldet/.test(last.error ?? ''), JSON.stringify(last));
  assert.equal(s.title, 'Produkte', 'the chat keeps its title');
});

test('Stop while the container wakes ends the turn at once; the wake finishes in the background', async () => {
  await J.pauseTask(taskId);
  const orig = S.fake.start.bind(S.fake); let release = () => {};
  S.fake.start = async (id: string) => { await new Promise<void>(r => (release = r)); return orig(id); };
  try {
    const s = getSession(chatId), seen: ChatEvent[] = [];
    s.listeners.add(ev => seen.push(ev));
    const { done } = startChat({ chatId, message: 'Noch etwas' });
    await S.until(() => seen.some(e => e.t === 'sandbox_status' && e.state === 'waking'));
    assert.equal(stopChat(chatId), true);
    await done;
    const last = seen.at(-1);
    assert.ok(last?.t === 'done' && last.error === 'Abgebrochen.', JSON.stringify(last));
    assert.deepEqual(seen.filter(e => e.t === 'sandbox_status').map(e => e.t === 'sandbox_status' && e.state), ['waking', 'failed']);
    assert.equal(T.getTask(taskId)!.status, 'waking', 'the wake goes on');
  } finally { S.fake.start = orig; release(); }
  await J.ensureAwake(taskId);
  assert.equal(T.getTask(taskId)!.status, 'ready');
});

test('a turn during the setup waits for it; a failed setup ends the turn with the reason', async () => {
  const id = crypto.randomUUID();
  const t = T.createTask({ chatId: id, repo: 'acme/shop-theme', baseBranch: 'main' });
  assert.equal(t.title, 'Sandbox shop-theme', 'title from the repository');
  const orig = S.fake.ensureImage.bind(S.fake); let release: (() => void) | null = null;
  S.fake.ensureImage = async (...a: Parameters<typeof orig>) => { await new Promise<void>(r => (release = r)); return orig(...a); };
  try {
    J.runSteps(t.id);
    const s = getSession(id), seen: ChatEvent[] = [];
    s.listeners.add(ev => seen.push(ev));
    const { done } = startChat({ chatId: id, message: 'Los' });
    await S.until(() => seen.some(e => e.t === 'sandbox_status') && !!release);
    assert.equal(T.getTask(t.id)!.status, 'setting_up');
    release!();
    await done;
    assert.deepEqual(seen.filter(e => e.t === 'sandbox_status').map(e => e.t === 'sandbox_status' && e.state), ['waking', 'ready']);
    assert.equal(T.getTask(t.id)!.status, 'ready');
  } finally { S.fake.ensureImage = orig; (release as (() => void) | null)?.(); }
  await J.finishTask(t.id);
});

test('no turn while Sandbox Coding is off', async () => {
  E.saveSandbox({ enabled: false });
  const off = startChat({ chatId, message: 'x' });
  await off.done;
  assert.match((getSession(chatId).events.at(-1) as { error?: string }).error ?? '', /ausgeschaltet/);
  E.saveSandbox({ enabled: true });
});

test('"Aufgabe abschließen" detaches: the chat stays (normal chat again, new AI session), the task stays as a record', async () => {
  await J.finishTask(taskId);
  assert.equal(T.attachedTask(chatId), null);
  assert.equal(chatList().find(c => c.id === chatId)?.taskId, undefined);
  const s = getSession(chatId);
  s.sdkSessionId = 'sdk-sandbox-session';
  const { done } = startChat({ chatId, message: 'Wieder Shop-Fragen' });
  await done;
  assert.equal(s.taskId, null);
  assert.equal(s.agentScope, null);
  assert.equal(s.sdkSessionId, null, 'the sandbox session is not resumed outside the worktree');
  assert.ok(chatGet(chatId), 'chat kept');
  assert.equal(T.getTask(taskId)!.status, 'done');
});

test('deleting a chat finishes its attached sandbox (record kept); deleting a task keeps its chat', async () => {
  const id = crypto.randomUUID();
  const t = await S.readyTask('Zum Löschen', id);
  getSession(id).events.push({ t: 'user', text: 'x' }); persist(getSession(id));
  await chatsRoute.DELETE(new Request(`http://127.0.0.1:3333/api/chats/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) });
  assert.equal(chatGet(id), null);
  assert.equal(T.getTask(t.id)!.status, 'done');
  assert.equal(T.getTask(t.id)!.containerId, null);

  const keep = crypto.randomUUID();
  const t2 = await S.readyTask('Behalten', keep);
  getSession(keep).events.push({ t: 'user', text: 'y' }); persist(getSession(keep));
  await J.deleteTask(t2.id);
  assert.equal(T.getTask(t2.id), null);
  assert.ok(chatGet(keep), 'the chat is a normal chat of the workspace and stays');
});

test('migration: a former separate code chat is the chat with its sandbox attached; its old AI session is not resumed', async () => {
  const id = crypto.randomUUID();
  const t = await S.readyTask('Alt', id);
  sweepIdleSessions(Date.now() + 60 * 60_000);
  chatPut({ id, title: 'Alt', target: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sdkSessionId: 'old-code-session', codexThreadId: null, draft: null, events: [{ t: 'user', text: 'alt' }], mode: 'code' } as any);
  const s = getSession(id);
  assert.deepEqual([s.taskId, s.agentScope], [t.id, 'legacy-code']);
  assert.equal(chatList().find(c => c.id === id)?.taskId, t.id);
  const { done } = startChat({ chatId: id, message: 'weiter' });
  await done;
  assert.equal(s.sdkSessionId, null);
  assert.equal(s.agentScope, t.id);
  await J.finishTask(t.id);
});
