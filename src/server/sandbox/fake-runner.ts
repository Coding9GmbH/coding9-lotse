import 'server-only';
// In-memory runner for tests and e2e (LOTSE_SANDBOX_RUNNER=fake): no Docker, records every call.
// Exec results are scripted; each started container gets a small node:http "storefront" that serves the synced files.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ContainerInfo, ContainerSpec, ExecOpts, ExecResult, NetworkInfo, PullProgress, SandboxRunner } from './runner';
import { MANAGED, assertAllowedImage, assertContainerPath, assertId, assertManaged, assertSafeSpec, isManaged } from './guards';

export interface FakeCall { op: string; id?: string; argv?: string[]; user?: string; detail?: unknown }
interface FakeContainer { id: string; spec: ContainerSpec; running: boolean; files: Map<string, Buffer>; server: http.Server | null; port: number | null }
type ExecScript = (argv: readonly string[], id: string) => Partial<ExecResult> | undefined;

/** Minimal tar reader (ustar): regular files only. */
export function readTar(tar: Buffer): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = str(0, 100), prefix = str(345, 500), size = parseInt(str(124, 136).trim() || '0', 8), type = String.fromCharCode(h[156] || 48);
    const data = tar.subarray(off + 512, off + 512 + size);
    if (type === '0') out.push({ path: prefix ? `${prefix}/${name}` : name, data: Buffer.from(data) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const WEBROOT = '/var/www/html/public';

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
  private seq = 0;

  private enter(op: string, call: Omit<FakeCall, 'op'> = {}) {
    this.calls.push({ op, ...call });
    if (this.down) throw new Error('Docker ist nicht erreichbar – Docker-Socket bzw. DOCKER_HOST einrichten.');
    if (this.failNext?.op === op) { const m = this.failNext.message; this.failNext = null; throw new Error(m); }
  }
  private managed(id: string): FakeContainer { const c = this.containers.get(assertId(id)); assertManaged(this.info(c)); return c!; }
  private info(c: FakeContainer | undefined): ContainerInfo | null {
    return c ? { id: c.id, name: c.spec.name, image: c.spec.Image, state: c.running ? 'running' : 'exited', running: c.running, labels: c.spec.Labels, port: c.port } : null;
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
    const id = `fake${(++this.seq).toString().padStart(8, '0')}`;
    this.containers.set(id, { id, spec, running: false, files: new Map(), server: null, port: null });
    return id;
  }
  async start(id: string) {
    this.enter('start', { id });
    const c = this.managed(id);
    if (c.running) return;
    c.running = true;
    c.server = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      const file = c.files.get(`${WEBROOT}${p === '/' ? '/index.html' : p}`);
      if (file) { res.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); res.end(file); return; }
      if (p === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang="de"><head><title>Sandbox ${c.spec.name}</title></head><body><h1>Fake-Storefront</h1><p>${c.files.size} Dateien</p></body></html>`); return; }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    });
    await new Promise<void>(ok => c.server!.listen(0, '127.0.0.1', ok));
    c.port = (c.server.address() as AddressInfo).port;
  }
  async stop(id: string) {
    this.enter('stop', { id });
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
  private async closeServer(c: FakeContainer) {
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
    const r = this.script(argv, id) ?? {};
    return { exitCode: r.exitCode ?? 0, output: r.output ?? '', truncated: r.truncated ?? false };
  }
  async putArchive(id: string, dir: string, tar: Buffer) {
    this.enter('putArchive', { id, detail: dir });
    const c = this.managed(id);
    for (const f of readTar(tar)) c.files.set(`${assertContainerPath(dir).replace(/\/$/, '')}/${f.path}`, f.data);
  }
  async inspectNetwork(name: string) { this.enter('inspectNetwork', { detail: name }); return this.networks.get(name) ?? null; }
  async createNetwork(name: string, opts: { internal: boolean; labels: Record<string, string> }) {
    this.enter('createNetwork', { detail: { name, ...opts } });
    this.networks.set(name, { name, internal: opts.internal, labels: opts.labels });
  }
  /** Tests: stop all fake storefronts. */
  async close() { for (const c of this.containers.values()) await this.closeServer(c); }
}
