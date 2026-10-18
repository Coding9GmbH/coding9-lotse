import 'server-only';
// Docker Engine API over node:http (unix socket or tcp://, e.g. the filtering socket proxy). No docker CLI, no shell.
// Every call that touches a container first checks its lotse.managed label.
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Socket } from 'node:net';
import type { ArchiveStream, ContainerInfo, ContainerSpec, ExecOpts, ExecResult, NetworkInfo, NetworkOpts, PullProgress, SandboxRunner } from './runner';
import { MANAGED, assertAllowedImage, assertContainerPath, assertEgressNetwork, assertId, assertManaged, assertNetworkName, assertSafeSpec } from './guards';
import { EGRESS_NET, ICC_OPTION, ISOLATED_GATEWAY, SANDBOX_NET } from './labels';

const PREFERRED_API = '1.41';
const REQUEST_TIMEOUT_MS = 30_000;
/** ping/version: the health route waits for them, a blackholed DOCKER_HOST must not stall it */
const PROBE_TIMEOUT_MS = 3_000;

type Target = { socketPath: string } | { host: string; port: number };
/** DOCKER_HOST: unix:///path or tcp://host:port. Anything else (ssh://, https with certificates) is not supported. */
export function parseDockerHost(raw = process.env.DOCKER_HOST): Target {
  const v = (raw ?? '').trim() || 'unix:///var/run/docker.sock';
  if (v.startsWith('unix://')) return { socketPath: v.slice(7) };
  const m = /^tcp:\/\/([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})\/?$/.exec(v);
  if (m) return { host: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]) };
  throw new Error('DOCKER_HOST wird nicht unterstützt: erlaubt sind unix:///pfad/docker.sock oder tcp://host:port (z. B. der Socket-Proxy).');
}

const cmpVersion = (a: string, b: string) => { const [x1, y1] = a.split('.').map(Number), [x2, y2] = b.split('.').map(Number); return x1 - x2 || y1 - y2; };
/** Our preferred API version, raised to the daemon's minimum if that is newer (Docker 29+ may refuse old versions). */
export const pickApiVersion = (server: { ApiVersion?: string; MinAPIVersion?: string }) =>
  server.MinAPIVersion && cmpVersion(server.MinAPIVersion, PREFERRED_API) > 0 ? server.MinAPIVersion : PREFERRED_API;

