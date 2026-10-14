import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeSet, ChatEvent, UndoOp } from '@/lib/protocol';
import type { ApplyCtx, ApplyResult } from '../../src/server/changes';

// Crash safety: applying with intermediate state in the DB (B1), partial undo retrying only the open steps (S1),
// open approvals/questions after a restart (S6). The "crash" is simulated: the executor reports progress and never returns,
// the session is evicted from memory and rebuilt from the DB.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-recover-'));
delete process.env.SHOP_PLATFORM;

const { updateSettings } = await import('../../src/server/settings');
const { ADAPTERS } = await import('../../src/server/platform');
const { getSession, decideChange, dropSession, peekSession, persist, chatSnapshot, undoChangeSet, stopChat, setRunClockForTests } = await import('../../src/server/sessions');
const { auditList, chatGet, chatPut, chatDelete, runPut, runsOpen } = await import('../../src/server/db');
const { trackedUndo } = await import('../../src/server/changes');

updateSettings({ platform: 'shopware' });
const sw = ADAPTERS.shopware;
let apply: (cs: ChangeSet, selected: Set<string>, ctx?: ApplyCtx) => Promise<ApplyResult> = async () => ({ results: [], undo: [] });
sw.apply = (cs, _payload, selected, ctx) => apply(cs, selected, ctx);
const undoCalls: UndoOp[][] = [];
let undoFail = new Set<string>();
// like the real adapters: run backwards (last step first) and report in that order
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

test('Apply: audit "started" before writing, run row disappears only after the saved result', async () => {
  const s = start('c-ok');
  let seenRun = 0;
  apply = async (set, _sel, ctx) => { seenRun = runsOpen('c-ok').length; const undo = [op('p1')], results = [{ itemId: 'i1', ok: true }]; ctx?.progress?.(1, 1, { results, undo }); return { results, undo }; };
  const p = s.requestChange(cs('cs-ok')); await tick();
  decideChange('c-ok', approvalIdOf(s.events), true, ['i1']);
  assert.equal((await p).status, 'applied');
  assert.equal(seenRun, 1, 'run row exists while applying');
  assert.equal(runsOpen('c-ok').length, 0, 'deleted after saving');
  const rows = auditList(10).filter(a => a.changeSet === 'cs-ok');
  assert.deepEqual(rows.map(a => a.status).sort(), ['applied', 'started']);
  assert.equal((rows.find(a => a.status === 'started')?.items as unknown[]).length, 1, 'started knows the selected items');
  s.running = false;
});

