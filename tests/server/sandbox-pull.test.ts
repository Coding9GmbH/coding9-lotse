import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../isolate-data';
import type { ChatEvent, ContainerChanges, ContainerTakeOver } from '@/lib/protocol';
import { makePluginRepo, makeProjectRepo } from '../support/plugin-repo';
import { startFakeGithub } from '../support/github-fake';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers and route contexts take loose input */

// A24 "Aus dem Container übernehmen": files made or changed inside the task container (console, sandbox_bash) are compared with the
// worktree and taken over on a click or by the AI's pull_from_container – for a plugin, a full project, an own setup and a sandbox
// without a project. The container is untrusted: its listing and its archives are parsed defensively (paths, links, devices, sizes,
// counts), every file goes through the commit checks, nothing is written through a link on the host, and only what was compared is
// taken over. What the container had right after its setup is no change; a full mirror no longer wipes what was made in the container.
for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-pull-'));
const theme = makePluginRepo(tmp, { theme: true });
makeProjectRepo(tmp, { repo: 'acme/shop' });
makePluginRepo(tmp, { repo: 'acme/plain-lib', composer: { name: 'acme/plain-lib', type: 'library' } });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${theme.remoteBase}`;
const TOKEN = `github_pat_${'Pu11Contnr'.repeat(8)}_abc`;
const gh = await startFakeGithub({ token: TOKEN, repos: ['acme/shop-theme', 'acme/shop', 'acme/plain-lib'].map(fullName => ({ fullName })) });
process.env.LOTSE_GITHUB_API_BASE = gh.base;

const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
const { setRunner } = await import('../../src/server/sandbox/runner');
const { allowFileRemotesForTests } = await import('../../src/server/git');
const { saveGithub } = await import('../../src/server/github');
const { getSession } = await import('../../src/server/sessions');
const { auditList } = await import('../../src/server/db');
const E = await import('../../src/server/sandbox/env');
const J = await import('../../src/server/sandbox/jobs');
const T = await import('../../src/server/sandbox/tasks');
const W = await import('../../src/server/sandbox/workspace-tools');
const P = await import('../../src/server/sandbox/container-pull');
const { PUBLISH_LIMITS } = await import('../../src/server/sandbox/publish');
const { TarError, readTarStrict, writeTar } = await import('../../src/server/sandbox/tar');
const { unifiedDiff } = await import('../../src/server/sandbox/line-diff');
const pullRoute = await import('../../src/app/api/sandbox/tasks/[id]/container-changes/route');

allowFileRemotesForTests(true);
saveGithub({ token: TOKEN });
const fake = new FakeRunner();
fake.images.add('dockware/shopware:6.7.15.1');
setRunner(fake);
const SECRET = 'pull-geheimnis-2026';
E.saveSandbox({ enabled: true, envVars: [{ key: 'SHOP_PASSWORD', value: SECRET, secret: true }] });
after(async () => { await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
const settled = (id: string) => until(() => !J.setupRunning(id) && T.getTask(id)!.status !== 'setting_up');
async function ready(p: Partial<Parameters<typeof T.createTask>[0]>) {
  const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Container übernehmen', repo: '', baseBranch: 'main', ...p });
  getSession(t.chatId!); // the chat exists (status lines land in it)
  J.runSteps(t.id);
  await settled(t.id);
  const done = T.getTask(t.id)!;
  assert.equal(done.status, 'ready', done.error ?? '');
  return done;
}
const files = (id: string) => fake.containers.get(T.getTask(id)!.containerId!)!.files;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (id: string) => `http://127.0.0.1/api/sandbox/tasks/${id}/container-changes`;
async function compare(id: string): Promise<ContainerChanges> {
  const r = await pullRoute.GET(new Request(url(id)), ctx(id));
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<ContainerChanges>;
}
const takeOver = (id: string, items: { path: string; sha: string | null }[]) =>
  pullRoute.POST(new Request(url(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) }), ctx(id));
const toolsFor = (t: { id: string; chatId: string | null }, events: ChatEvent[]) => W.sandboxTools({ id: t.chatId!, taskId: t.id, emit: ev => { events.push(ev); }, askUser: async () => '', approvals: new Map(), abort: null });
async function call(tools: ReturnType<typeof toolsFor>, name: string, input: Record<string, unknown> = {}) {
  const r = await tools.find(x => x.name === name)!.handler(input as any, {});
  return { error: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('') };
}
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const byPath = (c: ContainerChanges) => Object.fromEntries(c.changes.map(x => [x.path, x]));

