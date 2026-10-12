import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-agent-'));
const { recordEvent } = await import('./agent');
const { getSession, persist, chatSnapshot } = await import('./sessions');
const { chatGet } = await import('./db');

const draft = (n: number): ChatEvent => ({ t: 'draft', html: `<div>Entwurf ${n}</div>`, spec: { name: `E${n}` }, name: `E${n}`, pageType: 'landingpage', audit: { findings: [], score: 0 } as never });

test('recordEvent: nur-live-Ereignisse fehlen im Verlauf, Text wird zusammengefasst, von Entwürfen behält nur der letzte sein HTML', () => {
  const events: ChatEvent[] = [];
  for (const ev of [{ t: 'start' }, { t: 'text', text: 'Hal' }, { t: 'text', text: 'lo' }, { t: 'draft_partial', html: 'x', name: 'E', pageType: 'landingpage' }, draft(1), { t: 'changeset_progress', csId: 'c', done: 1, total: 2 }, draft(2), draft(3), { t: 'text', text: 'Fertig' }] as ChatEvent[]) recordEvent(events, ev);
  assert.deepEqual(events.map(e => e.t), ['text', 'draft', 'draft', 'draft', 'text']);
  assert.equal((events[0] as { text: string }).text, 'Hallo');
  const drafts = events.filter((e): e is Extract<ChatEvent, { t: 'draft' }> => e.t === 'draft');
  assert.deepEqual(drafts.map(d => d.html), [undefined, undefined, '<div>Entwurf 3</div>']);
  assert.ok(drafts.every(d => d.spec), 'Specs bleiben (für refreshDraftPreview und reuse)');
});

test('Speicher-Snapshot und gespeicherter Chat enthalten dieselben Entwürfe (nur eine Vorschau)', () => {
  const s = getSession('agent-draft');
  for (const ev of [{ t: 'user', text: 'Seite' } as ChatEvent, draft(1), draft(2)]) recordEvent(s.events, ev);
  persist(s);
  const mem = chatSnapshot('agent-draft')!, db = chatGet('agent-draft')!;
  assert.deepEqual(JSON.parse(JSON.stringify(mem.events)), db.events);
  assert.equal(mem.events.filter(e => e.t === 'draft' && e.html).length, 1);
  assert.ok(JSON.stringify(mem.events).length < 400, 'kein altes HTML im Speicher');
});
