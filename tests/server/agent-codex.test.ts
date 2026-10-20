import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThreadItem } from '@openai/codex-sdk';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-codex-'));

test('Codex run: no own tools, sandbox read-only, network off', async () => {
  const { codexConfig } = await import('../../src/server/codex');
  const { codexThreadOptions } = await import('../../src/server/agent-codex');
  const cfg = codexConfig({ mcpUrl: 'http://127.0.0.1:3333/api/mcp/c', instructions: 'SYS' });
  assert.equal(cfg.config.approval_policy, 'never');
  assert.equal(cfg.config.web_search, 'disabled');
  assert.equal(cfg.config.developer_instructions, 'SYS');
  assert.deepEqual(cfg.configOverrides, ['permissions.lotse.filesystem={":root"="deny"}']);
  const { code_mode: codeMode, ...features } = cfg.config.features as Record<string, unknown>;
  for (const name of ['shell_tool', 'unified_exec', 'view_image', 'computer_use', 'browser_use', 'plugins', 'hooks', 'remote_plugin', 'browser_use_full_cdp_access', 'request_permissions_tool', 'standalone_web_search']) {
    assert.equal(features[name], false, name);
  }
  assert.ok(Object.values(features).every(v => v === false), 'no Codex feature is on');
  // questions wait for the human: shop tools are called directly, never from a code-mode script that yields after 10 s.
  // Only [features.code_mode] counts (a top-level code_mode table is ignored by Codex), and it does not switch code mode on.
  assert.deepEqual(codeMode, { default_exec_yield_time_ms: 3_600_000, direct_only_tool_namespaces: ['mcp__shop'] });
  assert.equal('code_mode' in cfg.config, false);
  assert.deepEqual(Object.keys(cfg.config.mcp_servers), ['shop'], 'the namespace above is mcp__<server>');
  const opts = codexThreadOptions(cfg.workingDirectory, 'gpt-test');
  assert.equal(opts.sandboxMode, 'read-only');
  assert.equal(opts.approvalPolicy, 'never');
  assert.equal(opts.networkAccessEnabled, false);
  assert.equal(opts.webSearchMode, 'disabled');
  assert.equal(opts.skipGitRepoCheck, true);
  assert.equal(opts.workingDirectory, cfg.workingDirectory);
  assert.equal(opts.model, 'gpt-test');
  assert.equal(codexThreadOptions(cfg.workingDirectory).model, undefined);
});

test('runCodex and pingCodex release the MCP token at the end of the turn', async () => {
  const { mcpTokenFor, mcpTokenValid } = await import('../../src/server/codex');
  const { runCodex, pingCodex } = await import('../../src/server/agent-codex');
  const id = 'chat-codex-round';
  const token = mcpTokenFor(id);
  const end = await runCodex({ id } as never, 'hi', new AbortController().signal, () => {});
  assert.match(end.error ?? '', /nicht mit ChatGPT angemeldet/);
  assert.equal(mcpTokenValid(id, `Bearer ${token}`), false, 'after runCodex');

  const ping = mcpTokenFor('ping');
  await assert.rejects(() => pingCodex(), /angemeldet/);
  assert.equal(mcpTokenValid('ping', `Bearer ${ping}`), false, 'after pingCodex');
});

test('Codex turn: command, file and web search abort; text, shop tool, reasoning and plan do not', async () => {
  const { onCodexItem } = await import('../../src/server/agent-codex');
  const events: ChatEvent[] = [];
  const state = { texts: new Map<string, number>(), tools: new Set<string>() };
  const emit = (ev: ChatEvent) => { events.push(ev); };
  const abortOf = (item: ThreadItem) => onCodexItem(item, 'item.completed', state, emit).abort;

  assert.match(abortOf({ id: 'c', type: 'command_execution', command: 'id', aggregated_output: '', status: 'completed' }) ?? '', /abgebrochen/);
  assert.match(abortOf({ id: 'f', type: 'file_change', changes: [{ path: 'x', kind: 'update' }], status: 'failed' }) ?? '', /abgebrochen/);
  assert.match(abortOf({ id: 'w', type: 'web_search', query: 'preis' }) ?? '', /abgebrochen/);
  assert.equal(events.length, 0, 'an abort writes nothing to the chat');

  assert.equal(onCodexItem({ id: 'a', type: 'agent_message', text: 'Hallo' }, 'item.updated', state, emit).abort, undefined);
  assert.deepEqual(events, [{ t: 'text_start' }, { t: 'text', text: 'Hallo' }]);
  events.length = 0;
  onCodexItem({ id: 'a', type: 'agent_message', text: 'Hallo Welt' }, 'item.updated', state, emit);
  assert.deepEqual(events, [{ t: 'text', text: ' Welt' }]);

  events.length = 0;
  const call = { id: 'm', type: 'mcp_tool_call' as const, server: 'shop', tool: 'search_products', arguments: { q: 1 }, status: 'in_progress' as const };
  assert.equal(onCodexItem(call, 'item.started', state, emit).abort, undefined);
  assert.equal(onCodexItem({ ...call, status: 'completed', result: { content: [{ type: 'text', text: 'ok' }], structured_content: null } }, 'item.completed', state, emit).abort, undefined);
  assert.equal(events.filter(e => e.t === 'tool').length, 1);
  assert.deepEqual(events[0], { t: 'tool', id: 'm', name: 'search_products', input: { q: 1 } });
  assert.deepEqual(events[1], { t: 'tool_result', id: 'm', error: false, preview: 'ok' });

  const quiet: ThreadItem[] = [
    { id: 'r', type: 'reasoning', text: 'denke' },
    { id: 't', type: 'todo_list', items: [{ text: 'lesen', completed: false }] },
    { id: 'e', type: 'error', message: 'hinweis' },
  ];
  for (const item of quiet) {
    const n: number = events.length;
    assert.equal(onCodexItem(item, 'item.completed', state, emit).abort, undefined, item.type);
    assert.equal(events.length, n, item.type);
  }
});

