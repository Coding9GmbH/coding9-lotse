import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeSet, ChatEvent, UndoOp } from '@/lib/protocol';
import type { ApplyCtx, ApplyResult } from '../../src/server/changes';

// Absturzsicherheit: Anwenden mit Zwischenstand in der DB (B1), teilweises Rückgängig mit Wiederholung nur der offenen Schritte (S1),
// offene Freigaben/Rückfragen nach einem Neustart (S6). Der „Absturz“ wird simuliert: Executor meldet Fortschritt und kommt nie zurück,
// die Session wird aus dem Speicher geworfen und aus der DB neu aufgebaut.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-recover-'));
delete process.env.SHOP_PLATFORM;

const { updateSettings } = await import('../../src/server/settings');
const { ADAPTERS } = await import('../../src/server/platform');
const { getSession, decideChange, dropSession, peekSession, persist, chatSnapshot, undoChangeSet, stopChat } = await import('../../src/server/sessions');
const { auditList, chatGet, chatPut, chatDelete, runPut, runsOpen } = await import('../../src/server/db');
const { trackedUndo } = await import('../../src/server/changes');

updateSettings({ platform: 'shopware' });
const sw = ADAPTERS.shopware;
let apply: (cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx) => Promise<ApplyResult> = async () => ({ results: [], undo: [] });
sw.apply = (cs, _payload, selected, ctx) => apply(cs, selected, ctx);
const undoCalls: UndoOp[][] = [];
let undoFail = new Set<string>();
// wie die echten Adapter: rückwärts ausführen (letzter Schritt zuerst) und in dieser Reihenfolge melden
sw.undo = async ops => { undoCalls.push(ops); return [...ops].reverse().map(op => (undoFail.has(op.id) ? { ok: false, error: `${op.id} kaputt` } : { ok: true })); };

const cs = (id: string): ChangeSet => ({ id, kind: 'products', entity: 'product', title: 'Test', reason: null, atomic: false, skipped: [],
  items: [1, 2, 3].map(k => ({ id: `i${k}`, entity: 'product', entityId: `p${k}`, label: 'P', field: 'name', fieldLabel: 'Name', before: 'alt', after: 'neu', afterRaw: 'neu', warn: [] })) });
const op = (id: string): UndoOp => ({ op: 'patch', entity: 'product', id, data: { name: 'alt' } });
const start = (id: string) => {
  const s = getSession(id); s.running = true; s.abort = new AbortController();
  s.emit = ev => { s.events.push({ ...ev }); if (ev.t === 'changeset' || ev.t === 'changeset_result' || ev.t === 'question') persist(s); };
  s.events.push({ t: 'user', text: 'Hallo' }); persist(s);
  return s;
};
const approvalIdOf = (events: ChatEvent[]) => (events.findLast(e => e.t === 'changeset') as { approvalId: string }).approvalId;
const lastResult = (events: ChatEvent[] | undefined) => { const r = events?.findLast(e => e.t === 'changeset_result'); return r?.t === 'changeset_result' ? r : null; };
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

test('Anwenden: Audit „started“ vor dem Schreiben, Lauf-Zeile verschwindet erst nach dem gespeicherten Ergebnis', async () => {
  const s = start('c-ok');
  let seenRun = 0;
  apply = async (set, _sel, ctx) => { seenRun = runsOpen('c-ok').length; const undo = [op('p1')], results = [{ itemId: 'i1', ok: true }]; ctx?.progress?.(1, 1, { results, undo }); return { results, undo }; };
  const p = s.requestChange(cs('cs-ok')); await tick();
  decideChange('c-ok', approvalIdOf(s.events), true, ['i1']);
  assert.equal((await p).status, 'applied');
  assert.equal(seenRun, 1, 'Lauf-Zeile existiert während des Anwendens');
  assert.equal(runsOpen('c-ok').length, 0, 'nach dem Speichern gelöscht');
  const rows = auditList(10).filter(a => a.changeSet === 'cs-ok');
  assert.deepEqual(rows.map(a => a.status).sort(), ['applied', 'started']);
  assert.equal((rows.find(a => a.status === 'started')?.items as unknown[]).length, 1, 'started kennt die gewählten Elemente');
  s.running = false;
});

