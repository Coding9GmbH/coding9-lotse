import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../isolate-data';
import type { ConsoleEvent } from '@/lib/protocol';
import { sandboxForTests } from '../support/sandbox-task';
/* eslint-disable @typescript-eslint/no-explicit-any -- route context and audit rows as loose JSON */

// Console of a sandbox (tab "Konsole") against FakeRunner's echo shell: the template's shell as "dockware" in the shop root, the
// NDJSON stream with replay after a reload, input/resize by POST, limits, bound to task and actor, at most three, closed by the user,
// when idle, with pause/finish/a new setup/switching off, orphans after a restart; audit without keystrokes; never an AI tool.
const S = await sandboxForTests();
const { fake, J, T, E, until, readyTask } = S;
const C = await import('../../src/server/sandbox/console');
const R = await import('../../src/server/sandbox/reconcile');
const { CONSOLE, CONSOLE_PROCS, CONSOLE_SUDOERS } = await import('../../src/server/sandbox/templates/dockware');
const { SANDBOX_TOOL_NAMES, sandboxToolNames } = await import('../../src/server/sandbox/workspace-tools');
const db = await import('../../src/server/db');
const listRoute = await import('../../src/app/api/sandbox/tasks/[id]/console/route');
const sessionRoute = await import('../../src/app/api/sandbox/tasks/[id]/console/[session]/route');
after(async () => { R.resetReconcile(); await S.close(); });

const URL_ = (id: string, sid?: string) => `http://127.0.0.1:3333/api/sandbox/tasks/${id}/console${sid ? `/${sid}` : ''}`;
const auth = (user: string | null): Record<string, string> => (user ? { authorization: `Basic ${Buffer.from(`${user}:pw`).toString('base64')}` } : {});
const ctx = (id: string, session?: string) => ({ params: Promise.resolve({ id, session: session ?? '' }) }) as any;
const open = (id: string, size: unknown = { cols: 120, rows: 40 }, user: string | null = null) =>
  listRoute.POST(new Request(URL_(id), { method: 'POST', headers: { 'content-type': 'application/json', 'x-lotse': '1', ...auth(user) }, body: JSON.stringify(size) }), ctx(id));
const send = (id: string, sid: string, body: unknown, user: string | null = null) =>
  sessionRoute.POST(new Request(URL_(id, sid), { method: 'POST', headers: { 'content-type': 'application/json', 'x-lotse': '1', ...auth(user) }, body: JSON.stringify(body) }), ctx(id, sid));
const remove = (id: string, sid: string, user: string | null = null) => sessionRoute.DELETE(new Request(URL_(id, sid), { method: 'DELETE', headers: { 'x-lotse': '1', ...auth(user) } }), ctx(id, sid));

/** Reads the NDJSON stream of a console in the background: decoded output text and the end event. */
async function watch(id: string, sid: string, from = 0, user: string | null = null) {
  const ac = new AbortController();
  const r = await sessionRoute.GET(new Request(`${URL_(id, sid)}?from=${from}`, { signal: ac.signal, headers: auth(user) }), ctx(id, sid));
  const view = { status: r.status, text: '', seqs: [] as number[], end: null as ConsoleEvent | null, stop: () => ac.abort() };
  if (r.status !== 200) return view;
  void (async () => {
    const reader = r.body!.getReader(), dec = new TextDecoder();
    let rest = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += dec.decode(value, { stream: true });
        let i;
        while ((i = rest.indexOf('\n')) >= 0) {
          const ev = JSON.parse(rest.slice(0, i)) as ConsoleEvent; rest = rest.slice(i + 1);
          if (ev.t === 'out') { view.text += Buffer.from(ev.data, 'base64').toString('utf8'); view.seqs.push(ev.seq); } else view.end = ev;
        }
      }
    } catch { /* aborted */ }
  })();
  return view;
}
const audits = () => db.auditList().map(a => a as any).filter(a => a.kind === 'sandbox-task' && a.action === 'console').reverse(); // oldest first

