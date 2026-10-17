import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import '../isolate-data';
/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON bodies in assertions */

// Sandbox environment: off by default, LOTSE_SANDBOX=0 and the open-bind rule, image/variable/command validation,
// secret values sealed and masked, audit with names only, routes (403 while off, check reachable/unreachable) with FakeRunner.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];

const E = await import('../../src/server/sandbox/env');
const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { ensureNetwork, networkMode } = await import('../../src/server/sandbox/network');
const { kvGet, kvSet, auditList } = await import('../../src/server/db');
const { redact } = await import('../../src/server/settings');
const envRoute = await import('../../src/app/api/sandbox/env/route');
const { POST: checkRoute } = await import('../../src/app/api/sandbox/env/check/route');
const { GET: healthRoute } = await import('../../src/app/api/health/route');
const fake = new FakeRunner();
setRunner(fake);
after(() => fake.close());

const SECRET = 'sup3r-s3cret-value-123';
const put = async (body: unknown) => { const r = await envRoute.PUT(new Request('http://127.0.0.1/api/sandbox/env', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() as Record<string, any> }; };
const lines = async (r: Response) => (await r.text()).trim().split('\n').map(l => JSON.parse(l) as Record<string, any>);
const check = () => checkRoute(new Request('http://127.0.0.1/api/sandbox/env/check', { method: 'POST' }));

test('off by default; LOTSE_SANDBOX=0 and an open bind without password block it', () => {
  assert.deepEqual(E.sandboxStatus({}), { enabled: false, reason: 'off', message: E.SANDBOX_OFF });
  assert.equal(E.sandboxStatus({ LOTSE_SANDBOX: '0' }).reason, 'env');
  assert.equal(E.sandboxPublic().image, 'dockware/shopware:6.7.15.1');
  assert.equal(E.sandboxPublic().maxRunning, 2);
  assert.equal(E.maxRunning({ LOTSE_SANDBOX_MAX: '1' }), 1);
  assert.equal(E.maxRunning({ LOTSE_SANDBOX_MAX: '99' }), 10);
  assert.equal(E.sandboxPublic({ LOTSE_SANDBOX_IDLE_MINUTES: '45' }).idleMinutes, 45);
  // enabling is refused while Lotse is reachable from the network without a password
  assert.throws(() => E.saveSandbox({ enabled: true }, { HOSTNAME: '0.0.0.0' }), /LOTSE_PASSWORD/);
  assert.throws(() => E.saveSandbox({ enabled: true }, { AICB_DOCKER: '1', LOTSE_BIND: '0.0.0.0' }), /LOTSE_PASSWORD/);
  assert.throws(() => E.saveSandbox({ enabled: true }, { ALLOWED_HOSTS: 'lotse.example.com' }), /LOTSE_PASSWORD/);
  assert.throws(() => E.saveSandbox({ enabled: true }, { LOTSE_SANDBOX: '0' }), /LOTSE_SANDBOX=0/);
  assert.equal(E.sandboxStatus().enabled, false);
  E.saveSandbox({ enabled: true }, { HOSTNAME: '0.0.0.0', LOTSE_PASSWORD: 'pw' });
  assert.equal(E.sandboxStatus({ HOSTNAME: '0.0.0.0', LOTSE_PASSWORD: 'pw' }).enabled, true);
  // stored on, but the environment changed afterwards: still blocked
  assert.equal(E.sandboxStatus({ HOSTNAME: '0.0.0.0' }).reason, 'open-bind');
  // network mode: the task containers share the network with Lotse; without the pinned subnet they would count as local
  assert.match(E.sandboxStatus({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1' }).message ?? '', /LOTSE_SANDBOX_SUBNET/);
  assert.equal(E.sandboxStatus({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1', LOTSE_SANDBOX_SUBNET: 'kaputt' }).reason, 'open-bind');
  assert.equal(E.sandboxStatus({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1', LOTSE_SANDBOX_SUBNET: '10.213.0.0/24' }).enabled, true);
  assert.equal(E.sandboxStatus({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1', LOTSE_PASSWORD: 'pw' }).enabled, true);
  assert.equal(E.sandboxStatus({ AICB_DOCKER: '1', LOTSE_BIND: '127.0.0.1', LOTSE_SANDBOX_NETWORK: 'local' }).enabled, true);
  E.saveSandbox({ enabled: false });
});

test('stored template id of the renamed dockware-play template maps to dockware; a stored dockware/play image stays valid', () => {
  kvSet('sandbox', { templateId: 'dockware-play', image: 'dockware/play:6.7.2.2' });
  assert.equal(E.sandboxPublic().templateId, 'dockware');
  assert.equal(E.sandboxPublic().image, 'dockware/play:6.7.2.2');
  E.saveSandbox({ memoryMb: 4096 });
  assert.equal((kvGet('sandbox') as { templateId: string }).templateId, 'dockware');
  kvSet('sandbox', {});
});

test('image validation: German messages, no latest, no other repository', () => {
  assert.equal(E.validateImage(' dockware/play:6.6.10.4 '), 'dockware/play:6.6.10.4');
  assert.throws(() => E.validateImage('dockware/play:latest'), /latest/);
  assert.throws(() => E.validateImage('dockware/play'), /feste Version/);
  assert.equal(E.validateImage('dockware/shopware:6.7.15.1-arm64'), 'dockware/shopware:6.7.15.1-arm64');
  assert.throws(() => E.validateImage('dockware/shopware:6.7-latest'), /latest/);
  assert.throws(() => E.validateImage('dockware/shopware:latest'), /latest/);
  assert.throws(() => E.validateImage('nginx:1.25'), /Nur dockware\/shopware/);
  assert.throws(() => E.validateImage('registry.example.com/dockware/play:6.7.2.2'), /Nur dockware\/shopware/);
});

test('variables and commands: validation, secret sealed and masked, kept when left empty, redacted', () => {
  assert.throws(() => E.saveSandbox({ envVars: [{ key: 'lower', secret: false, value: 'x' }] }), /Variablenname/);
  assert.throws(() => E.saveSandbox({ envVars: [{ key: 'A', secret: false, value: '1' }, { key: 'A', secret: false, value: '2' }] }), /doppelt/);
  assert.throws(() => E.saveSandbox({ envVars: [{ key: 'TOKEN', secret: true }] }), /Wert für TOKEN fehlt/);
  assert.throws(() => E.saveSandbox({ commands: [{ label: '', command: 'x', phase: 'final' }] }), /Bezeichnung/);
  assert.throws(() => E.saveSandbox({ commands: [{ label: 'Demo', command: 'x'.repeat(2001), phase: 'final' }] }), /zu lang/);
  assert.throws(() => E.saveSandbox({ commands: [{ label: 'Demo', command: 'x', phase: 'final', timeoutSec: 4000 }] }), /Zeitlimit/);
  assert.throws(() => E.saveSandbox({ commands: [{ label: 'Demo', command: 'x', phase: 'later' as 'final' }] }), /Phase/);

  const r = E.saveSandbox({
    envVars: [{ key: 'APP_ENV', secret: false, value: 'dev' }, { key: 'API_TOKEN', secret: true, value: SECRET }],
    commands: [{ label: 'Demodaten', command: 'bin/console framework:demodata --products=20', phase: 'after-db' }, { label: 'Fertig', command: 'echo ok', phase: 'final', timeoutSec: 60 }],
  });
  assert.deepEqual(r.changed.sort(), ['commands', 'env.API_TOKEN', 'env.APP_ENV']);
  const raw = JSON.stringify(kvGet('sandbox'));
  assert.ok(!raw.includes(SECRET) && raw.includes('enc:v1:'), 'sealed in the DB');
  const pub = E.sandboxPublic();
  assert.ok(!JSON.stringify(pub).includes(SECRET));
  assert.deepEqual(pub.envVars, [{ key: 'APP_ENV', secret: false, value: 'dev', hasValue: true }, { key: 'API_TOKEN', secret: true, value: '', hasValue: true }]);
  assert.match(pub.commands[0].id, /^c_[a-z0-9]{8}$/);
  assert.equal(pub.commands[0].timeoutSec, 600);
  assert.equal(pub.commands[1].timeoutSec, 60);
  assert.deepEqual(E.getSandboxConfig().env, ['APP_ENV=dev', `API_TOKEN=${SECRET}`]);
  assert.equal(redact(`token is ${SECRET}!`), 'token is •••!');
  for (const enc of ['base64', 'base64url', 'hex'] as const) assert.ok(!redact(`x ${Buffer.from(SECRET).toString(enc)} y`).includes(Buffer.from(SECRET).toString(enc).replace(/=+$/, '')), `${enc} form redacted too (defense in depth)`);
  assert.ok(!redact(Buffer.from(SECRET).toString('hex').toUpperCase()).includes(Buffer.from(SECRET).toString('hex').toUpperCase()));

  // secret left empty = unchanged; ids of existing commands stay; reorder keeps them
  const ids = pub.commands.map(c => c.id);
  E.saveSandbox({ envVars: [{ key: 'API_TOKEN', secret: true }, { key: 'APP_ENV', secret: false, value: 'prod' }], commands: [...pub.commands].reverse() });
  assert.deepEqual(E.getSandboxConfig().env, [`API_TOKEN=${SECRET}`, 'APP_ENV=prod']);
  assert.deepEqual(E.sandboxPublic().commands.map(c => c.id), [...ids].reverse());

  // unticking "geheim" without a new value is refused (the stored secret is never dropped silently), with one it becomes plain
  assert.throws(() => E.saveSandbox({ envVars: [{ key: 'API_TOKEN', secret: false, value: '' }] }), /API_TOKEN: Neuen Wert eingeben/);
  assert.throws(() => E.saveSandbox({ envVars: [{ key: 'API_TOKEN', secret: false }] }), /Neuen Wert eingeben/);
  assert.deepEqual(E.getSandboxConfig().env, [`API_TOKEN=${SECRET}`, 'APP_ENV=prod'], 'unchanged after the refusal');
  E.saveSandbox({ envVars: [{ key: 'API_TOKEN', secret: false, value: 'visible' }, { key: 'APP_ENV', secret: false, value: 'prod' }] });
  assert.deepEqual(E.sandboxPublic().envVars[0], { key: 'API_TOKEN', secret: false, value: 'visible', hasValue: true });
  E.saveSandbox({ envVars: [{ key: 'API_TOKEN', secret: true, value: SECRET }, { key: 'APP_ENV', secret: false, value: 'prod' }] });
});

test('docker state: concurrent callers share one probe, cached afterwards', async () => {
  E.forgetDockerState();
  const before = fake.calls.filter(c => c.op === 'ping').length;
  const all = await Promise.all([E.dockerState(true), E.dockerState(), E.dockerState(true)]);
  assert.ok(all.every(s => s === all[0] && s.reachable));
  assert.equal(fake.calls.filter(c => c.op === 'ping').length - before, 1);
  assert.equal(await E.dockerState(), all[0], 'cached');
  E.forgetDockerState();
  fake.calls.length = 0;
});

test('routes while off: GET works without touching Docker, check answers 403 in German', async () => {
  fake.calls = [];
  const v = await envRoute.GET();
  const body = await v.json() as Record<string, any>;
  assert.equal(body.env.status.enabled, false);
  assert.equal(body.docker, null);
  assert.deepEqual(body.templates.map((t: { id: string }) => t.id), ['dockware']);
  const c = await check();
  assert.equal(c.status, 403);
  assert.equal((await c.json() as { error: string }).error, 'Sandbox Coding ist in den Einstellungen ausgeschaltet.');
  assert.deepEqual(fake.calls, [], 'Docker not contacted while off');
  const h = await (await healthRoute()).json() as Record<string, any>;
  assert.deepEqual(h.sandbox, { enabled: false, docker: null, github: false, image: null });
});

test('PUT: switch on, audit with field names only, invalid input 400', async () => {
  const bad = await put({ image: 'dockware/play:latest' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /latest/);
  assert.equal((await put({ nope: 1 })).status, 400, 'unknown fields rejected');
  const r = await put({ enabled: true, image: 'dockware/play:6.6.10.4', envVars: [{ key: 'API_TOKEN', secret: true, value: `${SECRET}-2` }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.env.status.enabled, true);
  assert.equal(r.body.docker.reachable, true);
  assert.equal(r.body.imagePresent, false);
  assert.ok(!JSON.stringify(r.body).includes(SECRET));
  const a = auditList(1)[0] as unknown as Record<string, any>;
  assert.equal(a.title, 'Sandbox-Umgebung geändert');
  assert.deepEqual(Object.keys(a.fields).sort(), ['enabled', 'env.API_TOKEN', 'env.APP_ENV', 'image']);
  assert.ok(!JSON.stringify(a).includes(SECRET), 'no values in the audit');
  const h = await (await healthRoute()).json() as Record<string, any>;
  assert.deepEqual(h.sandbox, { enabled: true, docker: true, github: false, image: 'dockware/play:6.6.10.4' });
});

test('check: pulls with progress lines, then present; unreachable Docker gives the German hint', async () => {
  const ev = await lines(await check());
  assert.ok(ev.some(e => e.t === 'progress' && e.pct === 100));
  const res = ev.at(-1)!;
  assert.equal(res.t, 'result');
  assert.equal(res.ok, true);
  assert.equal(res.pulled, true);
  assert.equal(res.docker.mode, 'local');
  assert.deepEqual(fake.calls.filter(c => c.op === 'ensureImage').map(c => c.detail), ['dockware/play:6.6.10.4']);
  assert.equal((await lines(await check())).at(-1)!.pulled, false);

  fake.down = true;
  const down = (await lines(await check())).at(-1)!;
  assert.equal(down.ok, false);
  assert.equal(down.docker.reachable, false);
  assert.match(down.message, /Docker ist nicht erreichbar – Docker-Socket bzw\. DOCKER_HOST einrichten/);
  fake.down = false;
  E.forgetDockerState();
});

test('network: created internal + labelled; a foreign or open network is refused', async () => {
  assert.equal(networkMode({}), 'local');
  assert.equal(networkMode({ AICB_DOCKER: '1' }), 'network');
  assert.equal(networkMode({ AICB_DOCKER: '1', LOTSE_SANDBOX_NETWORK: 'local' }), 'local');
  const r = new FakeRunner();
  assert.deepEqual(await ensureNetwork(r, null), { created: true });
  assert.deepEqual(r.networks.get('lotse-sandbox'), { name: 'lotse-sandbox', internal: true, labels: { 'lotse.managed': '1' }, subnets: [] });
  assert.deepEqual(await ensureNetwork(r, null), { created: false });
  // pinned subnet (LOTSE_SANDBOX_SUBNET): created with it; an existing network on another subnet is refused
  await assert.rejects(ensureNetwork(r, '10.213.0.0/24'), /Subnetz 10\.213\.0\.0\/24/);
  r.networks.clear();
  assert.deepEqual(await ensureNetwork(r, '10.213.0.0/24'), { created: true });
  assert.deepEqual(r.networks.get('lotse-sandbox')?.subnets, ['10.213.0.0/24']);
  assert.deepEqual(await ensureNetwork(r, '10.213.0.0/24'), { created: false });
  r.networks.set('lotse-sandbox', { name: 'lotse-sandbox', internal: false, labels: { 'lotse.managed': '1' }, subnets: [] });
  await assert.rejects(ensureNetwork(r, null), /nicht intern/);
  r.networks.set('lotse-sandbox', { name: 'lotse-sandbox', internal: true, labels: {}, subnets: [] });
  await assert.rejects(ensureNetwork(r, null), /gehört nicht zu Lotse/);
});

test('switching off stops running containers (not removed) and closes the routes again', async () => {
  const id = await fake.create({ name: 'lotse-t-abc', Image: 'dockware/play:6.6.10.4', Labels: { 'lotse.managed': '1', 'lotse.task': 't_abc' }, HostConfig: { NetworkMode: 'lotse-sandbox' } });
  await fake.start(id);
  const r = await put({ enabled: false });
  assert.equal(r.body.env.status.enabled, false);
  assert.equal(fake.containers.get(id)?.running, false);
  assert.ok(fake.containers.has(id), 'kept');
  assert.equal((await check()).status, 403);
});

test('fake runner: storefront serves synced files; exec scripted and recorded', async () => {
  const r = new FakeRunner();
  const id = await r.create({ name: 'lotse-t-x', Image: 'dockware/play:6.7.2.2', Labels: { 'lotse.managed': '1' }, HostConfig: { NetworkMode: 'lotse-sandbox' } });
  await r.start(id);
  const hdr = Buffer.alloc(512); hdr.write('index.html'); hdr.write('00000000016\0', 124); hdr.write('0', 156);
  const body = Buffer.alloc(512); body.write('<h1>Hallo</h1>');
  await r.putArchive(id, '/var/www/html/public', Buffer.concat([hdr, body, Buffer.alloc(1024)]));
  const addr = (await r.inspect(id))!.address!;
  assert.equal(await (await fetch(`http://${addr.host}:${addr.port}/`)).text(), '<h1>Hallo</h1>');
  r.script = argv => (argv[1] === 'theme:compile' ? { exitCode: 1, output: 'SCSS error' } : undefined);
  assert.deepEqual(await r.exec(id, ['bin/console', 'theme:compile'], { user: 'www-data', timeoutMs: 1000 }), { exitCode: 1, output: 'SCSS error', truncated: false });
  assert.deepEqual(r.calls.filter(c => c.op === 'exec').map(c => c.argv), [['bin/console', 'theme:compile']]);
  r.failNext = { op: 'stop', message: 'boom' };
  await assert.rejects(r.stop(id), /boom/);
  await r.remove(id);
  assert.equal(await r.inspect(id), null);
});
