import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// GitHub connection against a local fake: token stored sealed, never returned, disconnect, test/repos/branches routes, audit with names only.
process.env.AICB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-github-'));
const TOKEN = `github_pat_${'A1b2C3d4E5'.repeat(8)}_xyz`;
const { startFakeGithub } = await import('../support/github-fake');
const fake = await startFakeGithub({ token: TOKEN, login: 'octo-lotse', repos: [
  { fullName: 'acme/shop-theme', branches: ['main', 'develop'] },
  { fullName: 'acme/legacy-plugin', push: false },
] });
process.env.LOTSE_GITHUB_API_BASE = fake.base;
after(() => fake.close());

const G = await import('../../src/server/github');
const { kvGet, auditList } = await import('../../src/server/db');
const route = await import('../../src/app/api/github/route');
const { POST: testRoute } = await import('../../src/app/api/github/test/route');
const { GET: reposRoute } = await import('../../src/app/api/github/repos/route');
const { GET: branchesRoute } = await import('../../src/app/api/github/branches/route');

const put = (body: unknown) => route.PUT(new Request('http://127.0.0.1/api/github', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const json = async (r: Response) => ({ status: r.status, body: await r.json() as Record<string, unknown> });
const leaks = (v: unknown) => JSON.stringify(v).includes(TOKEN) || JSON.stringify(v).includes(TOKEN.slice(11, 40));

test('token format: fine-grained and classic accepted, anything else rejected', () => {
  assert.equal(G.normToken(`  ${TOKEN} `), TOKEN);
  assert.equal(G.normToken(`ghp_${'a'.repeat(36)}`), `ghp_${'a'.repeat(36)}`);
  assert.throws(() => G.normToken('sk-abc'), /GitHub-Token/);
  assert.throws(() => G.normToken(`github_pat_${'a'.repeat(40)}\nX`), /GitHub-Token/);
});

test('repository names are validated before they reach a URL', () => {
  assert.equal(G.assertRepoName('acme/shop-theme.v2'), 'acme/shop-theme.v2');
  for (const bad of ['acme', 'acme/x/y', '../etc', 'acme/..', 'ac me/x', '-a/b?', 'acme/x%2F..']) assert.throws(() => G.assertRepoName(bad), /Repository-Name/, bad);
});

test('without a token: public view empty, routes answer with a German error', async () => {
  assert.deepEqual(G.githubPublic(), { hasToken: false, login: null, updatedAt: null });
  const t = await json(await testRoute());
  assert.equal(t.body.ok, false);
  assert.match(String(t.body.message), /Noch kein Token/);
  const r = await json(await reposRoute());
  assert.equal(r.status, 400);
  assert.match(String(r.body.error), /Noch kein GitHub-Token/);
});

test('save: sealed in the DB, GET never returns it, audit has field names only', async () => {
  const bad = await json(await put({ token: 'kein-token' }));
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /GitHub-Token/);
  const r = await json(await put({ token: TOKEN }));
  assert.equal(r.status, 200);
  assert.equal(r.body.hasToken, true);
  assert.ok(!leaks(r.body));
  const raw = JSON.stringify(kvGet('github'));
  assert.ok(!raw.includes(TOKEN) && raw.includes('enc:v1:'), 'stored sealed');
  const g = await json(route.GET());
  assert.equal(g.body.hasToken, true);
  assert.ok(!leaks(g.body));
  assert.equal(G.getGithubToken(), TOKEN, 'server side only');
  const a = auditList(5).find(x => x.kind === 'settings' && x.title === 'GitHub-Token gespeichert');
  assert.ok(a, 'audit entry written');
  assert.deepEqual(a.fields, { githubToken: 'geändert' });
  assert.ok(!leaks(auditList(50)));
});

test('test route: login, visible repositories, read-only hint; login is remembered', async () => {
  const t = await json(await testRoute());
  assert.equal(t.body.ok, true);
  assert.equal(t.body.login, 'octo-lotse');
  assert.equal(t.body.repos, 2);
  assert.deepEqual(t.body.readOnly, ['acme/legacy-plugin']);
  assert.match(String(t.body.message), /Contents \+ Pull requests: Lesen & Schreiben/);
  assert.equal(G.githubPublic().login, 'octo-lotse');
  const call = fake.calls.find(c => c.path === '/user');
  assert.equal(call?.auth, `Bearer ${TOKEN}`, 'token only in the Authorization header');
  assert.ok(fake.calls.every(c => !c.path.includes(TOKEN)), 'never in a URL');
});

test('test route maps 401 and 404 to German errors without the token', async () => {
  fake.failNext = { status: 401, message: `Bad credentials for ${TOKEN}` };
  const t = await json(await testRoute());
  assert.equal(t.body.ok, false);
  assert.match(String(t.body.message), /lehnt den Token ab/);
  assert.ok(!leaks(t.body));
  fake.failNext = { status: 404, message: 'Not Found' };
  const n = await json(await testRoute());
  assert.match(String(n.body.message), /kein Zugriff/);
  fake.failNext = { status: 422, message: `boom ${TOKEN}` };
  const e = await json(await reposRoute());
  assert.equal(e.status, 502);
  assert.ok(!leaks(e.body), 'API message scrubbed');
  assert.ok(String(e.body.error).length <= 300);
});

test('repos and branches routes; repo access check reads permissions.push, 404 = no access', async () => {
  const r = await json(await reposRoute());
  assert.deepEqual((r.body.repos as { fullName: string; push: boolean }[]).map(x => [x.fullName, x.push]), [['acme/shop-theme', true], ['acme/legacy-plugin', false]]);
  const b = await json(await branchesRoute(new Request('http://127.0.0.1/api/github/branches?repo=acme/shop-theme')));
  assert.deepEqual(b.body.branches, [{ name: 'main', protected: true }, { name: 'develop', protected: false }]);
  const bad = await json(await branchesRoute(new Request('http://127.0.0.1/api/github/branches?repo=../../user')));
  assert.equal(bad.status, 400);
  assert.equal((await G.checkRepoAccess('acme/legacy-plugin')).push, false);
  await assert.rejects(G.checkRepoAccess('acme/secret'), /Kein Zugriff auf acme\/secret/);
});

test('disconnect: null removes the token, audit entry, nothing left in the DB', async () => {
  const r = await json(route.DELETE());
  assert.deepEqual(r.body, { hasToken: false, login: null, updatedAt: null });
  assert.equal(G.getGithubToken(), null);
  assert.equal(G.githubConnected(), false);
  assert.deepEqual(kvGet('github'), {});
  assert.ok(auditList(5).some(x => x.title === 'GitHub-Verbindung getrennt'));
  await assert.rejects(G.ghFetch('/user'), /Noch kein GitHub-Token/);
});