test('open: the template shell as dockware in the shop root (root wrapper, pid file, TERM), stream, input, resize, reconnect replays', async () => {
  const t = await readyTask('Konsole');
  const r = await open(t.id);
  assert.equal(r.status, 200);
  const { session } = await r.json() as { session: { id: string; cols: number; rows: number } };
  assert.match(session.id, /^[a-f0-9]{24}$/);
  assert.deepEqual([session.cols, session.rows], [120, 40]);
  const tty = fake.ttys.at(-1)!;
  assert.deepEqual(tty.argv, CONSOLE.start(session.id).argv);
  assert.deepEqual([tty.opts.user, tty.opts.workdir, tty.opts.cols, tty.opts.rows], ['root', '/var/www/html', 120, 40], 'the wrapper starts as root and drops to dockware');
  assert.ok(tty.opts.env.includes('TERM=xterm-256color'));
  assert.equal(fake.calls.findLast(c => c.op === 'openTty')!.id, t.containerId, 'the task container, nothing else');

  const v = await watch(t.id, session.id);
  assert.equal(v.status, 200);
  await until(() => v.text.includes('dockware@lotse-'));
  assert.equal((await send(t.id, session.id, { input: 'bin/console plugin:list\r' })).status, 204);
  await until(() => v.text.includes('AcmeTheme'));
  assert.equal((await send(t.id, session.id, { resize: { cols: 100, rows: 30 } })).status, 204);
  assert.deepEqual(fake.calls.findLast(c => c.op === 'ttyResize')!.detail, { cols: 100, rows: 30 });
  await send(t.id, session.id, { input: 'stty size\r' });
  await until(() => v.text.includes('30 100'));
  // a reload: the list names the session, ?from=0 replays what was shown (prompt, plugin list), ?from=n only the rest
  const list = await (await listRoute.GET(new Request(URL_(t.id)), ctx(t.id))).json() as { sessions: { id: string }[]; max: number };
  assert.deepEqual(list.sessions.map(s => s.id), [session.id]);
  assert.equal(list.max, 3);
  const again = await watch(t.id, session.id, 0);
  await until(() => again.text.includes('30 100'));
  assert.ok(again.text.includes('AcmeTheme') && again.text.startsWith(v.text.slice(0, 20)));
  v.stop(); again.stop(); // at most two views per session
  const later = await watch(t.id, session.id, v.seqs.at(-1)!);
  await until(() => later.seqs.length > 0);
  assert.equal(later.seqs[0], v.seqs.at(-1));
  later.stop();
  assert.deepEqual(audits().filter(a => a.taskId === t.id).map(a => a.event), ['open']);
  assert.ok(!JSON.stringify(audits()).includes('plugin:list'), 'no keystrokes in the audit');
  await J.finishTask(t.id);
});

test('limits: size validated, input at most 64 KB, at most three per task, unknown or foreign sessions are not found', async () => {
  const t = await readyTask('Grenzen');
  for (const bad of [{ cols: 5, rows: 40 }, { cols: 120, rows: 999 }, { cols: 1.5, rows: 10 }, { cols: 80 }]) assert.equal((await open(t.id, bad)).status, 400, JSON.stringify(bad));
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await open(t.id); assert.equal(r.status, 200); ids.push((await r.json() as any).session.id); }
  const fourth = await open(t.id);
  assert.equal(fourth.status, 409);
  assert.match((await fourth.json() as any).error, /Höchstens 3 Konsolen/);
  assert.equal((await send(t.id, ids[0], { input: 'x'.repeat(64 * 1024 + 1) })).status, 413);
  assert.equal((await send(t.id, ids[0], { input: 'ä'.repeat(40 * 1024) })).status, 413, 'counted in bytes');
  assert.equal((await send(t.id, ids[0], { input: 1 })).status, 400);
  assert.equal((await send(t.id, ids[0], { resize: { cols: 100, rows: 1 } })).status, 400);
  assert.equal((await send(t.id, 'f'.repeat(24), { input: 'ls\r' })).status, 404);
  assert.equal((await send(t.id, '../../x', { input: 'ls\r' })).status, 404);
  // another task's id with this session: not found; another login: not found and not listed
  const u = await readyTask('Andere');
  assert.equal((await send(u.id, ids[0], { input: 'ls\r' })).status, 404);
  process.env.LOTSE_PASSWORD = 'pw';
  try {
    assert.equal((await send(t.id, ids[0], { input: 'ls\r' }, 'mallory')).status, 404);
    assert.equal((await watch(t.id, ids[0], 0, 'mallory')).status, 404);
    assert.equal((await remove(t.id, ids[0], 'mallory')).status, 404);
    assert.deepEqual((await (await listRoute.GET(new Request(URL_(t.id), { headers: auth('mallory') }), ctx(t.id))).json() as any).sessions, []);
    assert.equal((await open(t.id, undefined, 'mallory')).status, 409, 'the limit counts every user');
  } finally { delete process.env.LOTSE_PASSWORD; }
  await J.finishTask(t.id); await J.finishTask(u.id);
});

