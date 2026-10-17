import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import type { ChatEvent } from '@/lib/protocol';
import { GITHUB_TOKEN, PLUGIN_DIR, sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- tool handlers take loose input */

// Workspace tools of a code chat with the FakeRunner: file edits synced into the container, allow-listed commands under the task lock,
// redacted output, diff, sandbox page, environment without secret values.
const S = await sandboxForTests({ env: [{ key: 'API_TOKEN', value: 'geheimer-wert-123', secret: true }, { key: 'APP_ENV', value: 'dev', secret: false }] });
const { fake, J, T } = S;
const W = await import('../../src/server/sandbox/workspace-tools');
after(S.close);

const task = await S.readyTask();
const events: ChatEvent[] = [];
const tools = W.codeTools({ id: 'chat-tools', taskId: task.id, emit: ev => { events.push(ev); }, askUser: async () => 'Ja', abort: null });
const call = async (name: string, input: Record<string, unknown> = {}) => {
  const r = await tools.find(t => t.name === name)!.handler(input as any, {});
  return { error: !!r.isError, text: r.content.map((c: any) => c.text ?? '').join('') };
};
const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';
const execs = () => fake.calls.filter(c => c.op === 'exec' && c.id === task.containerId).map(c => c.argv!);

test('the tool set is exactly the code tools, with the same names as the allow-list', () => {
  assert.deepEqual(tools.map(t => t.name), [...W.CODE_TOOL_NAMES]);
});

test('write_file and delete_file change the worktree, sync the container and emit file_change (rm with fixed argv)', async () => {
  const w = await call('write_file', { path: HEADER, content: "{% sw_extends '@Storefront/storefront/layout/header/header.html.twig' %}\n{% block layout_header %}<div>Gratis Versand</div>{{ parent() }}{% endblock %}\n" });
  assert.equal(w.error, false, w.text);
  assert.match(w.text, /angelegt \(\+2 −0\) und in den Container übertragen/);
  assert.ok(fs.readFileSync(path.join(T.taskPaths(task.id).worktree, HEADER), 'utf8').includes('Gratis Versand'));
  const arch = fake.archives.at(-1)!;
  assert.equal(arch.dir, '/var/www/html/custom/plugins');
  assert.ok(arch.entries.some(e => e.path === `AcmeTheme/${HEADER}` && e.uid === 33));
  assert.deepEqual(events.at(-1), { t: 'file_change', path: HEADER, kind: 'create', added: 2, removed: 0 });

  await call('write_file', { path: 'src/tmp.txt', content: 'x' });
  const d = await call('delete_file', { path: 'src/tmp.txt' });
  assert.equal(d.error, false, d.text);
  assert.deepEqual(execs().at(-1), ['rm', '-f', '--', `${PLUGIN_DIR}/src/tmp.txt`]);
  assert.deepEqual(events.at(-1), { t: 'file_change', path: 'src/tmp.txt', kind: 'delete', added: 0, removed: 1 });
});

test('edit_file: unique match required, replace_all for several; refused paths are errors without file_change', async () => {
  await call('write_file', { path: 'src/Resources/app/storefront/src/scss/base.scss', content: '.a { color: red; }\n.b { color: red; }\n' });
  const n = events.length;
  const twice = await call('edit_file', { path: 'src/Resources/app/storefront/src/scss/base.scss', old_str: 'color: red', new_str: 'color: green' });
  assert.equal(twice.error, true);
  assert.match(twice.text, /2-mal/);
  const all = await call('edit_file', { path: 'src/Resources/app/storefront/src/scss/base.scss', old_str: 'color: red', new_str: 'color: green', replace_all: true });
  assert.match(all.text, /2 Stellen/);
  for (const p of ['.env', '.git/config', '../../../etc/passwd', 'outside-link']) {
    const r = await call('write_file', { path: p, content: 'x' });
    assert.equal(r.error, true, p);
  }
  const env = await call('read_file', { path: '.env' });
  assert.equal(env.error, true);
  assert.doesNotMatch(env.text, /never-in-the-container/);
  assert.equal(events.length, n + 1, 'only the successful edit emits');
});

test('run_command: unknown ids and bad args refused, exact argv as www-data, under the task lock, preview reload', async () => {
  assert.match((await call('run_command', { command: 'bash' })).text, /nicht freigegeben/);
  assert.match((await call('run_command', { command: 'lint-twig', args: { path: '../../etc/passwd' } })).text, /Ungültiger Wert/);
  assert.match((await call('run_command', { command: 'theme-compile', args: { x: '1' } })).text, /Unbekanntes Argument/);
  assert.match((await call('run_command', { command: 'lint-twig', args: { path: '-rf /' } })).text, /Ungültiger Wert/);

  // a step holding the lock runs first: the command waits for it
  const order: string[] = [];
  let release!: () => void;
  const held = J.withTaskLock(task.id, () => new Promise<void>(r => { release = () => { order.push('lock'); r(); }; }));
  const pending = call('run_command', { command: 'theme-compile' }).then(r => { order.push('cmd'); return r; });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(order, []);
  release(); await held;
  const r = await pending;
  assert.deepEqual(order, ['lock', 'cmd']);
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /theme-compile: Exit-Code 0/);
  const run = fake.calls.filter(c => c.op === 'exec' && c.argv![1] === 'theme:compile').at(-1)!;
  assert.deepEqual(run.argv, ['bin/console', 'theme:compile']);
  assert.equal(run.user, 'www-data');
  const cmd = events.filter(e => e.t === 'command');
  assert.deepEqual(cmd.slice(-2).map(e => e.t === 'command' && e.status), ['running', 'ok']);
  assert.equal(events.at(-1)?.t, 'preview_reload');

  const lint = await call('run_command', { command: 'lint-twig', args: { path: HEADER } });
  assert.equal(lint.error, false);
  assert.deepEqual(execs().at(-1), ['bin/console', 'lint:twig', `custom/plugins/AcmeTheme/${HEADER}`]);
});

