// Live check of publishing (plan PR 7) through a RUNNING Lotse server (next dev) with the real Docker daemon and dockware/shopware:
// the clone and push target is a real bare repository served over git's smart HTTP protocol (git http-backend behind a small HTTPS
// server with a self-signed certificate; pushing requires the token as Basic credential), the pull request API is the GitHub fake,
// the AI is the scripted model (anthropic-fake). The AI edits the header and proposes a pull request; in the browser (Playwright)
// "Prüfen und veröffentlichen" opens the "Pull Request" tab, the click there commits, pushes lotse/… and opens the PR, and the
// PR card in the chat shows the fake PR. Before/after screenshots (plan PR 8): the setup captures the storefront with the real
// screenshot image (mcr.microsoft.com/playwright, desktop + mobile), publishing captures it again with the change; the "Pull Request"
// tab shows both, the PR body only mentions them. Finally the task is finished (container and screenshots removed).
//
//   LOTSE_DOCKWARE_LIVE=1 npx tsx tests/support/dockware-live/verify-publish.ts
//   Optional: LOTSE_DOCKWARE_IMAGE (default dockware/shopware:6.7.15.1, must be pulled), LOTSE_LIVE_PORT (default 3492), VERBOSE=1,
//   E2E_CHROMIUM (browser binary; default /opt/pw-browsers/chromium if present).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import type { CodeTaskPublic } from '@/lib/protocol';
import { HEADER_TEMPLATE, headerTemplate, makePluginRepo } from '../plugin-repo';
import { startFakeAnthropic } from '../anthropic-fake/server';
import { startFakeGithub } from '../github-fake';

if (process.env.LOTSE_DOCKWARE_LIVE !== '1') { console.log('Übersprungen: LOTSE_DOCKWARE_LIVE=1 setzen (startet echte Docker-Container).'); process.exit(0); }
const TOKEN = `github_pat_${'L1vePubl42'.repeat(8)}_abc`;
const port = Number(process.env.LOTSE_LIVE_PORT ?? 3492), base = `http://127.0.0.1:${port}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotse-publish-live-'));
const repo = makePluginRepo(tmp, { theme: true, name: 'LotsePubTheme', repo: 'acme/pub-theme', files: { [HEADER_TEMPLATE]: headerTemplate('Lotse Live-Header') } });
const TEXT = 'Gratis Versand ab 50 € – live veröffentlicht';

// ---- Smart HTTP git server over HTTPS (git http-backend as CGI) ----
const cert = path.join(tmp, 'cert.pem'), key = path.join(tmp, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
const gitLog: { method: string; url: string; authed: boolean }[] = [];
const expected = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`;
const backend = path.join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');
const gitServer = https.createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://x'), authed = req.headers.authorization === expected;
  gitLog.push({ method: req.method ?? 'GET', url: `${url.pathname}${url.search}`, authed });
  const push = url.searchParams.get('service') === 'git-receive-pack' || url.pathname.endsWith('/git-receive-pack');
  if (push && !authed) { res.writeHead(401, { 'www-authenticate': 'Basic realm="lotse-live"' }); res.end(); return; }
  const cgi = spawn(backend, [], { env: {
    GIT_PROJECT_ROOT: repo.remoteBase, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method ?? 'GET', CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
    GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''), REMOTE_USER: authed ? 'lotse' : '', REMOTE_ADDR: '127.0.0.1', PATH: process.env.PATH ?? '/usr/bin:/bin',
  } as unknown as NodeJS.ProcessEnv, stdio: 'pipe' });
  req.pipe(cgi.stdin);
  let head = Buffer.alloc(0), sent = false;
  cgi.stdout.on('data', (chunk: Buffer) => {
    if (sent) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const i = head.indexOf('\r\n\r\n');
    if (i < 0) return;
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of head.subarray(0, i).toString('latin1').split('\r\n')) {
      const [k, ...v] = line.split(':'), val = v.join(':').trim();
      if (k.toLowerCase() === 'status') status = Number(val.split(' ')[0]); else headers[k] = val;
    }
    res.writeHead(status, headers); res.write(head.subarray(i + 4)); sent = true;
  });
  cgi.on('close', () => res.end());
});
await new Promise<void>(r => gitServer.listen(0, '127.0.0.1', r));
const cloneBase = `https://127.0.0.1:${(gitServer.address() as AddressInfo).port}`;

