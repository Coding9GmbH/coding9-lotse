import 'server-only';
// The only door to Docker. A closed set of operations, and only on containers labelled lotse.managed=1.
// Implementations: Docker Engine API (docker-engine.ts) and an in-memory fake for tests and e2e (fake-runner.ts),
// chosen via LOTSE_SANDBOX_RUNNER=fake. The AI never gets this object; only server code (setup job, executor) uses it.
import type { Readable } from 'node:stream';
import { singleton } from '../state';
import { DockerEngine } from './docker-engine';
import { FakeRunner } from './fake-runner';

export { MANAGED, MANAGED_LABEL, TASK_LABEL } from './guards';

/** Body of POST /containers/create; built only by server code from a template, never from input. */
export interface ContainerSpec {
  name: string;
  Image: string;
  Labels: Record<string, string>;
  Env?: string[];
  Hostname?: string;
  /** screenshot containers only: the fixed script and its user (guards.ts) */
  Cmd?: string[];
  /** database copy containers only: the fixed copy command (db-snapshot-spec.ts) */
  Entrypoint?: string[];
  User?: string;
  ExposedPorts?: Record<string, object>;
  HostConfig?: Record<string, unknown>;
  NetworkingConfig?: Record<string, unknown>;
}
export interface ContainerInfo { id: string; name: string; image: string; state: string; running: boolean; labels: Record<string, string>; /** storefront address on the internal network lotse-sandbox (null = not attached there) */ address: { host: string; port: number } | null;
  /** names of the Docker networks the container is attached to */ networks: string[];
  /** inspect only: exit code of the last run and whether the kernel killed it for its memory limit */ exitCode?: number; oomKilled?: boolean }
export interface NetworkInfo { name: string; internal: boolean; labels: Record<string, string>; /** IPAM subnets (CIDR) */ subnets: string[];
  /** gateway_mode_ipv4=isolated: the host has no address on the bridge */ isolated: boolean; /** IPAM gateway (the host's address on the bridge) */ gateway?: string;
  /** containers on the bridge may talk to each other (Docker's default; enable_icc=false turns it off) */ icc: boolean }
export interface NetworkOpts { internal: boolean; labels: Record<string, string>; subnet?: string; isolated?: boolean; /** false = enable_icc=false */ icc?: boolean }
/** A label-managed volume (stored databases: db-snapshots.ts) */
export interface VolumeInfo { name: string; labels: Record<string, string>; createdAt?: string }
export interface ExecOpts { user: string; workdir?: string; env?: string[]; timeoutMs: number; signal?: AbortSignal; stdin?: Buffer; /** keep at most this many bytes (the end of the output) */ maxOutput?: number }
export interface ExecResult { exitCode: number; output: string; truncated: boolean }
export interface PullProgress { text: string; pct?: number }
/** An interactive shell in a task container (exec with a TTY): only the user's console uses it (console.ts), never the AI. */
export interface TtyOpts { user: string; workdir: string; env: string[]; cols: number; rows: number }
export interface TtySession {
  /** raw input (keystrokes, pasted text) */
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): Promise<void>;
  /** flow control: stop reading the output (the shell blocks once the buffers are full), and read again */
  pause(): void;
  resume(): void;
  /** drops the connection; the shell in the container may keep running (console.ts ends it with its own exec) */
  close(): void;
  /** raw terminal output (one TTY stream, not multiplexed); chunks that arrived before the first listener are delivered to it */
  onData(fn: (chunk: Buffer) => void): void;
  /** the stream ended: the shell exited, the container stopped or close() */
  onEnd(fn: () => void): void;
}
/** Terminal size a runner passes to Docker: whole numbers 1–1000 (console.ts narrows it further); anything else is refused. */
export function assertTtySize(cols: unknown, rows: unknown): void {
  const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000;
  if (!ok(cols) || !ok(rows)) throw new Error('Ungültige Terminalgröße.');
}
/** Bytes of TTY output kept for a session until its first onData listener (the end of them; normally just the first prompt) */
export const TTY_EARLY_MAX = 256 * 1024;
/** Output and end fan-out of a TtySession, shared by the runners: chunks that arrive before the first onData listener are kept
 *  (at most TTY_EARLY_MAX bytes, the newest) and handed to it; the end listeners run once, also when registered afterwards. */
