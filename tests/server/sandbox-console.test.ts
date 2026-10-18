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
const { CONSOLE } = await import('../../src/server/sandbox/templates/dockware');
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

test('open: the template shell as dockware in the shop root (TERM, login shell, pid file), stream, input, resize, reconnect replays', async () => {
  const t = await readyTask('Konsole');
  const r = await open(t.id);
  assert.equal(r.status, 200);
  const { session } = await r.json() as { session: { id: string; cols: number; rows: number } };
  assert.match(session.id, /^[a-f0-9]{24}$/);
  assert.deepEqual([session.cols, session.rows], [120, 40]);
  const tty = fake.ttys.at(-1)!;
  const pidFile = `/tmp/.lotse-console-${session.id}.pid`;
  assert.deepEqual(tty.argv, ['bash', '-c', 'echo $$ > "$0" && exec bash -l', pidFile]);
  assert.deepEqual([tty.opts.user, tty.opts.workdir, tty.opts.cols, tty.opts.rows], ['dockware', '/var/www/html', 120, 40]);
  assert.ok(tty.opts.env.includes('TERM=xterm-256color'));
  assert.equal(fake.calls.findLast(c => c.op === 'openTty')!.id, t.containerId, 'the task container, nothing else');

  const v = await watch(t.id, session.id);
  assert.equal(v.status, 200);
  await until(() => v.text.includes('www-data@sandbox'));
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
  const later = await watch(t.id, session.id, v.seqs.at(-1)!);
  await until(() => later.seqs.length > 0);
  assert.equal(later.seqs[0], v.seqs.at(-1));
  for (const x of [v, again, later]) x.stop();
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
  assert.deepEqual([kill.id, kill.user, kill.argv], [t.containerId, 'root', CONSOLE.stop(`/tmp/.lotse-console-${sid}.pid`).argv]);
  assert.equal(fake.ttys.at(-1)!.alive, false);
  await until(() => v.end !== null);
  assert.deepEqual(v.end, { t: 'end', reason: 'user' });
  // a view that reconnects after the end learns why instead of a bare 404
  const late = await watch(t.id, sid);
  await until(() => late.end !== null);
  assert.deepEqual(late.end, { t: 'end', reason: 'user' });
  assert.equal((await send(t.id, sid, { input: 'ls\r' })).status, 404);
  assert.deepEqual(audits().filter(a => a.taskId === t.id).map(a => [a.event, a.reason ?? null]), [['open', null], ['close', 'user']]);
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
  assert.ok(fake.calls.some(c => c.op === 'exec' && c.argv?.includes(`/tmp/.lotse-console-${sid}.pid`)));
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
  assert.ok(!fake.calls.slice(n).some(c => c.op === 'exec' && c.argv?.some(a => a.includes('.lotse-console-'))), 'the stop ends it anyway');
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
  const orphan = await fake.openTty(t.containerId!, CONSOLE.shell('/tmp/.lotse-console-0123456789abcdef01234567.pid'), { user: CONSOLE.user, workdir: CONSOLE.workdir, env: CONSOLE.env, cols: 80, rows: 24 });
  let gone = false; orphan.onEnd(() => { gone = true; });
  const n = fake.calls.length;
  assert.equal(await C.killOrphanConsoles(), 1);
  const kill = fake.calls.slice(n).find(c => c.op === 'exec' && c.id === t.containerId)!;
  assert.deepEqual([kill.user, kill.argv], ['root', CONSOLE.stopAll.argv]);
  assert.ok(gone);
  assert.deepEqual(audits().filter(a => a.taskId === t.id).map(a => [a.event, a.reason, a.shells]), [['close', 'lotse-restart', 1]]);
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
