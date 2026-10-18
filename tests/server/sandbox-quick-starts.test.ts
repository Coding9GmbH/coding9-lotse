import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import '../isolate-data';
import { makePluginRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- route answers are loose JSON */

// A22 "Schnellstarts": a quick start is a saved request of "Sandbox starten" – stored in kv (at most 50, one default), checked with the
// dialog's rules when saved, without secret values, checked again on every use (project, branch, stored database, image) and started
// like the dialog's own request; the approval of a repository's .lotse/sandbox.json is not part of it.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-qs-'));
const plugin = makePluginRepo(tmp, { repo: 'acme/qs-plugin', name: 'AcmeQs' });
makePluginRepo(tmp, { repo: 'acme/qs-file', name: 'AcmeQsFile', files: { '.lotse/sandbox.json': JSON.stringify({ commands: [{ label: 'Demodaten anlegen', command: 'bin/console framework:demodata', phase: 'after-db' }] }) } });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${plugin.remoteBase}`;
const TOKEN = `github_pat_${'QuickStart'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: [{ fullName: 'acme/qs-plugin', branches: ['main', 'develop'] }, { fullName: 'acme/qs-file' }] });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const R = await import('../../src/server/sandbox/reconcile');
const D = await import('../../src/server/sandbox/dumps');
const Q = await import('../../src/server/sandbox/quick-starts');
const db = await import('../../src/server/db');
const listRoute = await import('../../src/app/api/sandbox/quick-starts/route');
const oneRoute = await import('../../src/app/api/sandbox/quick-starts/[id]/route');
const startRoute = await import('../../src/app/api/sandbox/quick-starts/[id]/start/route');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
const SECRET = 'sk_live_quickstart_987654';
E.saveSandbox({ enabled: true, envVars: [{ key: 'STRIPE_KEY', secret: true, value: SECRET }, { key: 'SHOP_MODE', secret: false, value: 'test' }] });
after(async () => { R.resetReconcile(); await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
const req = (method: string, body?: unknown, lang = 'de') => new Request('http://127.0.0.1/api/sandbox/quick-starts', { method, headers: { 'content-type': 'application/json', 'accept-language': lang }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const create = async (body: unknown, lang = 'de') => { const r = await listRoute.POST(req('POST', body, lang)); return { status: r.status, body: (await r.json()) as any }; };
const start = async (id: string, chatId = crypto.randomUUID()) => { const r = await startRoute.POST(req('POST', { chatId }), params(id)); return { status: r.status, body: (await r.json()) as any }; };
const audits = (action: string) => db.auditList(500).filter(a => a.kind === 'sandbox-quick-start' && a.action === action);
const PLUGIN = { kind: 'existing', repo: 'acme/qs-plugin', baseBranch: 'main' };
async function storedDb(name = 'shop.sql') {
  const data = Buffer.from("-- MySQL dump\nINSERT INTO `product` VALUES (1);\n");
  const d = D.createDump(name, data.length, Date.now(), { library: true, uploadedBy: 'alex' });
  await D.appendChunk(d.id, 0, Readable.from([data]));
  return D.completeDump(d.id);
}

test('storage: create, sorted list, unique names, rename, duplicate, delete – each audited', async () => {
  const b = await create({ name: 'Plugin Develop', setup: { ...PLUGIN, baseBranch: 'develop' } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.match(b.body.quickStart.id, Q.QUICK_ID);
  const a = await create({ name: '  Ausgangslage   Plugin ', setup: PLUGIN });
  assert.equal(a.body.quickStart.name, 'Ausgangslage Plugin');
  assert.deepEqual(a.body.quickStart.setup, PLUGIN); // nothing added: mode auto, no commands, demo data
  const list = (await (await listRoute.GET(req('GET'))).json()) as any;
  assert.deepEqual(list.quickStarts.map((q: any) => q.name), ['Ausgangslage Plugin', 'Plugin Develop']);
  assert.equal((await create({ name: 'plugin develop', setup: PLUGIN })).status, 409, 'names are unique (case-insensitive)');
  assert.equal((await create({ name: '', setup: PLUGIN })).status, 400);
  assert.equal((await create({ name: 'x'.repeat(81), setup: PLUGIN })).status, 400);
  // rename, duplicate (free name), delete
  const id = a.body.quickStart.id;
  const ren = await oneRoute.PATCH(req('PATCH', { name: 'Grundstand' }), params(id));
  assert.equal(((await ren.json()) as any).quickStart.name, 'Grundstand');
  const c1 = await create({ duplicateOf: id });
  const c2 = await create({ duplicateOf: id });
  assert.deepEqual([c1.body.quickStart.name, c2.body.quickStart.name], ['Grundstand (Kopie)', 'Grundstand (Kopie) 2']);
  assert.deepEqual(c1.body.quickStart.setup, PLUGIN);
  for (const q of [c1, c2]) assert.equal((await oneRoute.DELETE(req('DELETE'), params(q.body.quickStart.id))).status, 200);
  assert.equal((await oneRoute.DELETE(req('DELETE'), params(c1.body.quickStart.id))).status, 404);
  assert.equal((await oneRoute.GET(req('GET'), params('qs_doesnotexi'))).status, 404);
  assert.ok(audits('create').some(x => x.title === 'Schnellstart: Plugin Develop' && x.repo === 'acme/qs-plugin'));
  assert.ok(audits('update').some(x => x.quickStartId === id && JSON.stringify(x.changed) === '["name"]'));
  assert.equal(audits('delete').length, 2);
  // English answers for an English browser
  const en = await create({ name: 'Grundstand', setup: PLUGIN }, 'en');
  assert.match(en.body.error, /There already is a quick start “Grundstand”/);
});

test('saved with the start dialog’s rules: target, plugin name, commands, image, start page, repository name, stored databases only', async () => {
  const bad = async (setup: Record<string, unknown>, re: RegExp) => {
    const r = await create({ name: `Ungültig ${crypto.randomUUID().slice(0, 6)}`, setup });
    assert.equal(r.status, 400, JSON.stringify(setup));
    assert.match(r.body.error, re);
  };
  await bad({ ...PLUGIN, kind: 'custom', targetPath: '/etc/app' }, /Ungültiger Zielordner/);
  await bad({ kind: 'none', repo: '', baseBranch: '', pluginName: 'kleinGeschrieben' }, /Ungültiger Plugin-Name/);
  await bad({ ...PLUGIN, commands: [{ label: '', command: 'make', phase: 'final' }] }, /Bezeichnung fehlt/);
  await bad({ ...PLUGIN, image: 'evil/image:1.0.0' }, /nur ein anderer Tag von dockware\/shopware/);
  await bad({ ...PLUGIN, image: 'latest' }, /latest/);
  await bad({ ...PLUGIN, previewPath: 'https://evil.example/' }, /Startseite der Vorschau/);
  await bad({ ...PLUGIN, repo: '../etc' }, /Ungültiger Repository-Name/);
  await bad({ ...PLUGIN, kind: 'other' }, /Ungültiger Schnellstart: kind/);
  await bad({ ...PLUGIN, chatId: 'x' }, /Ungültiger Schnellstart/); // the chat is never part of it
  const once = D.createDump('once.sql', 10);
  await bad({ ...PLUGIN, dumpId: once.id }, /nur gespeicherte Datenbanken/);
  const lib = await storedDb('lib.sql');
  const ok = await create({ name: 'Alles drin', setup: { ...PLUGIN, kind: 'custom', targetPath: '/srv/app', commands: [{ label: 'Bauen', command: 'make build', phase: 'final' }], env: [{ key: 'FEATURE', value: 'on' }], dumpId: lib.id, image: '6.7.14.0', previewPath: '/de/', notes: '  Testkunde: a@b.de ' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.quickStart.setup, { kind: 'custom', repo: 'acme/qs-plugin', baseBranch: 'main', mode: 'custom', targetPath: '/srv/app', commands: [{ label: 'Bauen', command: 'make build', phase: 'final' }],
    env: [{ key: 'FEATURE', value: 'on' }], dumpId: lib.id, image: 'dockware/shopware:6.7.14.0', previewPath: '/de/', notes: 'Testkunde: a@b.de' });
  // without a project: no repository, no own commands or variables (the dialog does not offer them there)
  const none = await create({ name: 'Ohne Projekt', setup: { kind: 'none', repo: 'acme/qs-plugin', baseBranch: 'main', pluginName: 'VersandHinweis', commands: [{ label: 'x', command: 'y', phase: 'final' }] } });
  assert.deepEqual(none.body.quickStart.setup, { kind: 'none', repo: '', baseBranch: '', pluginName: 'VersandHinweis', source: 'none' });
});

test('secret values are never stored: a secret variable of the environment, or a value containing one, is kept by name only', async () => {
  const r = await create({ name: 'Mit Variablen', setup: { ...PLUGIN, env: [{ key: 'STRIPE_KEY', value: 'anything' }, { key: 'API_URL', value: `https://x.test/?key=${SECRET}` }, { key: 'SHOP_MODE', value: 'dev' }] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.quickStart.setup.env, [{ key: 'SHOP_MODE', value: 'dev' }]);
  assert.deepEqual(r.body.quickStart.setup.envRefs, ['STRIPE_KEY', 'API_URL']);
  assert.ok(!JSON.stringify(db.kvGet('sandbox-quick-starts')).includes(SECRET), 'not in the stored row');
  assert.ok(!JSON.stringify(db.auditList(500)).includes(SECRET), 'not in the audit');
  // on use, missing names are a warning (the variable comes from the environment, never from the quick start)
  const used = await start(r.body.quickStart.id);
  assert.equal(used.status, 201, JSON.stringify(used.body));
  assert.deepEqual(used.body.warnings, ['Diese Umgebungsvariablen fehlen in der Umgebung: API_URL']);
  const t = T.getTask(used.body.task.id)!;
  assert.deepEqual(t.setup?.env, [{ key: 'SHOP_MODE', value: 'dev' }]);
  await settled(t.id);
  const env = fake.containers.get(T.getTask(t.id)!.containerId!)!.spec.Env as string[];
  assert.ok(env.includes(`STRIPE_KEY=${SECRET}`), 'the secret comes from the environment');
  assert.ok(env.includes('SHOP_MODE=dev'), 'the quick start’s plain value wins over the environment’s');
  // "Setup als Schnellstart speichern" of a running sandbox: its setup, no secret either
  const fromTask = await create({ fromTask: t.id });
  assert.equal(fromTask.status, 201, JSON.stringify(fromTask.body));
  assert.equal(fromTask.body.quickStart.name, 'Mit Variablen 2', 'the sandbox’s title, made unique');
  assert.deepEqual(fromTask.body.quickStart.setup, { kind: 'existing', repo: 'acme/qs-plugin', baseBranch: 'main', env: [{ key: 'SHOP_MODE', value: 'dev' }] });
});

test('a secret in any other text of the setup is refused, naming the field; references survive editing', async () => {
  const before = JSON.stringify(db.kvGet('sandbox-quick-starts'));
  const refused = async (setup: Record<string, unknown>, re: RegExp, lang = 'de') => {
    const r = await create({ name: `Geheim ${crypto.randomUUID().slice(0, 6)}`, setup }, lang);
    assert.equal(r.status, 400, JSON.stringify(setup));
    assert.match(r.body.error, re);
    assert.ok(!JSON.stringify(r.body).includes(SECRET), 'the answer does not repeat it');
  };
  await refused({ ...PLUGIN, commands: [{ label: 'Zahlung', command: `echo ${SECRET}`, phase: 'final' }] }, /Im Feld „Befehl 1“ steht der geheime Wert von STRIPE_KEY.*\$STRIPE_KEY/);
  await refused({ ...PLUGIN, commands: [{ label: `k ${SECRET}`, command: 'make', phase: 'final' }] }, /„Befehl 1: Bezeichnung“/);
  await refused({ ...PLUGIN, notes: `Stripe-Key: ${SECRET}` }, /„Hinweise für die KI“.*STRIPE_KEY/);
  await refused({ ...PLUGIN, previewPath: `/?k=${SECRET}` }, /„Startseite der Vorschau“/);
  await refused({ ...PLUGIN, kind: 'custom', targetPath: `/opt/${SECRET}` }, /„Zielordner“/);
  await refused({ ...PLUGIN, notes: `Token ${TOKEN}` }, /The field “Notes for the AI” contains a stored secret value/, 'en'); // Lotse's other secrets too
  assert.equal(JSON.stringify(db.kvGet('sandbox-quick-starts')), before, 'nothing stored');
  // the name ($STRIPE_KEY) is fine
  const ok = await create({ name: 'Mit Namen', setup: { ...PLUGIN, commands: [{ label: 'Zahlung', command: 'echo $STRIPE_KEY', phase: 'final' }], env: [{ key: 'STRIPE_KEY', value: SECRET }] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.quickStart.setup.envRefs, ['STRIPE_KEY']);
  const id = ok.body.quickStart.id, patch = async (body: unknown) => ((await (await oneRoute.PATCH(req('PATCH', body), params(id))).json()) as any);
  // an editor that does not send envRefs keeps them; [] removes them on purpose; a plain value replaces a reference
  assert.deepEqual((await patch({ setup: { ...PLUGIN, baseBranch: 'develop' } })).quickStart.setup.envRefs, ['STRIPE_KEY']);
  assert.deepEqual((await patch({ setup: { ...PLUGIN, envRefs: ['STRIPE_KEY', 'API_URL'] } })).quickStart.setup.envRefs, ['STRIPE_KEY', 'API_URL']);
  assert.deepEqual((await patch({ setup: { ...PLUGIN, env: [{ key: 'API_URL', value: 'https://x.test' }] } })).quickStart.setup.envRefs, ['STRIPE_KEY']);
  assert.equal((await patch({ setup: { ...PLUGIN, envRefs: [] } })).quickStart.setup.envRefs, undefined);
  assert.ok(!JSON.stringify(db.kvGet('sandbox-quick-starts')).includes(SECRET));
});

test('one click starts it like the dialog: title = its name, all choices on the task, last use and audit recorded', async () => {
  const lib = await storedDb('klick.sql');
  const q = (await create({ name: 'Klickstart', setup: { ...PLUGIN, commands: [{ label: 'Hallo', command: 'echo hallo', phase: 'final' }], dumpId: lib.id, image: '6.7.13.0', previewPath: '/checkout/cart', notes: 'Nur Test' } })).body.quickStart;
  const chatId = crypto.randomUUID();
  const r = await start(q.id, chatId);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const t = T.getTask(r.body.task.id)!;
  assert.equal(t.title, 'Klickstart');
  assert.match(t.branch, /^lotse\/klickstart-/);
  assert.equal(t.chatId, chatId);
  assert.equal(t.baseBranch, 'main');
  assert.equal(t.image, 'dockware/shopware:6.7.13.0');
  assert.equal(t.previewPath, '/checkout/cart');
  assert.equal(t.dump?.id, lib.id);
  assert.deepEqual(t.setup?.commands.map(c => c.label), ['Hallo']);
  assert.equal(t.setup?.notes, 'Nur Test');
  assert.ok(Q.getQuickStart(q.id).lastUsedAt);
  assert.ok(audits('use').some(x => x.quickStartId === q.id && x.taskId === t.id));
  assert.ok(db.auditList(500).some(x => x.kind === 'sandbox-task' && x.action === 'create' && x.taskId === t.id && x.quickStart === 'Klickstart'));
  // one sandbox per chat, as with the dialog
  const again = await start(q.id, chatId);
  assert.equal(again.status, 409);
  await settled(t.id);
  assert.equal(T.getTask(t.id)!.status, 'ready', T.getTask(t.id)!.error ?? '');
});

test('checked on every use: project, branch, stored database, image, GitHub – 422 with the problems and the quick start', async () => {
  const lib = await storedDb('weg.sql');
  gh.repos.push({ fullName: 'acme/qs-gone' });
  const q = (await create({ name: 'Wird kaputt', setup: { kind: 'existing', repo: 'acme/qs-gone', baseBranch: 'main', dumpId: lib.id, image: '6.7.14.0' } })).body.quickStart;
  gh.repos.splice(gh.repos.findIndex(r => r.fullName === 'acme/qs-gone'), 1);
  D.deleteDump(lib.id);
  E.saveSandbox({ image: 'dockware/play:6.7.2.2' }); // another image repository: the saved tag is not one of it any more
  try {
    const r = await start(q.id);
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.problems.map((p: any) => p.field), ['repo', 'dump', 'image']);
    assert.match(r.body.error, /^Der Schnellstart „Wird kaputt“ lässt sich so nicht starten/);
    assert.equal(r.body.lead, 'Der Schnellstart „Wird kaputt“ lässt sich so nicht starten – bitte prüfen und anpassen:');
    assert.match(r.body.problems[0].message, /Kein Zugriff auf acme\/qs-gone/);
    assert.equal(r.body.problems[1].message, 'Die gespeicherte Datenbank dieses Schnellstarts gibt es nicht mehr.');
    assert.match(r.body.problems[2].message, /^Image: .*nur ein anderer Tag von dockware\/play/);
    assert.equal(r.body.quickStart.id, q.id, 'for the prefilled dialog');
    assert.equal(r.body.quickStart.setup.repo, 'acme/qs-gone');
  } finally { E.saveSandbox({ image: 'dockware/shopware:6.7.15.1' }); }
  assert.ok(!audits('use').some(x => x.quickStartId === q.id), 'not started, not used');
  // a branch that is gone
  const b = (await create({ name: 'Alter Branch', setup: { ...PLUGIN, baseBranch: 'feature/alt' } })).body.quickStart;
  const rb = await start(b.id);
  assert.equal(rb.status, 422);
  assert.deepEqual(rb.body.problems, [{ field: 'branch', message: 'Den Branch „feature/alt“ gibt es in acme/qs-plugin nicht (mehr).' }]);
  // the branch is asked for on its own: found in a repository with more branches than a list returns (5 pages of 100)
  gh.repos.push({ fullName: 'acme/qs-many', branches: [...Array.from({ length: 600 }, (_, i) => `b${String(i).padStart(3, '0')}`), 'zz/release'] });
  const many = await Q.checkQuickStart({ ...Q.getQuickStart(b.id), setup: { kind: 'existing', repo: 'acme/qs-many', baseBranch: 'zz/release' } });
  assert.deepEqual(many.problems, []);
  assert.deepEqual((await Q.checkQuickStart({ ...Q.getQuickStart(b.id), setup: { kind: 'existing', repo: 'acme/qs-many', baseBranch: 'zz/gone' } })).problems.map(p => p.field), ['branch']);
  // GitHub disconnected
  saveGithub({ token: null });
  try {
    const rg = await start(b.id);
    assert.deepEqual(rg.body.problems.map((p: any) => p.field), ['github']);
  } finally { saveGithub({ token: TOKEN }); }
});

test('the approval of a repository file is not bypassed: the setup stops and asks, as with the dialog', async () => {
  const q = (await create({ name: 'Mit Projektdatei', setup: { kind: 'existing', repo: 'acme/qs-file', baseBranch: 'main' } })).body.quickStart;
  assert.ok(!('skipRepoHash' in q.setup));
  assert.equal((await create({ name: 'Mit Hash', setup: { kind: 'existing', repo: 'acme/qs-file', baseBranch: 'main', skipRepoHash: 'a'.repeat(64) } })).status, 400, 'no decision can be stored');
  const r = await start(q.id);
  assert.equal(r.status, 201);
  const id = r.body.task.id;
  await settled(id);
  const t = T.getTask(id)!;
  assert.equal(t.repoFile?.state, 'pending');
  assert.equal(t.status, 'failed');
  assert.ok(!t.steps.some(s => s.source === 'repo'), 'no command of the file became a step');
  assert.ok(!fake.calls.some(c => c.op === 'exec' && c.id === t.containerId && JSON.stringify(c.argv ?? []).includes('framework:demodata')));
});

test('default: one at a time, preselected; unmarked, replaced and cleared with its deletion', async () => {
  const a = (await create({ name: 'Standard A', setup: PLUGIN, isDefault: true })).body.quickStart;
  assert.equal(a.default, true);
  const b = (await create({ name: 'Standard B', setup: PLUGIN })).body.quickStart;
  assert.equal(b.default, false);
  await oneRoute.PATCH(req('PATCH', { isDefault: true }), params(b.id));
  const defaults = () => Q.listQuickStarts().filter(q => q.default).map(q => q.name);
  assert.deepEqual(defaults(), ['Standard B']);
  await oneRoute.PATCH(req('PATCH', { isDefault: false }), params(b.id));
  assert.deepEqual(defaults(), []);
  await oneRoute.PATCH(req('PATCH', { isDefault: true }), params(a.id));
  assert.deepEqual(defaults(), ['Standard A']);
  await oneRoute.DELETE(req('DELETE'), params(a.id));
  assert.deepEqual(defaults(), []);
  assert.equal((db.kvGet('sandbox-quick-starts') as any).defaultId, null);
  assert.ok(audits('update').some(x => x.quickStartId === b.id && JSON.stringify(x.changed) === '["default"]'));
  // edit: the setup is checked again, unchanged = no audit entry
  const before = audits('update').length;
  await oneRoute.PATCH(req('PATCH', { setup: PLUGIN }), params(b.id));
  assert.equal(audits('update').length, before);
  const bad = await oneRoute.PATCH(req('PATCH', { setup: { ...PLUGIN, image: 'evil/x:1.0.0' } }), params(b.id));
  assert.equal(bad.status, 400);
  const ok = await oneRoute.PATCH(req('PATCH', { setup: { ...PLUGIN, previewPath: '/de/' } }), params(b.id));
  assert.equal(((await ok.json()) as any).quickStart.setup.previewPath, '/de/');
});

test('limit: at most 50 quick starts', async () => {
  for (const q of Q.listQuickStarts()) Q.deleteQuickStart(q.id);
  for (let i = 0; i < Q.QUICK_MAX; i++) Q.createQuickStart({ name: `Nr ${i}`, setup: PLUGIN });
  const r = await create({ name: 'Einer zu viel', setup: PLUGIN });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Höchstens 50 Schnellstarts/);
  assert.equal((await create({ duplicateOf: Q.listQuickStarts()[0].id })).status, 409);
  // while Sandbox Coding is off, none of it answers
  E.saveSandbox({ enabled: false });
  try { assert.equal((await listRoute.GET(req('GET'))).status, 403); } finally { E.saveSandbox({ enabled: true }); }
});
