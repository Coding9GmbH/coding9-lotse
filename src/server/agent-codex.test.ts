import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ThreadItem } from '@openai/codex-sdk';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-codex-'));

test('Codex-Lauf: keine eigenen Werkzeuge, Sandbox nur lesend, Netz aus', async () => {
  const { codexConfig } = await import('./codex');
  const { codexThreadOptions } = await import('./agent-codex');
  const cfg = codexConfig({ mcpUrl: 'http://127.0.0.1:3333/api/mcp/c', instructions: 'SYS' });
  assert.equal(cfg.config.approval_policy, 'never');
  assert.equal(cfg.config.web_search, 'disabled');
  assert.equal(cfg.config.developer_instructions, 'SYS');
  assert.deepEqual(cfg.configOverrides, ['permissions.lotse.filesystem={":root"="deny"}']);
  const features = cfg.config.features as Record<string, boolean>;
  for (const name of ['shell_tool', 'unified_exec', 'view_image', 'computer_use', 'browser_use', 'plugins', 'hooks']) {
    assert.equal(features[name], false, name);
  }
  assert.ok(Object.values(features).every(v => v === false), 'kein Codex-Feature ist an');
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

test('Codex-Runde: Befehl, Datei und Websuche brechen ab; Text, Shop-Tool, Überlegung und Plan nicht', async () => {
  const { onCodexItem } = await import('./agent-codex');
  const events: ChatEvent[] = [];
  const state = { texts: new Map<string, number>(), tools: new Set<string>() };
  const emit = (ev: ChatEvent) => { events.push(ev); };
  const abortOf = (item: ThreadItem) => onCodexItem(item, 'item.completed', state, emit).abort;

  assert.match(abortOf({ id: 'c', type: 'command_execution', command: 'id', aggregated_output: '', status: 'completed' }) ?? '', /abgebrochen/);
  assert.match(abortOf({ id: 'f', type: 'file_change', changes: [{ path: 'x', kind: 'update' }], status: 'failed' }) ?? '', /abgebrochen/);
  assert.match(abortOf({ id: 'w', type: 'web_search', query: 'preis' }) ?? '', /abgebrochen/);
  assert.equal(events.length, 0, 'ein Abbruch schreibt nichts in den Chat');

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
