// Magento-Client: Schutzmechanismen gegen den Fake (Retry bei 429/503, Token-Erneuerung bei 401, Parallelitätsgrenze).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMagento } from '../../../support/magento-fake';

const fake = await startFakeMagento();
const { MagentoClient } = await import('../../../../src/server/platform/magento/client');
test.after(() => fake.close());

const calls = (path: string, from: number) => fake.log.slice(from).filter(l => l.path === path).length;
const SITES = '/V1/store/websites';

test('Retry: GET nach 429 (Retry-After) und nach 503 genau einmal wiederholt, nach 2 Wiederholungen Abbruch', async () => {
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  let n = fake.log.length;
  fake.failNext.push({ status: 429, retryAfter: 0 });
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2);
  assert.equal(calls('/store/websites', n), 2, 'eine Wiederholung');
  n = fake.log.length;
  fake.failNext.push({ status: 503, retryAfter: 0 });
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2);
  assert.equal(calls('/store/websites', n), 2, 'GET nach 503 wiederholt');
  n = fake.log.length;
  fake.failNext.push({ status: 429, retryAfter: 0 }, { status: 429, retryAfter: 0 }, { status: 429, retryAfter: 0 });
  await assert.rejects(c.req('GET', SITES, undefined, { store: 'all' }), /→ 429/);
  assert.equal(calls('/store/websites', n), 3, 'Erstversuch + 2 Wiederholungen, dann Fehler');
  assert.deepEqual(fake.failNext, []);
});

test('Schreibzugriffe: POST nach 503 wird NICHT wiederholt (könnte verarbeitet sein), nach 429 schon', async () => {
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  let n = fake.log.length;
  fake.failNext.push({ status: 503, retryAfter: 0 });
  await assert.rejects(c.req('POST', '/V1/inventory/source-items', { sourceItems: [] }, { store: 'all' }), /→ 503/);
  assert.equal(calls('/inventory/source-items', n), 1, 'keine Wiederholung');
  n = fake.log.length;
  fake.failNext.push({ status: 429, retryAfter: 0 });
  assert.equal(await c.req('POST', '/V1/inventory/source-items', { sourceItems: [] }, { store: 'all' }), true);
  assert.equal(calls('/inventory/source-items', n), 2, '429 = sicher nicht verarbeitet, wiederholt');
});

test('Admin-Token: abgelaufen → einmal neu anmelden und Anfrage ausführen; Integrations-Token 401 → kein Retry', async () => {
  const c = new MagentoClient({ url: fake.base, user: 'admin', password: 'geheim' }), logins = (from: number) => calls('/integration/admin/token', from);
  let n = fake.log.length;
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2);
  assert.equal(logins(n), 1);
  fake.expireToken();
  n = fake.log.length;
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2, 'nach Erneuerung erfolgreich');
  assert.equal(logins(n), 1, 'genau eine neue Anmeldung'); assert.equal(calls('/store/websites', n), 2, '401 + Wiederholung');
  const bad = new MagentoClient({ url: fake.base, accessToken: 'falsch' });
  n = fake.log.length;
  await assert.rejects(bad.req('GET', SITES, undefined, { store: 'all' }), /→ 401/);
  assert.equal(calls('/store/websites', n), 1, 'Integrations-Token: keine Wiederholung'); assert.equal(logins(n), 0);
});

test('Parallelität: höchstens MAX_CONC (4) Anfragen gleichzeitig offen', async () => {
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  fake.delayMs = 30; fake.maxOpen = 0;
  const r = await Promise.all(Array.from({ length: 8 }, () => c.req('GET', SITES, undefined, { store: 'all' })));
  fake.delayMs = 0;
  assert.equal(r.length, 8); assert.ok(fake.maxOpen >= 2 && fake.maxOpen <= 4, `maxOpen ${fake.maxOpen}`);
});