interface Res { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
interface Req { query?: Record<string, string>; body?: unknown; raw?: Buffer; stream?: ArchiveStream; contentType?: string; timeoutMs?: number; signal?: AbortSignal; onData?: (chunk: Buffer) => void; /** body larger than this = error */ maxBytes?: number }

const unreachable = (e: NodeJS.ErrnoException) => new Error(
  e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Docker ist nicht erreichbar – Docker-Socket bzw. DOCKER_HOST einrichten.'
    : e.code === 'EACCES' ? 'Kein Zugriff auf den Docker-Socket (Berechtigung fehlt).' : `Docker ist nicht erreichbar: ${e.code ?? e.message}`);

/** Docker error body {message} → short German-prefixed text. */
const apiError = (r: Res, what: string) => {
  let msg = '';
  try { msg = String((JSON.parse(r.body.toString('utf8')) as { message?: unknown }).message ?? ''); } catch { msg = r.body.toString('utf8'); }
  return new Error(`${what}: Docker meldet HTTP ${r.status}${msg ? ` – ${msg.replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}`);
};

// ---- Exec stream: 8-byte frame header (stream type, 3×0, uint32 BE length) followed by the payload ----
export function createDemuxer(onFrame: (stream: number, data: Buffer) => void) {
  let buf: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 8) {
      const len = buf.readUInt32BE(4);
      if (buf.length < 8 + len) break;
      onFrame(buf[0], buf.subarray(8, 8 + len));
      buf = buf.subarray(8 + len);
    }
  };
}
/** Body of /containers/{id}/logs: multiplexed frames for a container without TTY (ours), plain text otherwise. */
export function demuxLog(body: Buffer): string {
  if (body.length < 8 || body[0] > 2 || body[1] || body[2] || body[3]) return body.toString('utf8');
  const parts: Buffer[] = [];
  createDemuxer((_s, d) => parts.push(d))(body);
  return Buffer.concat(parts).toString('utf8');
}
/** Keeps the last `max` bytes (errors are at the end). */
function tailBuffer(max: number) {
  const parts: Buffer[] = []; let size = 0, truncated = false;
  return {
    push(b: Buffer) { parts.push(b); size += b.length; while (size > max && parts.length) { const over = size - max, first = parts[0]; if (first.length <= over) { parts.shift(); size -= first.length; } else { parts[0] = first.subarray(over); size -= over; } truncated = true; } },
    get: () => ({ output: Buffer.concat(parts).toString('utf8'), truncated }),
  };
}

/** Pull progress: JSON lines {status, id, progressDetail:{current,total}} or {error}. Average over the layers seen so far. */
export function pullProgressParser(onProgress: (p: PullProgress) => void) {
  const layers = new Map<string, { current: number; total: number }>();
  let rest = '', error: string | null = null;
  const line = (l: string) => {
    let j: { status?: string; id?: string; error?: string; errorDetail?: { message?: string }; progressDetail?: { current?: number; total?: number } };
    try { j = JSON.parse(l); } catch { return; }
    if (j.error || j.errorDetail?.message) { error = j.error ?? j.errorDetail?.message ?? 'Fehler'; return; }
    if (j.id && j.progressDetail?.total) layers.set(j.id, { current: j.progressDetail.current ?? 0, total: j.progressDetail.total });
    if (j.id && /Pull complete|Already exists/.test(j.status ?? '')) { const x = layers.get(j.id); layers.set(j.id, { current: x?.total ?? 1, total: x?.total ?? 1 }); }
    let cur = 0, tot = 0;
    for (const x of layers.values()) { cur += x.current; tot += x.total; }
    onProgress({ text: j.status ? `${j.status}${j.id ? ` ${j.id}` : ''}` : '…', ...(tot ? { pct: Math.min(100, Math.round((cur / tot) * 100)) } : {}) });
  };
  return {
    push(chunk: Buffer) { rest += chunk.toString('utf8'); let i; while ((i = rest.indexOf('\n')) >= 0) { const l = rest.slice(0, i).trim(); rest = rest.slice(i + 1); if (l) line(l); } },
    end() { if (rest.trim()) line(rest.trim()); rest = ''; return error; },
  };
}

/** Storefront address of a container: its IPv4 on the internal network lotse-sandbox, port 80. Anything else (other networks, no IP) = null. */
export const netAddress = (nets: Record<string, { IPAddress?: string } | null> | undefined) => {
  const ip = nets?.[SANDBOX_NET]?.IPAddress ?? '';
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? { host: ip, port: 80 } : null;
};

type Nets = Record<string, { IPAddress?: string } | null> | undefined;
const netNames = (nets: Nets) => Object.keys(nets ?? {});

const imageRef = (image: string) => { const i = image.lastIndexOf(':'); return { fromImage: image.slice(0, i), tag: image.slice(i + 1) }; };
const enc = encodeURIComponent;

export class DockerEngine implements SandboxRunner {
  readonly kind = 'docker' as const;
  private api: Promise<string> | null = null;
  constructor(private readonly target: Target = parseDockerHost()) {}

  private raw(method: string, path: string, o: Req = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const qs = o.query ? `?${new URLSearchParams(o.query)}` : '';
      const payload = o.raw ?? (o.body !== undefined ? Buffer.from(JSON.stringify(o.body)) : undefined);
      const req = http.request({
        ...this.target, method, path: `${path}${qs}`, timeout: o.timeoutMs ?? REQUEST_TIMEOUT_MS,
        headers: { host: 'docker', ...(payload || o.stream ? { 'content-type': o.contentType ?? 'application/json', 'content-length': o.stream?.length ?? payload!.length } : {}) },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          if (o.onData && (res.statusCode ?? 500) < 300) { o.onData(c); return; }
          size += c.length;
          if (o.maxBytes !== undefined && size > o.maxBytes) { req.destroy(new Error(`Antwort von Docker ist zu groß (mehr als ${Math.round(o.maxBytes / 1048576)} MB).`)); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 500, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      const onAbort = () => req.destroy(new Error('Abgebrochen.'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => o.signal?.removeEventListener('abort', onAbort));
      req.on('timeout', () => req.destroy(new Error('Docker antwortet nicht (Timeout).')));
      req.on('error', (e: NodeJS.ErrnoException) => reject(e.code ? unreachable(e) : e));
      if (o.stream) pipeline(o.stream.stream, req).catch(e => req.destroy(e as Error));
      else req.end(payload);
    });
  }
  private async prefix(): Promise<string> {
    this.api ??= this.raw('GET', '/version').then(r => {
      if (r.status !== 200) throw apiError(r, 'Docker-Version');
      return `/v${pickApiVersion(JSON.parse(r.body.toString('utf8')))}`;
    }).catch(e => { this.api = null; throw e; });
    return this.api;
  }
  private async call(method: string, path: string, o: Req = {}) { return this.raw(method, `${await this.prefix()}${path}`, o); }
  private json = <T>(r: Res) => JSON.parse(r.body.toString('utf8') || 'null') as T;

  async ping() {
    const r = await this.raw('GET', '/_ping', { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.status !== 200) throw apiError(r, 'Docker-Ping');
  }
  async version() {
    const r = await this.raw('GET', '/version', { timeoutMs: PROBE_TIMEOUT_MS });
    if (r.status !== 200) throw apiError(r, 'Docker-Version');
    const v = this.json<{ ApiVersion?: string; Version?: string }>(r);
    return { apiVersion: String(v.ApiVersion ?? ''), version: String(v.Version ?? '') };
  }

  async imagePresent(image: string) {
    const r = await this.call('GET', `/images/${enc(assertAllowedImage(image))}/json`);
    if (r.status === 404) return false;
    if (r.status !== 200) throw apiError(r, 'Image prüfen');
    return true;
  }
  async ensureImage(image: string, onProgress: (p: PullProgress) => void = () => {}, signal?: AbortSignal) {
    if (await this.imagePresent(image)) return { pulled: false };
    const parser = pullProgressParser(onProgress);
    const r = await this.call('POST', '/images/create', { query: imageRef(image), timeoutMs: 30 * 60_000, signal, onData: c => parser.push(c) });
    if (r.status === 404) throw new Error(`Image „${image}“ gibt es nicht (Tag prüfen).`);
    if (r.status !== 200) throw apiError(r, 'Image laden');
    const err = parser.end();
    if (err) throw new Error(/not found|manifest unknown/i.test(err) ? `Image „${image}“ gibt es nicht (Tag prüfen).` : `Image laden fehlgeschlagen: ${err.slice(0, 300)}`);
    if (!(await this.imagePresent(image))) throw new Error(`Image „${image}“ fehlt nach dem Laden.`);
    return { pulled: true };
  }

  async create(spec: ContainerSpec) {
    const { name, ...body } = assertSafeSpec(spec);
    const r = await this.call('POST', '/containers/create', { query: { name }, body });
    if (r.status !== 201) throw apiError(r, 'Container anlegen');
    return assertId(this.json<{ Id: string }>(r).Id);
  }
  /** Inspect + label check: every write goes through here. */
  private async managed(id: string) { return assertManaged(await this.inspect(id)); }
  async start(id: string) {
    await this.managed(id);
    const r = await this.call('POST', `/containers/${enc(id)}/start`);
    if (r.status !== 204 && r.status !== 304) throw apiError(r, 'Container starten');
  }
  async stop(id: string, timeoutSec = 10) {
    await this.managed(id);
    const r = await this.call('POST', `/containers/${enc(id)}/stop`, { query: { t: String(timeoutSec) }, timeoutMs: (timeoutSec + 30) * 1000 });
    if (r.status !== 204 && r.status !== 304) throw apiError(r, 'Container stoppen');
  }
  async remove(id: string) {
    if (!(await this.inspect(id))) return;
    await this.managed(id);
    const r = await this.call('DELETE', `/containers/${enc(id)}`, { query: { force: '1', v: '1' }, timeoutMs: 120_000 });
    if (r.status !== 204 && r.status !== 404) throw apiError(r, 'Container löschen');
  }
  async inspect(id: string): Promise<ContainerInfo | null> {
    const r = await this.call('GET', `/containers/${enc(assertId(id))}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw apiError(r, 'Container prüfen');
    const c = this.json<{ Id: string; Name?: string; Config?: { Image?: string; Labels?: Record<string, string> | null }; State?: { Status?: string; Running?: boolean; ExitCode?: number; OOMKilled?: boolean }; NetworkSettings?: { Networks?: Nets } }>(r);
    return { id: c.Id, name: (c.Name ?? '').replace(/^\//, ''), image: c.Config?.Image ?? '', state: c.State?.Status ?? 'unknown', running: c.State?.Running === true, labels: c.Config?.Labels ?? {}, address: netAddress(c.NetworkSettings?.Networks), networks: netNames(c.NetworkSettings?.Networks),
      ...(typeof c.State?.ExitCode === 'number' ? { exitCode: c.State.ExitCode } : {}), ...(c.State?.OOMKilled ? { oomKilled: true } : {}) };
  }
  async logs(id: string, o: { tail: number }) {
    await this.managed(id);
    const tail = String(Math.max(1, Math.min(1000, Math.floor(o.tail))));
    const r = await this.call('GET', `/containers/${enc(id)}/logs`, { query: { stdout: '1', stderr: '1', tail }, maxBytes: 1024 * 1024, timeoutMs: 15_000 });
    if (r.status !== 200) throw apiError(r, 'Container-Log lesen');
    return demuxLog(r.body);
  }
  async list(labels: Record<string, string> = {}) {
    const filters = JSON.stringify({ label: Object.entries({ ...labels, ...MANAGED }).map(([k, v]) => `${k}=${v}`) });
    const r = await this.call('GET', '/containers/json', { query: { all: '1', filters } });
    if (r.status !== 200) throw apiError(r, 'Container auflisten');
    return this.json<{ Id: string; Names?: string[]; Image?: string; State?: string; Labels?: Record<string, string>; NetworkSettings?: { Networks?: Nets } }[]>(r)
      .filter(c => c.Labels?.[Object.keys(MANAGED)[0]] === '1') // never trust the filter alone
      .map(c => ({ id: c.Id, name: (c.Names?.[0] ?? '').replace(/^\//, ''), image: c.Image ?? '', state: c.State ?? 'unknown', running: c.State === 'running', labels: c.Labels ?? {}, address: netAddress(c.NetworkSettings?.Networks), networks: netNames(c.NetworkSettings?.Networks) }));
  }
  async putArchive(id: string, dir: string, tar: Buffer | ArchiveStream, o: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    await this.managed(id);
    const body = Buffer.isBuffer(tar) ? { raw: tar } : { stream: tar };
    const r = await this.call('PUT', `/containers/${enc(id)}/archive`, { query: { path: assertContainerPath(dir) }, ...body, contentType: 'application/x-tar', timeoutMs: o.timeoutMs ?? 120_000, signal: o.signal });
    if (r.status !== 200) throw apiError(r, 'Dateien übertragen');
  }

  async getArchive(id: string, path: string, o: { maxBytes: number; timeoutMs?: number }) {
    await this.managed(id);
    const r = await this.call('GET', `/containers/${enc(id)}/archive`, { query: { path: assertContainerPath(path) }, maxBytes: o.maxBytes, timeoutMs: o.timeoutMs ?? 60_000 });
    if (r.status !== 200) throw apiError(r, 'Dateien abholen');
    return r.body;
  }
  async wait(id: string, o: { timeoutMs: number; signal?: AbortSignal }) {
    await this.managed(id);
    const r = await this.call('POST', `/containers/${enc(id)}/wait`, { query: { condition: 'not-running' }, timeoutMs: o.timeoutMs, signal: o.signal });
    if (r.status !== 200) throw apiError(r, 'Auf Container warten');
    const code = this.json<{ StatusCode?: number }>(r).StatusCode;
    return typeof code === 'number' ? code : -1;
  }

  async exec(id: string, argv: readonly string[], o: ExecOpts): Promise<ExecResult> {
    await this.managed(id);
    if (!argv.length || argv.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Ungültiger Befehl.');
    const created = await this.call('POST', `/containers/${enc(id)}/exec`, { body: {
      Cmd: [...argv], User: o.user, WorkingDir: o.workdir, Env: o.env ?? [], AttachStdin: !!o.stdin, AttachStdout: true, AttachStderr: true, Tty: false,
    } });
    if (created.status !== 201) throw apiError(created, 'Befehl anlegen');
    const execId = assertId(this.json<{ Id: string }>(created).Id);
    const out = tailBuffer(o.maxOutput ?? 256 * 1024);
    await this.attach(`${await this.prefix()}/exec/${execId}/start`, out.push, o);
    const r = await this.call('GET', `/exec/${execId}/json`);
    if (r.status !== 200) throw apiError(r, 'Befehl prüfen');
    const { ExitCode } = this.json<{ ExitCode: number | null }>(r);
    return { exitCode: typeof ExitCode === 'number' ? ExitCode : -1, ...out.get() };
  }
  /** Start the exec with an upgraded connection (stdin possible), demux stdout/stderr until the stream ends. */
  private attach(path: string, onOut: (b: Buffer) => void, o: ExecOpts): Promise<void> {
    const body = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    return new Promise((resolve, reject) => {
      let sock: Socket | null = null, done = false;
      const finish = (e?: Error) => { if (done) return; done = true; clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); if (e) { sock?.destroy(); req.destroy(); reject(e); } else resolve(); };
      const timer = setTimeout(() => finish(new Error(`Zeitüberschreitung nach ${Math.round(o.timeoutMs / 1000)} s.`)), o.timeoutMs);
      const onAbort = () => finish(new Error('Abgebrochen.'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const demux = createDemuxer((_stream, data) => onOut(data));
      const req = http.request({ ...this.target, method: 'POST', path, headers: { host: 'docker', 'content-type': 'application/json', 'content-length': body.length, connection: 'Upgrade', upgrade: 'tcp' } });
      req.on('upgrade', (_res, s, head) => {
        sock = s;
        if (head.length) demux(head);
        s.on('data', demux);
        s.on('end', () => finish());
        s.on('close', () => finish());
        s.on('error', e => finish(e));
        if (o.stdin) s.write(o.stdin);
        s.end(); // half-close: stdin EOF, the output keeps flowing
      });
      req.on('response', res => { // without upgrade (some proxies): the body is the same multiplexed stream
        if ((res.statusCode ?? 500) >= 300) { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => finish(apiError({ status: res.statusCode ?? 500, headers: res.headers, body: Buffer.concat(c) }, 'Befehl starten'))); return; }
        res.on('data', demux); res.on('end', () => finish()); res.on('error', e => finish(e));
      });
      req.on('error', (e: NodeJS.ErrnoException) => finish(e.code ? unreachable(e) : e));
      req.end(body);
    });
  }

  async inspectNetwork(name: string): Promise<NetworkInfo | null> {
    const r = await this.call('GET', `/networks/${enc(name)}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw apiError(r, 'Netzwerk prüfen');
    const n = this.json<{ Name: string; Internal?: boolean; Labels?: Record<string, string> | null; Options?: Record<string, string> | null; IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] | null } }>(r);
    const cfg = n.IPAM?.Config ?? [], gateway = cfg.find(c => c.Gateway)?.Gateway;
    return { name: n.Name, internal: n.Internal === true, labels: n.Labels ?? {}, subnets: cfg.flatMap(c => (c.Subnet ? [c.Subnet] : [])), isolated: n.Options?.[ISOLATED_GATEWAY] === 'isolated', icc: n.Options?.[ICC_OPTION] !== 'false', ...(gateway ? { gateway } : {}) };
  }
  async createNetwork(name: string, opts: NetworkOpts) {
    const options = { ...(opts.isolated ? { [ISOLATED_GATEWAY]: 'isolated' } : {}), ...(opts.icc === false ? { [ICC_OPTION]: 'false' } : {}) };
    const r = await this.call('POST', '/networks/create', { body: { Name: assertNetworkName(name), Driver: 'bridge', Internal: opts.internal, Labels: opts.labels, CheckDuplicate: true,
      ...(Object.keys(options).length ? { Options: options } : {}), ...(opts.subnet ? { IPAM: { Config: [{ Subnet: opts.subnet }] } } : {}) } });
    if (r.status !== 201) throw apiError(r, 'Netzwerk anlegen');
  }
  async connectEgress(id: string) {
    const c = await this.managed(id);
    if (c.networks.includes(EGRESS_NET)) return;
    assertEgressNetwork(await this.inspectNetwork(EGRESS_NET));
    const r = await this.call('POST', `/networks/${enc(EGRESS_NET)}/connect`, { body: { Container: c.id } });
    if (r.status !== 200) throw apiError(r, 'Internetzugang einrichten');
  }
  async disconnectEgress(id: string) {
    const c = await this.inspect(id);
    if (!c || !c.networks.includes(EGRESS_NET)) return;
    assertManaged(c);
    const r = await this.call('POST', `/networks/${enc(EGRESS_NET)}/disconnect`, { body: { Container: c.id, Force: true } });
    if (r.status !== 200 && r.status !== 404) throw apiError(r, 'Internetzugang sperren');
  }
}
