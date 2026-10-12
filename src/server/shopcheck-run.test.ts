import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CheckFinding } from '@/lib/protocol';
import type { ShopCheck } from './checks';
import { DeniedError } from './policy';
import { normalizeFinding, runChecks } from './shopcheck-run';
import type { ShopReader } from './shopware';

const sw = { base: 'http://shop' } as unknown as ShopReader;
const f = (id: string, over: Partial<CheckFinding> = {}): CheckFinding => ({ id, area: '', title: id, severity: 'mittel', count: 3, fixPrompt: `Behebe ${id}`, ...over });
const check = (id: string, run: ShopCheck['run'], over: Partial<ShopCheck> = {}): ShopCheck => ({ id, area: 'SEO', run, ...over });

test('runChecks: Fehler isoliert, gesperrter Bereich übersprungen, Rest kommt durch', async () => {
  const run = await runChecks(sw, [
    check('ok', async () => f('a')),
    check('kaputt', async () => { throw new Error('Shop antwortet nicht'); }),
    check('gesperrt', async () => { throw new DeniedError('ZUGRIFF VERWEIGERT'); }),
    check('aus', async () => f('nie'), { scopes: ['media'] }),
  ], { scopes: { media: false } });
  assert.deepEqual(run.findings.map(x => x.id), ['a']);
  assert.equal(run.findings[0].area, 'SEO'); // Bereich aus der Prüfung
  assert.deepEqual(run.errors, [{ check: 'kaputt', error: 'Shop antwortet nicht' }]);
  assert.deepEqual(run.skipped?.sort(), ['aus', 'gesperrt']);
  assert.equal(run.checks, 3);
});

test('runChecks: Zeitlimit je Prüfung', async () => {
  const run = await runChecks(sw, [check('langsam', () => new Promise(() => {})), check('schnell', async () => f('s'))], { timeoutMs: 30 });
  assert.equal(run.findings.length, 1);
  assert.match(run.errors[0].error, /langsam: Zeitlimit/);
});

test('runChecks: Parallelität begrenzt', async () => {
  let active = 0, max = 0;
  const slow = (id: string) => check(id, async () => { active++; max = Math.max(max, active); await new Promise(r => setTimeout(r, 10)); active--; return null; });
  await runChecks(sw, ['a', 'b', 'c', 'd', 'e', 'f'].map(slow), { concurrency: 2 });
  assert.equal(max, 2);
});

test('runChecks: sortiert wichtig zuerst, dann Anzahl; ohne Treffer entfällt; doppelte IDs nur einmal', async () => {
  const run = await runChecks(sw, [check('x', async () => [f('klein', { count: 2 }), f('null', { count: 0 }), f('gross', { count: 40 }), f('hoch', { severity: 'hoch', count: 1 }), f('klein', { count: 9 })])]);
  assert.deepEqual(run.findings.map(x => x.id), ['hoch', 'gross', 'klein']);
});

test('normalizeFinding: Beispiele max. 5, total nie kleiner als count, Pflichtfelder', () => {
  const n = normalizeFinding(f('a', { count: 7, total: 3, sample: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, label: `P${i}` })) }), { area: 'Bilder' })!;
  assert.equal(n.sample!.length, 5);
  assert.equal(n.total, 7);
  assert.equal(n.area, 'Bilder');
  assert.equal(normalizeFinding(f('b', { fixPrompt: '' }), { area: 'x' }), null);
  assert.equal(normalizeFinding(f('c', { severity: 'egal' as never }), { area: 'x' })!.severity, 'mittel');
});

test('perRun: je Durchlauf ein frisches Lese-Client-Objekt (Zwischenspeicher je Objekt gelten nur für den Durchlauf), perRun:false reicht es unverändert durch', async () => {
  const { perRun } = await import('./shopcheck-run');
  const seen: unknown[] = [];
  const counts = new WeakMap<object, number>();
  const counting = check('zaehlt', async r => { seen.push(r); counts.set(r, (counts.get(r) ?? 0) + 1); return null; });
  const reader = { base: 'http://shop', search: async (e: string) => ({ data: [{ e }] }), get: async () => null, salesChannels: async () => [], req: async () => 'ok' } as unknown as ShopReader;
  await runChecks(reader, [counting]); await runChecks(reader, [counting]);
  assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1]); assert.notEqual(seen[0], reader);
  assert.equal(counts.get(seen[0] as object), 1); assert.equal(counts.get(seen[1] as object), 1);
  await runChecks(reader, [counting], { perRun: false }); await runChecks(reader, [counting], { perRun: false });
  assert.equal(seen[2], reader); assert.equal(counts.get(reader), 2);
  // Hülle hat alle Eigenschaften und reicht Argumente durch
  const w = perRun(reader);
  for (const k of Object.keys(reader)) assert.ok(k in w, k);
  assert.equal(w.base, 'http://shop'); assert.deepEqual(await w.search('product', { limit: 1 }), { data: [{ e: 'product' }] }); assert.equal(await w.req('GET', '/x'), 'ok');
});
