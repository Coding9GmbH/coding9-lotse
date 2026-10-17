// Live check of a sandbox in a normal chat, end to end through a RUNNING Lotse server (next dev) with the real Docker daemon and
// dockware/shopware, and the scripted model (anthropic-fake) instead of Claude: the real Claude Code process edits the theme's header
// template with its own Read/Edit tools in the worktree, runs `bin/console theme:compile` with sandbox_bash inside the container,
// and the changed header text then appears in the /sbx preview. Also checks that the container has no internet (curl in the container
// fails) while Lotse reaches its storefront over the internal network lotse-sandbox.
//
//   LOTSE_DOCKWARE_LIVE=1 npx tsx tests/support/dockware-live/verify-agent.ts
//   Optional: LOTSE_DOCKWARE_IMAGE (default dockware/shopware:6.7.15.1, must be pulled), LOTSE_LIVE_PORT (default 3491), VERBOSE=1.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatEvent, CodeTaskPublic } from '@/lib/protocol';
import { HEADER_TEMPLATE, headerTemplate, makePluginRepo } from '../plugin-repo';
import { startFakeAnthropic } from '../anthropic-fake/server';
import { startFakeGithub } from '../github-fake';

if (process.env.LOTSE_DOCKWARE_LIVE !== '1') { console.log('Übersprungen: LOTSE_DOCKWARE_LIVE=1 setzen (startet echte Docker-Container).'); process.exit(0); }
const TOKEN = `github_pat_${'L1veCheck42'.repeat(8)}_abc`;
const port = Number(process.env.LOTSE_LIVE_PORT ?? 3491), base = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-agent-live-'));
const repo = makePluginRepo(tmp, { theme: true, name: 'LotseLiveTheme', repo: 'acme/live-theme', files: { [HEADER_TEMPLATE]: headerTemplate('Lotse Live-Header') } });
const ai = await startFakeAnthropic({ quiet: process.env.VERBOSE !== '1' });
const gh = await startFakeGithub({ token: TOKEN, repos: [{ fullName: 'acme/live-theme' }] });
const TEXT = 'Gratis Versand ab 50 € – Lotse live';

const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LOTSE_|AICB_|AI_|CLAUDE_|ANTHROPIC_|SHOPWARE_|SHOPIFY_|HOSTNAME$|HOST$)/.test(k)));
const server = spawn(process.execPath, [path.join(process.cwd(), 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  env: { ...inherited, AICB_DATA: path.join(tmp, 'data'), ANTHROPIC_BASE_URL: ai.url, ANTHROPIC_API_KEY: 'sk-ant-live-fake-key', AI_PROVIDER: 'claude',
    LOTSE_GITHUB_API_BASE: gh.base, LOTSE_GITHUB_CLONE_BASE: `file://${repo.remoteBase}`, LOTSE_TEST_FILE_REMOTES: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', NEXT_TELEMETRY_DISABLED: '1' } as unknown as NodeJS.ProcessEnv,
  stdio: process.env.VERBOSE === '1' ? 'inherit' : 'ignore',
});
const H = { 'content-type': 'application/json', 'x-lotse': '1' };
const api = async <T>(p: string, init: RequestInit = {}): Promise<T> => {
  const r = await fetch(base + p, { ...init, headers: { ...H, ...init.headers } });
  const body = await r.text();
  if (!r.ok) throw new Error(`${init.method ?? 'GET'} ${p}: HTTP ${r.status} ${body.slice(0, 300)}`);
  return (body ? JSON.parse(body) : null) as T;
};
const until = async (fn: () => Promise<boolean>, ms: number, what: string) => { const end = Date.now() + ms; while (!(await fn().catch(() => false))) { if (Date.now() > end) throw new Error(`Zeitüberschreitung: ${what}`); await new Promise(r => setTimeout(r, 1000)); } };
/** One chat turn over POST /api/chat (NDJSON) until `done`. */
async function turn(chatId: string, message: string): Promise<ChatEvent[]> {
  const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ chatId, message }) });
  assert.equal(r.status, 200, await r.clone().text());
  const events = (await r.text()).split('\n').filter(Boolean).map(l => JSON.parse(l) as ChatEvent);
  if (process.env.VERBOSE === '1') console.log(events.filter(e => !['text', 'text_start'].includes(e.t)));
  return events;
}

