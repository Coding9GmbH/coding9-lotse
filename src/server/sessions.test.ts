import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangeSet, ChatEvent } from '@/lib/protocol';

// Freigabe-Workflow (Kern des Sicherheitsmodells): Mensch entscheidet, Auswahl zählt, Abbruch = Ablehnung, Audit-Log, Rückgängig nur mit passender Plattform.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-sessions-'));
delete process.env.SHOP_PLATFORM;

const { updateSettings } = await import('./settings');
const { ADAPTERS } = await import('./platform');
const { getSession, decideChange, answerQuestion, stopChat, dropSession, peekSession, persist, chatSnapshot, undoChangeSet } = await import('./sessions');
const { auditList, chatGet, chatDelete } = await import('./db');
import type { ApplyResult } from './changes';

updateSettings({ platform: 'shopware' });
const sw = ADAPTERS.shopware;
const applied: { cs: ChangeSet; selected: string[] }[] = [];
let applyResult: () => Promise<ApplyResult> = async () => ({ results: [{ itemId: 'a', ok: true }], undo: [{ op: 'patch', entity: 'product', id: 'p1', data: { name: 'alt' } }] });
sw.apply = async (cs, _payload, selected) => { applied.push({ cs, selected: [...selected] }); return applyResult(); };
const undone: unknown[][] = [];
sw.undo = async ops => { undone.push(ops); return ops.map(() => ({ ok: true })); };

const cs = (id: string, platform?: string): ChangeSet => ({ id, kind: 'products', entity: 'product', title: 'Test', reason: null, atomic: false, skipped: [], ...(platform ? { platform: platform as ChangeSet['platform'] } : {}),
  items: ['a', 'b'].map(i => ({ id: i, entity: 'product', entityId: 'p1', label: 'P', field: 'name', fieldLabel: 'Name', before: 'alt', after: 'neu', afterRaw: 'neu', warn: [] })) });
// wie startChat: Ereignisse sammeln, speichern, Runde läuft
const start = (id: string) => {
  const s = getSession(id); s.running = true; s.abort = new AbortController();
  s.emit = ev => { s.events.push({ ...ev }); if (ev.t === 'changeset' || ev.t === 'changeset_result' || ev.t === 'question') persist(s); };
  s.events.push({ t: 'user', text: 'Hallo' }); persist(s);
  return s;
};
const approvalIdOf = (events: ChatEvent[]) => (events.findLast(e => e.t === 'changeset') as { approvalId: string }).approvalId;
const tick = () => new Promise(r => setTimeout(r, 5));

test('requestChange: Freigabe mit Auswahl → Executor bekommt nur die gewählten Elemente, Ergebnis + Audit „approved“', async () => {
  const s = start('c-approve');
  const pending = s.requestChange(cs('cs1'), { x: 1 });
  await tick();
  assert.equal(s.approvals.size, 1);
  assert.equal(decideChange('c-approve', 'falsch', true), false, 'unbekannte Freigabe');
  assert.ok(decideChange('c-approve', approvalIdOf(s.events), true, ['a']));
  const out = await pending;
  assert.equal(out.status, 'applied'); assert.equal(out.applied, 1);
  assert.deepEqual(applied.at(-1)?.selected, ['a']);
  assert.equal(applied.at(-1)?.cs.platform, 'shopware', 'Set trägt die Plattform der Session');
  const res = s.events.findLast(e => e.t === 'changeset_result');
  assert.equal(res?.t === 'changeset_result' && res.status, 'applied');
  assert.deepEqual(res?.t === 'changeset_result' && res.undo?.[0], { op: 'patch', entity: 'product', id: 'p1', data: { name: 'alt' }, platform: 'shopware' }, 'Rückgängig-Schritt bekommt die Plattform');
  const audit = auditList(5).find(a => a.changeSet === 'cs1');
  assert.equal(audit?.decision, 'approved'); assert.equal(audit?.applied, 1); assert.equal((audit?.items as unknown[]).length, 1);
  assert.equal(s.approvals.size, 0);
  assert.equal(chatGet('c-approve')?.events.some(e => e.t === 'changeset_result'), true, 'gespeichert');
});

test('requestChange: Ablehnung schreibt nichts, Audit „rejected“; stopChat während offener Freigabe = Ablehnung + Abbruch', async () => {
  const n = applied.length;
  const s = start('c-reject');
  const p1 = s.requestChange(cs('cs2')); await tick();
  assert.ok(decideChange('c-reject', approvalIdOf(s.events), false));
  const r1 = await p1;
  assert.equal(r1.status, 'rejected'); assert.match(r1.message, /nichts geschrieben/);
  assert.equal(auditList(5).find(a => a.changeSet === 'cs2')?.decision, 'rejected');

  const p2 = s.requestChange(cs('cs3')); await tick();
  assert.ok(stopChat('c-reject'));
  const r2 = await p2;
  assert.equal(r2.status, 'rejected');
  assert.equal(s.abort?.signal.aborted, true);
  assert.equal(applied.length, n, 'Executor nie aufgerufen');
  assert.equal(stopChat('c-reject-unbekannt'), false);
  s.running = false;
});