test('command output is redacted (stored PAT, ghp_ token, secret env value) and a failure is an error with the tail', async () => {
  fake.script = argv => (argv[1] === 'cache:clear' ? { exitCode: 3, output: `token ${GITHUB_TOKEN}\nalso ghp_${'a1B2'.repeat(9)}\nenv geheimer-wert-123\nboom` } : undefined);
  const r = await call('run_command', { command: 'cache-clear' });
  fake.script = () => undefined;
  assert.equal(r.error, true);
  for (const s of [GITHUB_TOKEN, `ghp_${'a1B2'.repeat(9)}`, 'geheimer-wert-123']) assert.ok(!r.text.includes(s), s);
  assert.match(r.text, /Exit-Code 3[\s\S]*boom/);
  const ev = events.filter(e => e.t === 'command').at(-1)!;
  assert.ok(ev.t === 'command' && ev.status === 'failed' && ev.exitCode === 3 && !ev.tail!.includes('geheimer'));
  assert.notEqual(events.at(-1)?.t, 'preview_reload', 'no reload after a failure');
});

test('git_diff shows the changes against the base branch, never secret files', async () => {
  fs.writeFileSync(path.join(T.taskPaths(task.id).worktree, '.env'), 'APP_SECRET=changed\n'); // changed outside the tools
  const d = await call('git_diff');
  assert.ok(d.text.includes(`added ${HEADER} (+2 −0)`), d.text);
  assert.match(d.text, /Gratis Versand/);
  assert.doesNotMatch(d.text, /APP_SECRET|\.env/);
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

test('get_environment: variable names without values, own commands, allow-listed command ids', async () => {
  const r = await call('get_environment');
  const env = JSON.parse(r.text);
  assert.deepEqual(env.envVars, [{ key: 'API_TOKEN', secret: true }, { key: 'APP_ENV', secret: false }]);
  assert.ok(!r.text.includes('geheimer-wert-123') && !r.text.includes('"dev"'));
  assert.equal(env.containerPath, PLUGIN_DIR);
  assert.deepEqual(env.commands.map((c: { id: string }) => c.id), ['theme-compile', 'cache-clear', 'plugin-refresh', 'theme-refresh', 'lint-twig', 'php-lint']);
});

test('ask_user and propose_publish: question to the host, card event only', async () => {
  assert.match((await call('ask_user', { question: 'Grün?', options: [{ label: 'Ja' }] })).text, /"answer": "Ja"/);
  await call('propose_publish', { title: 'Header: Gratis Versand', body: `Prüfung in der Vorschau. ${GITHUB_TOKEN}` });
  const ev = events.at(-1)!;
  assert.ok(ev.t === 'publish_proposal' && ev.title === 'Header: Gratis Versand' && !ev.body.includes(GITHUB_TOKEN));
});

test('a paused task is woken by run_command (no new setup)', async () => {
  await J.pauseTask(task.id);
  const installs = () => execs().filter(a => a[1] === 'plugin:install').length, before = installs();
  const r = await call('run_command', { command: 'theme-compile' });
  assert.equal(r.error, false, r.text);
  assert.equal(T.getTask(task.id)!.status, 'ready');
  assert.equal(installs(), before, 'no setup step again');
});
