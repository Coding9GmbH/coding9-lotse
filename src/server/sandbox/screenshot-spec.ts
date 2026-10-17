// Screenshot containers (pure part, no I/O): the second fixed image, the create body, the job and the fixed script.
// One short-lived container per capture: the pinned Playwright image (only its headless Chromium is used, no npm package),
// attached to the internal network lotse-sandbox only, no mounts, no ports, non-root, all capabilities dropped.
// Lotse puts the script and the job (built here from the task id and validated paths) into it via the archive API,
// starts it, waits, takes /lotse/out back via the archive API and removes it. The browser reaches only its task's
// storefront: every request goes through the sandbox alias as HTTP proxy with Host: localhost (the domain Dockware knows).
import type { ContainerSpec } from './runner';
import { MANAGED, ROLE_LABEL, SANDBOX_NET, SHOT_ROLE, TASK_LABEL, sandboxAlias } from './labels';

/** Pinned like @playwright/test in package.json; the browser inside is chrome-headless-shell. */
export const SCREENSHOT_IMAGE = 'mcr.microsoft.com/playwright:v1.64.0-noble';
export const SHOT_USER = 'pwuser';
export const SHOT_OWNER = { uid: 1001, gid: 1001, uname: SHOT_USER, gname: SHOT_USER } as const;
export const SHOT_DIR = '/lotse';
export const SHOT_OUT = `${SHOT_DIR}/out`;
export const SHOT_CMD = ['node', `${SHOT_DIR}/shot.mjs`] as const;
export const MAX_SHOT_PATHS = 5;
export const DEFAULT_SHOT_PATHS = ['/'];

export type ShotDevice = 'desktop' | 'mobile';
export const DEVICES: Record<ShotDevice, { width: number; height: number; userAgent?: string }> = {
  desktop: { width: 1366, height: 900 },
  mobile: { width: 390, height: 844, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
};

/** A storefront path: starts with one "/", no "..", no "//", no fragment, only URL-safe characters. Throws in German. */
export function validShotPath(raw: string): string {
  const p = raw.trim();
  if (!/^\/[A-Za-z0-9._~%/?=&+,:@-]{0,199}$/.test(p) || p.includes('//') || p.split(/[/?]/).includes('..'))
    throw new Error(`Ungültiger Pfad für Screenshots „${p.slice(0, 80)}“: beginnt mit /, ohne „..“, Leerzeichen oder Sonderzeichen (z. B. /, /checkout/cart).`);
  return p;
}
export function validShotPaths(list: string[]): string[] {
  const out = [...new Set(list.map(s => s.trim()).filter(Boolean).map(validShotPath))];
  if (out.length > MAX_SHOT_PATHS) throw new Error(`Höchstens ${MAX_SHOT_PATHS} Seiten für Screenshots.`);
  return out;
}

export const shotContainerName = (taskId: string) => `lotse-shot-${sandboxAlias(taskId).slice('lotse-sbx-'.length)}`;
/** File name inside the container (and the suffix of the stored file): <n>-<device>.png, n = 1-based index of the path. */
export const shotFile = (i: number, d: ShotDevice) => `${i + 1}-${d}.png`;

export interface ShotJob { proxy: string; budgetMs: number; shotTimeoutMs: number; shots: { file: string; url: string; width: number; height: number; userAgent?: string }[] }
/** Desktop and mobile per path. Only the task's own sandbox (alias) as proxy; the URL host is always localhost. */
export function buildShotJob(taskId: string, paths: string[]): ShotJob {
  if (!/^t_[a-z0-9]{12}$/.test(taskId)) throw new Error('Ungültige Aufgaben-ID.');
  const ok = validShotPaths(paths);
  if (!ok.length) throw new Error('Keine Seiten für Screenshots.');
  return {
    proxy: `http://${sandboxAlias(taskId)}:80`, budgetMs: 6000, shotTimeoutMs: 40_000,
    shots: ok.flatMap((p, i) => (Object.keys(DEVICES) as ShotDevice[]).map(d => ({ file: shotFile(i, d), url: `http://localhost${p}`, ...DEVICES[d] }))),
  };
}
/** Time Lotse waits for the whole container (per shot the script stops the browser itself after shotTimeoutMs). */
export const jobTimeoutMs = (job: ShotJob) => Math.min(5 * 60_000, 30_000 + job.shots.length * 30_000);

/** Create body. Pure: only the validated task id. */
export function buildShotSpec(taskId: string): ContainerSpec {
  if (!/^t_[a-z0-9]{12}$/.test(taskId)) throw new Error('Ungültige Aufgaben-ID.');
  return {
    name: shotContainerName(taskId), Image: SCREENSHOT_IMAGE, Cmd: [...SHOT_CMD], User: SHOT_USER,
    Labels: { ...MANAGED, [TASK_LABEL]: taskId, [ROLE_LABEL]: SHOT_ROLE },
    HostConfig: {
      NetworkMode: SANDBOX_NET, Memory: 1024 * 1024 * 1024, NanoCpus: 1e9, PidsLimit: 512, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
    },
  };
}

/** The fixed script (node, inside the container): one chrome-headless-shell per shot, argv only (no shell), results in out/result.json. */
export const SHOT_SCRIPT = `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const job = JSON.parse(fs.readFileSync('${SHOT_DIR}/job.json', 'utf8'));
const root = '/ms-playwright';
const dir = fs.readdirSync(root).find(d => d.startsWith('chromium_headless_shell-'));
const bin = dir && root + '/' + dir + '/chrome-headless-shell-linux64/chrome-headless-shell';
const result = [];
for (const [i, s] of job.shots.entries()) {
  if (!bin) { result.push({ file: s.file, ok: false, error: 'chrome-headless-shell fehlt im Image' }); continue; }
  const args = ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-dev-shm-usage', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--force-device-scale-factor=1', '--window-size=' + s.width + ',' + s.height,
    '--proxy-server=' + job.proxy, '--proxy-bypass-list=<-loopback>', '--virtual-time-budget=' + job.budgetMs, '--user-data-dir=/tmp/lotse-shot-' + i,
    ...(s.userAgent ? ['--user-agent=' + s.userAgent] : []), '--screenshot=${SHOT_OUT}/' + s.file, s.url];
  const t0 = Date.now();
  const r = await new Promise(done => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-600); });
    const kill = setTimeout(() => p.kill('SIGKILL'), job.shotTimeoutMs);
    p.on('error', e => { clearTimeout(kill); done({ code: -1, err: String(e.message) }); });
    p.on('close', code => { clearTimeout(kill); done({ code, err }); });
  });
  const ok = fs.existsSync('${SHOT_OUT}/' + s.file);
  result.push({ file: s.file, ok, ms: Date.now() - t0, ...(ok ? {} : { error: 'Exit ' + r.code + ': ' + r.err.split('\\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) }) });
}
fs.writeFileSync('${SHOT_OUT}/result.json', JSON.stringify(result));
`;