// a plugin sandbox, set up before the tests are registered (the runner must not finish – and clean up – while it starts)
const PLUGIN = '/var/www/html/custom/plugins/AcmeTheme';
const plugin = await ready({ title: 'Plugin bauen', repo: 'acme/shop-theme' });
const wt = T.taskPaths(plugin.id).worktree, gd = T.taskPaths(plugin.id).gitDir;
const git = (...args: string[]) => execFileSync('git', [`--git-dir=${gd}`, `--work-tree=${wt}`, ...args], { encoding: 'utf8', cwd: wt }).trim();
const events: ChatEvent[] = [];
const tools = toolsFor(plugin, events);
const bash = async (command: string) => { const r = await call(tools, 'sandbox_bash', { command }); assert.equal(r.error, false, r.text); };

// ---- Untrusted input, parsed defensively ----
/** A raw ustar header (the fields an attacker controls), checksum computed unless `badSum` */
function hdr(name: string, type: string, size: number, o: { link?: string; badSum?: boolean; base256?: boolean } = {}): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8'); h.write('0000644\0', 100); h.write('0000041\0', 108); h.write('0000041\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156);
  if (o.link) h.write(o.link, 157, 100);
  h.write('ustar\0', 257); h.write('00', 263);
  if (o.base256) { h.fill(0, 124, 136); h[124] = 0x80; h[135] = 5; }
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${(o.badSum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const data = (s: string) => { const b = Buffer.from(s); return Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]); };
const tarOf = (...parts: Buffer[]) => Buffer.concat([...parts, Buffer.alloc(1024)]);
const pax = (rec: Record<string, string>) => {
  const body = Object.entries(rec).map(([k, v]) => { const s = ` ${k}=${v}\n`; let n = s.length + 1; while (String(n).length + s.length !== n) n++; return `${n}${s}`; }).join('');
  return Buffer.concat([hdr('PaxHeader', 'x', Buffer.byteLength(body)), data(body)]);
};
const LIM = { entries: 10, fileBytes: 1024, totalBytes: 2048 };

