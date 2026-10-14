// Magento client: safeguards against the fake (retry on 429/503, token renewal on 401, concurrency limit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeMagento } from '../../../support/magento-fake';

const fake = await startFakeMagento();
const { MagentoClient } = await import('../../../../src/server/platform/magento/client');
test.after(() => fake.close());

const calls = (path: string, from: number) => fake.log.slice(from).filter(l => l.path === path).length;
const SITES = '/V1/store/websites';

test('retry: GET retried exactly once after 429 (Retry-After) and after 503, aborted after 2 retries', async () => {
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  let n = fake.log.length;
  fake.failNext.push({ status: 429, retryAfter: 0 });
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2);
  assert.equal(calls('/store/websites', n), 2, 'one retry');
  n = fake.log.length;
  fake.failNext.push({ status: 503, retryAfter: 0 });
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2);
  assert.equal(calls('/store/websites', n), 2, 'GET retried after 503');
  n = fake.log.length;
  fake.failNext.push({ status: 429, retryAfter: 0 }, { status: 429, retryAfter: 0 }, { status: 429, retryAfter: 0 });
  await assert.rejects(c.req('GET', SITES, undefined, { store: 'all' }), /→ 429/);
  assert.equal(calls('/store/websites', n), 3, 'first attempt + 2 retries, then error');
  assert.deepEqual(fake.failNext, []);
});

test('writes: POST after 503 is NOT retried (might have been processed), after 429 it is', async () => {
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  let n = fake.log.length;
  fake.failNext.push({ status: 503, retryAfter: 0 });
  await assert.rejects(c.req('POST', '/V1/inventory/source-items', { sourceItems: [] }, { store: 'all' }), /→ 503/);
  assert.equal(calls('/inventory/source-items', n), 1, 'no retry');
  n = fake.log.length;
  fake.failNext.push({ status: 429, retryAfter: 0 });
  assert.equal(await c.req('POST', '/V1/inventory/source-items', { sourceItems: [] }, { store: 'all' }), true);
  assert.equal(calls('/inventory/source-items', n), 2, '429 = definitely not processed, retried');
});

test('admin token: expired → log in again once and run the request; integration token 401 → no retry', async () => {
  const c = new MagentoClient({ url: fake.base, user: 'admin', password: 'geheim' }), logins = (from: number) => calls('/integration/admin/token', from);
  let n = fake.log.length;
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2);
  assert.equal(logins(n), 1);
  fake.expireToken();
  n = fake.log.length;
  assert.equal((await c.req('GET', SITES, undefined, { store: 'all' })).length, 2, 'successful after renewal');
  assert.equal(logins(n), 1, 'exactly one new login'); assert.equal(calls('/store/websites', n), 2, '401 + retry');
  const bad = new MagentoClient({ url: fake.base, accessToken: 'falsch' });
  n = fake.log.length;
  await assert.rejects(bad.req('GET', SITES, undefined, { store: 'all' }), /→ 401/);
  assert.equal(calls('/store/websites', n), 1, 'integration token: no retry'); assert.equal(logins(n), 0);
});

test('concurrency: at most MAX_CONC (4) requests open at once', async () => {
  const c = new MagentoClient({ url: fake.base, accessToken: fake.token });
  fake.delayMs = 30; fake.maxOpen = 0;
  const r = await Promise.all(Array.from({ length: 8 }, () => c.req('GET', SITES, undefined, { store: 'all' })));
  fake.delayMs = 0;
  assert.equal(r.length, 8); assert.ok(fake.maxOpen >= 2 && fake.maxOpen <= 4, `maxOpen ${fake.maxOpen}`);
});