test('B1: crash mid-apply: intermediate state batched in the DB, rebuild yields partial result with undo + audit', async () => {
  let now = 1_700_000_000_000;
  const queued: { at: number; fn: () => void; dead: boolean }[] = [];
  setRunClockForTests({
    now: () => now,
    later(fn, ms) {
      const t = { at: now + ms, fn, dead: false };
      queued.push(t);
      return { cancel() { t.dead = true; } };
    },
  });
  try {
    const s = start('c-crash');
    apply = async (_set, _sel, ctx) => {
      const results: ApplyResult['results'] = [{ itemId: 'i1', ok: true }], undo = [op('p1')];
      ctx?.progress?.(1, 3, { results, undo }); // first item written
      results.push({ itemId: 'i2', ok: false, error: 'Timeout' }); ctx?.progress?.(2, 3, { results, undo }); // shortly after: gets batched
      return new Promise(() => {}); // "crash": the process never returns
    };
    void s.requestChange(cs('cs-crash')); await tick();
    decideChange('c-crash', approvalIdOf(s.events), true); await tick();
    assert.equal(auditList(10).find(a => a.changeSet === 'cs-crash')?.status, 'started');
    let run = runsOpen('c-crash');
    assert.equal(run.length, 1); assert.equal(run[0].results.length, 1, 'first tick saved immediately');
    const waiting = queued.filter(t => !t.dead);
    assert.equal(waiting.length, 1, 'second tick waits for batching');
    assert.equal(waiting[0].at - now, 250, 'batching after 250 ms');
    now = waiting[0].at;
    for (const t of queued) if (!t.dead && t.at <= now) { t.dead = true; t.fn(); }
    run = runsOpen('c-crash');
    assert.equal(run[0].results.length, 2, 'second tick written later in a batch');
    assert.deepEqual(run[0].undo, [{ ...op('p1'), platform: 'shopware' }], 'undo step with platform');

    dropSession('c-crash'); // "restart": memory gone, history only in the DB
    assert.equal(peekSession('c-crash'), null);
    const res = lastResult(chatSnapshot('c-crash')?.events); // like initialChat / GET /api/chat afterwards
    assert.ok(res, 'result added');
    assert.equal(res.status, 'partial'); assert.deepEqual(res.counts, { applied: 1, failed: 1 }); assert.match(res.error ?? '', /Neustart/);
    assert.match(res.error ?? '', /ob weitere Elemente noch geschrieben wurden, ist unbekannt/, '2 of 3 counted: the rest is open, not "not written"');
    assert.deepEqual(res.undo, [{ ...op('p1'), platform: 'shopware' }]);
    assert.equal(runsOpen('c-crash').length, 0, 'run completed');
    const audit = auditList(10).find(a => a.changeSet === 'cs-crash' && a.status === 'partial');
    assert.equal(audit?.interrupted, true); assert.equal(audit?.applied, 1); assert.equal(audit?.failed, 1);
    assert.equal(chatSnapshot('c-crash')?.events.filter(e => e.t === 'changeset_result').length, 1, 'second call changes nothing');

    const u = await undoChangeSet('c-crash', 'cs-crash'); // undo with the saved steps
    assert.equal(u?.ok, true);
    assert.deepEqual(undoCalls.at(-1), [{ ...op('p1'), platform: 'shopware' }]);
    assert.equal(lastResult(chatGet('c-crash')?.events)?.undone, true);
  } finally { setRunClockForTests(null); }
});

test('S1: partial undo remembers the outcome per step; second click retries only the failed ones', async () => {
  const s = start('c-undo');
  apply = async () => ({ results: [1, 2, 3].map(k => ({ itemId: `i${k}`, ok: true })), undo: [op('p1'), { op: 'delete', entity: 'product', id: 'p2' }, op('p3')] });
  const p = s.requestChange(cs('cs-u')); await tick();
  decideChange('c-undo', approvalIdOf(s.events), true); await p; s.running = false;

  undoFail = new Set(['p2']);
  const first = await undoChangeSet('c-undo', 'cs-u');
  assert.equal(first?.ok, false); assert.equal(first?.done, 2); assert.equal(first?.total, 3); assert.match(first?.error ?? '', /p2 kaputt/);
  assert.deepEqual(first?.undoResults, [{ ok: true }, { ok: false, error: 'p2 kaputt' }, { ok: true }], 'outcome per step in step order');
  const stored = lastResult(chatGet('c-undo')?.events);
  assert.equal(stored?.undone, false); assert.equal(stored?.undoResults?.length, 3, 'saved');

  undoFail = new Set();
  const second = await undoChangeSet('c-undo', 'cs-u');
  assert.deepEqual(undoCalls.at(-1)?.map(o => o.id), ['p2'], 'only the failed step, not p1/p3 again');
  assert.equal(second?.ok, true); assert.equal(second?.done, 3);
  assert.deepEqual(second?.undoResults, [{ ok: true }, { ok: true }, { ok: true }]);
  assert.equal(lastResult(s.events)?.undone, true);
  assert.equal(auditList(10).find(a => a.changeSet === 'cs-u' && a.decision === 'undo')?.retry, true);
  assert.equal(await undoChangeSet('c-undo', 'cs-u'), null, 'everything reverted');
});