test('Fehler im Executor → Status failed mit Fehlertext, Rückfrage liefert die Antwort des Menschen', async () => {
  const s = start('c-fail');
  applyResult = async () => { throw new Error('Shop nicht erreichbar'); };
  const p = s.requestChange(cs('cs4')); await tick();
  decideChange('c-fail', approvalIdOf(s.events), true);
  const r = await p;
  assert.equal(r.status, 'failed'); assert.match(r.error ?? '', /Shop nicht erreichbar/);
  applyResult = async () => ({ results: [{ itemId: 'a', ok: true }], undo: [] });

  const q = s.askUser({ question: 'Weiter?', options: [{ label: 'Ja' }, { label: 'Nein', description: 'abbrechen' }] }); await tick();
  const qe = s.events.findLast(e => e.t === 'question');
  assert.ok(qe?.t === 'question' && qe.optionHints?.[1] === 'abbrechen');
  assert.equal(answerQuestion('c-fail-unbekannt', 'x', 'Ja'), false, 'unbekannter Chat legt keine Session an');
  assert.equal(peekSession('c-fail-unbekannt'), null);
  assert.ok(answerQuestion('c-fail', (qe as { approvalId: string }).approvalId, 'Ja'));
  assert.equal(await q, 'Ja');
  assert.equal((chatGet('c-fail')?.events.findLast(e => e.t === 'question') as { answer?: string }).answer, 'Ja');
  s.running = false;
});

test('dropSession während laufender Runde: gelöschter Chat wird durch das Ende der Runde nicht wiederbelebt', async () => {
  const s = start('c-del');
  const p = s.requestChange(cs('cs5')); await tick();
  assert.ok(chatGet('c-del'), 'vor dem Löschen gespeichert');
  chatDelete('c-del'); dropSession('c-del'); // wie DELETE /api/chats/[id]
  assert.equal(peekSession('c-del'), null);
  const r = await p; // stopChat hat die Freigabe als Ablehnung aufgelöst → changeset_result wird emittiert (persist!)
  assert.equal(r.status, 'rejected');
  s.running = false; s.events.push({ t: 'done', error: 'Abgebrochen.' }); persist(s); // finally von startChat
  assert.equal(chatGet('c-del'), null, 'bleibt gelöscht');
  assert.equal(chatSnapshot('c-del'), null);
});

test('undoChangeSet: nutzt die Rückgängig-Schritte des Ergebnisses, markiert undone, Audit „undo“; zweites Mal null', async () => {
  const s = start('c-undo');
  const p = s.requestChange(cs('cs6')); await tick();
  applyResult = async () => ({ results: [{ itemId: 'a', ok: true }, { itemId: 'b', ok: true }], undo: [{ op: 'patch', entity: 'product', id: 'p1', data: { name: 'alt' } }] });
  decideChange('c-undo', approvalIdOf(s.events), true);
  await p; s.running = false;
  const r = await undoChangeSet('c-undo', 'cs6');
  assert.equal(r?.ok, true); assert.deepEqual(r?.results, [{ ok: true }]); assert.deepEqual(r?.undoResults, [{ ok: true }]);
  assert.deepEqual(undone.at(-1), [{ op: 'patch', entity: 'product', id: 'p1', data: { name: 'alt' }, platform: 'shopware' }]);
  assert.equal(auditList(5).find(a => a.changeSet === 'cs6' && a.decision === 'undo')?.decision, 'undo');
  assert.equal(await undoChangeSet('c-undo', 'cs6'), null, 'schon rückgängig gemacht');
  assert.equal(await undoChangeSet('c-undo', 'gibt-es-nicht'), null);
});

test('Plattformwechsel: ruhende Session wird neu aufgebaut (Verlauf bleibt), Set einer fremden Plattform wird nicht geschrieben', async () => {
  const before = getSession('c-undo');
  updateSettings({ platform: 'magento' });
  const s = getSession('c-undo');
  assert.notEqual(s, before); assert.equal(s.platform, 'magento');
  assert.ok(s.events.some(e => e.t === 'changeset_result'), 'Verlauf aus der DB');
  s.running = true; s.emit = ev => { s.events.push({ ...ev }); };
  const n = applied.length;
  const p = s.requestChange(cs('cs7', 'shopware')); await tick();
  decideChange('c-undo', approvalIdOf(s.events), true);
  const r = await p;
  assert.equal(r.status, 'failed'); assert.match(r.error ?? '', /gehört zu Shopware, verbunden ist jetzt Magento/);
  assert.equal(applied.length, n, 'Shopware-Executor nicht aufgerufen');
  s.running = false;
  updateSettings({ platform: 'shopware' });
});
