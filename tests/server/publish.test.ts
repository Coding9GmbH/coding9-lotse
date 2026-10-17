import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import { GITHUB_TOKEN, sandboxForTests } from '../support/sandbox-task';

// Publishing a sandbox (plan PR 7) with the GitHub fake and a bare file:// remote: commit, push to lotse/<slug>-<id>, open or
// update the pull request. Branch and base come from the task only; workflows, secret files and secret-looking content are
// blocked; audit rows carry the actor and never the token; a retry after a crash creates exactly one pull request.
const S = await sandboxForTests();
const { gh, theme, T } = S;
const P = await import('../../src/server/sandbox/publish');
const { withActor } = await import('../../src/server/actor');
const { auditList } = await import('../../src/server/db');
const { getSession } = await import('../../src/server/sessions');
const { interruptStale } = await import('../../src/server/sandbox/reconcile');
const publishRoute = await import('../../src/app/api/sandbox/tasks/[id]/publish/route');
const prRoute = await import('../../src/app/api/sandbox/tasks/[id]/pr/route');
const { saveGithub } = await import('../../src/server/github');
after(S.close);

const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const write = (id: string, rel: string, text: string) => { const f = path.join(T.taskPaths(id).worktree, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const remove = (id: string, rel: string) => fs.rmSync(path.join(T.taskPaths(id).worktree, rel), { recursive: true, force: true });
const bare = (...args: string[]) => execFileSync('git', ['--git-dir', theme.bare, ...args], { encoding: 'utf8' }).trim();
const remoteSha = (branch: string) => { try { return bare('rev-parse', `refs/heads/${branch}`); } catch { return null; } };
const posts = () => gh.calls.filter(c => c.method === 'POST' && c.path.endsWith('/pulls'));
const publish = (id: string, title = 'Header: Gratis Versand', body = 'Im Header steht jetzt „Gratis Versand“. Geprüft in der Vorschau.') => withActor('alex', () => P.publishTask(id, { title, body }));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown) => publishRoute.POST(new Request(`http://127.0.0.1/api/sandbox/tasks/${id}/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx(id));
const mainBefore = remoteSha('main');
const task = await S.readyTask('main; git push --force'); // before the first test: node:test runs `after` once the declared tests are done

test('preflight rules: workflows, secret files, path tricks; secret scan of new lines (tokens, keys, stored secrets)', () => {
  const M = (p: string, status = 'M') => ({ path: p, status });
  assert.match(P.blockReason([])!, /Nichts zu veröffentlichen/);
  assert.match(P.blockReason([M('.github/workflows/ci.yml', 'A')])!, /Workflows/);
  assert.match(P.blockReason([M('.env')])!, /geschützte Datei/);
  assert.match(P.blockReason([M('a/../../etc/passwd')])!, /Ungültiger Pfad/);
  assert.equal(P.blockReason([M('src/x.twig'), M('.github/ISSUE_TEMPLATE.md')]), null);
  const none = new Set<string>();
  assert.equal(P.scanFile('src/x.twig', '<div class="desk-navigation-wrapper-xxxxxxxx">ok</div>\n', none), null, 'a CSS class with "sk-" is no key');
  assert.match(P.scanFile('src/x.php', `$t = '${'ghp_' + 'a'.repeat(36)}';\n`, none)!, /„src\/x\.php“.*GitHub-Token/);
  assert.match(P.scanFile('k.txt', '-----BEGIN RSA PRIVATE KEY-----\n', none)!, /privater Schlüssel/);
  assert.equal(P.scanFile('k.txt', 'x\n-----BEGIN RSA PRIVATE KEY-----\n', new Set(['-----BEGIN RSA PRIVATE KEY-----'])), null, 'lines already in the base do not block');
  assert.match(P.scanFile('a.php', '$x = "mein-shop-passwort";\n', none, ['mein-shop-passwort'])!, /in Lotse gespeichertes Geheimnis/);
  assert.match(P.scanFile('a.env.php', 'DATABASE_URL=mysql://app:s3cret@db/shop\n', none)!, /Adresse mit Zugangsdaten/);
  assert.deepEqual(P.changedPaths('M\ta.txt\nR100\told.txt\tnew.txt\n'), [{ path: 'a.txt', status: 'M' }, { path: 'old.txt', status: 'R' }, { path: 'new.txt', status: 'R' }]);
});


test('publish: commit as Lotse with the actor as co-author, push to lotse/<slug>-<id>, PR against the base, card in the chat', async () => {
  assert.match(task.branch, /^lotse\/main-git-push-force-[a-z0-9]{6}$/, 'the branch comes from the task, whatever the title says');
  write(task.id, HEADER, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand</div>{{ parent() }}{% endblock %}\n");
  const r = await publish(task.id);
  assert.equal(r.action, 'created');
  assert.equal(r.pr.number, 1);
  assert.equal(r.files, 1);
  const sha = remoteSha(task.branch);
  assert.ok(sha && sha === T.getTask(task.id)!.pushedSha, 'pushed SHA stored');
  assert.equal(remoteSha('main'), mainBefore, 'the base is never written');
  assert.deepEqual(bare('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort(), ['refs/heads/main', `refs/heads/${task.branch}`].sort());
  const msg = bare('log', '-1', '--format=%an <%ae>%n%B', task.branch);
  assert.match(msg, /^Lotse <lotse@users\.noreply\.github\.com>\nHeader: Gratis Versand\n/);
  assert.match(msg, /Co-Authored-By: alex <alex@lotse\.invalid>/);
  const [created] = posts();
  assert.deepEqual({ head: (created.body as any).head, base: (created.body as any).base, draft: (created.body as any).draft, title: (created.body as any).title }, { head: task.branch, base: 'main', draft: false, title: 'Header: Gratis Versand' }); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.match((created.body as { body: string }).body, /Geprüft in der Vorschau\.\n\n---\n_Erstellt mit Lotse/);
  const t = T.getTask(task.id)!;
  assert.deepEqual(T.publicTask(t).pr, { number: 1, url: 'https://github.com/acme/shop-theme/pull/1', title: 'Header: Gratis Versand' });
  assert.equal(t.publish, null);
  const ev = getSession(task.chatId!).events.at(-1)!;
  assert.deepEqual(ev, { t: 'pr', taskId: task.id, number: 1, url: 'https://github.com/acme/shop-theme/pull/1', title: 'Header: Gratis Versand', action: 'created', files: 1 });
});

test('publish again: same PR updated (no second POST), push with a lease on the last SHA; nothing new = no push', async () => {
  const before = remoteSha(task.branch);
  write(task.id, HEADER, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand ab 50 €</div>{{ parent() }}{% endblock %}\n");
  const r = await publish(task.id, 'Header: Gratis Versand ab 50 €');
  assert.equal(r.action, 'updated');
  assert.equal(r.pr.number, 1);
  assert.equal(posts().length, 1, 'no second POST /pulls');
  assert.ok(gh.calls.some(c => c.method === 'PATCH' && c.path.endsWith('/pulls/1')));
  assert.equal(gh.pulls['acme/shop-theme'][0].title, 'Header: Gratis Versand ab 50 €');
  const after1 = remoteSha(task.branch);
  assert.notEqual(after1, before);
  assert.equal(bare('rev-parse', `${after1}~1`), before, 'a fast-forward on top of the first commit');
  await publish(task.id, 'Header: Gratis Versand ab 50 €');
  assert.equal(remoteSha(task.branch), after1, 'nothing to commit, nothing pushed');
});

test('blocked: a workflow change and a planted token stop the publish before anything is written (audit "rejected")', async () => {
  const sha = remoteSha(task.branch), n = gh.calls.length;
  write(task.id, '.github/workflows/deploy.yml', 'on: push\n');
  await assert.rejects(publish(task.id), (e: Error & { status?: number }) => e.status === 422 && /GitHub-Workflows/.test(e.message));
  remove(task.id, '.github');
  write(task.id, 'src/Resources/config/token.txt', `${GITHUB_TOKEN}\n`);
  await assert.rejects(publish(task.id), (e: Error) => /Geheimnis/.test(e.message) && !e.message.includes(GITHUB_TOKEN));
  remove(task.id, 'src/Resources/config/token.txt');
  write(task.id, 'src/key.pem.txt', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
  await assert.rejects(publish(task.id), /privater Schlüssel/);
  remove(task.id, 'src/key.pem.txt');
  await assert.rejects(async () => withActor('alex', () => P.publishTask(task.id, { title: `Token ${GITHUB_TOKEN}`, body: '' })), /Titel oder Beschreibung/);
  assert.equal(remoteSha(task.branch), sha, 'nothing pushed');
  assert.equal(gh.calls.length, n, 'GitHub not asked');
  assert.equal(T.getTask(task.id)!.publish?.state, 'failed');
  assert.match(String(auditList(5).find(r => r.kind === 'code-pr')?.reason), /privater Schlüssel/);
  assert.equal(auditList(5).find(r => r.kind === 'code-pr')?.decision, 'rejected');
});

test('audit: started before the write and the result afterwards, with the actor; the token is nowhere', async () => {
  const rows = auditList(50).filter(r => r.kind === 'code-pr').reverse();
  const first = rows.findIndex(r => r.status === 'started');
  assert.ok(first >= 0);
  assert.equal(rows[first + 1].status, 'applied');
  assert.equal(rows[first + 1].prUrl, 'https://github.com/acme/shop-theme/pull/1');
  assert.deepEqual(rows[first + 1].files, [HEADER]);
  for (const r of rows) { assert.equal(r.actor, 'alex'); assert.equal(r.decision === 'approved' || r.decision === 'rejected', true); }
  const all = [JSON.stringify(rows), fs.readFileSync(path.join(T.taskPaths(task.id).gitDir, 'config'), 'utf8'), bare('log', '-p', '--all'), JSON.stringify(getSession(task.chatId!).events), JSON.stringify(T.getTask(task.id))];
  const basic = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString('base64');
  for (const text of all) { assert.ok(!text.includes(GITHUB_TOKEN)); assert.ok(!text.includes(basic)); }
});

test('crash after the push, before the pull request: recovery marks it interrupted, the retry creates exactly one PR', async () => {
  const t2 = await S.readyTask('Footer grün');
  write(t2.id, 'src/Resources/app/storefront/src/scss/base.scss', '.footer { color: green; }\n');
  gh.failNext = { status: 422, message: 'Validation Failed' }; // the lookup of an open PR fails (not retried): the branch is pushed, no PR yet
  await assert.rejects(publish(t2.id, 'Footer grün'), (e: Error & { status?: number }) => e.status === 502 && /Pull Request nicht angelegt/.test(e.message));
  const pushed = remoteSha(t2.branch);
  assert.ok(pushed, 'the push happened');
  assert.equal(T.getTask(t2.id)!.pushedSha, pushed);
  // the process died at this point: the row still says "running"
  const row = T.getTask(t2.id)!; row.publish = { state: 'running', step: 'pr', at: new Date().toISOString() }; T.saveTask(row);
  assert.ok(interruptStale().includes(t2.id));
  assert.equal(T.getTask(t2.id)!.publish?.state, 'interrupted');
  assert.equal(T.publicTask(T.getTask(t2.id)!).publish?.state, 'interrupted');
  const before = posts().length;
  const r = await publish(t2.id, 'Footer grün');
  assert.equal(r.action, 'created');
  assert.equal(posts().length, before + 1);
  assert.equal(gh.pulls['acme/shop-theme'].filter(p => p.head === t2.branch).length, 1);
  assert.equal(remoteSha(t2.branch), pushed, 'nothing pushed twice');
  // a response lost after GitHub created it: the retry finds and reuses the open one
  const again = await publish(t2.id, 'Footer grün');
  assert.equal(again.action, 'updated');
  assert.equal(gh.pulls['acme/shop-theme'].filter(p => p.head === t2.branch).length, 1);
});

test('routes: concurrent publish 409, a running agent turn 409, strict body (no branch/base), missing token in German; PR state with checks', async () => {
  write(task.id, 'README.md', '# AcmeTheme\n\nmit Gratis Versand\n');
  const [a, b] = await Promise.all([post(task.id, { title: 'README', body: '' }), post(task.id, { title: 'README', body: '' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.match(((await (a.status === 409 ? a : b).json()) as { error: string }).error, /gerade veröffentlicht/);
  T.markTurn(task.id, true);
  const busy = await post(task.id, { title: 'README', body: '' });
  T.markTurn(task.id, false);
  assert.equal(busy.status, 409);
  assert.match(((await busy.json()) as { error: string }).error, /KI arbeitet gerade/);
  const sneaky = await post(task.id, { title: 'x', body: '', branch: 'main', base: 'main' });
  assert.equal(sneaky.status, 400);
  const pr = gh.pulls['acme/shop-theme'][0];
  pr.headSha = 'a'.repeat(40);
  gh.checkRuns['a'.repeat(40)] = [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'e2e', status: 'in_progress' }];
  P.forgetPrStatus(task.id);
  const st = await (await prRoute.GET(new Request('http://127.0.0.1/x'), ctx(task.id))).json() as { pr: { state: string; checks: unknown; number: number } };
  assert.equal(st.pr.number, 1);
  assert.equal(st.pr.state, 'open');
  assert.deepEqual(st.pr.checks, { total: 3, success: 1, failure: 1, pending: 1 });
  pr.merged = true;
  const cached = await (await prRoute.GET(new Request('http://127.0.0.1/x'), ctx(task.id))).json() as { pr: { state: string } };
  assert.equal(cached.pr.state, 'open', 'cached for a short while');
  saveGithub({ token: null });
  const none = await post(task.id, { title: 'README', body: '' });
  assert.equal(none.status, 400);
  assert.match(((await none.json()) as { error: string }).error, /GitHub ist nicht verbunden/);
  saveGithub({ token: GITHUB_TOKEN });
});

test('German errors: no write access for pull requests, branch changed on GitHub', async () => {
  const t3 = await S.readyTask('Ohne Recht');
  write(t3.id, 'README.md', '# geändert\n');
  gh.repos[0].push = false;
  try {
    gh.failNext = undefined;
    // the push goes to the bare repo (file://): the PR call is refused
    await assert.rejects(publish(t3.id, 'Ohne Recht'), /Keine Schreibrechte für Pull Requests in acme\/shop-theme/);
  } finally { gh.repos[0].push = true; }
  // someone else pushed to the lotse branch: the lease refuses to overwrite it
  const other = path.join(path.dirname(theme.bare), 'other');
  execFileSync('git', ['clone', '-q', '--branch', t3.branch, theme.bare, other]);
  fs.writeFileSync(path.join(other, 'x.txt'), 'fremd\n');
  execFileSync('git', ['-C', other, 'add', 'x.txt']);
  execFileSync('git', ['-C', other, '-c', 'user.name=X', '-c', 'user.email=x@example.com', 'commit', '-qm', 'fremd']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', `HEAD:refs/heads/${t3.branch}`]);
  write(t3.id, 'README.md', '# noch einmal geändert\n');
  await assert.rejects(publish(t3.id, 'Ohne Recht'), /wurde auf GitHub verändert/);
});