test('B1: Absturz mitten im Anwenden: Zwischenstand gebündelt in der DB, Neuaufbau liefert Teilergebnis mit Rückgängig + Audit', async () => {
  const s = start('c-crash');
  apply = async (_set, _sel, ctx) => {
    const results: ApplyResult['results'] = [{ itemId: 'i1', ok: true }], undo = [op('p1')];
    ctx?.progress?.(1, 3, { results, undo }); // erstes Element geschrieben
    results.push({ itemId: 'i2', ok: false, error: 'Timeout' }); ctx?.progress?.(2, 3, { results, undo }); // kurz danach: wird gebündelt
    return new Promise(() => {}); // „Absturz“: der Prozess kommt nie zurück
  };
  void s.requestChange(cs('cs-crash')); await tick();
  decideChange('c-crash', approvalIdOf(s.events), true); await tick();
  assert.equal(auditList(10).find(a => a.changeSet === 'cs-crash')?.status, 'started');
  let run = runsOpen('c-crash');
  assert.equal(run.length, 1); assert.equal(run[0].results.length, 1, 'erster Tick sofort gesichert');
  await tick(300);
  run = runsOpen('c-crash');
  assert.equal(run[0].results.length, 2, 'zweiter Tick gebündelt nachgeschrieben');
  assert.deepEqual(run[0].undo, [{ ...op('p1'), platform: 'shopware' }], 'Rückgängig-Schritt mit Plattform');

  dropSession('c-crash'); // „Neustart“: Speicher weg, Verlauf nur noch in der DB
  assert.equal(peekSession('c-crash'), null);
  const res = lastResult(chatSnapshot('c-crash')?.events); // wie initialChat / GET /api/chat danach
  assert.ok(res, 'Ergebnis ergänzt');
  assert.equal(res.status, 'partial'); assert.deepEqual(res.counts, { applied: 1, failed: 1 }); assert.match(res.error ?? '', /Neustart/);
  assert.match(res.error ?? '', /ob weitere Elemente noch geschrieben wurden, ist unbekannt/, '2 von 3 gezählt: der Rest ist offen, nicht „nicht geschrieben“');
  assert.deepEqual(res.undo, [{ ...op('p1'), platform: 'shopware' }]);
  assert.equal(runsOpen('c-crash').length, 0, 'Lauf abgeschlossen');
  const audit = auditList(10).find(a => a.changeSet === 'cs-crash' && a.status === 'partial');
  assert.equal(audit?.interrupted, true); assert.equal(audit?.applied, 1); assert.equal(audit?.failed, 1);
  assert.equal(chatSnapshot('c-crash')?.events.filter(e => e.t === 'changeset_result').length, 1, 'zweiter Aufruf ändert nichts');

  const u = await undoChangeSet('c-crash', 'cs-crash'); // Rückgängig mit den gesicherten Schritten
  assert.equal(u?.ok, true);
  assert.deepEqual(undoCalls.at(-1), [{ ...op('p1'), platform: 'shopware' }]);
  assert.equal(lastResult(chatGet('c-crash')?.events)?.undone, true);
});