test('close by the user: the template stop command as root ends the shell session, the stream says why, audited', async () => {
  const t = await readyTask('Schließen');
  const sid = (await (await open(t.id)).json() as any).session.id as string;
  const v = await watch(t.id, sid);
  await until(() => v.text.length > 0);
  const n = fake.calls.length;
  assert.equal((await remove(t.id, sid)).status, 200);
  const kill = fake.calls.slice(n).find(c => c.op === 'exec')!;
  assert.deepEqual([kill.id, kill.user, kill.argv], [t.containerId, 'root', CONSOLE.stop(sid).argv]);
  assert.equal(fake.ttys.at(-1)!.alive, false);
  await until(() => v.end !== null);
  assert.deepEqual(v.end, { t: 'end', reason: 'user' });
  // a view that reconnects after the end learns why instead of a bare 404
  const late = await watch(t.id, sid);
  await until(() => late.end !== null);
  assert.deepEqual(late.end, { t: 'end', reason: 'user' });
  assert.equal((await send(t.id, sid, { input: 'ls\r' })).status, 404);
  assert.deepEqual(audits().filter(a => a.taskId === t.id).map(a => [a.event, a.reason ?? null, a.user]), [['open', null, 'dockware'], ['close', 'user', 'dockware']], 'both rows name the shell user');
  // the shell ending by itself ("exit")
  const sid2 = (await (await open(t.id)).json() as any).session.id as string;
  const v2 = await watch(t.id, sid2);
  await send(t.id, sid2, { input: 'exit\r' });
  await until(() => v2.end !== null);
  assert.deepEqual(v2.end, { t: 'end', reason: 'exit' });
  assert.equal(C.consoleCount(t.id), 0);
  await J.finishTask(t.id);
});

test('idle: no input for 30 minutes closes the console (shell ended); input counts as activity for the sandbox', async () => {
  const t = await readyTask('Leerlauf');
  const sid = (await (await open(t.id)).json() as any).session.id as string;
  const before = T.getTask(t.id)!;
  before.lastActiveAt = new Date(Date.now() - 3600_000).toISOString(); T.saveTask(before, false);
  await send(t.id, sid, { input: 'pwd\r' });
  assert.ok(Date.now() - Date.parse(T.getTask(t.id)!.lastActiveAt) < 5000, 'input touches the task');
  assert.deepEqual(await C.sweepConsoles(Date.now() + 29 * 60_000), []);
  assert.deepEqual(await C.sweepConsoles(Date.now() + 31 * 60_000), [sid]);
  assert.equal(C.consoleCount(t.id), 0);
  assert.ok(fake.calls.some(c => c.op === 'exec' && c.argv?.includes(sid) && c.user === 'root'));
  assert.equal(audits().findLast(a => a.taskId === t.id)!.reason, 'idle');
  await J.finishTask(t.id);
});

