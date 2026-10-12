import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent } from '@/lib/protocol';

process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-sessions-run-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$|AI_|ANTHROPIC_)/.test(k)) delete process.env[k];
process.env.AI_PROVIDER = 'codex'; // nicht angemeldet → die Runde endet sofort mit einem Fehler, ohne KI-Prozess

const { getSession, peekSession, chatStatus, chatSnapshot, sweepIdleSessions } = await import('../../src/server/sessions');
const { startChat } = await import('../../src/server/agent');
const { GET } = await import('../../src/app/api/chat/route');

test('Runde: done kommt erst, wenn die Session nicht mehr läuft (Verlauf danach nie mehr „läuft“)', async () => {
  const s = getSession('chat-run-1');
  const seen: { t: string; running: boolean; status: string | undefined }[] = [];
  s.listeners.add((ev: ChatEvent) => seen.push({ t: ev.t, running: s.running, status: chatStatus(s) }));
  const { started, done } = startChat({ chatId: 'chat-run-1', message: 'Hallo', target: null });
  assert.equal(started, true);
  assert.equal(s.running, true);
  assert.equal(startChat({ chatId: 'chat-run-1', message: 'nochmal', target: null }).started, false, 'zweite Runde abgewiesen');
  await done;
  const fin = seen.filter(x => x.t === 'done');
  assert.equal(fin.length, 1, 'genau ein done');
  assert.deepEqual(fin[0], { t: 'done', running: false, status: undefined });
  assert.equal(s.events.at(-1)?.t, 'done');
  const last = s.events.at(-1); assert.ok(last?.t === 'done' && /Codex/.test(last.error ?? ''));
  assert.equal(chatSnapshot('chat-run-1')?.events.length, s.events.length);
});

test('GET /api/chat: unbekannte ID → 404 ohne neue Session; bekannter Chat → Snapshot', async () => {
  const r = await GET(new Request('http://127.0.0.1:3333/api/chat?chatId=gibt-es-nicht'));
  assert.equal(r.status, 404);
  assert.equal(peekSession('gibt-es-nicht'), null);
  const ok = await GET(new Request('http://127.0.0.1:3333/api/chat?chatId=chat-run-1'));
  assert.equal(ok.status, 200);
  const first = JSON.parse((await ok.text()).split('\n')[0]) as { t: string; running: boolean; chat: { events: ChatEvent[] } };
  assert.equal(first.t, 'snapshot');
  assert.equal(first.running, false);
  assert.equal(first.chat.events.at(-1)?.t, 'done');
});

test('Ruhende Sessions ohne Zuhörer werden nach 30 Minuten freigegeben, laufende und verbundene nicht', () => {
  const idle = getSession('chat-idle'), busy = getSession('chat-busy'), watched = getSession('chat-watched');
  const old = Date.now() - 31 * 60_000;
  idle.lastUsed = old; busy.lastUsed = old; busy.running = true; watched.lastUsed = old; watched.listeners.add(() => {});
  assert.equal(sweepIdleSessions(), 1);
  assert.equal(peekSession('chat-idle'), null);
  assert.ok(peekSession('chat-busy') && peekSession('chat-watched'));
  busy.running = false;
  assert.equal(sweepIdleSessions(Date.now() + 60_000), 1);
  assert.ok(peekSession('chat-watched'), 'verbundene Oberfläche bleibt');
  assert.ok(peekSession('chat-run-1'), 'gerade benutzt: bleibt');
});
