// For server tests only: Sandbox Coding switched on with the FakeRunner, a GitHub fake and a bare file:// theme repository,
// plus a task whose setup reached "ready". Import after '../isolate-data' and before the modules under test.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePluginRepo } from './plugin-repo';
import { startFakeGithub } from './github-fake';

export const GITHUB_TOKEN = `github_pat_${'C0deTools42'.repeat(8)}_abc`;
/** Where the test theme lives in the container */
export const PLUGIN_DIR = '/var/www/html/custom/plugins/AcmeTheme';

export async function sandboxForTests(o: { env?: { key: string; value: string; secret: boolean }[] } = {}) {
  for (const k of ['LOTSE_SANDBOX', 'LOTSE_PASSWORD', 'ALLOWED_HOSTS', 'HOSTNAME', 'HOST', 'AICB_DOCKER', 'LOTSE_BIND', 'LOTSE_SANDBOX_MAX', 'LOTSE_SANDBOX_IDLE_MINUTES', 'LOTSE_SANDBOX_NETWORK', 'LOTSE_SANDBOX_SUBNET', 'LOTSE_SANDBOX_RUNNER']) delete process.env[k];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-code-'));
  const theme = makePluginRepo(tmp, { theme: true });
  process.env.LOTSE_GITHUB_CLONE_BASE = `file://${theme.remoteBase}`;
  const gh = await startFakeGithub({ token: GITHUB_TOKEN, repos: [{ fullName: 'acme/shop-theme' }] });
  process.env.LOTSE_GITHUB_API_BASE = gh.base;
  const { FakeRunner } = await import('../../src/server/sandbox/fake-runner');
  const { setRunner } = await import('../../src/server/sandbox/runner');
  const { allowFileRemotesForTests } = await import('../../src/server/git');
  const { saveGithub } = await import('../../src/server/github');
  const E = await import('../../src/server/sandbox/env');
  const J = await import('../../src/server/sandbox/jobs');
  const T = await import('../../src/server/sandbox/tasks');
  allowFileRemotesForTests(true);
  saveGithub({ token: GITHUB_TOKEN });
  const fake = new FakeRunner();
  fake.images.add('dockware/shopware:6.7.15.1');
  setRunner(fake);
  E.saveSandbox({ enabled: true, envVars: o.env ?? [] });
  const until = async (fn: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); } };
  /** a task whose setup finished (status ready, container running), attached to `chatId` (default: a new chat) */
  const readyTask = async (title = 'Header anpassen', chatId: string = crypto.randomUUID()) => {
    const t = T.createTask({ chatId, title, goal: 'Im Header soll „Gratis Versand“ stehen.', repo: 'acme/shop-theme', baseBranch: 'main' });
    J.runSteps(t.id);
    await until(() => !J.setupRunning(t.id) && T.getTask(t.id)!.status !== 'setting_up');
    const done = T.getTask(t.id)!;
    if (done.status !== 'ready') throw new Error(`setup: ${done.status} ${done.error ?? ''}`);
    return done;
  };
  const close = async () => { await fake.close(); await gh.close(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { fake, gh, theme, E, J, T, until, readyTask, close };
}
