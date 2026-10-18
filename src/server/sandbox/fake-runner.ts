import 'server-only';
// In-memory runner for tests and e2e (LOTSE_SANDBOX_RUNNER=fake): no Docker, records every call.
// Exec results are scripted; each started container gets a small node:http "storefront" that serves the synced files.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertTtySize, ttyEmitter, type ArchiveStream, type ContainerInfo, type ContainerSpec, type ExecOpts, type ExecResult, type NetworkInfo, type NetworkOpts, type PullProgress, type SandboxRunner, type TtyOpts, type TtySession, type VolumeInfo } from './runner';
import { MANAGED, assertAllowedImage, assertContainerPath, assertEgressNetwork, assertId, assertManaged, assertNetworkName, assertSafeSpec, isManaged } from './guards';
import { DB_COPY_ROLE, EGRESS_NET, ROLE_LABEL, SANDBOX_NET, SHOT_ROLE } from './labels';
import { COPY_FROM, COPY_TO, assertVolumeName } from './db-snapshot-spec';
import { SHOT_DIR, SHOT_OUT, type ShotJob } from './screenshot-spec';
import { readTar, readTarEntries, writeTar, type TarRecord } from './tar';

export interface FakeCall { op: string; id?: string; argv?: string[]; user?: string; detail?: unknown }
/** A volume in the fake: `data` stands for MySQL's data directory (what was imported into it; [] = empty, as Docker creates it) */
export interface FakeVolume { name: string; labels: Record<string, string>; data: string[] }
type Mount = { Source: string; Target: string; ReadOnly?: boolean };
const mountsOf = (spec: ContainerSpec) => ((spec.HostConfig as { Mounts?: Mount[] } | undefined)?.Mounts ?? []);
interface FakeContainer { id: string; spec: ContainerSpec; running: boolean; exitCode?: number; oomKilled?: boolean; /** container output (docker logs) */ log: string[]; networks: string[]; files: Map<string, Buffer>; server: http.Server | null; port: number | null; /** storefront templates as of the last theme:compile */ compiled: string[] }
type ExecScript = (argv: readonly string[], id: string) => Partial<ExecResult> | undefined;

export { readTar, readTarEntries, type TarRecord } from './tar';

/** A console in the fake: a line-editing echo shell that knows a few commands (enough for tests and e2e, see FakeRunner.openTty). */
export interface FakeTty { containerId: string; argv: string[]; opts: TtyOpts; cols: number; rows: number; alive: boolean; input: string; end: () => void;
  /** flow control (TtySession.pause): output waits in `held` until resume */ paused?: boolean; held?: Buffer[] }
