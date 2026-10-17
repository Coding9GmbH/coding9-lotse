// Live check of the coding agent against the real Docker daemon and dockware/shopware, with the scripted model (anthropic-fake)
// instead of Claude: the real Claude Code process gets the workspace tools, writes a Twig header template into the task's
// repository (synced into the container), runs theme-compile there, and the header text then appears in the /sbx preview.
//
//   LOTSE_DOCKWARE_LIVE=1 npx tsx --conditions=react-server tests/support/dockware-live/verify-agent.ts
//   Optional: LOTSE_DOCKWARE_IMAGE (default dockware/shopware:6.7.15.1, must be pulled), DOCKER_HOST.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { ChatEvent } from '@/lib/protocol';
import { makePluginRepo } from '../plugin-repo';
import { startFakeAnthropic } from '../anthropic-fake/server';

if (process.env.LOTSE_DOCKWARE_LIVE !== '1') { console.log('Übersprungen: LOTSE_DOCKWARE_LIVE=1 setzen (startet echte Docker-Container).'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-agent-live-'));
process.env.AICB_DATA = path.join(tmp, 'data');
for (const k of Object.keys(process.env)) if (/^(LOTSE_SANDBOX|AICB_DOCKER$|HOSTNAME$|HOST$|AI_|CLAUDE_|ANTHROPIC_|SHOPWARE_|SHOPIFY_)/.test(k)) delete process.env[k];
const repo = makePluginRepo(tmp, { theme: true, name: 'LotseLiveTheme', repo: 'acme/live-theme' });
process.env.LOTSE_GITHUB_CLONE_BASE = `file://${repo.remoteBase}`;
const ai = await startFakeAnthropic({ quiet: process.env.VERBOSE !== '1' });
Object.assign(process.env, { ANTHROPIC_BASE_URL: ai.url, ANTHROPIC_API_KEY: 'sk-ant-live-fake-key', AI_PROVIDER: 'claude', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });

const { allowFileRemotesForTests } = await import('../../../src/server/git');
const E = await import('../../../src/server/sandbox/env');
const J = await import('../../../src/server/sandbox/jobs');
const T = await import('../../../src/server/sandbox/tasks');
const { getSession } = await import('../../../src/server/sessions');
const { startChat } = await import('../../../src/server/agent');
const sbx = await import('../../../src/app/sbx/[task]/[[...path]]/route');
allowFileRemotesForTests(true);
E.saveSandbox({ enabled: true, image: process.env.LOTSE_DOCKWARE_IMAGE ?? 'dockware/shopware:6.7.15.1' });
const until = async (fn: () => boolean, ms: number) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('Zeitüberschreitung'); await new Promise(res => setTimeout(res, 500)); } };
const TEXT = 'Gratis Versand ab 50 € – Lotse live';
const HEADER = 'src/Resources/views/storefront/layout/header/header.html.twig';

let taskId = '';
try {
  const t0 = Date.now();
  const t = T.createTask({ title: 'Agent live', goal: 'Header-Hinweis', repo: repo.repo, baseBranch: 'main' });
  taskId = t.id;
  J.runSteps(t.id);
  await until(() => !J.setupRunning(t.id) && T.getTask(t.id)!.status !== 'setting_up', 15 * 60_000);
  const ready = T.getTask(t.id)!;
  assert.equal(ready.status, 'ready', ready.error ?? '');
  console.log(`Einrichtung fertig nach ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  const page = async () => {
    const [seg, ...rest] = T.previewPath(t.id).slice('/sbx/'.length).split('/');
    const res = await sbx.GET(new NextRequest(`http://127.0.0.1:3333${T.previewPath(t.id)}/`, { headers: { host: '127.0.0.1:3333' } }), { params: Promise.resolve({ task: seg, path: rest.filter(Boolean) }) });
    return { status: res.status, html: await res.text() };
  };
  const before = await page();
  assert.equal(before.status, 200);
  assert.ok(!before.html.includes(TEXT));

  const s = getSession(ready.chatId!), seen: ChatEvent[] = [];
  s.listeners.add(ev => seen.push(ev));
  const a = Date.now();
  const { done } = startChat({ chatId: ready.chatId!, message: `Bitte umsetzen. [e2e:edit ${HEADER} ${TEXT}] [e2e:cmd theme-compile]`, taskId: t.id });
  await done;
  const end = seen.at(-1);
  console.log('Ereignisse:', seen.filter(e => !['text', 'text_start'].includes(e.t)).map(e => (e.t === 'command' ? `command:${e.status}${e.ms ? ` ${(e.ms / 1000).toFixed(1)} s` : ''}` : e.t === 'tool' ? `tool:${e.name}` : e.t)).join(', '));
  assert.ok(end?.t === 'done' && !end.error, JSON.stringify(end));
  assert.ok(seen.some(e => e.t === 'file_change' && e.path === HEADER), 'file card');
  assert.ok(seen.some(e => e.t === 'command' && e.status === 'ok' && e.command === 'theme-compile'), 'theme compiled');
  assert.ok(seen.some(e => e.t === 'preview_reload'), 'preview reload');
  console.log(`KI-Runde (Fake-Modell, echter Claude-Code-Prozess) ${((Date.now() - a) / 1000).toFixed(1)} s`);

  const after = await page();
  assert.equal(after.status, 200);
  assert.ok(after.html.includes(TEXT), 'header text in the /sbx preview');
  console.log(`/sbx-Vorschau zeigt den neuen Header-Text ✓ (${after.html.length} Bytes)`);
  console.log('OK');
} finally {
  if (taskId) await J.finishTask(taskId).catch(e => console.error('Aufräumen fehlgeschlagen:', e));
  await ai.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
