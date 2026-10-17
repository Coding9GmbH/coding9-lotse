import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import '../isolate-data';
import type { ChatEvent } from '@/lib/protocol';
import { sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON bodies and tool input */

// Internet for a task container only after a human allowed it (A12), with the FakeRunner: the egress network (labelled, not internal,
// no traffic between containers, pinned subnet), the panel switch and request_internet's card (nothing before the click), revoking on
// "sperren", pause, finish, a new setup and the policy "nie", a woken container offline, the restart reconcile, the audit, the proxy block.
const S = await sandboxForTests();
const { fake, J, T, E } = S;
const I = await import('../../src/server/sandbox/internet');
const W = await import('../../src/server/sandbox/workspace-tools');
const R = await import('../../src/server/sandbox/reconcile');
const db = await import('../../src/server/db');
const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { ensureEgressNetwork } = await import('../../src/server/sandbox/network');
const { egressSubnet } = await import('../../src/server/access');
const { fromSandbox } = await import('../../src/proxy');
const { getSession, decideChange } = await import('../../src/server/sessions');
const { chatReducer, initialChatState } = await import('../../src/lib/chat-state');
const route = await import('../../src/app/api/sandbox/tasks/[id]/internet/route');
const envRoute = await import('../../src/app/api/sandbox/env/route');
after(async () => { R.resetReconcile(); await S.close(); });

const EGRESS = 'lotse-sandbox-egress';
const attached = (id: string) => fake.containers.get(T.getTask(id)!.containerId!)!.networks.includes(EGRESS);
const audits = (taskId: string) => db.auditList(1000).filter((a: any) => a.taskId === taskId && String(a.action).startsWith('internet')).reverse() as any[];
const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(new Request(`http://127.0.0.1/api/sandbox/tasks/${id}/internet`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

test('egress network: created labelled, not internal, without traffic between containers; anything else is refused', async () => {
  const r = new FakeRunner();
  assert.deepEqual(await ensureEgressNetwork(r, null), { created: true });
  const n = r.networks.get(EGRESS)!;
  assert.deepEqual(n, { name: EGRESS, internal: false, labels: { 'lotse.managed': '1' }, subnets: [], isolated: false, icc: false });
  assert.deepEqual(await ensureEgressNetwork(r, null), { created: false });
  for (const [bad, re] of [[{ icc: true }, /enable_icc/], [{ internal: true }, /intern/], [{ labels: {} }, /gehört nicht zu Lotse/]] as const) {
    r.networks.set(EGRESS, { ...n, ...bad });
    await assert.rejects(ensureEgressNetwork(r, null), re);
  }
  r.networks.clear();
  await ensureEgressNetwork(r, '10.214.0.0/24');
  assert.deepEqual(r.networks.get(EGRESS)?.subnets, ['10.214.0.0/24']);
  await assert.rejects(ensureEgressNetwork(r, '10.215.0.0/24'), /Subnetz 10\.215\.0\.0\/24/);
  process.env.LOTSE_SANDBOX_SUBNET = '10.214.0.0/24';
  try { await assert.rejects(ensureEgressNetwork(r, '10.214.0.0/24'), /unterscheiden/); } finally { delete process.env.LOTSE_SANDBOX_SUBNET; }
  await assert.rejects(r.createNetwork('bridge', { internal: false, labels: {} }), /nicht angelegt/);
});

test('proxy: requests from the egress subnet are refused like those from lotse-sandbox', () => {
  const env = { LOTSE_SANDBOX_SUBNET: '10.213.0.0/24', LOTSE_SANDBOX_EGRESS_SUBNET: '10.214.0.0/24' };
  assert.equal(fromSandbox('10.214.0.7', null, env), true);
  assert.equal(fromSandbox('127.0.0.1', '10.214.0.7', env), true);
  assert.equal(fromSandbox('10.213.0.5', null, env), true);
  assert.equal(fromSandbox('10.215.0.5', null, env), false);
  assert.equal(fromSandbox('10.214.0.7', null, { LOTSE_SANDBOX_EGRESS_SUBNET: '10.214.0.0/24' }), true, 'egress alone is enough');
  assert.equal(egressSubnet({ LOTSE_SANDBOX_EGRESS_SUBNET: 'kaputt' }), null);
});

test('blocked: policy "nie", and Lotse in Docker without password and without the pinned egress subnet', () => {
  assert.equal(I.internetBlocked({}), null);
  assert.match(I.internetBlocked({ AICB_DOCKER: '1' }) ?? '', /LOTSE_SANDBOX_EGRESS_SUBNET/);
  assert.equal(I.internetBlocked({ AICB_DOCKER: '1', LOTSE_SANDBOX_EGRESS_SUBNET: '10.214.0.0/24' }), null);
  assert.equal(I.internetBlocked({ AICB_DOCKER: '1', LOTSE_PASSWORD: 'x' }), null);
  E.saveSandbox({ internet: 'never' });
  try { assert.equal(I.internetBlocked({}), I.INTERNET_NEVER); } finally { E.saveSandbox({ internet: 'approval' }); }
  assert.throws(() => E.saveSandbox({ internet: 'always' as any }), /nur nach Freigabe/);
  assert.equal(E.sandboxPublic().internet, 'approval', 'default');
});

test('panel switch: on attaches the running container to the egress network, off detaches it; both audited with the user', async () => {
  const t = await S.readyTask('Internet im Panel');
  assert.equal(T.publicTask(t).internet, null);
  assert.ok(!attached(t.id), 'offline by default');
  process.env.LOTSE_PASSWORD = 'pw';
  const auth = { authorization: `Basic ${Buffer.from('alex:pw').toString('base64')}` };
  try {
    const on = await post(t.id, { on: true }, auth);
    assert.equal(on.status, 200);
    assert.ok(((await on.json()) as any).task.internet.since);
    assert.ok(attached(t.id));
    assert.equal(fake.networks.get(EGRESS)?.internal, false, 'egress network created on demand');
    const off = await post(t.id, { on: false }, auth);
    assert.equal(((await off.json()) as any).task.internet, null);
  } finally { delete process.env.LOTSE_PASSWORD; }
  assert.ok(!attached(t.id));
  assert.deepEqual(audits(t.id).map(a => [a.action, a.via ?? a.reason, a.actor]), [['internet-on', 'panel', 'alex'], ['internet-off', 'panel', 'alex']]);
  assert.equal((await post(t.id, { on: 'ja' })).status, 400);
  await J.pauseTask(t.id);
  const res = await post(t.id, { on: true });
  assert.equal(res.status, 409, 'only a ready sandbox with a running container');
  assert.ok(!fake.containers.get(T.getTask(t.id)!.containerId!)!.networks.includes(EGRESS));
  await J.finishTask(t.id);
});

test('pause, a container stopped outside Lotse, a new setup and finish: internet ends, a woken container starts offline', async () => {
  const t = await S.readyTask('Lebenszyklus');
  await I.grantInternet(t.id, { via: 'panel' });
  await J.pauseTask(t.id);
  assert.ok(!attached(t.id));
  assert.equal(T.getTask(t.id)!.internet, null);
  // attached while stopped (e.g. a Docker restart left it so): waking detaches before the start
  await fake.connectEgress(T.getTask(t.id)!.containerId!);
  await J.ensureAwake(t.id);
  assert.equal(T.getTask(t.id)!.status, 'ready');
  assert.ok(!attached(t.id), 'woken offline');
  // "Datenbank ersetzen"/retry: the setup runs offline
  await I.grantInternet(t.id, { via: 'panel' });
  J.runSteps(t.id, 'theme-compile');
  await S.until(() => !J.setupRunning(t.id) && T.getTask(t.id)!.status !== 'setting_up');
  assert.ok(!attached(t.id));
  await I.grantInternet(t.id, { via: 'panel' });
  await J.finishTask(t.id);
  assert.equal(T.getTask(t.id)!.internet, null);
  assert.deepEqual(audits(t.id).filter(a => a.action === 'internet-off').map(a => a.reason), ['pause', 'setup', 'finish']);
});

test('policy "nie": refused, and switching to it revokes every task', async () => {
  const t = await S.readyTask('Richtlinie');
  await I.grantInternet(t.id, { via: 'panel' });
  const res = await envRoute.PUT(new Request('http://127.0.0.1/api/sandbox/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ internet: 'never' }) }));
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).env.internet, 'never');
  assert.ok(!attached(t.id));
  assert.equal(audits(t.id).at(-1).reason, 'policy');
  const again = await post(t.id, { on: true });
  assert.equal(again.status, 403);
  assert.match(((await again.json()) as any).error, /nie/);
  E.saveSandbox({ internet: 'approval' });
  await J.finishTask(t.id);
});

test('request_internet: a card, the tool waits; only the click attaches; declining attaches nothing (audited)', async () => {
  const t = await S.readyTask('Werkzeug');
  const events: ChatEvent[] = [], approvals = new Map<string, (r: { allow?: boolean }) => void>();
  const host = { id: 'chat-internet', taskId: t.id, emit: (ev: ChatEvent) => { events.push(ev); }, askUser: async () => '', approvals, abort: null };
  const tool = W.sandboxTools(host).find(x => x.name === 'request_internet')!;
  const call = () => tool.handler({ reason: 'composer require acme/lib' } as any, {});
  let p = call();
  await S.until(() => approvals.size === 1);
  const card = events.find(e => e.t === 'internet_request') as Extract<ChatEvent, { t: 'internet_request' }>;
  assert.equal(card.reason, 'composer require acme/lib');
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!attached(t.id), 'nothing before the click');
  approvals.get(card.approvalId)!({ allow: true });
  let r = await p;
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.ok(attached(t.id));
  assert.match((await call()).content.map((c: any) => c.text).join(''), /bereits freigegeben/);
  await I.revokeInternet(t.id, 'panel');
  p = call();
  await S.until(() => approvals.size === 1);
  [...approvals.values()][0]({ allow: false });
  r = await p;
  assert.ok(r.isError);
  assert.ok(!attached(t.id));
  assert.deepEqual(audits(t.id).map(a => [a.action, a.via ?? a.reason]), [['internet-on', 'chat'], ['internet-off', 'panel'], ['internet-denied', 'chat']]);
  assert.equal(audits(t.id)[0].reason, 'composer require acme/lib');
  // policy "nie": the tool says so without a card
  E.saveSandbox({ internet: 'never' });
  try { const n = events.length; const x = await call(); assert.ok(x.isError); assert.equal(events.length, n); } finally { E.saveSandbox({ internet: 'approval' }); }
  await J.finishTask(t.id);
});

test('restart: an attachment nobody allowed is removed, a stored approval without attachment is cleared', async () => {
  const t = await S.readyTask('Neustart');
  await fake.connectEgress(t.containerId!);
  await R.reconcileContainers();
  assert.ok(!attached(t.id));
  await I.grantInternet(t.id, { via: 'panel' });
  await R.reconcileContainers();
  assert.ok(attached(t.id), 'allowed and running: stays');
  await fake.disconnectEgress(t.containerId!);
  await R.reconcileContainers();
  assert.equal(T.getTask(t.id)!.internet, null);
  await J.finishTask(t.id);
});

test('chat: the decision is stored on the card event; the log card is interactive only live and until decided', () => {
  const s = getSession('chat-internet-card');
  let got: unknown = null;
  s.events.push({ t: 'internet_request', approvalId: 'a1', reason: 'npm install' });
  s.approvals.set('a1', r => { got = r; });
  assert.equal(decideChange('chat-internet-card', 'a1', true), true);
  assert.deepEqual(got, { allow: true, selected: undefined });
  assert.equal((s.events.at(-1) as any).decision, true);
  const ev: ChatEvent = { t: 'internet_request', approvalId: 'a2', reason: 'npm install' };
  const live = chatReducer(initialChatState, { type: 'event', event: ev, mode: 'live' });
  assert.deepEqual(live.items.at(-1), { kind: 'internet', key: live.items.at(-1)!.key, approvalId: 'a2', reason: 'npm install', decision: undefined, interactive: true });
  const decided = chatReducer(live, { type: 'decide', approvalId: 'a2', allow: false });
  assert.deepEqual([(decided.items.at(-1) as any).interactive, (decided.items.at(-1) as any).decision], [false, false]);
  const replay = chatReducer(initialChatState, { type: 'event', event: ev, mode: 'replay' });
  assert.equal((replay.items.at(-1) as any).interactive, false);
});