test('lifecycle: pause closes (no stop command needed), opening wakes a paused sandbox, finish and switching off close, a new setup too', async () => {
  const t = await readyTask('Lebenszyklus');
  const sid = (await (await open(t.id)).json() as any).session.id as string;
  const v = await watch(t.id, sid);
  const n = fake.calls.length;
  await J.pauseTask(t.id);
  await until(() => v.end !== null);
  assert.deepEqual(v.end, { t: 'end', reason: 'pause' });
  assert.ok(!fake.calls.slice(n).some(c => c.op === 'exec' && c.argv?.includes(sid)), 'the stop ends it anyway');
  assert.equal(T.getTask(t.id)!.status, 'paused');
  // opening wakes it (start, wait, sync) and then starts the shell
  const r = await open(t.id);
  assert.equal(r.status, 200);
  assert.equal(T.getTask(t.id)!.status, 'ready');
  assert.equal(fake.containers.get(T.getTask(t.id)!.containerId!)!.running, true);
  const sid2 = (await r.json() as any).session.id as string;
  // a new setup ("Einrichtung erneut") closes and ends the shells first
  const w = await watch(t.id, sid2);
  J.runSteps(t.id, 'theme-compile');
  await until(() => w.end !== null);
  assert.deepEqual(w.end, { t: 'end', reason: 'restart' });
  await until(() => !J.setupRunning(t.id));
  // switching off
  const sid3 = (await (await open(t.id)).json() as any).session.id as string;
  const x = await watch(t.id, sid3);
  await J.suspendAll();
  await until(() => x.end !== null);
  assert.deepEqual(x.end, { t: 'end', reason: 'disabled' });
  // finish
  await J.startWake(t.id); await J.ensureAwake(t.id);
  const sid4 = (await (await open(t.id)).json() as any).session.id as string;
  const y = await watch(t.id, sid4);
  await J.finishTask(t.id);
  await until(() => y.end !== null);
  assert.deepEqual(y.end, { t: 'end', reason: 'finish' });
  assert.equal((await open(t.id)).status, 409, 'finished: no console');
  assert.equal(C.consoleCount(t.id), 0);
  E.saveSandbox({ enabled: false });
  try { assert.equal((await open(t.id)).status, 403); } finally { E.saveSandbox({ enabled: true }); }
});

test('after a Lotse restart: shells nobody holds are ended in every running task container, audited without a user', async () => {
  const t = await readyTask('Neustart');
  // a shell from before the restart: running in the container, unknown to this process
  const orphan = await fake.openTty(t.containerId!, CONSOLE.start('0123456789abcdef01234567').argv, { user: 'root', workdir: CONSOLE.workdir, env: CONSOLE.env, cols: 80, rows: 24 });
  let gone = false; orphan.onEnd(() => { gone = true; });
  const n = fake.calls.length;
  assert.equal(await C.killOrphanConsoles(), 1);
  const kill = fake.calls.slice(n).find(c => c.op === 'exec' && c.id === t.containerId)!;
  assert.deepEqual([kill.user, kill.argv], ['root', CONSOLE.stopAll.argv]);
  assert.ok(gone);
  assert.deepEqual(audits().filter(a => a.taskId === t.id).map(a => [a.event, a.reason, a.shells, a.user]), [['close', 'lotse-restart', 1, 'dockware']]);
  assert.equal(await C.killOrphanConsoles(), 0, 'nothing left: no audit');
  assert.equal(audits().filter(a => a.taskId === t.id).length, 1);
  await J.pauseTask(t.id);
  assert.equal(await C.killOrphanConsoles(), 0, 'not in stopped containers');
  await J.finishTask(t.id);
});

test('human only: no AI tool and no MCP tool for the console; the agent prompt only mentions the tab', async () => {
  const names = [...SANDBOX_TOOL_NAMES, ...sandboxToolNames('codex')];
  assert.ok(!names.some(n => /console|terminal|shell|tty/i.test(n)), names.join(', '));
  for (const f of ['workspace-tools.ts', 'native-tools.ts', 'offer-tool.ts']) assert.doesNotMatch(fs.readFileSync(path.join('src/server/sandbox', f), 'utf8'), /from '\.\/console'|openTty/, f);
  assert.doesNotMatch(fs.readFileSync('src/server/tools.ts', 'utf8'), /sandbox\/console|openTty/);
  assert.match(fs.readFileSync('prompts/code/01-common.md', 'utf8'), /Reiter „Konsole“/);
});