const ai = await startFakeAnthropic({ quiet: process.env.VERBOSE !== '1' });
const gh = await startFakeGithub({ token: TOKEN, repos: [{ fullName: 'acme/pub-theme' }] });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LOTSE_|AICB_|AI_|CLAUDE_|ANTHROPIC_|SHOPWARE_|SHOPIFY_|HOSTNAME$|HOST$|GIT_)/.test(k)));
const server = spawn(process.execPath, [path.join(process.cwd(), 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  env: { ...inherited, AICB_DATA: path.join(tmp, 'data'), ANTHROPIC_BASE_URL: ai.url, ANTHROPIC_API_KEY: 'sk-ant-live-fake-key', AI_PROVIDER: 'claude',
    LOTSE_GITHUB_API_BASE: gh.base, LOTSE_GITHUB_CLONE_BASE: cloneBase, GIT_SSL_CAINFO: cert,
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
const bare = (...args: string[]) => execFileSync('git', ['--git-dir', repo.bare, ...args], { encoding: 'utf8' }).trim();

let taskId = '';
let failShot = async () => {};
const executablePath = process.env.E2E_CHROMIUM ?? (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
try {
  const t0 = Date.now();
  await until(async () => (await fetch(`${base}/api/health`)).ok, 180_000, 'Lotse startet');
  console.log(`Lotse (next dev) läuft auf ${base}, Git-Server (smart HTTP über HTTPS) ${cloneBase}`);
  await api('/api/github', { method: 'PUT', body: JSON.stringify({ token: TOKEN }) });
  await api('/api/sandbox/env', { method: 'PUT', body: JSON.stringify({ enabled: true, image: process.env.LOTSE_DOCKWARE_IMAGE ?? 'dockware/shopware:6.7.15.1' }) });

  const chatId = crypto.randomUUID();
  const { task } = await api<{ task: CodeTaskPublic }>('/api/sandbox/tasks', { method: 'POST', body: JSON.stringify({ chatId, title: 'Gratis Versand live', repo: 'acme/pub-theme', baseBranch: 'main' }) });
  taskId = task.id;
  let cur = task;
  await until(async () => { cur = (await api<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${taskId}`)).task; return cur.status !== 'setting_up'; }, 15 * 60_000, 'Einrichtung');
  assert.equal(cur.status, 'ready', cur.error ?? '');
  console.log(`Einrichtung fertig nach ${((Date.now() - t0) / 1000).toFixed(0)} s (geklont über ${cloneBase})`);
  assert.ok(gitLog.some(l => l.url.includes('git-upload-pack') && l.authed), 'the clone sent the token as Basic credential');
  // before screenshots: real PNGs from the browser container, served by Lotse; the container is gone again
  const png = async (url: string) => { const r = await fetch(base + url); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); const b = Buffer.from(await r.arrayBuffer()); assert.ok(b.subarray(1, 4).toString() === 'PNG' && b.length > 10_000, `real PNG (${b.length} bytes)`); return b; };
  assert.equal(cur.steps.find(s => s.key === 'screenshots')?.state, 'done', JSON.stringify(cur.steps.find(s => s.key === 'screenshots')));
  assert.deepEqual(cur.shots.before?.shots.map(x => `${x.path} ${x.device}`), ['/ desktop', '/ mobile']);
  const shotDir = process.env.LOTSE_LIVE_SHOTS ?? path.join(os.tmpdir(), 'lotse-live-shots');
  fs.mkdirSync(shotDir, { recursive: true });
  for (const x of cur.shots.before!.shots) fs.writeFileSync(path.join(shotDir, `before-${x.device}.png`), await png(x.url));
  assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', 'label=lotse.role=screenshot'], { encoding: 'utf8' }).trim(), '', 'no screenshot container left');
  console.log(`Vorher-Screenshots (Desktop + Mobil) aus dem Browser-Container gespeichert (${shotDir}) ✓`);

  // the AI edits the header and proposes the pull request (scripted model, real Claude Code process)
  const r = await fetch(`${base}/api/chat`, { method: 'POST', headers: H, body: JSON.stringify({ chatId, message: `Bitte umsetzen. [e2e:replace ${HEADER_TEMPLATE} Lotse Live-Header|${TEXT}] [e2e:pr Header: ${TEXT}|Geprüft in der Sandbox-Vorschau.]` }) });
  const events = (await r.text()).split('\n').filter(Boolean).map(l => JSON.parse(l) as { t: string; error?: string | null });
  assert.ok(events.some(e => e.t === 'publish_proposal'), 'proposal card');
  assert.ok(events.at(-1)?.t === 'done' && !events.at(-1)?.error, JSON.stringify(events.at(-1)));
  assert.equal(gh.calls.filter(c => c.method === 'POST').length, 0, 'the AI published nothing');
  console.log('KI-Runde: Header geändert, Vorschlag für den Pull Request angezeigt (nichts veröffentlicht) ✓');

  // next dev compiles every route on first use (and reloads open pages meanwhile): warm up what the page needs
  for (const p of ['/', '/sandbox-coding', `/api/sandbox/tasks/${taskId}/diff`, `/api/sandbox/tasks/${taskId}/pr`]) await fetch(base + p, { headers: H }).then(r => r.text());
  const ac = new AbortController(), ev = await fetch(`${base}/api/sandbox/tasks/${taskId}/events`, { headers: H, signal: ac.signal });
  await ev.body?.getReader().read(); ac.abort();
  await fetch(`${base}/api/sandbox/tasks/${taskId}/publish`, { method: 'POST', headers: H, body: '{"nope":1}' }); // 400 (strict body): compiled, nothing published

  // the browser: open the chat, review the proposal, publish
  const page = await browser.newPage({ locale: 'de-DE', viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90_000); // next dev compiles each page on first use
  failShot = async () => { const f = path.join(os.tmpdir(), 'lotse-publish-live-failed.png'); await page.screenshot({ path: f }).catch(() => {}); console.log(`Bildschirmfoto: ${f}\n${(await page.locator('body').innerText().catch(() => '')).slice(0, 3000)}`); };
  // open the chat from the history (next dev compiles and hydrates slowly: retry until the sandbox panel is there)
  await page.goto(base);
  const panel = page.getByRole('region', { name: 'Sandbox' });
  for (let i = 0; i < 10 && !(await panel.isVisible()); i++) {
    await page.getByText('Gratis Versand live', { exact: true }).first().click().catch(() => {});
    await panel.waitFor({ timeout: 10_000 }).catch(() => {});
  }
  await page.getByRole('region', { name: 'Vorschlag für den Pull Request' }).getByRole('button', { name: 'Prüfen und veröffentlichen' }).click();
  const form = panel.getByRole('form', { name: 'Pull Request' });
  await form.getByText(HEADER_TEMPLATE).waitFor({ timeout: 30_000 });
  assert.equal(await form.getByLabel('Titel').inputValue(), `Header: ${TEXT}`);
  await form.getByRole('button', { name: 'Pull Request erstellen' }).click();
  const card = page.getByRole('log').getByRole('region', { name: /^Pull Request #1:/ });
  await card.waitFor({ timeout: 120_000 });
  const href = await card.getByRole('link', { name: 'Auf GitHub öffnen' }).getAttribute('href');
  assert.equal(href, 'https://github.com/acme/pub-theme/pull/1');
  const shot = path.join(os.tmpdir(), 'lotse-publish-live.png');
  await page.screenshot({ path: shot, fullPage: false });
  console.log(`PR-Karte im Chat: „${(await card.innerText()).replace(/\s+/g, ' ')}“ ✓ (Bildschirmfoto ${shot})`);

  // the bare repository has the branch, main is untouched, the push carried the token; the fake has exactly one PR
  const branch = cur.branch;
  assert.match(branch, /^lotse\/gratis-versand-live-[a-z0-9]{6}$/);
  const heads = bare('for-each-ref', '--format=%(refname)', 'refs/heads').split('\n').sort();
  assert.deepEqual(heads, ['refs/heads/main', `refs/heads/${branch}`].sort());
  assert.ok(bare('show', `${branch}:${HEADER_TEMPLATE}`).includes(TEXT), 'the change is on the branch');
  assert.match(bare('log', '-1', '--format=%an <%ae>', branch), /^Lotse <lotse@users\.noreply\.github\.com>$/);
  assert.ok(gitLog.some(l => l.method === 'POST' && l.url.endsWith('/git-receive-pack') && l.authed), 'authenticated push');
  const post = gh.calls.filter(c => c.method === 'POST' && c.path === '/repos/acme/pub-theme/pulls');
  assert.equal(post.length, 1);
  assert.deepEqual({ head: (post[0].body as { head: string }).head, base: (post[0].body as { base: string }).base }, { head: branch, base: 'main' });
  console.log(`Bare-Repository: ${branch} = ${bare('rev-parse', '--short', branch)} (main unverändert), Pull Request #1 beim GitHub-Fake ✓`);
  const fresh = (await api<{ task: CodeTaskPublic }>(`/api/sandbox/tasks/${taskId}`)).task;
  // after screenshots: taken at publishing, different from before (the header changed), mentioned in the body without a link
  assert.deepEqual(fresh.shots.after?.shots.map(x => `${x.path} ${x.device}`), ['/ desktop', '/ mobile'], fresh.shots.after?.error ?? '');
  for (const x of fresh.shots.after!.shots) {
    const b = await png(x.url);
    fs.writeFileSync(path.join(shotDir, `after-${x.device}.png`), b);
    assert.ok(!b.equals(fs.readFileSync(path.join(shotDir, `before-${x.device}.png`))), `after differs from before (${x.device})`);
  }
  const prBody = String((post[0].body as { body: string }).body);
  assert.match(prBody, /\*\*Screenshots:\*\* Vorher-\/Nachher-Screenshots der Sandbox-Storefront \(Desktop und Mobil; `\/`\)/);
  assert.ok(!/\/api\/sandbox|!\[/.test(prBody), 'no link or image in the PR body');
  const shots = panel.getByRole('region', { name: 'Vorher / Nachher' });
  await shots.getByRole('img', { name: 'Nachher, Desktop: /' }).waitFor();
  await shots.getByRole('img', { name: 'Vorher, Desktop: /' }).waitFor();
  await shots.scrollIntoViewIfNeeded();
  const tabShot = path.join(shotDir, 'pr-tab.png');
  await panel.screenshot({ path: tabShot });
  console.log(`Nachher-Screenshots beim Veröffentlichen, im Reiter „Pull Request“ neben den Vorher-Bildern (${tabShot}), im PR-Text nur erwähnt ✓`);
  assert.deepEqual(fresh.pr, { number: 1, url: 'https://github.com/acme/pub-theme/pull/1', title: `Header: ${TEXT}` });
  const gitConfig = fs.readFileSync(path.join(tmp, 'data', 'git', taskId, 'config'), 'utf8');
  assert.ok(!gitConfig.includes(TOKEN) && !gitConfig.includes(expected.slice(6)), 'no token in .git/config');

  await api(`/api/sandbox/tasks/${taskId}/finish`, { method: 'POST', body: '{}' });
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'screenshots', taskId)), 'screenshots removed with the task');
  taskId = '';
  console.log('Aufgabe abgeschlossen: Container und Screenshots entfernt ✓');
  console.log('OK');
} catch (e) {
  await failShot();
  throw e;
} finally {
  await browser.close();
  if (taskId) await fetch(`${base}/api/sandbox/tasks/${taskId}/finish`, { method: 'POST', headers: H, body: '{}' }).catch(() => {});
  try { for (const id of execFileSync('docker', ['ps', '-aq', '--filter', 'label=lotse.managed=1'], { encoding: 'utf8' }).split('\n').filter(Boolean)) execFileSync('docker', ['rm', '-f', id]); } catch { /* docker gone */ }
  server.kill('SIGTERM');
  gitServer.closeAllConnections(); gitServer.close();
  await ai.close(); await gh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
