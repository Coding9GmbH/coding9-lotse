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
  assert.match((created.body as { body: string }).body, /Geprüft in der Vorschau\.\n\n---\n_Erstellt mit Lotse/, 'no screenshot note: nobody took one');
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
  assert.match(((await (a.status === 409 ? a : b).json()) as { error: string }).error, /Sandbox wird gerade veröffentlicht/);
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

test('push errors: only a real 403 of GitHub is the token hint; protection, moved branch and other refusals have their own text, the full report follows', () => {
  const t = { repo: 'acme/shop-theme', branch: 'lotse/header-abc123' };
  const first = (s: string) => s.split('\n')[0];
  assert.match(first(P.pushErrorText('remote: Permission to acme/shop-theme.git denied to lotse-bot.\nfatal: unable to access \'https://github.com/acme/shop-theme.git/\': The requested URL returned error: 403', t)), /^Keine Schreibrechte für acme\/shop-theme: .*Contents/);
  assert.match(first(P.pushErrorText('remote: error: GH006: Protected branch update failed for refs/heads/lotse/header-abc123.\n! refs/heads/lotse/header-abc123 [remote rejected] (protected branch hook declined)', t)), /^Branch-Schutz verhindert den Push auf lotse\/header-abc123/);
  assert.match(first(P.pushErrorText('!\tHEAD:refs/heads/lotse/header-abc123\t[rejected] (stale info)', t)), /wurde auf GitHub verändert/);
  // a pre-receive hook that says "denied" is a server refusal, not a token problem
  const hook = P.pushErrorText('remote: error: File big.bin is 120.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB (access denied)\n! [remote rejected] HEAD -> lotse/header-abc123 (pre-receive hook declined)', t);
  assert.equal(first(hook), 'Push abgelehnt: File big.bin is 120.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB (access denied)');
  assert.match(hook, /\n.*pre-receive hook declined/, 'git\'s report follows after the first line');
  assert.match(first(P.pushErrorText('! [remote rejected] HEAD -> lotse/x (push declined due to email privacy restrictions)', t)), /^Push abgelehnt: push declined due to email privacy restrictions$/);
  assert.match(first(P.pushErrorText('fatal: unable to access \'https://github.com/acme/x.git/\': Could not resolve host: github.com', t)), /^Push fehlgeschlagen: unable to access/);
  // GitHub's real reports: GH007 (private e-mail) is no branch protection; GH001 (large file) names its reason, not the Trace id
  const gh007 = ['remote: error: GH007: Your push would publish a private email address.', 'remote: You can make your email public or disable this protection by visiting:', 'remote: https://github.com/settings/emails', 'To https://github.com/acme/shop-theme.git', ' ! [remote rejected] HEAD -> lotse/header-abc123 (push declined due to email privacy restrictions)', 'error: failed to push some refs to \'https://github.com/acme/shop-theme.git\''].join('\n');
  assert.equal(first(P.pushErrorText(gh007, t)), 'Push abgelehnt: GH007: Your push would publish a private email address.');
  const gh001 = ['remote: Resolving deltas: 100% (3/3), completed with 2 local objects.', 'remote: error: Trace: b5bd4c3e0f6c9a1f2e7d8a9b0c1d2e3f', 'remote: error: See https://gh.io/lfs for more information.', 'remote: error: File big.bin is 120.00 MB; this exceeds GitHub\'s file size limit of 100.00 MB', 'remote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.', 'To https://github.com/acme/shop-theme.git', ' ! [remote rejected] HEAD -> lotse/header-abc123 (pre-receive hook declined)'].join('\n');
  assert.equal(first(P.pushErrorText(gh001, t)), 'Push abgelehnt: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.');
  const gh013 = ['remote: error: GH013: Repository rule violations found for refs/heads/lotse/header-abc123.', 'remote: Review all repository rules at https://github.com/acme/shop-theme/rules?ref=refs%2Fheads%2Flotse%2Fheader-abc123', 'remote:', 'remote: - Cannot update this protected ref.', ' ! [remote rejected] HEAD -> lotse/header-abc123 (push declined due to repository rule violations)'].join('\n');
  assert.match(first(P.pushErrorText(gh013, t)), /^Branch-Schutz verhindert den Push auf lotse\/header-abc123/);
  const secret = ['remote: error: GH013: Repository rule violations found for refs/heads/lotse/header-abc123.', 'remote:', 'remote: - GITHUB PUSH PROTECTION', 'remote:   —————————————————————————————————————————', 'remote:     Resolve the following violations before pushing again', 'remote:', 'remote:     - Push cannot contain secrets', ' ! [remote rejected] HEAD -> lotse/header-abc123 (push declined due to repository rule violations)'].join('\n');
  assert.equal(first(P.pushErrorText(secret, t)), 'Push abgelehnt: Push cannot contain secrets');
  assert.match(first(P.pushErrorText('remote: Permission to acme/shop-theme.git denied to bot.\nfatal: The requested URL returned error: 403', t, 'en')), /^No write access to acme\/shop-theme/);
});