test('dockware wrapper: root writes rc and pid file into a root-owned directory, drops to dockware, reads nothing uid 33 can write', () => {
  const sid = '0123456789abcdef01234567', start = CONSOLE.start(sid), [script, , arg, rc] = start.argv.slice(2);
  assert.equal(start.user, 'root');
  assert.equal(arg, sid);
  assert.match(script, /\[ "\$\(stat -c %u "\$d"\)" = 0 \]/, 'the pid directory must belong to root');
  assert.match(script, /exec env -u BASH_ENV -u ENV .*setpriv --reuid="\$u" --regid="\$g" --groups="\$gs" bash --noprofile --rcfile "\$d\/bashrc" -i$/);
  assert.match(script, /INPUTRC=\/etc\/inputrc/);
  assert.doesNotMatch(script, /bash -l|\/tmp\//);
  assert.match(rc, /unset BASH_ENV HISTFILE/);
  assert.doesNotMatch(rc.replace(/^#.*$/gm, '').replace(/nvm\(\) \{[^\n]*\}/, ''), /\/var\/www|~|\$HOME/, 'only system-wide files at start; nvm loads when typed');
  // stop only ends the session whose pid and start time root recorded
  for (const argv of [CONSOLE.stop(sid).argv, CONSOLE.stopAll.argv]) {
    assert.match(argv[2], /\/run\/lotse-console\//);
    assert.match(argv[2], /\[ "\$\{20\}" = "\$t" \]/);
    assert.match(argv[2], /freeze "\$p"; .*sig KILL/, 'the whole process tree, frozen first');
    assert.doesNotMatch(argv[2], /pkill -s/, 'not just the session: sudo (use_pty) runs its command in a new one');
  }
  // the prompt names the console user and the full shop directory, as the tab and the audit do
  assert.match(rc, /^PS1='.*dockware@\\h.*\$PWD.*'$/m);
  // the sudo audit warning: allowed commands of the sudo group are not logged (nowhere to log to), checked by visudo before use
  assert.equal(CONSOLE_SUDOERS, 'Defaults:%sudo !log_allowed');
  assert.match(script, /visudo -cqf "\$d\/sudoers" && mv -f "\$d\/sudoers" "\$c"/);
  assert.doesNotMatch(script, /use_pty|!syslog|AUDIT/);
});

test('dockware stop: the console\'s whole process tree is found (also children in a new session, like sudo with use_pty) and killed', { skip: process.platform !== 'linux' }, async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  // a "console": session leader sh with a job in its session, a job in a new session (setsid, like sudo's command) and a daemon
  // that detaches completely (double fork) – that one is not the console's any more and stays
  const leader = spawn('setsid', ['sh', '-c', 'sleep 300 & setsid sleep 301 & (setsid sleep 302 &); wait'], { stdio: 'ignore' });
  const pids = (pat: string) => execFileSync('sh', ['-c', `pgrep -f '^sleep ${pat}$' || :`]).toString().split(/\s+/).filter(Boolean);
  await until(() => pids('30[012]').length === 3);
  const session = execFileSync('sh', ['-c', `ps -o sid= -p ${pids('300')[0]}`]).toString().trim();
  const found = execFileSync('sh', ['-c', `${CONSOLE_PROCS}; procs "$1" ""`, 'sh', session]).toString().trim().split(' ').map(x => x.split(':')[0]);
  for (const p of [...pids('300'), ...pids('301')]) assert.ok(found.includes(p), `sleep ${p} belongs to the console`);
  for (const p of pids('302')) assert.ok(!found.includes(p), 'a detached daemon is left alone');
  const stop = CONSOLE.stop('0'.repeat(24)).argv[2], kill = stop.slice(0, stop.indexOf('; f='));
  execFileSync('sh', ['-c', `${kill}; a=; freeze "$1"; sig KILL`, 'sh', session]);
  await until(() => pids('30[01]').length === 0);
  assert.equal(pids('302').length, 1);
  for (const p of pids('302')) process.kill(Number(p), 'SIGKILL');
  leader.kill('SIGKILL');
});

test('dockware stop: a process name with a newline neither hides a console process nor adds an unrelated one', { skip: process.platform !== 'linux' }, async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  const victim = spawn('sleep', ['304'], { stdio: 'ignore' }); // not the console's
  // the console's sh renames itself so that its stat line splits into "<pid> (" and a forged "<victim> (x) S <ppid> <pgrp> <session> …"
  const leader = spawn('setsid', ['sh', '-c', `printf '\\n%s (x' ${victim.pid} > /proc/$$/comm; sleep 303; :`], { stdio: 'ignore' });
  try {
    await until(() => { try { return execFileSync('cat', [`/proc/${leader.pid}/stat`]).toString().includes('\n'); } catch { return false; } });
    const session = execFileSync('sh', ['-c', `ps -o sid= -p ${leader.pid}`]).toString().trim();
    const found = execFileSync('sh', ['-c', `${CONSOLE_PROCS}; procs "$1" ""`, 'sh', session]).toString().trim().split(' ');
    assert.ok(found.every(x => /^\d+:\d+$/.test(x)), found.join(' '));
    const ids = found.map(x => x.split(':')[0]);
    assert.ok(ids.includes(String(leader.pid)), 'the renamed console process is found by its real pid');
    assert.ok(!ids.includes(String(victim.pid)), 'the forged pid is not');
  } finally {
    victim.kill('SIGKILL');
    execFileSync('sh', ['-c', `pkill -9 -s ${leader.pid} || :`]);
  }
});

test('flow control: output capped per second (socket paused, then resumed), a view that falls behind is dropped, at most two views', async () => {
  const t = await readyTask('Flut');
  const sid = (await (await open(t.id)).json() as any).session.id as string;
  const tty = fake.ttys.at(-1)!;
  const a = await watch(t.id, sid), b = await watch(t.id, sid);
  await until(() => a.text.length > 0 && b.text.length > 0);
  const third = await sessionRoute.GET(new Request(`${URL_(t.id, sid)}?from=0`), ctx(t.id, sid));
  assert.equal(third.status, 409);
  a.stop(); b.stop();
  // a view nobody reads: more than its queue fits -> its stream closes (without an end event), the session lives on
  const slow = await sessionRoute.GET(new Request(`${URL_(t.id, sid)}?from=0`), ctx(t.id, sid));
  assert.equal(slow.status, 200);
  await send(t.id, sid, { input: `yes | head -c ${3 * 1024 * 1024}\r` });
  await until(() => tty.paused === true);
  const reader = slow.body!.getReader(), dec = new TextDecoder();
  let text = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  assert.ok(!text.includes('"t":"end"'), 'dropped, not ended');
  assert.equal(C.consoleCount(t.id), 1);
  await until(() => tty.paused === false, 3000); // resumed after the rest of the second
  // reconnecting from the last chunk gets the end of the output, from the buffer
  const again = await watch(t.id, sid, 1);
  await until(() => again.seqs.length > 0);
  assert.ok(again.seqs[0] > 1, 'what fell out of the buffer is skipped');
  again.stop();
  await J.finishTask(t.id);
});

test('lifecycle races: a console still starting when the sandbox is paused is closed with that reason; a failed stop ends the shells', async () => {
  const t = await readyTask('Rennen');
  const orig = fake.openTty.bind(fake);
  let release!: () => void;
  const gate = new Promise<void>(res => { release = res; });
  fake.openTty = async (...args: Parameters<typeof orig>) => { const r = await orig(...args); await gate; return r; };
  try {
    const opening = open(t.id);
    await until(() => fake.calls.some(c => c.op === 'openTty' && c.id === t.containerId));
    const paused = J.pauseTask(t.id);
    await until(() => T.getTask(t.id)!.status === 'paused');
    release();
    const r = await opening;
    assert.equal(r.status, 409);
    await paused;
    assert.equal(C.consoleCount(t.id), 0);
    assert.equal(fake.ttys.at(-1)!.alive, false);
    assert.equal(audits().findLast(a => a.taskId === t.id)!.reason, 'pause');
  } finally { fake.openTty = orig; }
  // docker stop fails: the shells the pause did not end are ended with the template's stopAll
  const u = await readyTask('Stopp scheitert');
  await open(u.id);
  const tty = fake.ttys.at(-1)!;
  fake.failNext = { op: 'stop', message: 'Timeout' };
  const n = fake.calls.length;
  await J.pauseTask(u.id).catch(() => {});
  assert.equal(tty.alive, false);
  assert.ok(fake.calls.slice(n).some(c => c.op === 'exec' && c.user === 'root' && JSON.stringify(c.argv) === JSON.stringify(CONSOLE.stopAll.argv)));
  await J.finishTask(t.id); await J.finishTask(u.id);
});
