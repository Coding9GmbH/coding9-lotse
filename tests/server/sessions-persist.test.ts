import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeSet } from '@/lib/protocol';

// Gebündeltes Speichern (persistSoon) während des Streamings, sofortiges Speichern (persist) an wichtigen Stellen, flushPersists vor dem Prozessende.
// Dazu die Texte, die der Server im Chat zeigt, in der Sprache der Oberfläche (Abbruch, Neustart, Plattformwechsel).
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-persist-'));
delete process.env.SHOP_PLATFORM;

const { getSession, persist, persistSoon, flushPersists, dropSession, stopChat, chatSnapshot, noteUiLocale, setRunClockForTests } = await import('../../src/server/sessions');
const { auditList, chatGet, chatPut } = await import('../../src/server/db');
const { usageOf } = await import('../../src/server/agent');
const { onCodexItem } = await import('../../src/server/agent-codex');

let now = 1_700_000_000_000;
let queued: { at: number; fn: () => void; dead: boolean }[] = [];
const fakeClock = () => { queued = []; setRunClockForTests({ now: () => now, later(fn, ms) { const t = { at: now + ms, fn, dead: false }; queued.push(t); return { cancel() { t.dead = true; } }; } }); };
const advance = (ms: number) => { now += ms; for (const t of queued) if (!t.dead && t.at <= now) { t.dead = true; t.fn(); } };
const waiting = () => queued.filter(t => !t.dead).length;
const stored = (id: string) => chatGet(id)?.events.length ?? 0;
afterEach(() => { setRunClockForTests(null); noteUiLocale('de'); });

test('persistSoon: erstes Speichern sofort, danach höchstens alle 500 ms, gebündelt am Ende des Fensters', () => {
  fakeClock();
  const s = getSession('p-soon');
  s.events.push({ t: 'user', text: 'Hallo' }); persistSoon(s);
  assert.equal(stored('p-soon'), 1, 'nach einer Pause sofort');
  for (let i = 0; i < 20; i++) { s.events.push({ t: 'text', text: `${i}` }); persistSoon(s); advance(10); }
  assert.equal(stored('p-soon'), 1, 'innerhalb des Fensters nichts geschrieben');
  assert.equal(waiting(), 1, 'genau ein Timer für viele Ereignisse');
  advance(500);
  assert.equal(stored('p-soon'), 21, 'am Ende des Fensters alles auf einmal');
  assert.equal(waiting(), 0);
});

test('persist (sofort) nimmt einen offenen gebündelten mit; flushPersists schreibt alles Offene', () => {
  fakeClock();
  const a = getSession('p-now'), b = getSession('p-flush');
  for (const s of [a, b]) { s.events.push({ t: 'user', text: 'x' }); persist(s); s.events.push({ t: 'text', text: 'y' }); persistSoon(s); }
  assert.equal(waiting(), 2);
  a.events.push({ t: 'question', approvalId: 'q', question: 'Weiter?', options: ['Ja'] }); persist(a);
  assert.equal(stored('p-now'), 3, 'Rückfrage sofort gespeichert, mit dem gebündelten Text');
  assert.equal(waiting(), 1, 'Timer von a aufgehoben');
  assert.equal(stored('p-flush'), 1);
  assert.equal(flushPersists(), 1);
  assert.equal(stored('p-flush'), 2, 'vor dem Prozessende geschrieben');
  assert.equal(flushPersists(), 0, 'nichts mehr offen');
});

test('gelöschter Chat: ein offener gebündelter Speichervorgang legt ihn nicht wieder an', () => {
  fakeClock();
  const s = getSession('p-del');
  s.events.push({ t: 'user', text: 'x' }); persist(s); s.events.push({ t: 'text', text: 'y' }); persistSoon(s);
  dropSession('p-del');
  assert.equal(waiting(), 0, 'Timer aufgehoben');
  persistSoon(s); advance(1000);
  assert.equal(stored('p-del'), 1, 'nichts mehr geschrieben');
});

