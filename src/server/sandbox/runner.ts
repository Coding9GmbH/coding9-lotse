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
  ExposedPorts?: Record<string, object>;
  HostConfig?: Record<string, unknown>;
  NetworkingConfig?: Record<string, unknown>;
}
export interface ContainerInfo { id: string; name: string; image: string; state: string; running: boolean; labels: Record<string, string>; /** storefront address on the internal network lotse-sandbox (null = not attached there) */ address: { host: string; port: number } | null }
export interface NetworkInfo { name: string; internal: boolean; labels: Record<string, string>; /** IPAM subnets (CIDR) */ subnets: string[] }
export interface ExecOpts { user: string; workdir?: string; env?: string[]; timeoutMs: number; signal?: AbortSignal; stdin?: Buffer; /** keep at most this many bytes (the end of the output) */ maxOutput?: number }
export interface ExecResult { exitCode: number; output: string; truncated: boolean }
export interface PullProgress { text: string; pct?: number }
/** A large archive streamed from disk (dump import): length is the exact byte count. */
export interface ArchiveStream { stream: Readable; length: number }

export interface SandboxRunner {
  readonly kind: 'docker' | 'fake';
  ping(): Promise<void>;
  version(): Promise<{ apiVersion: string; version: string }>;
  imagePresent(image: string): Promise<boolean>;
  /** inspect, otherwise pull with progress; true = pulled now */
  ensureImage(image: string, onProgress?: (p: PullProgress) => void, signal?: AbortSignal): Promise<{ pulled: boolean }>;
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSec?: number): Promise<void>;
  remove(id: string): Promise<void>;
  inspect(id: string): Promise<ContainerInfo | null>;
  exec(id: string, argv: readonly string[], opts: ExecOpts): Promise<ExecResult>;
  putArchive(id: string, dir: string, tar: Buffer | ArchiveStream, o?: { timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  /** managed containers only; extra labels narrow the list */
  list(labels?: Record<string, string>): Promise<ContainerInfo[]>;
  inspectNetwork(name: string): Promise<NetworkInfo | null>;
  createNetwork(name: string, opts: { internal: boolean; labels: Record<string, string>; subnet?: string }): Promise<void>;
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
