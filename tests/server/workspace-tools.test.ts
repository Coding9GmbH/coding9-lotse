import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import type { ChatEvent } from '@/lib/protocol';
import { GITHUB_TOKEN, PLUGIN_DIR, sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers take loose input */

// MCP tools of a chat with an attached sandbox, with the FakeRunner: sandbox_bash runs any command line INSIDE the container (bash -lc,
// www-data, /var/www/html) after a full sync and under the task lock, output redacted and capped; delete_file, diff, the sandbox page,
// the environment without secret values; Codex additionally gets the read tools. Files are written natively (here: fs + syncChanged).
const S = await sandboxForTests({ env: [{ key: 'API_TOKEN', value: 'geheimer-wert-123', secret: true }, { key: 'APP_ENV', value: 'dev', secret: false }] });
const { fake, J, T } = S;
const W = await import('../../src/server/sandbox/workspace-tools');
after(S.close);

const task = await S.readyTask();
const events: ChatEvent[] = [];
const host = { id: 'chat-tools', taskId: task.id, emit: (ev: ChatEvent) => { events.push(ev); }, askUser: async () => 'Ja', abort: null };
const tools = W.sandboxTools(host);
const call = async (name: string, input: Record<string, unknown> = {}, set = tools) => {
  const r = await set.find(t => t.name === name)!.handler(input as any, {});
  return { error: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('') };
};
const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const execs = () => fake.calls.filter(c => c.op === 'exec' && c.id === task.containerId).map(c => c.argv!);
const write = (rel: string, text: string) => { const f = path.join(T.taskPaths(task.id).worktree, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

test('tool sets: Claude gets only what its own tools do not cover, Codex also the read tools; names match the allow-lists', () => {
  assert.deepEqual(tools.map(t => t.name), [...W.SANDBOX_TOOL_NAMES]);
  assert.deepEqual(W.sandboxToolNames('claude'), [...W.SANDBOX_TOOL_NAMES]);
  const codex = W.sandboxTools(host, 'codex');
  assert.deepEqual(codex.map(t => t.name), W.sandboxToolNames('codex'));
  assert.deepEqual(W.sandboxToolNames('codex').slice(0, 3), ['list_files', 'read_file', 'search_files']);
  for (const gone of ['edit_file', 'write_file', 'run_command']) assert.ok(!codex.some(t => t.name === gone), gone);
});

test('syncChanged mirrors a natively written file into the container; delete_file removes it there (fixed argv)', async () => {
  write(HEADER, "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand</div>{{ parent() }}{% endblock %}\n");
  assert.equal(await W.syncChanged(task.id, [HEADER]), ' und in den Container übertragen');
  const arch = fake.archives.at(-1)!;
  assert.equal(arch.dir, '/var/www/html/custom/plugins');
  assert.ok(arch.entries.some(e => e.path === `AcmeTheme/${HEADER}` && e.uid === 33));

  write('src/tmp.txt', 'x\n');
  const d = await call('delete_file', { path: 'src/tmp.txt' });
  assert.equal(d.error, false, d.text);
  assert.deepEqual(execs().at(-1), ['rm', '-f', '--', `${PLUGIN_DIR}/src/tmp.txt`]);
  assert.deepEqual(events.at(-1), { t: 'file_change', path: 'src/tmp.txt', kind: 'delete', added: 0, removed: 1 });
  for (const p of ['.env', '.git', '../../../etc/passwd', 'vendor/x.php']) assert.equal((await call('delete_file', { path: p })).error, true, p);
});

test('Codex read tools stay confined: no .env, no paths outside', async () => {
  const codex = W.sandboxTools(host, 'codex');
  const env = await call('read_file', { path: '.env' }, codex);
  assert.equal(env.error, true);
  assert.doesNotMatch(env.text, /never-in-the-container/);
  assert.equal((await call('read_file', { path: '../../../etc/passwd' }, codex)).error, true);
  assert.match((await call('read_file', { path: HEADER }, codex)).text, /Gratis Versand/);
  assert.match((await call('search_files', { pattern: 'APP_SECRET' }, codex)).text, /Keine Treffer/);
});

test('sandbox_bash: any command line via bash -lc as www-data in /var/www/html, full sync first, under the task lock, preview reload', async () => {
  // a step holding the lock runs first: the command waits for it
  const order: string[] = [];
  let release!: () => void;
  const held = J.withTaskLock(task.id, () => new Promise<void>(r => { release = () => { order.push('lock'); r(); }; }));
  const pending = call('sandbox_bash', { command: 'bin/console theme:compile && bin/console cache:clear' }).then(r => { order.push('cmd'); return r; });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, []);
  release(); await held;
  const r = await pending;
  assert.deepEqual(order, ['lock', 'cmd']);
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^Exit-Code 0 nach [\d.]+ s – die Vorschau lädt neu/);
  const all = fake.calls.filter(c => c.op === 'exec' && c.id === task.containerId);
  const run = all.at(-1)!;
  assert.deepEqual(run.argv, ['bash', '-lc', 'bin/console theme:compile && bin/console cache:clear']);
  assert.equal(run.user, 'www-data');
  assert.deepEqual(all.at(-2)!.argv, ['rm', '-rf', '--', PLUGIN_DIR], 'the full sync ran right before');
  const cmd = events.filter(e => e.t === 'command');
  assert.deepEqual(cmd.slice(-2).map(e => e.t === 'command' && [e.status, e.command]), [['running', 'bin/console theme:compile && bin/console cache:clear'], ['ok', 'bin/console theme:compile && bin/console cache:clear']]);
  assert.equal(events.at(-1)?.t, 'preview_reload');

  const ls = await call('sandbox_bash', { command: 'ls var/log', timeout_sec: 5 });
  assert.equal(ls.error, false);
  assert.notEqual(events.at(-1)?.t, 'preview_reload', 'no reload for a read-only command');
});

test('command output is redacted (stored PAT, ghp_ token, secret env value printed by env) and a failure is an error with the tail', async () => {
  fake.script = argv => (argv[0] === 'bash' && argv[2] === 'env; exit 3' ? { exitCode: 3, output: `token ${GITHUB_TOKEN}\nalso ghp_${'a1B2'.repeat(9)}\nAPI_TOKEN=geheimer-wert-123\nboom` } : undefined);
  const r = await call('sandbox_bash', { command: 'env; exit 3' });
  fake.script = () => undefined;
  assert.equal(r.error, true);
  for (const s of [GITHUB_TOKEN, `ghp_${'a1B2'.repeat(9)}`, 'geheimer-wert-123']) assert.ok(!r.text.includes(s), s);
  assert.match(r.text, /Exit-Code 3[\s\S]*boom/);
  const ev = events.filter(e => e.t === 'command').at(-1)!;
  assert.ok(ev.t === 'command' && ev.status === 'failed' && ev.exitCode === 3 && !ev.tail!.includes('geheimer'));
  // the command line on the card is redacted too
  await call('sandbox_bash', { command: `echo ${GITHUB_TOKEN}` });
  const shown = events.filter(e => e.t === 'command').at(-1)!;
  assert.ok(shown.t === 'command' && !shown.command.includes(GITHUB_TOKEN));
  assert.notEqual(events.at(-1)?.t, 'preview_reload', 'no reload after a failure');
});

test('git_diff shows the changes against the base branch, never secret files', async () => {
  fs.writeFileSync(path.join(T.taskPaths(task.id).worktree, '.env'), 'APP_SECRET=changed\n'); // changed outside the tools
  const d = await call('git_diff');
  assert.ok(d.text.includes(`added ${HEADER} (+2 −0)`), d.text);
  assert.match(d.text, /Gratis Versand/);
  assert.doesNotMatch(d.text, /APP_SECRET|\.env/);
});

test('git_diff at the same moment as the Änderungen tab: no index.lock clash', async () => {
  const { taskDiff } = await import('../../src/server/sandbox/diff');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(T.taskPaths(task.id).worktree, `neu-${i}.txt`), `${i}\n`); // new files: intent-to-add writes the index
  const all = await Promise.all([call('git_diff'), taskDiff(T.getTask(task.id)!, 200_000), call('git_diff'), taskDiff(T.getTask(task.id)!, 200_000), call('git_diff')]);
  for (const r of all) assert.ok('files' in r ? r.files.some(f => f.path === 'neu-5.txt') : !r.error && r.text.includes('neu-5.txt'), JSON.stringify(r).slice(0, 300));
  for (let i = 0; i < 6; i++) fs.unlinkSync(path.join(T.taskPaths(task.id).worktree, `neu-${i}.txt`));
});

