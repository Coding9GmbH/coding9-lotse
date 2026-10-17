import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-agent-'));
const { recordEvent } = await import('../../src/server/agent');
const { getSession, persist, chatSnapshot } = await import('../../src/server/sessions');
const { chatGet } = await import('../../src/server/db');

const draft = (n: number): ChatEvent => ({ t: 'draft', html: `<div>Entwurf ${n}</div>`, spec: { name: `E${n}` }, name: `E${n}`, pageType: 'landingpage', audit: { findings: [], score: 0 } as never });

test('recordEvent: live-only events are missing from the history, text is merged, only the last draft keeps its HTML', () => {
  const events: ChatEvent[] = [];
  for (const ev of [{ t: 'start' }, { t: 'text', text: 'Hal' }, { t: 'text', text: 'lo' }, { t: 'draft_partial', html: 'x', name: 'E', pageType: 'landingpage' }, draft(1), { t: 'changeset_progress', csId: 'c', done: 1, total: 2 }, draft(2), draft(3), { t: 'text', text: 'Fertig' }] as ChatEvent[]) recordEvent(events, ev);
  assert.deepEqual(events.map(e => e.t), ['text', 'draft', 'draft', 'draft', 'text']);
  assert.equal((events[0] as { text: string }).text, 'Hallo');
  const drafts = events.filter((e): e is Extract<ChatEvent, { t: 'draft' }> => e.t === 'draft');
  assert.deepEqual(drafts.map(d => d.html), [undefined, undefined, '<div>Entwurf 3</div>']);
  assert.ok(drafts.every(d => d.spec), 'specs remain (for refreshDraftPreview and reuse)');
});

test('tool preview masks a secret that redact removes', async () => {
  const { updateSettings } = await import('../../src/server/settings');
  const { previewToolResult } = await import('../../src/server/agent');
  updateSettings({ shopware: { url: 'http://shop', user: 'admin', password: 'geheimes-passwort' } });
  const preview = previewToolResult([{ type: 'text', text: 'Login geheimes-passwort und Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop' }]);
  assert.equal(preview.includes('geheimes-passwort'), false);
  assert.equal(preview.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.match(preview, /Bearer •••/);
});

test('memory snapshot and stored chat contain the same drafts (only one preview)', () => {
  const s = getSession('agent-draft');
  for (const ev of [{ t: 'user', text: 'Seite' } as ChatEvent, draft(1), draft(2)]) recordEvent(s.events, ev);
  persist(s);
  const mem = chatSnapshot('agent-draft')!, db = chatGet('agent-draft')!;
  assert.deepEqual(JSON.parse(JSON.stringify(mem.events)), db.events);
  assert.equal(mem.events.filter(e => e.t === 'draft' && e.html).length, 1);
  assert.ok(JSON.stringify(mem.events).length < 400, 'no old HTML in memory');
});

test('recordEvent: a command keeps only its last state, preview_reload is live only, file changes stay', () => {
  const events: ChatEvent[] = [];
  for (const ev of [
    { t: 'command', id: 'c', command: 'theme-compile', status: 'running' },
    { t: 'file_change', path: 'a.twig', kind: 'edit', added: 1, removed: 1 },
    { t: 'command', id: 'c', command: 'theme-compile', status: 'ok', exitCode: 0, ms: 5 },
    { t: 'preview_reload' },
  ] as ChatEvent[]) recordEvent(events, ev);
  assert.deepEqual(events.map(e => e.t), ['command', 'file_change']);
  assert.equal((events[0] as { status: string }).status, 'ok');
});