test('S1: teilweises Rückgängig merkt sich den Ausgang je Schritt; zweiter Klick wiederholt nur die fehlgeschlagenen', async () => {
  const s = start('c-undo');
  apply = async () => ({ results: [1, 2, 3].map(k => ({ itemId: `i${k}`, ok: true })), undo: [op('p1'), { op: 'delete', entity: 'product', id: 'p2' }, op('p3')] });
  const p = s.requestChange(cs('cs-u')); await tick();
  decideChange('c-undo', approvalIdOf(s.events), true); await p; s.running = false;

  undoFail = new Set(['p2']);
  const first = await undoChangeSet('c-undo', 'cs-u');
  assert.equal(first?.ok, false); assert.equal(first?.done, 2); assert.equal(first?.total, 3); assert.match(first?.error ?? '', /p2 kaputt/);
  assert.deepEqual(first?.undoResults, [{ ok: true }, { ok: false, error: 'p2 kaputt' }, { ok: true }], 'Ausgang je Schritt in Schritt-Reihenfolge');
  const stored = lastResult(chatGet('c-undo')?.events);
  assert.equal(stored?.undone, false); assert.equal(stored?.undoResults?.length, 3, 'gespeichert');

  undoFail = new Set();
  const second = await undoChangeSet('c-undo', 'cs-u');
  assert.deepEqual(undoCalls.at(-1)?.map(o => o.id), ['p2'], 'nur der fehlgeschlagene Schritt, p1/p3 nicht noch einmal');
  assert.equal(second?.ok, true); assert.equal(second?.done, 3);
  assert.deepEqual(second?.undoResults, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(lastResult(s.events)?.undone, true);
  assert.equal(auditList(10).find(a => a.changeSet === 'cs-u' && a.decision === 'undo')?.retry, true);
  assert.equal(await undoChangeSet('c-undo', 'cs-u'), null, 'alles zurückgesetzt');
});

test('S6: Neustart mit offener Freigabe und Rückfrage: „rejected“ mit Grund, Audit-Zeile, Rückfrage markiert; nichts doppelt', () => {
  const set = cs('cs-open');
  chatPut({ id: 'c-restart', title: 'T', target: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sdkSessionId: null, draft: null,
    events: [{ t: 'user', text: 'Hallo' }, { t: 'question', approvalId: 'q1', question: 'Weiter?', options: ['Ja'] }, { t: 'changeset', approvalId: 'a1', cs: set },
      { t: 'changeset', approvalId: 'a0', cs: cs('cs-done'), decision: false }, { t: 'changeset_result', csId: 'cs-done', status: 'rejected' }] });
  assert.equal(peekSession('c-restart'), null);
  const snap = chatSnapshot('c-restart')!;
  const res = lastResult(snap.events.filter(e => e.t !== 'changeset_result' || e.csId === 'cs-open'));
  assert.ok(res); assert.equal(res.status, 'rejected'); assert.match(res.error ?? '', /Neustart, bitte erneut vorschlagen/); assert.equal(res.undo, undefined);
  const q = snap.events.find(e => e.t === 'question'); assert.ok(q?.t === 'question' && /Neustart/.test(q.answer ?? ''), 'Rückfrage markiert');
  const ev = snap.events.find(e => e.t === 'changeset' && e.cs.id === 'cs-open'); assert.ok(ev?.t === 'changeset' && ev.decision === false);
  const a = auditList(10).find(x => x.changeSet === 'cs-open');
  assert.equal(a?.decision, 'rejected'); assert.equal(a?.reason, 'Neustart, bitte erneut vorschlagen');
  const stored = chatGet('c-restart')!;
  assert.equal(stored.updatedAt, '2024-01-01T00:00:00.000Z', 'rückt in der Liste nicht nach oben');
  assert.equal(stored.events.filter(e => e.t === 'changeset_result').length, 2, 'schon entschiedenes Set unberührt, offenes genau einmal ergänzt');
  const s = getSession('c-restart'); // Session-Neuaufbau: derselbe Stand, keine zweite Zeile
  assert.equal(s.events.filter(e => e.t === 'changeset_result').length, 2);
  assert.equal(auditList(20).filter(x => x.changeSet === 'cs-open').length, 1);
});

test('B1: Applier ohne Zwischenstand (z. B. Promotion) stürzt ab: Ergebnis sagt „unbekannt“ statt „0 angewendet, nichts geschrieben“', async () => {
  const s = start('c-blind');
  apply = async () => new Promise(() => {}); // meldet nie Fortschritt: Absturz vor dem ersten Tick
  void s.requestChange({ ...cs('cs-blind'), kind: 'promotion' }); await tick();
  decideChange('c-blind', approvalIdOf(s.events), true); await tick();
  assert.equal(runsOpen('c-blind')[0]?.total, 3, 'Lauf-Zeile kennt die gewählte Zahl');
  dropSession('c-blind');
  const res = lastResult(chatSnapshot('c-blind')?.events);
  assert.ok(res); assert.equal(res.status, 'failed'); assert.equal(res.counts, undefined, 'kein belegter Nullstand'); assert.deepEqual(res.undo, []);
  assert.match(res.error ?? '', /ob und was geschrieben wurde, ist unbekannt/); assert.match(res.error ?? '', /nicht blind erneut anwenden/);
  assert.doesNotMatch(res.error ?? '', /nicht mehr geschrieben|0 angewendet/);
  const a = auditList(10).find(x => x.changeSet === 'cs-blind' && x.status === 'failed');
  assert.equal(a?.unknown, true); assert.equal(a?.interrupted, true);
  assert.equal(typeof a?.recoveredFrom, 'string', 'Audit kennt den Zeitpunkt des Vorfalls (Start des Laufs), nicht nur den des Ladens');
});

test('B1: nur Schreibschritte gesichert (trackedUndo), kein Element fertig: Hinweis mit Schrittzahl, Rückgängig möglich', async () => {
  const s = start('c-steps');
  apply = async (_set, _sel, ctx) => { const undo = trackedUndo(ctx, 1); undo.push(op('p1')); return new Promise(() => {}); };
  void s.requestChange({ ...cs('cs-steps'), kind: 'promotion' }); await tick();
  decideChange('c-steps', approvalIdOf(s.events), true); await tick();
  dropSession('c-steps');
  const res = lastResult(chatSnapshot('c-steps')?.events);
  assert.ok(res); assert.equal(res.status, 'failed'); assert.equal(res.counts, undefined);
  assert.match(res.error ?? '', /bevor ein Element abgeschlossen war: 1 Schreibschritt ist gesichert/);
  assert.deepEqual(res.undo, [{ ...op('p1'), platform: 'shopware' }]);
  assert.equal((await undoChangeSet('c-steps', 'cs-steps'))?.ok, true);
});

test('B1: vollständig gezählter Zwischenstand: kein „unbekannt“-Zusatz', async () => {
  const s = start('c-full');
  apply = async (_set, _sel, ctx) => { const results = [1, 2, 3].map(k => ({ itemId: `i${k}`, ok: true })); ctx?.progress?.(3, 3, { results, undo: [op('p1')] }); return new Promise(() => {}); };
  void s.requestChange(cs('cs-full')); await tick();
  decideChange('c-full', approvalIdOf(s.events), true); await tick();
  dropSession('c-full');
  const res = lastResult(chatSnapshot('c-full')?.events);
  assert.ok(res); assert.equal(res.status, 'partial'); assert.deepEqual(res.counts, { applied: 3, failed: 0 });
  assert.match(res.error ?? '', /3 angewendet, 0 fehlgeschlagen \(letzter gesicherter Zwischenstand\)\.$/); assert.doesNotMatch(res.error ?? '', /unbekannt/);
});

test('Executor wirft nach einem Zwischenstand: Catch-Pfad behält die gemeldeten Rückgängig-Schritte, Lauf-Zeile verschwindet (finish)', async () => {
  const s = start('c-throw');
  apply = async (_set, _sel, ctx) => { ctx?.progress?.(1, 3, { results: [{ itemId: 'i1', ok: true }], undo: [op('p1')] }); throw new Error('Kaputt'); };
  const p = s.requestChange(cs('cs-throw')); await tick();
  decideChange('c-throw', approvalIdOf(s.events), true);
  const out = await p;
  assert.equal(out.status, 'failed'); assert.equal(out.error, 'Kaputt');
  assert.equal(runsOpen('c-throw').length, 0, 'finish() erreicht: keine Lauf-Zeile bleibt liegen');
  const r = lastResult(s.events);
  assert.equal(r?.status, 'failed'); assert.deepEqual(r?.undo, [{ ...op('p1'), platform: 'shopware' }], 'Rückgängig aus dem letzten Tick');
  assert.deepEqual(auditList(10).filter(a => a.changeSet === 'cs-throw').map(a => a.status).sort(), ['failed', 'started']);
  s.running = false;
  dropSession('c-throw');
  assert.equal(chatSnapshot('c-throw')?.events.filter(e => e.t === 'changeset_result').length, 1, 'Neuaufbau ergänzt nichts: Ergebnis war gespeichert');
});

test('Anderer Shop verbunden: Fehler ohne „started“-Audit und ohne Lauf-Zeile (es wird garantiert nichts geschrieben)', async () => {
  const s = start('c-plat');
  let called = false; apply = async () => { called = true; return { results: [], undo: [] }; };
  const p = s.requestChange({ ...cs('cs-plat'), platform: 'shopify' }); await tick();
  decideChange('c-plat', approvalIdOf(s.events), true);
  const out = await p;
  assert.equal(out.status, 'failed'); assert.match(out.error ?? '', /verbunden ist jetzt/); assert.equal(called, false);
  assert.deepEqual(auditList(10).filter(a => a.changeSet === 'cs-plat').map(a => a.status), ['failed'], 'kein „started“');
  assert.equal(runsOpen('c-plat').length, 0);
  s.running = false;
});

test('S6: stopChat beantwortet offene Rückfragen mit „Abgebrochen“; Neuaufbau markiert nur Fragen der unterbrochenen Runde', async () => {
  const s = start('c-stop');
  const q = s.askUser({ question: 'Weiter?', options: [{ label: 'Ja' }] }); await tick();
  assert.equal(stopChat('c-stop'), true); assert.equal(await q, '');
  const ev = chatGet('c-stop')?.events.find(e => e.t === 'question');
  assert.ok(ev?.t === 'question' && ev.answer === 'Abgebrochen', 'gespeichert, damit sie beim nächsten Laden nicht als „Nicht beantwortet (Neustart)“ gilt');
  s.running = false;
  chatPut({ id: 'c-old', title: 'T', target: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sdkSessionId: null, draft: null,
    events: [{ t: 'user', text: 'A' }, { t: 'question', approvalId: 'q0', question: 'Alt?', options: ['Ja'] }, { t: 'done', error: null }, { t: 'user', text: 'B' }, { t: 'question', approvalId: 'q1', question: 'Neu?', options: ['Ja'] }] });
  const qs = chatSnapshot('c-old')!.events.filter(e => e.t === 'question');
  assert.ok(qs[0].t === 'question' && qs[0].answer === undefined, 'Frage einer abgeschlossenen Runde bleibt, wie sie war');
  assert.ok(qs[1].t === 'question' && /Neustart/.test(qs[1].answer ?? ''), 'offene Frage der letzten Runde markiert');
});

test('chatDelete räumt Lauf-Zeilen des Chats mit auf', () => {
  runPut({ csId: 'cs-orphan', chatId: 'c-gone', kind: 'products', title: 'x', startedAt: new Date().toISOString(), results: [], undo: [] });
  assert.equal(runsOpen('c-gone').length, 1);
  chatDelete('c-gone');
  assert.equal(runsOpen('c-gone').length, 0);
});