test('read_sandbox_page: text of the task storefront (after theme:compile the fake shows the template)', async () => {
  const r = await call('read_sandbox_page', { path: '/' });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^HTTP 200 · text\/html/);
  assert.match(r.text, /Gratis Versand/);
  assert.match(r.text, /Fake-Storefront/);
  assert.match((await call('read_sandbox_page', { path: 'http://evil/' })).text, /muss mit \/ beginnen/);
  assert.match((await call('read_sandbox_page', { path: '//evil/x' })).text, /muss mit \/ beginnen/);
  assert.match((await call('read_sandbox_page', { path: '/', format: 'html' })).text, /<h1>Fake-Storefront<\/h1>/);
});

test('get_environment: variable names without values, own commands', async () => {
  const r = await call('get_environment');
  const env = JSON.parse(r.text);
  assert.deepEqual(env.envVars, [{ key: 'API_TOKEN', secret: true }, { key: 'APP_ENV', secret: false }]);
  assert.ok(!r.text.includes('geheimer-wert-123') && !r.text.includes('"dev"'));
  assert.equal(env.containerPath, PLUGIN_DIR);
  assert.equal(env.commands, undefined, 'no allow-listed command ids any more: sandbox_bash takes any command line');
});

test('ask_user and propose_publish: question to the host, card event only', async () => {
  assert.match((await call('ask_user', { question: 'Grün?', options: [{ label: 'Ja' }] })).text, /"answer": "Ja"/);
  await call('propose_publish', { title: 'Header: Gratis Versand', body: `Prüfung in der Vorschau. ${GITHUB_TOKEN}` });
  const ev = events.at(-1)!;
  assert.ok(ev.t === 'publish_proposal' && ev.title === 'Header: Gratis Versand' && !ev.body.includes(GITHUB_TOKEN));
});

test('a paused task is woken by sandbox_bash (no new setup)', async () => {
  await J.pauseTask(task.id);
  const installs = () => execs().filter(a => a[1] === 'plugin:install').length, before = installs();
  const r = await call('sandbox_bash', { command: 'bin/console theme:compile' });
  assert.equal(r.error, false, r.text);
  assert.equal(T.getTask(task.id)!.status, 'ready');
  assert.equal(installs(), before, 'no setup step again');
});