test('Änderungsset: Vorschlag und Ergebnis werden sofort gespeichert, auch mitten im Streaming-Fenster', async () => {
  fakeClock();
  const s = getSession('p-cs'); s.running = true;
  s.emit = ev => { s.events.push({ ...ev }); if (ev.t === 'changeset' || ev.t === 'changeset_result') persist(s); else persistSoon(s); };
  s.events.push({ t: 'user', text: 'x' }); persist(s);
  s.emit({ t: 'text', text: 'Ich schlage vor …' });
  const set: ChangeSet = { id: 'cs-p', kind: 'products', entity: 'product', title: 'T', reason: null, atomic: false, skipped: [], items: [] };
  const p = s.requestChange(set); await new Promise(r => setTimeout(r, 5));
  assert.ok(chatGet('p-cs')?.events.some(e => e.t === 'changeset'), 'Vorschlag liegt in der DB, bevor jemand entscheidet');
  const approvalId = (s.events.find(e => e.t === 'changeset') as { approvalId: string }).approvalId;
  s.approvals.get(approvalId)!({ allow: false });
  assert.equal((await p).status, 'rejected');
  assert.ok(chatGet('p-cs')?.events.some(e => e.t === 'changeset_result'));
  s.running = false;
});

test('i18n: Abbruch und Neustart-Hinweise in der Sprache der Oberfläche, Audit-Grund bleibt stabil', () => {
  const s = getSession('p-en'); s.locale = 'en'; s.running = true; s.abort = new AbortController(); s.emit = ev => { s.events.push(ev); };
  void s.askUser({ question: 'Go on?', options: [{ label: 'Yes' }] });
  assert.equal(stopChat('p-en'), true);
  const q = s.events.find(e => e.t === 'question'); assert.ok(q?.t === 'question'); assert.equal(q.answer, 'Cancelled');
  s.running = false;

  const set: ChangeSet = { id: 'cs-en', kind: 'products', entity: 'product', title: 'T', reason: null, atomic: false, skipped: [], items: [] };
  chatPut({ id: 'p-restart-en', title: 'T', target: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sdkSessionId: null, draft: null,
    events: [{ t: 'user', text: 'Hi' }, { t: 'question', approvalId: 'q1', question: 'Go?', options: ['Yes'] }, { t: 'changeset', approvalId: 'a1', cs: set }] });
  const snap = chatSnapshot('p-restart-en', 'en')!;
  const r = snap.events.find(e => e.t === 'changeset_result'); assert.ok(r?.t === 'changeset_result'); assert.match(r.error ?? '', /Server restarted, please propose again/);
  const q2 = snap.events.find(e => e.t === 'question'); assert.ok(q2?.t === 'question'); assert.equal(q2.answer, 'Not answered (restart)');
  assert.equal(auditList(20).find(a => a.changeSet === 'cs-en')?.reason, 'Neustart, bitte erneut vorschlagen', 'Audit unabhängig von der Sprache');

  // ohne Sprache der Anfrage: die zuletzt genutzte Sprache der Oberfläche
  chatPut({ id: 'p-restart-ui', title: 'T', target: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sdkSessionId: null, draft: null,
    events: [{ t: 'user', text: 'Hi' }, { t: 'changeset', approvalId: 'a2', cs: { ...set, id: 'cs-ui' } }] });
  noteUiLocale('en');
  const r2 = chatSnapshot('p-restart-ui')!.events.find(e => e.t === 'changeset_result'); assert.ok(r2?.t === 'changeset_result'); assert.match(r2.error ?? '', /Nothing was written/);
  assert.equal(getSession('p-new-en').locale, 'en', 'neue Session übernimmt die Sprache');
});

test('Codex: gesperrtes Werkzeug je Sprache; usageOf summiert die Modelle', () => {
  const state = { texts: new Map<string, number>(), tools: new Set<string>() }, item = { id: 'c', type: 'command_execution', command: 'id', aggregated_output: '', status: 'completed' } as const;
  assert.match(onCodexItem(item, 'item.completed', state, () => {}, 'en').abort ?? '', /blocked tool/);
  assert.match(onCodexItem(item, 'item.completed', state, () => {}).abort ?? '', /gesperrtes Werkzeug/);
  const u = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 1 };
  assert.deepEqual(usageOf({ 'claude-a': u, 'claude-b': { ...u, outputTokens: 7 } }, 3), { model: 'claude-a,claude-b', usage: { input: 20, output: 12, cacheRead: 200, cacheWrite: 2, turns: 3 } });
  assert.deepEqual(usageOf(undefined), {});
});
