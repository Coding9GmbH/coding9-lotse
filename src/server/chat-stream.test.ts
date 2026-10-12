import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatEvent } from '@/lib/protocol';
import { listenStream } from './chat-stream';
import type { Session } from './sessions';

const session = () => ({ listeners: new Set<(ev: ChatEvent) => void>() }) as unknown as Session;
const emit = (s: Session, ev: ChatEvent) => { for (const l of s.listeners) l(ev); };
const lines = async (res: Response, n: number) => {
  const reader = res.body!.getReader(), dec = new TextDecoder(); let buf = '', done = false;
  while (buf.split('\n').filter(Boolean).length < n && !done) { const r = await reader.read(); done = r.done; if (r.value) buf += dec.decode(r.value); }
  return { reader, out: buf.split('\n').filter(Boolean).map(l => JSON.parse(l) as ChatEvent), done };
};

test('listenStream: erst der Snapshot, dann Live-Ereignisse; „done“ schließt den Strom und meldet den Listener ab', async () => {
  const s = session();
  const res = listenStream(s, [{ t: 'snapshot', chat: { id: 'c', title: '', target: null, events: [] }, running: true }], true);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(s.listeners.size, 1, 'angemeldet');
  emit(s, { t: 'text', text: 'Hallo' });
  emit(s, { t: 'done', error: null });
  const { reader, out } = await lines(res, 3);
  assert.deepEqual(out.map(e => e.t), ['snapshot', 'text', 'done']);
  assert.equal((await reader.read()).done, true, 'nach done geschlossen');
  assert.equal(s.listeners.size, 0, 'abgemeldet');
  emit(s, { t: 'text', text: 'zu spät' }); // kein Fehler, nichts mehr zu tun
});

test('listenStream: ohne live schließt der Strom nach dem Verlauf; cancel des Lesers entfernt den Listener (Runde läuft weiter)', async () => {
  const s = session();
  const res = listenStream(s, [{ t: 'user', text: 'a' }, { t: 'text', text: 'b' }], false);
  const { reader, out } = await lines(res, 2);
  assert.deepEqual(out.map(e => e.t), ['user', 'text']);
  assert.equal((await reader.read()).done, true);
  assert.equal(s.listeners.size, 0);

  const live = listenStream(s, [], true);
  assert.equal(s.listeners.size, 1);
  await live.body!.getReader().cancel();
  assert.equal(s.listeners.size, 0, 'Client weg = nur abmelden');
  emit(s, { t: 'done', error: null }); // niemand hört mehr zu, kein Fehler
});

test('listenStream: Fehler beim Senden (Client schon zu) räumt den Listener auf', async () => {
  const s = session();
  const res = listenStream(s, [], true);
  const reader = res.body!.getReader();
  emit(s, { t: 'text', text: 'x' });
  await reader.cancel();
  emit(s, { t: 'text', text: 'y' });
  assert.equal(s.listeners.size, 0);
});