export function ttyEmitter() {
  const data: ((b: Buffer) => void)[] = [], ends: (() => void)[] = [];
  let early: Buffer[] | null = [], size = 0, done = false;
  return {
    get ended() { return done; },
    emit(b: Buffer) {
      if (done || !b.length) return;
      if (!early) { for (const fn of data) fn(b); return; }
      early.push(b); size += b.length;
      while (size > TTY_EARLY_MAX) { const over = size - TTY_EARLY_MAX, first = early[0]; if (first.length <= over) { early.shift(); size -= first.length; } else { early[0] = first.subarray(over); size -= over; } }
    },
    end() { if (done) return; done = true; for (const fn of ends.splice(0)) fn(); },
    onData(fn: (b: Buffer) => void) { data.push(fn); if (early) { const b = early; early = null; size = 0; for (const c of b) fn(c); } },
    onEnd(fn: () => void) { if (done) fn(); else ends.push(fn); },
  };
}
/** A large archive streamed from disk (dump import): length is the exact byte count. */
export interface ArchiveStream { stream: Readable; length: number }

export interface SandboxRunner {
  readonly kind: 'docker' | 'fake';
  ping(): Promise<void>;
  version(): Promise<{ apiVersion: string; version: string }>;
  imagePresent(image: string): Promise<boolean>;
  /** inspect, otherwise pull with progress; true = pulled now */
  ensureImage(image: string, onProgress?: (p: PullProgress) => void, signal?: AbortSignal): Promise<{ pulled: boolean }>;
  /** builds a local image from a Dockerfile (the only file of the build context); `image` must be one the guards allow (custom-image.ts).
   *  A failed build throws with the tail of the build output. */
  buildImage(image: string, dockerfile: string, onProgress?: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSec?: number): Promise<void>;
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<ContainerInfo | null>;
  /** the last `tail` lines of the container's output (stdout and stderr), e.g. why it exited while starting */
  logs(id: string, o: { tail: number }): Promise<string>;
  exec(id: string, argv: readonly string[], opts: ExecOpts): Promise<ExecResult>;
  /** interactive exec with a TTY (hijacked connection, both directions), resizable */
  openTty(id: string, argv: readonly string[], opts: TtyOpts): Promise<TtySession>;
  putArchive(id: string, dir: string, tar: Buffer | ArchiveStream, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  /** tar of a path in the container (screenshots); more than maxBytes = error */
  getArchive(id: string, path: string, o: { maxBytes: number; timeoutMs?: number }): Promise<Buffer>;
  /** until the container has stopped; its exit code. Timeout or abort = error (the container keeps running) */
  wait(id: string, o: { timeoutMs: number; signal?: AbortSignal }): Promise<number>;
  /** managed containers only; extra labels narrow the list */
  list(labels?: Record<string, string>): Promise<ContainerInfo[]>;
  inspectNetwork(name: string): Promise<NetworkInfo | null>;
  /** only lotse-sandbox and lotse-sandbox-egress */
  createNetwork(name: string, opts: NetworkOpts): Promise<void>;
  /** only volumes named like a snapshot or a task database (db-snapshot-spec.ts), always with lotse.managed=1 */
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  /** null = missing (also: a volume of that name without the Lotse label is reported as foreign, never as missing) */
  inspectVolume(name: string): Promise<VolumeInfo | null>;
  /** managed volumes only; missing = nothing to do; in use = error */
  removeVolume(name: string): Promise<void>;
  /** managed volumes only; extra labels narrow the list */
  listVolumes(labels?: Record<string, string>): Promise<VolumeInfo[]>;
  /** Internet for a task: attach a managed container to lotse-sandbox-egress (a Lotse-labelled network), or detach it. Idempotent. */
  connectEgress(id: string): Promise<void>;
  disconnectEgress(id: string): Promise<void>;
}

// ---- Selection ----
const holder = () => singleton<{ runner: SandboxRunner | null }>('sandboxRunner', () => ({ runner: null }));

export function getRunner(): SandboxRunner {
  const h = holder();
  if (!h.runner) {
    // Nothing is contacted before the first call: constructing a runner has no side effects
    h.runner = process.env.LOTSE_SANDBOX_RUNNER === 'fake' ? new FakeRunner() : new DockerEngine();
  }
  return h.runner;
}
/** Tests: inject a runner (null = choose again from the environment). */
export const setRunner = (r: SandboxRunner | null) => { holder().runner = r; };