const FAKE_PLUGINS = `Shopware Plugin Service
=======================

 -------------- ---------------- --------- ----------- -------- ----------- 
  Plugin         Label            Version   Installed   Active   Upgradeable  
 -------------- ---------------- --------- ----------- -------- ----------- 
  AcmeTheme      Acme Theme       1.0.0     Yes         Yes      No           
 -------------- ---------------- --------- ----------- -------- ----------- 

 1 plugins, 1 installed, 1 active , 0 upgradeable
`;
/** The user the shell runs as: a root wrapper that drops privileges (templates: console.start, setpriv) names it in its script. */
const shellUser = (t: FakeTty) => (t.opts.user === 'root' && /setpriv\b/.test(t.argv.join(' ')) && /\bid -u (\w+)/.exec(t.argv.join(' '))?.[1]) || t.opts.user;
function fakeShell(t: FakeTty, line: string): string | null {
  const cmd = line.trim();
  if (cmd === 'exit' || cmd === 'logout') return null;
  if (!cmd) return '';
  if (cmd === 'whoami') return `${shellUser(t) === 'dockware' ? 'www-data' : shellUser(t)}\r\n`;
  if (cmd === 'pwd') return `${t.opts.workdir}\r\n`;
  if (cmd === 'stty size') return `${t.rows} ${t.cols}\r\n`;
  if (cmd === 'sudo -n true') return '';
  if (/^(bin\/console|php bin\/console) plugin:list\b/.test(cmd)) return FAKE_PLUGINS.replace(/\n/g, '\r\n');
  const yes = /^yes \| head -c (\d+)$/.exec(cmd); // a lot of output (flow control)
  if (yes) return 'y\r\n'.repeat(Math.ceil(Math.min(Number(yes[1]), 8 << 20) / 3));
  if (cmd.startsWith('echo ')) return `${cmd.slice(5)}\r\n`;
  if (/^printf '\\e\[3[0-7]m/.test(cmd)) return '\x1b[32mgrün\x1b[0m\r\n';
  return `\x1b[2m(fake) ${cmd}\x1b[0m\r\n`;
}

async function collect(a: ArchiveStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of a.stream) parts.push(c as Buffer);
  const b = Buffer.concat(parts);
  if (b.length !== a.length) throw new Error(`Archiv-Länge ${b.length} statt ${a.length}.`);
  return b;
}

const WEBROOT = '/var/www/html/public';
const PLUGINS = '/var/www/html/custom/plugins/';
/** What the fake storefront shows of a plugin's storefront template: its markup without Twig tags (enough to see an edit after compiling). */
const renderTwig = (src: string) => src.replace(/\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}|\{#[\s\S]*?#\}/g, '').trim();
/** The image's extension aliases as `bin/console debug:config` lists them (6.7.15.1) */
export const FAKE_EXTENSIONS = ['debug', 'elasticsearch', 'framework', 'mcp', 'monolog', 'pentatrion_vite', 'service', 'shopware', 'storefront', 'twig', 'twig_component', 'web_profiler'];
/** Enough YAML for tests: nested block mappings of `key: value` (comments, lists and anchors are skipped) */
export function fakeYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}, stack: { indent: number; obj: Record<string, unknown> }[] = [{ indent: -1, obj: root }];
  for (const line of text.split('\n')) {
    const m = /^(\s*)([A-Za-z0-9_.@\\()-]+|'[^']*'):(?:\s+(.*))?$/.exec(line.replace(/\s+#.*$/, ''));
    if (!m || /^\s*#/.test(line)) continue;
    const indent = m[1].length, key = m[2].replace(/^'|'$/g, ''), raw = (m[3] ?? '').trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (!raw || raw.startsWith('&')) { const child: Record<string, unknown> = {}; parent[key] = child; stack.push({ indent, obj: child }); continue; }
    parent[key] = raw === 'true' ? true : raw === 'false' ? false : raw === '~' || raw === 'null' ? null : /^-?\d+$/.test(raw) ? Number(raw) : raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  return root;
}
/** What a healthy Dockware answers where the setup reads output (plugins installed and active, the project steps' probes). */
function dockwareAnswers(argv: readonly string[], c: FakeContainer): Partial<ExecResult> | undefined {
  const last = argv.at(-1) ?? '', script = argv[0] === 'bash' ? argv[2] ?? '' : '';
  if (argv[0] === 'mysql' && argv.some(a => a.includes('installed_at IS NOT NULL'))) {
    const names = /WHERE name IN \(([^)]*)\)/.exec(last)?.[1];
    return { output: names ? names.split(',').map(n => `${n.replace(/'/g, '').trim()}\t11`).join('\n') + '\n' : '11\n' };
  }
  if (argv[0] === 'bin/console' && argv[1] === 'about') return { output: ' Kernel\n  Environment          dev\n  Debug                true\n' };
  if (script === 'bin/console debug:config 2>&1') return { output: ` ---- ----\n  Bundle name   Extension alias\n${FAKE_EXTENSIONS.map(e => `  Some${e.replace(/_/g, '')}Bundle   ${e}`).join('\n')}\n` };
  if (argv[0] === 'bash' && /env \| cut -d= -f1/.test(script)) return { output: 'APP_ENV\nAPP_URL\nDATABASE_URL\nAPP_SECRET\nPATH\n' };
  if (argv[0] === 'cat' && argv[1] === 'composer.json') return { output: JSON.stringify({ type: 'project', require: { 'shopware/core': 'v6.7.15.1' }, autoload: { 'psr-4': { 'App\\': 'src/' } } }) };
  if (argv[0] === 'cat' && argv[1]?.startsWith('/')) { const f = c.files.get(argv[1]); return f ? { output: f.toString('utf8') } : { exitCode: 1, output: `cat: ${argv[1]}: No such file or directory` }; }
  // the project's config parsed by "the container's Symfony": staged files below /tmp/lotse-config
  if (argv[0] === 'php' && argv[1] === '-r' && argv[2]?.includes('PARSE_CUSTOM_TAGS')) {
    const out: Record<string, unknown> = {};
    for (const rel of argv.slice(4)) { const f = c.files.get(`/tmp/lotse-config/${rel}`); out[rel] = f ? (/^\s*broken:\s*\[/m.test(f.toString('utf8')) ? { error: 'Malformed inline YAML string' } : { data: fakeYaml(f.toString('utf8')) }) : { error: 'missing' }; }
    return { output: JSON.stringify(out) };
  }
  return undefined;
}

/** A valid 1×1 PNG: what the fake screenshot container "captures". */
export const FAKE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export class FakeRunner implements SandboxRunner {
  readonly kind = 'fake' as const;
  calls: FakeCall[] = [];
  containers = new Map<string, FakeContainer>();
  networks = new Map<string, NetworkInfo>();
  images = new Set<string>();
  /** Docker "unreachable" for ping/version and every other call */
  down = false;
  /** next call of this operation fails with the message */
  failNext: { op: string; message: string } | null = null;
  script: ExecScript = () => undefined;
  /** tests: answer a storefront request of a started container itself (true = handled) */
  storefront: ((req: http.IncomingMessage, res: http.ServerResponse, containerId: string) => boolean) | null = null;
  /** screenshot container: which file each shot gets (null = that shot fails); default FAKE_PNG for every shot. Throwing = exit code 1 without output */
  shooter: ((job: ShotJob) => Record<string, Buffer | null>) | null = null;
  /** every uploaded archive, decoded (tests check owner and paths) */
  archives: { id: string; dir: string; entries: TarRecord[] }[] = [];
  /** every console opened (tests: argv, user, size, whether it is still open) */
  ttys: FakeTty[] = [];
  volumes = new Map<string, FakeVolume>();
  /** what a fresh task database volume holds once a container started on it (Docker copies the image's data directory in) */
  imageDb: string[] = ['demo'];
  /** database copy containers exit with this code (tests: a failing copy) */
  copyExit = 0;
  private seq = 0;

  private enter(op: string, call: Omit<FakeCall, 'op'> = {}) {
    this.calls.push({ op, ...call });
    if (this.down) throw new Error('Docker ist nicht erreichbar – Docker-Socket bzw. DOCKER_HOST einrichten.');
    if (this.failNext?.op === op) { const m = this.failNext.message; this.failNext = null; throw new Error(m); }
  }
  private managed(id: string): FakeContainer { const c = this.containers.get(assertId(id)); assertManaged(this.info(c)); return c!; }
  private info(c: FakeContainer | undefined): ContainerInfo | null {
    return c ? { id: c.id, name: c.spec.name, image: c.spec.Image, state: c.running ? 'running' : 'exited', running: c.running, labels: c.spec.Labels, address: c.port ? { host: '127.0.0.1', port: c.port } : null, networks: [...c.networks],
      ...(c.exitCode !== undefined ? { exitCode: c.exitCode } : {}), ...(c.oomKilled ? { oomKilled: true } : {}) } : null;
  }

  async ping() { this.enter('ping'); }
  async version() { this.enter('version'); return { apiVersion: '1.41', version: 'fake' }; }
  async imagePresent(image: string) { this.enter('imagePresent', { detail: image }); return this.images.has(assertAllowedImage(image)); }
  async ensureImage(image: string, onProgress: (p: PullProgress) => void = () => {}) {
    this.enter('ensureImage', { detail: image });
    if (this.images.has(assertAllowedImage(image))) return { pulled: false };
    onProgress({ text: 'Downloading', pct: 50 });
    onProgress({ text: 'Pull complete', pct: 100 });
    this.images.add(image);
    return { pulled: true };
  }
  async create(spec: ContainerSpec) {
    this.enter('create', { detail: spec });
    assertSafeSpec(spec);
    for (const m of mountsOf(spec)) if (!this.volumes.has(m.Source)) throw new Error(`Volume ${m.Source} fehlt.`);
    const id = `fake${(++this.seq).toString().padStart(8, '0')}`;
    this.containers.set(id, { id, spec, running: false, log: [], networks: [SANDBOX_NET], files: new Map(), server: null, port: null, compiled: [] });
    return id;
  }
  async start(id: string) {
    this.enter('start', { id });
    const c = this.managed(id);
    if (c.running) return;
    if (c.spec.Labels[ROLE_LABEL] === SHOT_ROLE) { this.shoot(c); return; }
    if (c.spec.Labels[ROLE_LABEL] === DB_COPY_ROLE) { this.copy(c); return; }
    // an empty volume at the data directory gets the image's data on the first start (Docker's copy-up)
    for (const m of mountsOf(c.spec)) { const v = this.volumes.get(m.Source); if (v && !v.data.length) v.data = [...this.imageDb]; }
    c.running = true; delete c.exitCode; delete c.oomKilled;
    c.server = http.createServer((req, res) => {
      if (this.storefront?.(req, res, c.id)) return;
      const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = c.files.get(`${WEBROOT}${p === '/' ? '/index.html' : p}`);
      if (file) { res.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); res.end(file); return; }
      if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang="de"><head><title>Sandbox ${c.spec.name}</title></head><body>${c.compiled.join('\n')}<h1>Fake-Storefront</h1><p>${c.files.size} Dateien</p></body></html>`); return; }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    });
    await new Promise<void>(ok => c.server!.listen(0, '127.0.0.1', ok));
    c.port = (c.server.address() as AddressInfo).port;
  }
  /** The screenshot script, simulated: reads the job from the uploaded files, writes the shots and result.json, exits. */
  private shoot(c: FakeContainer) {
    try {
      const job = JSON.parse(c.files.get(`${SHOT_DIR}/job.json`)?.toString('utf8') ?? 'null') as ShotJob;
      if (!job || !c.files.has(`${SHOT_DIR}/shot.mjs`)) throw new Error('job missing');
      const made = this.shooter?.(job) ?? Object.fromEntries(job.shots.map(s => [s.file, FAKE_PNG]));
      const result = job.shots.map(s => { const png = made[s.file]; if (png) c.files.set(`${SHOT_OUT}/${s.file}`, png); return { file: s.file, ok: !!png, ...(png ? {} : { error: 'Exit 1: net::ERR_CONNECTION_REFUSED' }) }; });
      c.files.set(`${SHOT_OUT}/result.json`, Buffer.from(JSON.stringify(result)));
      c.exitCode = 0;
    } catch { c.exitCode = 1; }
  }
  /** The copy container's fixed command, simulated: source not empty, target empty, then the data is copied (exit 3/4 otherwise). */
  private copy(c: FakeContainer) {
    const m = mountsOf(c.spec), from = this.volumes.get(m.find(x => x.Target === COPY_FROM)?.Source ?? ''), to = this.volumes.get(m.find(x => x.Target === COPY_TO)?.Source ?? '');
    if (!from?.data.length) { c.exitCode = 4; c.log.push('Quelle ist leer'); return; }
    if (!to || to.data.length) { c.exitCode = 3; c.log.push('Ziel ist nicht leer'); return; }
    if (this.copyExit) { c.exitCode = this.copyExit; c.log.push('cp: write error: No space left on device'); return; }
    to.data = [...from.data]; c.exitCode = 0;
  }
  async wait(id: string) {
    this.enter('wait', { id });
    const c = this.managed(id);
    return c.exitCode ?? (c.running ? -1 : 0);
  }
  async getArchive(id: string, dir: string, o: { maxBytes: number }) {
    this.enter('getArchive', { id, detail: dir });
    const c = this.managed(id), root = assertContainerPath(dir).replace(/\/$/, ''), base = root.split('/').pop()!;
    const entries = [...c.files].filter(([k]) => k.startsWith(`${root}/`)).map(([k, data]) => ({ path: `${base}/${k.slice(root.length + 1)}`, type: 'file' as const, data }));
    if (!entries.length) throw new Error(`Dateien abholen: Docker meldet HTTP 404 – Could not find the file ${root} in container`);
    const tar = writeTar([{ path: base, type: 'dir' }, ...entries], { uid: 1001, gid: 1001, uname: 'pwuser', gname: 'pwuser' });
    if (tar.length > o.maxBytes) throw new Error('Antwort von Docker ist zu groß.');
    return tar;
  }
  /** Tests: the container's main process ends by itself (e.g. its database failed while starting), with these output lines. */
  async exit(id: string, o: { exitCode?: number; log?: string[]; oomKilled?: boolean } = {}) {
    const c = this.managed(id);
    c.running = false; c.exitCode = o.exitCode ?? 1; c.oomKilled = o.oomKilled; c.log.push(...(o.log ?? []));
    await this.closeServer(c);
  }
  async logs(id: string, o: { tail: number }) {
    this.enter('logs', { id, detail: o.tail });
    const c = this.managed(id);
    return c.log.slice(-o.tail).map(l => `${l}\n`).join('');
  }
  async stop(id: string, timeoutSec?: number) {
    this.enter('stop', { id, detail: timeoutSec });
    const c = this.managed(id);
    c.running = false;
    await this.closeServer(c);
  }
  async remove(id: string) {
    this.enter('remove', { id });
    const c = this.containers.get(assertId(id));
    if (!c) return;
    this.managed(id);
    await this.closeServer(c);
    this.containers.delete(id);
  }
  /** A stopped or removed container ends its consoles (Docker closes the exec streams). */
  private endTtys(id: string) { for (const t of this.ttys) if (t.containerId === id && t.alive) t.end(); }
  private async closeServer(c: FakeContainer) {
    this.endTtys(c.id);
    const s = c.server; c.server = null; c.port = null;
    if (s) await new Promise<void>(ok => { s.closeAllConnections?.(); s.close(() => ok()); });
  }
  async inspect(id: string) { this.enter('inspect', { id }); return this.info(this.containers.get(assertId(id))); }
  async list(labels: Record<string, string> = {}) {
    this.enter('list', { detail: labels });
    const want = { ...labels, ...MANAGED };
    return [...this.containers.values()].filter(c => isManaged(c.spec.Labels) && Object.entries(want).every(([k, v]) => c.spec.Labels[k] === v)).map(c => this.info(c)!);
  }
  async exec(id: string, argv: readonly string[], o: ExecOpts): Promise<ExecResult> {
    this.enter('exec', { id, argv: [...argv], user: o.user });
    const c = this.managed(id);
    if (!c.running) throw new Error('Container läuft nicht.');
    if (o.signal?.aborted) throw new Error('Abgebrochen.');
    // theme:compile directly (setup, allow-listed command) or inside a shell command line (sandbox_bash)
    if ((argv[0] === 'bin/console' && argv[1] === 'theme:compile') || (argv[0] === 'bash' && /\btheme:compile\b/.test(argv.at(-1) ?? ''))) {
      c.compiled = [...c.files].filter(([k]) => k.startsWith(PLUGINS) && /\/Resources\/views\/storefront\/.+\.html\.twig$/.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => renderTwig(v.toString('utf8')));
    }
    // the console's stop command names the session id its shell wrapper got (templates: console.start/stop); the "all" variant
    // (a loop over every pid file) ends every one
    const all = /for f in \S*\*\.pid/.test(argv.join(' '));
    let ended = 0;
    for (const t of this.ttys) if (t.alive && t.containerId === id && (all || argv.some(a => /^[a-f0-9]{24}$/.test(a) && t.argv.includes(a)))) { t.end(); ended++; }
    if (all) return { exitCode: 0, output: `${ended}\n`, truncated: false };
    // the dump import (IMPORT_ARGV) replaces the database in the container's data volume; the content stands for the dump
    if (argv[0] === 'bash' && /gunzip -cf .*\| mysql /.test(argv.at(-1) ?? '')) {
      const dump = [...c.files].find(([k]) => k.endsWith('/lotse-import/dump'))?.[1];
      for (const m of mountsOf(c.spec)) { const v = this.volumes.get(m.Source); if (v) v.data = [`import:${dump?.length ?? 0}`]; }
    }
    // sync.ts RESTORE_SH: the image's config/ and src/ kept once, each path removed and the image's version put back
    if (argv[0] === 'bash' && argv[3] === 'lotse-restore') {
      const root = '/var/www/html', b = `${root}/var/lotse-image`;
      if (!c.files.has(`${b}/.complete`)) {
        for (const [k, v] of [...c.files]) if (k.startsWith(`${root}/config/`) || k.startsWith(`${root}/src/`)) c.files.set(`${b}/${k.slice(root.length + 1)}`, v);
        c.files.set(`${b}/.complete`, Buffer.alloc(0));
      }
      for (const rel of argv.slice(4)) {
        for (const k of [...c.files.keys()]) if (k === `${root}/${rel}` || k.startsWith(`${root}/${rel}/`)) c.files.delete(k);
        for (const [k, v] of [...c.files]) if (k === `${b}/${rel}` || k.startsWith(`${b}/${rel}/`)) c.files.set(`${root}/${k.slice(b.length + 1)}`, v);
      }
    }
    if (argv[0] === 'rm' && argv.includes('--')) for (const target of argv.slice(argv.indexOf('--') + 1)) for (const k of [...c.files.keys()]) if (k === target || k.startsWith(`${target}/`)) c.files.delete(k);
    const r = this.script(argv, id) ?? dockwareAnswers(argv, c) ?? {};
    return { exitCode: r.exitCode ?? 0, output: r.output ?? '', truncated: r.truncated ?? false };
  }
  /** Echo shell: prompt, line editing (backspace, Ctrl-C), a few commands (whoami, pwd, stty size, plugin:list, echo), exit ends it. */
  async openTty(id: string, argv: readonly string[], o: TtyOpts): Promise<TtySession> {
    this.enter('openTty', { id, argv: [...argv], user: o.user, detail: { workdir: o.workdir, env: o.env, cols: o.cols, rows: o.rows } });
    const c = this.managed(id);
    if (!c.running) throw new Error('Container läuft nicht.');
    assertTtySize(o.cols, o.rows);
    const out = ttyEmitter();
    const emit = (text: string) => { if (!t.alive || !text) return; const b = Buffer.from(text); if (t.paused) (t.held ??= []).push(b); else out.emit(b); };
    const t: FakeTty = { containerId: c.id, argv: [...argv], opts: o, cols: o.cols, rows: o.rows, alive: true, input: '', end: () => { if (!t.alive) return; t.alive = false; out.end(); } };
    this.ttys.push(t);
    // like the PS1 of the dockware console rc: the console user, the container's host name, the full directory
    const prompt = () => emit(`\x1b[32m${shellUser(t)}@${c.spec.Hostname ?? 'sandbox'}\x1b[0m:\x1b[34m${o.workdir}\x1b[0m$ `);
    let line = '';
    prompt();
    return {
      write: d => {
        if (!t.alive) return;
        const text = d.toString();
        t.input += text;
        for (const ch of text) {
          if (ch === '\r' || ch === '\n') { emit('\r\n'); const reply = fakeShell(t, line); line = ''; if (reply === null) { emit('logout\r\n'); t.end(); return; } emit(reply); prompt(); }
          else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); emit('\b \b'); } }
          else if (ch === '\x03') { line = ''; emit('^C\r\n'); prompt(); }
          else if (ch === '\x04' && !line) { emit('logout\r\n'); t.end(); return; }
          else if (ch >= ' ') { line += ch; emit(ch); }
        }
      },
      resize: async (cols, rows) => { assertTtySize(cols, rows); this.calls.push({ op: 'ttyResize', id, detail: { cols, rows } }); t.cols = cols; t.rows = rows; },
      pause: () => { t.paused = true; },
      resume: () => { t.paused = false; const b = t.held ?? []; t.held = []; for (const x of b) out.emit(x); },
      close: () => t.end(),
      onData: out.onData,
      onEnd: out.onEnd,
    };
  }
  async putArchive(id: string, dir: string, archive: Buffer | ArchiveStream) {
    this.enter('putArchive', { id, detail: dir });
    const c = this.managed(id);
    const tar = Buffer.isBuffer(archive) ? archive : await collect(archive);
    this.archives.push({ id, dir, entries: readTarEntries(tar) });
    for (const f of readTar(tar)) c.files.set(`${assertContainerPath(dir).replace(/\/$/, '')}/${f.path}`, f.data);
  }
  async inspectNetwork(name: string) { this.enter('inspectNetwork', { detail: name }); return this.networks.get(name) ?? null; }
  async createNetwork(name: string, opts: NetworkOpts) {
    this.enter('createNetwork', { detail: { name, ...opts } });
    this.networks.set(assertNetworkName(name), { name, internal: opts.internal, labels: opts.labels, subnets: opts.subnet ? [opts.subnet] : [], isolated: !!opts.isolated, icc: opts.icc !== false });
  }
  async connectEgress(id: string) {
    this.enter('connectEgress', { id });
    const c = this.managed(id);
    assertEgressNetwork(this.networks.get(EGRESS_NET) ?? null);
    if (!c.networks.includes(EGRESS_NET)) c.networks.push(EGRESS_NET);
  }
  async disconnectEgress(id: string) {
    this.enter('disconnectEgress', { id });
    const c = this.containers.get(assertId(id));
    if (!c) return;
    this.managed(id);
    c.networks = c.networks.filter(n => n !== EGRESS_NET);
  }
  async createVolume(name: string, labels: Record<string, string>) {
    this.enter('createVolume', { detail: { name, labels } });
    if (!isManaged(labels)) throw new Error('Volumes ohne Lotse-Label werden nicht angelegt.');
    if (!this.volumes.has(assertVolumeName(name))) this.volumes.set(name, { name, labels: { ...labels }, data: [] });
  }
  async inspectVolume(name: string): Promise<VolumeInfo | null> {
    this.enter('inspectVolume', { detail: name });
    const v = this.volumes.get(assertVolumeName(name));
    if (v && !isManaged(v.labels)) throw new Error(`Volume ${name} gehört nicht zu Lotse (Label lotse.managed=1 fehlt).`);
    return v ? { name: v.name, labels: { ...v.labels } } : null;
  }
  async removeVolume(name: string) {
    this.enter('removeVolume', { detail: name });
    const v = this.volumes.get(assertVolumeName(name));
    if (!v) return;
    if (!isManaged(v.labels)) throw new Error(`Volume ${name} gehört nicht zu Lotse (Label lotse.managed=1 fehlt).`);
    if ([...this.containers.values()].some(c => mountsOf(c.spec).some(m => m.Source === name))) throw new Error(`Volume ${name} wird noch von einem Container benutzt.`);
    this.volumes.delete(name);
  }
  async listVolumes(labels: Record<string, string> = {}) {
    this.enter('listVolumes', { detail: labels });
    const want = { ...labels, ...MANAGED };
    return [...this.volumes.values()].filter(v => Object.entries(want).every(([k, x]) => v.labels[k] === x)).map(v => ({ name: v.name, labels: { ...v.labels } }));
  }
  /** Tests: stop all fake storefronts. */
  async close() { for (const c of this.containers.values()) await this.closeServer(c); }
}