test('preflight: GitHub actions blocked like workflows; a non-ASCII stored secret is found in a latin1-read file', () => {
  const M = (p: string) => ({ path: p, status: 'M' });
  assert.match(P.blockReason([M('.github/actions/setup/action.yml')])!, /Workflows oder -Actions/);
  assert.match(P.blockReason([M('tools/deploy/action.yaml')])!, /Workflows oder -Actions/);
  const disk = Buffer.from('<default>Größe-Passwort1</default>\n', 'utf8').toString('latin1');
  assert.match(P.scanFile('config.xml', disk, new Set(), ['Größe-Passwort1'])!, /in Lotse gespeichertes Geheimnis/);
});

test('a setup re-run waits for a running publish (the clone step wipes the worktree)', () => {
  let release!: () => void;
  T.markPublishing(task.id, new Promise<void>(r => { release = r; }));
  try { assert.throws(() => S.J.runSteps(task.id, T.getTask(task.id)!.steps.find(s => s.key === 'clone')!.id), (e: Error & { status?: number }) => e.status === 409 && /veröffentlicht/.test(e.message)); }
  finally { release(); }
});

test('an untouched credential line already in the base does not block (the base is read unredacted); a new one does', async () => {
  const seed = path.join(path.dirname(theme.bare), 'seed-creds');
  execFileSync('git', ['clone', '-q', '--branch', 'main', theme.bare, seed]);
  fs.writeFileSync(path.join(seed, 'phpunit.xml.dist'), '<phpunit>\n<env name="DATABASE_URL" value="mysql://root:root@127.0.0.1:3306/shopware"/>\n<env name="APP_ENV" value="test"/>\n</phpunit>\n');
  execFileSync('git', ['-C', seed, 'add', '-A']);
  execFileSync('git', ['-C', seed, '-c', 'user.name=X', '-c', 'user.email=x@example.com', 'commit', '-qm', 'phpunit']);
  execFileSync('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
  const t4 = await S.readyTask('PHPUnit Umgebung');
  write(t4.id, 'phpunit.xml.dist', '<phpunit>\n<env name="DATABASE_URL" value="mysql://root:root@127.0.0.1:3306/shopware"/>\n<env name="APP_ENV" value="ci"/>\n</phpunit>\n');
  write(t4.id, 'README.md', '# x\n');
  await P.preflight(T.getTask(t4.id)!);
  write(t4.id, 'phpunit.xml.dist', '<phpunit>\n<env name="DATABASE_URL" value="mysql://root:root@127.0.0.1:3306/shopware"/>\n<env name="X" value="https://u:geheim1@example.com/x"/>\n</phpunit>\n');
  await assert.rejects(P.preflight(T.getTask(t4.id)!), /Adresse mit Zugangsdaten/);
});

test('the lotse branch was deleted on GitHub (after a merge): the next publish creates it anew instead of failing the lease', async () => {
  assert.ok(T.getTask(task.id)!.pushedSha);
  bare('update-ref', '-d', `refs/heads/${task.branch}`);
  write(task.id, 'README.md', '# AcmeTheme\n\nNachtrag nach dem Merge\n');
  await publish(task.id, 'Nachtrag');
  const sha = remoteSha(task.branch);
  assert.ok(sha && sha === T.getTask(task.id)!.pushedSha);
});

test('a weak stored password ("shopware") is no secret for the scan: composer.json with shopware/core publishes', async () => {
  const { updateSettings } = await import('../../src/server/settings');
  updateSettings({ shopware: { url: 'http://shop', user: 'admin', password: 'shopware' } });
  try {
    const t5 = await S.readyTask('Composer');
    write(t5.id, 'composer.json', '{\n  "name": "acme/shop-theme",\n  "require": { "shopware/core": "~6.7.0", "shopware/storefront": "~6.7.0" }\n}\n');
    write(t5.id, 'src/Resources/config/config.xml', '<label>Shopware Passwort-Hinweis</label>\n');
    const r = await P.preflight(T.getTask(t5.id)!);
    assert.deepEqual(r.overridden, []);
  } finally { updateSettings({ shopware: { password: null } }); }
});

test('findings name file and line; a stored secret can be published anyway by its id (audited without the value), a token cannot', async () => {
  const SECRET = 'Kx7!pQ3z-Lm9w';
  S.E.saveSandbox({ envVars: [{ key: 'SHOP_API_SECRET', secret: true, value: SECRET }] });
  try {
    const t6 = await S.readyTask('Gefunden');
    write(t6.id, 'src/Resources/config/services.xml', `<services>\n  <!-- example -->\n  <argument>${SECRET}</argument>\n</services>\n`);
    write(t6.id, 'src/x.txt', `prefix${SECRET.replace('!', '')}suffix\n`); // no token of its own (and another value): no finding
    const blocked = await publish(t6.id).then(() => null, (e: Error & { findings?: { id: string; file: string; line: number; kind: string; overridable: boolean }[] }) => e);
    assert.ok(blocked, 'blocked');
    assert.match(blocked.message, /„src\/Resources\/config\/services\.xml“ \(Zeile 3\).*gespeichertes Geheimnis.*Trotzdem veröffentlichen/);
    assert.ok(!blocked.message.includes(SECRET));
    const stored = T.getTask(t6.id)!.publish!;
    assert.equal(stored.state, 'failed');
    assert.deepEqual(stored.findings!.map(f => [f.file, f.line, f.overridable]), [['src/Resources/config/services.xml', 3, true]]);
    assert.ok(!JSON.stringify(stored).includes(SECRET), 'the value is nowhere in the task');
    const ids = stored.findings!.map(f => f.id);
    // an approval of a different line content does not count
    assert.equal((await post(t6.id, { title: 'x', allowFindings: ['0123456789abcdef'] })).status, 422);
    const r = await post(t6.id, { title: 'Konfiguration', body: 'Beispielwert', allowFindings: ids });
    assert.equal(r.status, 200, await r.clone().text());
    const started = auditList(20).find(x => x.kind === 'code-pr' && x.taskId === t6.id && x.status === 'started')!;
    assert.deepEqual(started.secretOverride, [{ file: 'src/Resources/config/services.xml', line: 3, kind: 'ein in Lotse gespeichertes Geheimnis' }]);
    assert.ok(!JSON.stringify(auditList(20)).includes(SECRET));
    // keys and tokens: no override, even with their id; the line published anyway before does not block again
    write(t6.id, 'src/token.txt', `${'ghp_' + 'b'.repeat(36)}\n`);
    const tokenBlock = await publish(t6.id).then(() => null, (e: Error & { findings?: { id: string; file: string; overridable: boolean }[] }) => e);
    assert.deepEqual(tokenBlock!.findings!.map(f => [f.file, f.overridable]), [['src/token.txt', false]]);
    assert.doesNotMatch(tokenBlock!.message, /Trotzdem/);
    assert.equal((await post(t6.id, { title: 'x', allowFindings: tokenBlock!.findings!.map(f => f.id) })).status, 422);
  } finally { S.E.saveSandbox({ envVars: [] }); }
});

test('preflight secret scan: plausible values only, as a token of their own; a value already in the base file is no new leak', () => {
  const none = new Set<string>();
  assert.equal(P.scanFile('composer.json', '"shopware/core": "*"\n', none, ['shopware']), null, 'too weak to search for');
  assert.equal(P.scanFile('a.php', '$x = "abcKx7pQ3zLm9wdef";\n', none, ['Kx7pQ3zLm9w']), null, 'inside a longer word');
  assert.match(P.scanFile('a.php', '$x = "Kx7pQ3zLm9w";\n', none, ['Kx7pQ3zLm9w'])!, /\(Zeile 1\)/);
  assert.equal(P.scanFile('a.php', '$y = "Kx7pQ3zLm9w";\n', none, ['Kx7pQ3zLm9w'], '$x = "Kx7pQ3zLm9w";\n'), null, 'the base version already has it');
  const found = P.scanFindings('b.php', 'a\nb Kx7pQ3zLm9w\nc\nd Kx7pQ3zLm9w\n', none, ['Kx7pQ3zLm9w']);
  assert.deepEqual(found.map(f => f.line), [2, 4]);
  assert.notEqual(found[0].id, found[1].id, 'the id follows the line content');
});

test('diff route: after a push it says whether anything changed since ("Pull Request aktualisieren" only then)', async () => {
  const diffRoute = await import('../../src/app/api/sandbox/tasks/[id]/diff/route');
  const get = async (id: string) => (await diffRoute.GET(new Request(`http://127.0.0.1/api/sandbox/tasks/${id}/diff`), ctx(id))).json() as Promise<{ unpublished?: boolean; files: unknown[] }>;
  const t7 = await S.readyTask('Seit dem Push');
  write(t7.id, 'README.md', '# AcmeTheme\n\nErste Fassung\n');
  assert.equal((await get(t7.id)).unpublished, undefined, 'never pushed');
  await publish(t7.id, 'Erste Fassung');
  assert.equal((await get(t7.id)).unpublished, false);
  write(t7.id, 'README.md', '# AcmeTheme\n\nZweite Fassung\n');
  assert.equal((await get(t7.id)).unpublished, true);
  write(t7.id, 'neu.txt', 'neu\n');
  write(t7.id, 'README.md', '# AcmeTheme\n\nErste Fassung\n');
  assert.equal((await get(t7.id)).unpublished, true, 'a new file counts');
});