test('S6: restart with open approval and question: "rejected" with reason, audit row, question marked; nothing duplicated', () => {
  const set = cs('cs-open');
  chatPut({ id: 'c-restart', title: 'T', target: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sdkSessionId: null, draft: null,
    events: [{ t: 'user', text: 'Hallo' }, { t: 'question', approvalId: 'q1', question: 'Weiter?', options: ['Ja'] }, { t: 'changeset', approvalId: 'a1', cs: set },
      { t: 'changeset', approvalId: 'a0', cs: cs('cs-done'), decision: false }, { t: 'changeset_result', csId: 'cs-done', status: 'rejected' }] });
  assert.equal(peekSession('c-restart'), null);
  const snap = chatSnapshot('c-restart')!;
  const res = lastResult(snap.events.filter(e => e.t !== 'changeset_result' || e.csId === 'cs-open'));
  assert.ok(res); assert.equal(res.status, 'rejected'); assert.match(res.error ?? '', /Neustart, bitte erneut vorschlagen/); assert.equal(res.undo, undefined);
  const q = snap.events.find(e => e.t === 'question'); assert.ok(q?.t === 'question' && /Neustart/.test(q.answer ?? ''), 'question marked');
  const ev = snap.events.find(e => e.t === 'changeset' && e.cs.id === 'cs-open'); assert.ok(ev?.t === 'changeset' && ev.decision === false);
  const a = auditList(10).find(x => x.changeSet === 'cs-open');
  assert.equal(a?.decision, 'rejected'); assert.equal(a?.reason, 'Neustart, bitte erneut vorschlagen');
  const stored = chatGet('c-restart')!;
  assert.equal(stored.updatedAt, '2024-01-01T00:00:00.000Z', 'does not move up in the list');
  assert.equal(stored.events.filter(e => e.t === 'changeset_result').length, 2, 'already decided set untouched, open one added exactly once');
  const s = getSession('c-restart'); // session rebuild: same state, no second row
  assert.equal(s.events.filter(e => e.t === 'changeset_result').length, 2);
  assert.equal(auditList(20).filter(x => x.changeSet === 'cs-open').length, 1);
});

test('B1: applier without intermediate state (e.g. promotion) crashes: result says "unknown" instead of "0 applied, nothing written"', async () => {
  const s = start('c-blind');
  apply = async () => new Promise(() => {}); // never reports progress: crash before the first tick
  void s.requestChange({ ...cs('cs-blind'), kind: 'promotion' }); await tick();
  decideChange('c-blind', approvalIdOf(s.events), true); await tick();
  assert.equal(runsOpen('c-blind')[0]?.total, 3, 'run row knows the selected count');
  dropSession('c-blind');
  const res = lastResult(chatSnapshot('c-blind')?.events);
  assert.ok(res); assert.equal(res.status, 'failed'); assert.equal(res.counts, undefined, 'no confirmed zero state'); assert.deepEqual(res.undo, []);
  assert.match(res.error ?? '', /ob und was geschrieben wurde, ist unbekannt/); assert.match(res.error ?? '', /nicht blind erneut anwenden/);
  assert.doesNotMatch(res.error ?? '', /nicht mehr geschrieben|0 angewendet/);
  const a = auditList(10).find(x => x.changeSet === 'cs-blind' && x.status === 'failed');
  assert.equal(a?.unknown, true); assert.equal(a?.interrupted, true);
  assert.equal(typeof a?.recoveredFrom, 'string', 'audit knows the time of the incident (start of the run), not just the time of loading');
});

