import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Cost brake: per-turn cost from the SDK's cumulative total, monthly budget, block before a turn, status for UI and health
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-usage-'));
for (const k of Object.keys(process.env)) if (/^(SHOPWARE_|SHOPIFY_|MAGENTO_|OPENMAGE_|SHOP_PLATFORM$|AI_|ANTHROPIC_|LOTSE_AI_BUDGET)/.test(k)) delete process.env[k];
process.env.AI_PROVIDER = 'claude';

const U = await import('../../src/server/usage');
const { usageAdd, usageSince } = await import('../../src/server/db');
const { updateSettings, publicSettings } = await import('../../src/server/settings');
const { getSession } = await import('../../src/server/sessions');
const { startChat } = await import('../../src/server/agent');
const { GET: health } = await import('../../src/app/api/health/route');

test('budget text: dot or comma, empty/0/invalid = no limit', () => {
  assert.equal(U.parseBudget('50'), 50);
  assert.equal(U.parseBudget(' 49,90 '), 49.9);
  for (const v of ['', '0', 'abc', '-5', undefined, null]) assert.equal(U.parseBudget(v), null, String(v));
});

test('cost per turn: the SDK total is cumulative for a resumed session', () => {
  assert.equal(U.turnCost(0.12, null), 0.12, 'first turn');
  assert.equal(Math.round(U.turnCost(0.30, 0.12)! * 100) / 100, 0.18, 'second turn: only the difference');
  assert.equal(U.turnCost(0.05, 0.30), 0.05, 'new session (smaller total): counts as a whole');
  assert.equal(U.turnCost(undefined, 0.3), null, 'no cost reported (Codex)');
});

test('month boundary (UTC), status and gate', () => {
  const now = new Date('2026-10-17T10:00:00Z');
  assert.equal(U.monthStart(now), '2026-10-01T00:00:00.000Z');
  usageAdd({ provider: 'claude', costUsd: 7, ts: '2026-09-30T23:59:00.000Z' }); // last month: does not count
  usageAdd({ provider: 'claude', costUsd: 3.5, ts: '2026-10-02T08:00:00.000Z', chatId: 'a' });
  usageAdd({ provider: 'claude', costUsd: 1.5, ts: '2026-10-17T09:00:00.000Z', chatId: 'b' });
  usageAdd({ provider: 'codex', costUsd: null, ts: '2026-10-17T09:30:00.000Z', chatId: 'c' });
  let s = U.usageStatus(now);
  assert.deepEqual([s.budget, s.month.cost, s.month.turns, s.today.cost, s.today.turns, s.used, s.warn, s.blocked], [null, 5, 3, 1.5, 2, null, false, false]);
  assert.deepEqual(U.budgetGate(now), { blocked: false }, 'without a budget: no limit');
  updateSettings({ ai: { budget: '6' } });
  s = U.usageStatus(now);
  assert.deepEqual([s.budget, s.used, s.warn, s.blocked], [6, 0.833, true, false], '5 of 6 = warning');
  assert.deepEqual(U.budgetGate(now), { blocked: false, maxUsd: 1 }, 'remaining budget = limit of the turn');
  updateSettings({ ai: { budget: '5' } });
  assert.deepEqual(U.budgetGate(now), { blocked: true, spent: 5, budget: 5 });
  assert.equal(U.usageStatus(now).blocked, true);
  assert.equal(publicSettings().ai.budget, '5');
});

test('used-up budget: the turn ends at once with a clear message, nothing is counted; health shows the brake', async () => {
  updateSettings({ ai: { budget: '0,01', apiKey: 'sk-ant-test' } });
  usageAdd({ provider: 'claude', costUsd: 1 });
  const before = usageSince('2000-01-01').turns;
  const { started, done } = startChat({ chatId: 'chat-budget', message: 'Hallo', target: null });
  assert.equal(started, true);
  await done;
  const last = getSession('chat-budget').events.at(-1);
  assert.ok(last?.t === 'done' && /KI-Budget für diesen Monat ist aufgebraucht/.test(last.error ?? ''), JSON.stringify(last));
  assert.equal(usageSince('2000-01-01').turns, before, 'blocked turn is not recorded');
  const h = await (await health()).json();
  assert.equal(h.ai.budget.blocked, true); assert.equal(h.ai.budget.limit, 0.01);
  updateSettings({ ai: { budget: '' } });
  assert.equal((await (await health()).json()).ai.budget, undefined, 'no budget: no brake in health');
});

test('environment variable as default, the setting takes precedence', () => {
  process.env.LOTSE_AI_BUDGET_USD = '20';
  try {
    assert.equal(U.budgetUsd(), 20);
    assert.equal(publicSettings().ai.budgetViaEnv, true);
    updateSettings({ ai: { budget: '30' } });
    assert.equal(U.budgetUsd(), 30);
    assert.equal(publicSettings().ai.budgetViaEnv, false);
  } finally { delete process.env.LOTSE_AI_BUDGET_USD; updateSettings({ ai: { budget: '' } }); }
});