let taskId = '';
try {
  const t0 = Date.now();
  await until(async () => (await fetch(`${base}/api/health`)).ok, 180_000, 'Lotse startet');
  console.log(`Lotse (next dev) läuft auf ${base}`);
  await api('/api/github', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) });
  await api('/api/sandbox/env', { method: 'PUT', body: JSON.stringify({ enabled: true, image: process.env.LOTSE_DOCKWARE_IMAGE ?? 'dockware/shopware:6.7.15.1' }) });

  // a normal chat, then "Sandbox starten" for it
  const chatId = crypto.randomUUID();
  const { task } = await api<{ task: CodeTaskPublic }>('/api/sandbox/tasks', { method: 'POST', body: JSON.stringify({ chatId, repo: 'acme/live-theme', baseBranch: 'main' }) });
  taskId = task.id;
  assert.equal(task.chatId, chatId);
  let cur = task;
  await until(async () => { cur = (await api<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${taskId}`)).task; return cur.status !== 'setting_up'; }, 15 * 60_000, 'Einrichtung');
  assert.equal(cur.status, 'ready', cur.error ?? '');
  console.log(`Einrichtung fertig nach ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const chat = await api<{ taskId?: string }>(`/api/chats/${chatId}`);
  assert.equal(chat.taskId, taskId, 'the chat carries its sandbox');

  // the container: only the internal network, no published port
  const inspect = JSON.parse(execFileSync('docker', ['inspect', `lotse-sbx-${taskId.replace(/_/g, '-')}`], { encoding: 'utf8' }))[0];
  assert.deepEqual(Object.keys(inspect.NetworkSettings.Networks), ['lotse-sandbox']);
  assert.equal(JSON.parse(execFileSync('docker', ['network', 'inspect', 'lotse-sandbox'], { encoding: 'utf8' }))[0].Internal, true);
  assert.deepEqual(inspect.HostConfig.PortBindings ?? {}, {});
  console.log(`Container nur im internen Netzwerk lotse-sandbox (${inspect.NetworkSettings.Networks['lotse-sandbox'].IPAddress}), kein veröffentlichter Port ✓`);

  const page = async () => { const r = await fetch(`${base}${cur.preview}/`); return { status: r.status, html: await r.text() }; };
  const before = await page();
  assert.equal(before.status, 200);
  assert.ok(before.html.includes('Lotse Live-Header') && !before.html.includes(TEXT), 'the original header in the preview');

  const a = Date.now();
  const seen = await turn(chatId, `Bitte umsetzen. [e2e:replace ${HEADER_TEMPLATE} Lotse Live-Header|${TEXT}] [e2e:bash bin/console theme:compile]`);
  const end = seen.at(-1);
  console.log('Ereignisse:', seen.filter(e => !['text', 'text_start'].includes(e.t)).map(e => (e.t === 'command' ? `command:${e.status}${e.ms ? ` ${(e.ms / 1000).toFixed(1)} s` : ''}` : e.t === 'tool' ? `tool:${e.name}` : e.t)).join(', '));
  assert.ok(end?.t === 'done' && !end.error, JSON.stringify(end));
  assert.ok(seen.some(e => e.t === 'tool' && e.name === 'Edit'), 'native Edit');
  assert.ok(seen.some(e => e.t === 'file_change' && e.path === HEADER_TEMPLATE && e.kind === 'edit'), 'file card');
  assert.ok(seen.some(e => e.t === 'command' && e.status === 'ok' && e.command === 'bin/console theme:compile'), 'theme compiled via sandbox_bash');
  assert.ok(seen.some(e => e.t === 'preview_reload'), 'preview reload');
  console.log(`KI-Runde (Fake-Modell, echter Claude-Code-Prozess, natives Edit + sandbox_bash) ${((Date.now() - a) / 1000).toFixed(1)} s`);

  const after = await page();
  assert.equal(after.status, 200);
  assert.ok(after.html.includes(TEXT), 'header text in the /sbx preview');
  console.log(`/sbx-Vorschau zeigt den neuen Header-Text ✓ (${after.html.length} Bytes)`);

  // no egress: the agent's own command inside the container cannot reach the internet
  const net = await turn(chatId, '[e2e:bash curl -sS -m 5 https://example.com -o /dev/null; echo "rc=$?"]');
  const out = net.filter(e => e.t === 'command').at(-1);
  assert.ok(out?.t === 'command' && /rc=(6|7|28)\b/.test(out.tail ?? ''), JSON.stringify(out));
  console.log(`curl https://example.com im Container: ${out.tail?.split('\n').slice(-2).join(' | ')} ✓ (kein Internet)`);

  await api(`/api/sandbox/tasks/${taskId}/finish`, { method: 'POST', body: '{}' });
  assert.equal((await api<{ taskId?: string }>(`/api/chats/${chatId}`)).taskId, undefined, 'detached, the chat stays');
  taskId = '';
  console.log('Aufgabe abgeschlossen: Container entfernt, Chat bleibt ✓');
  console.log('OK');
} finally {
  if (taskId) await fetch(`${base}/api/sandbox/tasks/${taskId}/finish`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  try { for (const id of execFileSync('docker', ['ps', '-aq', '--filter', 'label=lotse.managed=1'], { encoding: 'utf8' }).split('\n').filter(Boolean)) execFileSync('docker', ['rm', '-f', id]); } catch { /* docker gone */ }
  server.kill('SIGTERM');
  await ai.close(); await gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