test('B1: only write steps saved (trackedUndo), no item finished: notice with step count, undo possible', async () => {
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

test('B1: fully counted intermediate state: no "unknown" suffix', async () => {
  const s = start('c-full');
  apply = async (_set, _sel, ctx) => { const results = [1, 2, 3].map(k => ({ itemId: `i${k}`, ok: true })); ctx?.progress?.(3, 3, { results, undo: [op('p1')] }); return new Promise(() => {}); };
  void s.requestChange(cs('cs-full')); await tick();
  decideChange('c-full', approvalIdOf(s.events), true); await tick();
  dropSession('c-full');
  const res = lastResult(chatSnapshot('c-full')?.events);
  assert.ok(res); assert.equal(res.status, 'partial'); assert.deepEqual(res.counts, { applied: 3, failed: 0 });
  assert.match(res.error ?? '', /3 angewendet, 0 fehlgeschlagen \(letzter gesicherter Zwischenstand\)\.$/); assert.doesNotMatch(res.error ?? '', /unbekannt/);
});

test('Executor throws after an intermediate state: catch path keeps the reported undo steps, run row disappears (finish)', async () => {
  const s = start('c-throw');
  apply = async (_set, _sel, ctx) => { ctx?.progress?.(1, 3, { results: [{ itemId: 'i1', ok: true }], undo: [op('p1')] }); throw new Error('Kaputt'); };
  const p = s.requestChange(cs('cs-throw')); await tick();
  decideChange('c-throw', approvalIdOf(s.events), true);
  const out = await p;
  assert.equal(out.status, 'failed'); assert.equal(out.error, 'Kaputt');
  assert.equal(runsOpen('c-throw').length, 0, 'finish() reached: no run row is left behind');
  const r = lastResult(s.events);
  assert.equal(r?.status, 'failed'); assert.deepEqual(r?.undo, [{ ...op('p1'), platform: 'shopware' }], 'undo from the last tick');
  assert.deepEqual(auditList(10).filter(a => a.changeSet === 'cs-throw').map(a => a.status).sort(), ['failed', 'started']);
  s.running = false;
  dropSession('c-throw');
  assert.equal(chatSnapshot('c-throw')?.events.filter(e => e.t === 'changeset_result').length, 1, 'rebuild adds nothing: result was saved');
});

test('Different shop connected: error without "started" audit and without run row (guaranteed nothing is written)', async () => {
  const s = start('c-plat');
  let called = false; apply = async () => { called = true; return { results: [], undo: [] }; };
  const p = s.requestChange({ ...cs('cs-plat'), platform: 'shopify' }); await tick();
  decideChange('c-plat', approvalIdOf(s.events), true);
  const out = await p;
  assert.equal(out.status, 'failed'); assert.match(out.error ?? '', /verbunden ist jetzt/); assert.equal(called, false);
  assert.deepEqual(auditList(10).filter(a => a.changeSet === 'cs-plat').map(a => a.status), ['failed'], 'no "started"');
  assert.equal(runsOpen('c-plat').length, 0);
  s.running = false;
});

test('S6: stopChat answers open questions with "Abgebrochen"; rebuild marks only questions of the interrupted turn', async () => {
  const s = start('c-stop');
  const q = s.askUser({ question: 'Weiter?', options: [{ label: 'Ja' }] }); await tick();
  assert.equal(stopChat('c-stop'), true); assert.equal(await q, '');
  const ev = chatGet('c-stop')?.events.find(e => e.t === 'question');
  assert.ok(ev?.t === 'question' && ev.answer === 'Abgebrochen', 'saved so that it does not count as "Nicht beantwortet (Neustart)" on the next load');
  s.running = false;
  chatPut({ id: 'c-old', title: 'T', target: null, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z', sdkSessionId: null, draft: null,
    events: [{ t: 'user', text: 'A' }, { t: 'question', approvalId: 'q0', question: 'Alt?', options: ['Ja'] }, { t: 'done', error: null }, { t: 'user', text: 'B' }, { t: 'question', approvalId: 'q1', question: 'Neu?', options: ['Ja'] }] });
  const qs = chatSnapshot('c-old')!.events.filter(e => e.t === 'question');
  assert.ok(qs[0].t === 'question' && qs[0].answer === undefined, 'question of a finished turn stays as it was');
  assert.ok(qs[1].t === 'question' && /Neustart/.test(qs[1].answer ?? ''), 'open question of the last turn marked');
});

test('chatDelete also cleans up the run rows of the chat', () => {
  runPut({ csId: 'cs-orphan', chatId: 'c-gone', kind: 'products', title: 'x', startedAt: new Date().toISOString(), results: [], undo: [] });
  assert.equal(runsOpen('c-gone').length, 1);
  chatDelete('c-gone');
  assert.equal(runsOpen('c-gone').length, 0);
});