test('Codex with web research: web search live, web search event appears as a work step instead of an abort; commands stay blocked', async () => {
  const { codexConfig } = await import('../../src/server/codex');
  const { codexThreadOptions, onCodexItem } = await import('../../src/server/agent-codex');
  const cfg = codexConfig({ mcpUrl: 'http://127.0.0.1:3333/api/mcp/c', instructions: 'SYS', web: true });
  assert.equal(cfg.config.web_search, 'live');
  assert.ok(Object.entries(cfg.config.features as Record<string, unknown>).every(([k, v]) => k === 'code_mode' || v === false), 'everything else stays off');
  const opts = codexThreadOptions(cfg.workingDirectory, undefined, true);
  assert.equal(opts.webSearchMode, 'live');
  assert.equal(opts.networkAccessEnabled, false, 'no network for commands');
  assert.equal(opts.sandboxMode, 'read-only');

  const events: ChatEvent[] = [];
  const state = { texts: new Map<string, number>(), tools: new Set<string>(), web: true };
  const item: ThreadItem = { id: 'w', type: 'web_search', query: '3M Datenblatt' };
  assert.equal(onCodexItem(item, 'item.started', state, ev => events.push(ev)).abort, undefined);
  assert.equal(onCodexItem(item, 'item.completed', state, ev => events.push(ev)).abort, undefined);
  assert.deepEqual(events, [{ t: 'tool', id: 'w', name: 'web_search', input: { query: '3M Datenblatt' } }]);
  assert.match(onCodexItem({ id: 'c', type: 'command_execution', command: 'curl x', aggregated_output: '', status: 'completed' }, 'item.completed', state, () => {}).abort ?? '', /abgebrochen/);
});

test('a refused Codex patch is undone: tracked files restored from HEAD, new ones deleted, nothing outside touched', async () => {
  const { onCodexItem, revertPaths } = await import('../../src/server/agent-codex');
  const { execFileSync } = await import('node:child_process');
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-revert-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: wt });
  const w = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), text); };
  w('vendor/a/x.php', 'orig'); w('src/ok.php', 'ok');
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  const outside = path.join(os.tmpdir(), `lotse-outside-${process.pid}`);
  fs.writeFileSync(outside, 'keep');
  // Codex already applied: vendor edited, vendor file added, .env created, a legit edit
  w('vendor/a/x.php', 'changed'); w('vendor/b/new.php', 'new'); w('.env', 'SECRET=1'); w('src/ok.php', 'edited');
  const changes = [{ path: path.join(wt, 'vendor/a/x.php'), kind: 'update' }, { path: 'vendor/b/new.php', kind: 'add' }, { path: path.join(wt, '.env'), kind: 'add' }, { path: path.join(wt, 'src/ok.php'), kind: 'update' }, { path: outside, kind: 'update' }] as const;
  const events: ChatEvent[] = [];
  const r = onCodexItem({ id: 'p', type: 'file_change', status: 'completed', changes: changes.map(c => ({ ...c })) }, 'item.completed', { texts: new Map(), tools: new Set(), sandbox: wt }, ev => events.push(ev));
  assert.match(r.abort ?? '', /zurückgenommen/);
  assert.deepEqual(r.files, ['src/ok.php']);
  assert.deepEqual(events.map(e => e.t === 'file_change' && e.path), ['src/ok.php']);
  assert.deepEqual(await revertPaths(wt, path.join(wt, '.git'), r.revert ?? []), ['vendor/a/x.php', 'vendor/b/new.php', '.env']);
  assert.equal(fs.readFileSync(path.join(wt, 'vendor/a/x.php'), 'utf8'), 'orig');
  assert.equal(fs.existsSync(path.join(wt, 'vendor/b/new.php')), false);
  assert.equal(fs.existsSync(path.join(wt, '.env')), false);
  assert.equal(fs.readFileSync(path.join(wt, 'src/ok.php'), 'utf8'), 'edited', 'accepted changes stay');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep', 'never touches anything outside');
  assert.deepEqual(await revertPaths(wt, path.join(wt, '.git'), [path.join(wt, '.git/config'), '../x', '~/.bashrc']), []);
  fs.rmSync(outside, { force: true });
});