test('the limits are publishing\'s; the line diff is a git-style patch', () => {
  assert.deepEqual([P.PULL_LIMITS.files, P.PULL_LIMITS.fileBytes, P.PULL_LIMITS.totalBytes], [PUBLISH_LIMITS.files, PUBLISH_LIMITS.fileBytes, PUBLISH_LIMITS.totalBytes]);
  const d = unifiedDiff('a.txt', 'eins\nzwei\ndrei\n', 'eins\nZWEI\ndrei\nvier\n');
  assert.equal(d.patch, 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,4 @@\n eins\n-zwei\n+ZWEI\n drei\n+vier\n');
  assert.deepEqual([d.added, d.removed], [2, 1]);
  assert.match(unifiedDiff('n.txt', null, 'x\n').patch, /^diff --git a\/n\.txt b\/n\.txt\nnew file mode 100644\n--- \/dev\/null\n\+\+\+ b\/n\.txt\n@@ -0,0 \+1,1 @@\n\+x\n$/);
  assert.equal(unifiedDiff('s.txt', 'gleich\n', 'gleich\n').patch, '');
});

test('archives from the container: only clean regular files and folders; links, devices, traversal, bad headers and oversize are refused', () => {
  const ok = readTarStrict(writeTar([{ path: 'stage', type: 'dir' }, { path: 'stage/0', type: 'file', data: Buffer.from('hallo'), mode: 0o755 }], { uid: 33, gid: 33, uname: 'www-data', gname: 'www-data' }), LIM);
  assert.deepEqual(ok.entries.map(e => [e.path, e.type, e.data.toString(), e.mode]), [['stage', 'dir', '', 0o755], ['stage/0', 'file', 'hallo', 0o755]]);
  // links and special files are listed as refused, never returned as content
  const odd = readTarStrict(tarOf(hdr('stage/0', '2', 0, { link: '/etc/shadow' }), hdr('stage/1', '1', 0, { link: 'stage/0' }), hdr('stage/2', '3', 0), hdr('stage/3', '4', 0), hdr('stage/4', '6', 0)), LIM);
  assert.deepEqual(odd.entries, []);
  assert.deepEqual(odd.refused.map(r => r.type), ['symlink', 'hardlink', 'device', 'device', 'fifo']);
  const refused = (tar: Buffer, re: RegExp, lim = LIM) => assert.throws(() => readTarStrict(tar, lim), (e: unknown) => e instanceof TarError && re.test((e as Error).message));
  for (const p of ['../evil', 'stage/../../etc/x', '/etc/passwd', 'a//b', 'a/./b', 'a\\b', 'a\nb']) refused(tarOf(hdr(p, '0', 1), data('x')), /unsicherer Pfad/);
  refused(tarOf(pax({ path: '../../root/.ssh/authorized_keys' }), hdr('harmless', '0', 1), data('x')), /unsicherer Pfad/);
  refused(tarOf(pax({ size: '99999999999' }), hdr('stage/0', '0', 1), data('x')), /PAX-Feld „size“/);
  refused(tarOf(hdr('longlink', 'L', 10), data('../../evil'), hdr('x', '0', 1), data('x')), /Eintragstyp „L“/);
  refused(tarOf(hdr('g', 'g', 0)), /Eintragstyp „g“/);
  refused(tarOf(hdr('stage/0', '0', 5, { badSum: true }), data('hallo')), /Prüfsumme/);
  refused(tarOf(hdr('stage/0', '0', 5, { base256: true }), data('hallo')), /Binärformat/);
  refused(tarOf(hdr('stage/0', '0', 2000), data('x'.repeat(2000))), /zu groß/);
  refused(tarOf(hdr('stage/0', '0', 1000), data('x'.repeat(1000)), hdr('stage/1', '0', 1000), data('x'.repeat(1000)), hdr('stage/2', '0', 1000), data('x'.repeat(1000))), /Inhalt zu groß/);
  refused(tarOf(...Array.from({ length: 11 }, (_, i) => hdr(`stage/${i}`, '5', 0))), /zu viele Einträge/);
  refused(Buffer.concat([hdr('stage/0', '0', 4000)]), /abgeschnitten/, { ...LIM, fileBytes: 5000, totalBytes: 5000 });
  refused(tarOf(hdr('stage', '5', 3), data('abc')), /Ordner mit Inhalt/);
});

test('the container\'s file list: malformed output is refused as a whole, odd names are skipped and never used', () => {
  const roots = [{ container: '/r', rel: '' }];
  const out = (...t: string[]) => `${t.join('\0')}\0`;
  const l = P.parseListing(out('R', '/r', 'D', 'src', 'F', '5', '644', 'src/a.txt', 'F', '1', '755', '../x', 'F', '1', '644', '/etc/passwd', 'F', '1', '644', 'a\nb', 'O', 'l', 'link', 'O', 'p', 'fifo', 'P', 'vendor',
    'H', `${'a'.repeat(64)}  src/a.txt`, `${'b'.repeat(64)}  nicht/gelistet`, 'E'), roots);
  assert.deepEqual([...l.entries].map(([k, v]) => [k, v.kind, v.kind === 'file' ? v.sha : null]), [['src', 'dir', null], ['src/a.txt', 'file', 'a'.repeat(64)], ['link', 'link', null], ['fifo', 'special', null], ['vendor', 'pruned', null]]);
  assert.deepEqual(l.skipped.map(s => [s.path, s.reason]), [['../x', 'name'], ['/etc/passwd', 'name'], ['a?b', 'name']]);
  assert.ok(l.present.has('/r'));
  const bad = (o: string, re: RegExp) => assert.throws(() => P.parseListing(o, roots), re);
  bad(out('R', '/r', 'F', '1', '644', 'a'), /unvollständig/); // cut: no end marker
  bad(out('R', '/etc', 'E'), /unerwarteter Ordner/);
  bad(out('R', '/r', 'F', '1', '644', 'a', 'F', '2', '644', 'a', 'E'), /doppelter Eintrag/);
  bad(out('R', '/r', 'F', '-1', '644', 'a', 'E'), /Größe oder Rechte/);
  bad(out('R', '/r', 'F', '1', '9999', 'a', 'E'), /Größe oder Rechte/);
  bad(out('R', '/r', 'H', 'kein-hash', 'E'), /Prüfsumme/);
  bad(out('R', '/r', 'X', 'a', 'E'), /unbekannter Eintrag/);
  bad(out('E'), /Ordner fehlen/);
  bad(out('R', '/r', 'F', '1', '644'), /unvollständig|abgeschnitten/);
  assert.throws(() => P.parseListing(out('R', '/r', ...Array.from({ length: P.PULL_LIMITS.entries + 1 }, (_, i) => ['D', `d${i}`]).flat(), 'E'), roots), /Zu viele Dateien im Container/);
  // a missing root is no error: it just has nothing (and nothing of it counts as deleted)
  assert.equal(P.parseListing(out('R', '/r', 'E'), roots).present.size, 0);
});

test('plugin: right after the setup nothing differs (the baseline), only the plugin folder is compared', async () => {
  assert.ok(fs.existsSync(path.join(T.taskPaths(plugin.id).workspace, 'container-baseline.json')), 'the setup kept what the fresh container had');
  const c = await compare(plugin.id);
  assert.deepEqual(c.changes, []);
  assert.equal(c.noBaseline, undefined);
  assert.deepEqual(c.roots, [PLUGIN]);
});

test('plugin: what the console or sandbox_bash made is listed with a diff – vendor/ and other folders not, secrets and workflows blocked', async () => {
  await bash("echo '<?php // Migration' > custom/plugins/AcmeTheme/src/Migration/Migration1700000000Neu.php && echo geändert >> custom/plugins/AcmeTheme/README.md && rm -f custom/plugins/AcmeTheme/src/Resources/app/storefront/src/scss/overrides.scss");
  await bash('echo x > custom/plugins/AcmeTheme/vendor/acme/lib/Lib.php && echo y > custom/plugins/Other/composer.json && echo z > custom/plugins/AcmeTheme/node_modules/x/index.js');
  await bash(`echo APP_SECRET=x > custom/plugins/AcmeTheme/.env.local && echo ${TOKEN} > custom/plugins/AcmeTheme/src/Resources/config/token.txt && echo 'on: push' > custom/plugins/AcmeTheme/.github/workflows/deploy.yml`);
  await bash(`echo pw=${SECRET} > custom/plugins/AcmeTheme/src/Resources/config/shop.ini`);
  // the next command does not mirror the plugin folder again: what was made in the container stays until it is taken over
  await bash('ls');
  assert.ok(files(plugin.id).has(`${PLUGIN}/src/Migration/Migration1700000000Neu.php`));
  const c = await compare(plugin.id), m = byPath(c);
  assert.deepEqual(Object.keys(m).sort(), ['.github/workflows/deploy.yml', 'README.md', 'src/Migration/Migration1700000000Neu.php', 'src/Resources/app/storefront/src/scss/overrides.scss', 'src/Resources/config/shop.ini', 'src/Resources/config/token.txt']);
  assert.deepEqual([m['src/Migration/Migration1700000000Neu.php'].status, m['README.md'].status, m['src/Resources/app/storefront/src/scss/overrides.scss'].status], ['added', 'modified', 'deleted']);
  assert.equal(m['README.md'].sha, sha('# AcmeTheme\ngeändert\n'));
  assert.equal(m['src/Resources/app/storefront/src/scss/overrides.scss'].sha, null);
  assert.deepEqual([m['README.md'].added, m['README.md'].removed], [1, 0]);
  for (const ok of ['README.md', 'src/Migration/Migration1700000000Neu.php', 'src/Resources/app/storefront/src/scss/overrides.scss']) assert.equal(m[ok].blocked, undefined, ok);
  assert.match(m['src/Resources/config/token.txt'].blocked!, /GitHub-Token/);
  assert.match(m['.github/workflows/deploy.yml'].blocked!, /GitHub-Workflows/);
  assert.match(m['src/Resources/config/shop.ini'].blocked!, /gespeichertes Geheimnis/);
  assert.deepEqual(c.skipped, [{ path: '.env.local', reason: 'protected' }]);
  assert.match(c.diff, /\+<\?php \/\/ Migration/);
  assert.match(c.diff, /^ # AcmeTheme\n\+geändert$/m);
  assert.ok(!c.diff.includes(TOKEN) && !c.diff.includes(SECRET), 'the diff is redacted');
});

test('plugin: taking over writes exactly the compared versions (normalized, audited); changed since or blocked = refused', async () => {
  const c = await compare(plugin.id), m = byPath(c);
  const r = await takeOver(plugin.id, [
    ...['src/Migration/Migration1700000000Neu.php', 'README.md', 'src/Resources/app/storefront/src/scss/overrides.scss'].map(p => ({ path: p, sha: m[p].sha })),
    { path: 'src/Resources/config/token.txt', sha: m['src/Resources/config/token.txt'].sha },
    { path: 'src/Resources/config/shop.ini', sha: sha('anders') },
    { path: 'gibt/es/nicht.txt', sha: null },
  ]);
  assert.equal(r.status, 200, await r.clone().text());
  const res = await r.json() as ContainerTakeOver;
  assert.deepEqual(res.taken.map(x => [x.path, x.status]), [['src/Migration/Migration1700000000Neu.php', 'added'], ['README.md', 'modified'], ['src/Resources/app/storefront/src/scss/overrides.scss', 'deleted']]);
  assert.deepEqual(res.refused.map(x => x.path), ['src/Resources/config/shop.ini', 'gibt/es/nicht.txt', 'src/Resources/config/token.txt']);
  assert.match(res.refused[0].reason, /seit dem Vergleich geändert/);
  assert.match(res.refused[2].reason, /GitHub-Token/);
  assert.equal(fs.readFileSync(path.join(wt, 'src/Migration/Migration1700000000Neu.php'), 'utf8'), '<?php // Migration\n');
  assert.equal(fs.statSync(path.join(wt, 'src/Migration/Migration1700000000Neu.php')).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), '# AcmeTheme\ngeändert\n');
  assert.ok(!fs.existsSync(path.join(wt, 'src/Resources/app/storefront/src/scss/overrides.scss')));
  assert.ok(!fs.existsSync(path.join(wt, 'src/Resources/config/token.txt')) && !fs.existsSync(path.join(wt, '.env.local')));
  const row = (auditList(20) as any[]).find(a => a.kind === 'sandbox-pull');
  assert.deepEqual([row.taskId, row.via, row.files, row.refused], [plugin.id, 'panel', ['src/Migration/Migration1700000000Neu.php', 'README.md', 'src/Resources/app/storefront/src/scss/overrides.scss'], 3]);
  // the container had these already: nothing is mirrored back, and the comparison lists only what is still blocked
  const before = fake.archives.length;
  assert.deepEqual((await compare(plugin.id)).changes.map(x => x.path).sort(), ['.github/workflows/deploy.yml', 'src/Resources/config/shop.ini', 'src/Resources/config/token.txt']);
  assert.equal(fake.archives.length, before, 'nothing transferred into the container');
  // the normal flow from here: commit
  assert.match(git('status', '--porcelain'), /src\/Migration\//);
  const commit = await call(tools, 'git_commit', { message: 'Migration aus dem Container übernehmen' });
  assert.equal(commit.error, false, commit.text);
  // changed again in the container after the comparison: the old version is refused
  const again = await compare(plugin.id);
  await bash('echo noch-einmal >> custom/plugins/AcmeTheme/src/Resources/config/shop.ini && echo neu > custom/plugins/AcmeTheme/CHANGELOG.md');
  const stale = await (await takeOver(plugin.id, [{ path: 'CHANGELOG.md', sha: sha('alt\n') }])).json() as ContainerTakeOver;
  assert.deepEqual([stale.taken, stale.refused.map(x => x.path)], [[], ['CHANGELOG.md']]);
  assert.ok(again.changes.every(x => x.path !== 'CHANGELOG.md'));
  // bad requests: wrong shapes are refused before anything happens
  for (const body of [{ items: [] }, { items: [{ path: 'a', sha: 'xyz' }] }, { items: [{ path: 'a', sha: null, extra: 1 }] }, { all: true }]) {
    const r2 = await pullRoute.POST(new Request(url(plugin.id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx(plugin.id));
    assert.equal(r2.status, 400, JSON.stringify(body));
  }
});

test('plugin: the AI\'s pull_from_container takes over (all or below paths) and shows file cards; refused ones are named', async () => {
  events.length = 0;
  await bash("echo '{\"neu\": \"Neu\"}' > custom/plugins/AcmeTheme/src/Resources/snippet/de_DE/neu.de-DE.json && echo Service > custom/plugins/AcmeTheme/src/Service/Neu.php");
  const some = await call(tools, 'pull_from_container', { paths: ['src/Resources/snippet'] });
  assert.equal(some.error, false, some.text);
  assert.match(some.text, /^Übernommen \(1\):\nneu src\/Resources\/snippet\/de_DE\/neu\.de-DE\.json \(\+1 −0\)/);
  assert.match(some.text, /Noch nicht committet – prüfen und mit git_commit speichern\./);
  assert.ok(fs.existsSync(path.join(wt, 'src/Resources/snippet/de_DE/neu.de-DE.json')) && !fs.existsSync(path.join(wt, 'src/Service/Neu.php')));
  assert.deepEqual(events.filter(e => e.t === 'file_change'), [{ t: 'file_change', path: 'src/Resources/snippet/de_DE/neu.de-DE.json', kind: 'create', added: 1, removed: 0 }]);
  const rest = await call(tools, 'pull_from_container');
  assert.match(rest.text, /neu src\/Service\/Neu\.php/);
  assert.match(rest.text, /neu CHANGELOG\.md/);
  assert.match(rest.text, /Nicht übernommen:\n[\s\S]*src\/Resources\/config\/token\.txt: [\s\S]*GitHub-Token/);
  assert.match(rest.text, /Übersprungen: \.env\.local \(geschützt/);
  assert.ok(!rest.text.includes(TOKEN) && !rest.text.includes(SECRET));
  for (const bad of ['../x', '/etc', '.git']) assert.equal((await call(tools, 'pull_from_container', { paths: [bad] })).error, true, bad);
  const row = (auditList(5) as any[]).find(a => a.kind === 'sandbox-pull');
  assert.equal(row.via, 'ai');
});

test('plugin: nothing is written through a link on the host; folders the repository tracks inside public/ are compared', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-outside-'));
  fs.symlinkSync(outside, path.join(wt, 'linkdir'));
  fs.mkdirSync(path.join(wt, 'src/Resources/public/administration/js'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src/Resources/public/administration/js/acme.js'), 'alt\n');
  assert.equal((await call(tools, 'git_commit', { message: 'Admin-Build', paths: ['src/Resources/public'] })).error, false);
  await compare(plugin.id); // the worktree changed outside the tools: one full sync first
  await bash('echo pwn > custom/plugins/AcmeTheme/linkdir/pwn.txt && echo neu > custom/plugins/AcmeTheme/src/Resources/public/administration/js/acme.js && echo cache > custom/plugins/AcmeTheme/var/cache.txt');
  const c = await compare(plugin.id), m = byPath(c);
  assert.ok(c.roots.includes(`${PLUGIN}/src/Resources/public`), 'a tracked public/ folder is compared too');
  assert.equal(m['src/Resources/public/administration/js/acme.js']?.status, 'modified');
  assert.ok(!m['var/cache.txt']);
  const r = await (await takeOver(plugin.id, ['linkdir/pwn.txt', 'src/Resources/public/administration/js/acme.js'].map(p => ({ path: p, sha: m[p].sha })))).json() as ContainerTakeOver;
  assert.deepEqual(r.taken.map(x => x.path), ['src/Resources/public/administration/js/acme.js']);
  assert.match(r.refused[0].reason, /„linkdir“ ist im Repository kein Ordner/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing written outside the worktree');
  fs.rmSync(outside, { recursive: true });
  fs.rmSync(path.join(wt, 'linkdir'));
});

test('plugin: a hostile container – forged listing and archive – is refused or skipped, never followed', async () => {
  await compare(plugin.id); // in sync again
  const LIST = (argv: readonly string[]) => argv[0] === 'bash' && argv[3] === 'lotse-list';
  // links, a FIFO, a traversal name and an absolute name in the listing: skipped, never fetched
  const n = fake.calls.length;
  const z = (...t: string[]) => `${t.join('\0')}\0`;
  // every root the request named, the evil entries in the plugin folder
  const forged = (argv: readonly string[], evil: string[]) => z(...argv.slice(5).flatMap(r => ['R', r, ...(r === PLUGIN ? evil : []), 'H']), 'E');
  fake.script = argv => (LIST(argv) ? { output: forged(argv, ['O', 'l', 'evil-link', 'O', 'p', 'fifo', 'F', '1', '644', '../../../../etc/passwd', 'F', '1', '644', '/root/x']) } : undefined);
  try {
    const c = await compare(plugin.id);
    assert.deepEqual(c.skipped.map(s => [s.path, s.reason]).sort(), [['../../../../etc/passwd', 'name'], ['/root/x', 'name'], ['evil-link', 'symlink'], ['fifo', 'special']].sort());
    assert.ok(c.changes.every(x => x.status === 'deleted'), 'what the forged list lacks shows as deleted – nothing else');
    assert.ok(!fake.calls.slice(n).some(x => x.argv?.[3] === 'lotse-stage' && x.argv.some(a => a.includes('passwd'))));
  } finally { fake.script = () => undefined; }
  // cut or garbled output: the whole comparison is refused
  fake.script = argv => (LIST(argv) ? { output: z('R', PLUGIN, 'F', '1', '644', 'a') } : undefined);
  try {
    const r = await pullRoute.GET(new Request(url(plugin.id)), ctx(plugin.id));
    assert.equal(r.status, 500);
    assert.match(((await r.json()) as any).error, /Dateiliste aus dem Container ist ungültig/);
  } finally { fake.script = () => undefined; }
  await bash('echo inhalt > custom/plugins/AcmeTheme/NEU.txt');
  const stage = (dir: string) => path.posix.basename(dir);
  // the staged file came back as a link: not read
  fake.archive = (_id, dir) => (dir.startsWith('/tmp/lotse-pull-') ? tarOf(hdr(stage(dir), '5', 0), hdr(`${stage(dir)}/0`, '2', 0, { link: '/etc/shadow' })) : undefined);
  try { assert.match(byPath(await compare(plugin.id))['NEU.txt'].blocked!, /nicht gelesen/); } finally { fake.archive = null; }
  // other bytes than listed: refused (the sha256 is checked on what arrives)
  fake.archive = (_id, dir) => (dir.startsWith('/tmp/lotse-pull-') ? tarOf(hdr(stage(dir), '5', 0), hdr(`${stage(dir)}/0`, '0', 5), data('böse')) : undefined);
  try { assert.match(byPath(await compare(plugin.id))['NEU.txt'].blocked!, /währenddessen geändert/); } finally { fake.archive = null; }
  // traversal, a foreign entry or a broken header: the whole archive is refused
  for (const forged of [(d: string) => tarOf(hdr(`${d}/../../etc/cron.d/x`, '0', 1), data('x')), (d: string) => tarOf(hdr(`${d}/99`, '0', 1), data('x')), (d: string) => tarOf(hdr(`${d}/0`, '0', 1, { badSum: true }), data('x'))]) {
    fake.archive = (_id, dir) => (dir.startsWith('/tmp/lotse-pull-') ? forged(stage(dir)) : undefined);
    try {
      const r = await pullRoute.GET(new Request(url(plugin.id)), ctx(plugin.id));
      assert.equal(r.status, 500);
      assert.match(((await r.json()) as any).error, /Archiv/);
      assert.ok(!fs.existsSync(path.join(wt, 'NEU.txt')));
    } finally { fake.archive = null; }
  }
  // the staging folder is removed again every time
  assert.ok(![...files(plugin.id).keys()].some(k => k.startsWith('/tmp/lotse-pull-')));
});

test('plugin: a wake keeps what was made in the container; edits while paused are synced alone', async () => {
  await bash('echo bleibt > custom/plugins/AcmeTheme/BLEIBT.md');
  await J.pauseTask(plugin.id);
  fs.writeFileSync(path.join(wt, 'src/Resources/app/storefront/src/scss/base.scss'), '.pausiert { color: red; }\n');
  assert.match(await W.syncChanged(plugin.id, ['src/Resources/app/storefront/src/scss/base.scss']), /Container pausiert/);
  const n = fake.archives.length;
  await J.ensureAwake(plugin.id);
  assert.equal(T.getTask(plugin.id)!.status, 'ready');
  const put = fake.archives.slice(n).filter(a => a.dir !== '/var/www');
  assert.deepEqual(put.flatMap(a => a.entries.filter(e => e.type === 'file').map(e => e.path)), ['AcmeTheme/src/Resources/app/storefront/src/scss/base.scss'], 'only the edited file');
  assert.ok(files(plugin.id).has(`${PLUGIN}/BLEIBT.md`), 'not wiped by a full mirror');
  assert.equal(files(plugin.id).get(`${PLUGIN}/src/Resources/app/storefront/src/scss/base.scss`)!.toString(), '.pausiert { color: red; }\n');
  assert.ok(byPath(await compare(plugin.id))['BLEIBT.md']);
});

test('full project: new plugin folders and config made in the container; image and Lotse files, vendor/ and the root are not offered', async () => {
  const p = await ready({ title: 'Projekt', repo: 'acme/shop' });
  const c0 = await compare(p.id);
  assert.deepEqual(c0.roots, ['custom/plugins', 'custom/static-plugins', 'custom/apps', 'config', 'src'].map(r => `/var/www/html/${r}`));
  assert.deepEqual(c0.changes, [], 'the override, quarantined config and the image\'s files are no changes');
  const ev: ChatEvent[] = [], ptools = toolsFor(p, ev);
  const r1 = await call(ptools, 'sandbox_bash', { command: "echo '{\"name\": \"acme/neu\"}' > custom/plugins/AcmeNeu/composer.json && echo 'App\\\\Neu' > src/Neu.php && echo 'framework: {}' > config/packages/neu.yaml" });
  assert.equal(r1.error, false, r1.text);
  await call(ptools, 'sandbox_bash', { command: 'echo x > custom/plugins/AcmeNeu/vendor/autoload.php && echo y > composer.json && echo z > public/robots.txt && echo w > config/bundles.php' });
  const c = await compare(p.id);
  assert.deepEqual(c.changes.map(x => [x.path, x.status]), [['config/packages/neu.yaml', 'added'], ['custom/plugins/AcmeNeu/composer.json', 'added'], ['src/Neu.php', 'added']]);
  const r = await call(ptools, 'pull_from_container');
  assert.equal(r.error, false, r.text);
  for (const f of ['custom/plugins/AcmeNeu/composer.json', 'src/Neu.php', 'config/packages/neu.yaml']) assert.ok(fs.existsSync(path.join(T.taskPaths(p.id).worktree, f)), f);
  assert.ok(!fs.existsSync(path.join(T.taskPaths(p.id).worktree, 'custom/plugins/AcmeNeu/vendor')));
  assert.deepEqual((await compare(p.id)).changes, []);
  await J.finishTask(p.id);
});

test('own setup: the target folder is compared; what the own setup commands made is the baseline', async () => {
  fake.script = (argv, id) => { if (argv[2] === 'make build') fake.containers.get(id)!.files.set('/srv/plain/build/app.txt', Buffer.from('gebaut\n')); return undefined; };
  let c: Awaited<ReturnType<typeof ready>>;
  try { c = await ready({ title: 'Eigenes Setup', repo: 'acme/plain-lib', mode: 'custom', targetPath: '/srv/plain', commands: [{ label: 'Bauen', command: 'make build', phase: 'after-db' }] }); } finally { fake.script = () => undefined; }
  const c0 = await compare(c.id);
  assert.deepEqual([c0.roots, c0.changes], [['/srv/plain'], []]);
  const ctools = toolsFor(c, []);
  assert.equal((await call(ctools, 'sandbox_bash', { command: 'echo neu > lib/neu.txt && echo neu-gebaut > build/app.txt' })).error, false);
  const m = byPath(await compare(c.id));
  assert.deepEqual(Object.keys(m).sort(), ['build/app.txt', 'lib/neu.txt']);
  const r = await (await takeOver(c.id, Object.values(m).map(x => ({ path: x.path, sha: x.sha })))).json() as ContainerTakeOver;
  assert.equal(r.taken.length, 2);
  assert.equal(fs.readFileSync(path.join(T.taskPaths(c.id).worktree, 'build/app.txt'), 'utf8'), 'neu-gebaut\n');
  await J.finishTask(c.id);
});

test('without a project: bin/console plugin:create in the container, taken over into the local repository', async () => {
  const n = await ready({ title: 'Ohne Projekt', source: 'none', pluginName: 'AcmeOhne', baseBranch: '' });
  assert.equal(n.layout?.pluginDir, 'custom/plugins/AcmeOhne');
  const ntools = toolsFor(n, []);
  assert.equal((await call(ntools, 'sandbox_bash', { command: "echo '{\"type\": \"shopware-platform-plugin\"}' > custom/plugins/AcmeOhne/composer.json && echo '<?php' > custom/plugins/AcmeOhne/src/AcmeOhne.php" })).error, false);
  const r = await call(ntools, 'pull_from_container');
  assert.match(r.text, /Übernommen \(2\)/);
  assert.ok(fs.existsSync(path.join(T.taskPaths(n.id).worktree, 'composer.json')));
  assert.equal((await call(ntools, 'git_commit', { message: 'Plugin-Grundgerüst' })).error, false);
  await J.finishTask(n.id);
});

test('routes: refused while the sandbox is not set up, finished or busy', async () => {
  const fresh = T.createTask({ chatId: crypto.randomUUID(), title: 'Neu', repo: 'acme/shop-theme', baseBranch: 'main' });
  assert.equal((await pullRoute.GET(new Request(url(fresh.id)), ctx(fresh.id))).status, 409);
  assert.equal((await takeOver(fresh.id, [{ path: 'a', sha: null }])).status, 409);
});

test('LOTSE_SANDBOX_MAX: the chat of the sandbox that starts says which one was paused for it', async () => {
  process.env.LOTSE_SANDBOX_MAX = '1';
  try {
    assert.equal(T.getTask(plugin.id)!.status, 'ready');
    const t = T.createTask({ chatId: crypto.randomUUID(), title: 'Theme ändern', repo: 'acme/shop-theme', baseBranch: 'main' });
    getSession(t.chatId!);
    J.runSteps(t.id);
    const ev = getSession(t.chatId!).events.find(e => e.t === 'sandbox_status' && e.state === 'displaced');
    assert.deepEqual(ev, { t: 'sandbox_status', state: 'displaced', paused: ['Plugin bauen'], max: 1 });
    await settled(t.id);
  } finally { delete process.env.LOTSE_SANDBOX_MAX; }
});
