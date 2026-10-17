// Sandbox templates: a fixed recipe per platform (image pattern, setup steps, allow-listed commands).
// Templates are code, never configuration: neither the AI nor chat input can add steps or commands.
import type { CommandPhase, SandboxStepKey, SandboxCommandKey, TaskLayout } from '@/lib/protocol';
import type { ContainerSpec } from '../runner';

/** What a step may do: a restricted facade over the runner, git and the workspace, bound to one task. */
export interface StepCtx {
  taskId: string;
  repo: string;
  baseBranch: string;
  image: string;
  /** detected by detect-layout; null before */
  layout: () => TaskLayout | null;
  setLayout: (l: TaskLayout) => void;
  /** a fixed argv or the id of an allow-listed command; never a shell string from input. Throws on a non-zero exit (with the output's tail). */
  run: (cmd: readonly string[] | { command: SandboxCommandKey; args?: Record<string, string> }, o?: { timeoutMs?: number; okCodes?: number[]; /** polling: neither the command nor its output go to the log */ quiet?: boolean }) => Promise<{ exitCode: number; output: string }>;
  ensureImage: () => Promise<void>;
  /** fresh clone of repo@baseBranch into the task workspace (an old one is removed first) */
  clone: () => Promise<{ head: string }>;
  /** absolute path of the cloned worktree (read-only use: layout detection) */
  worktree: string;
  /** removes an old container of the task, creates one from buildSpec and starts it */
  createContainer: () => Promise<void>;
  /** HTTP status of a storefront path, requested by Lotse with Host: localhost (the domain Dockware knows) */
  httpStatus: (path: string) => Promise<number>;
  /** workspace → container (full mirror of the plugin directory) */
  syncAll: () => Promise<void>;
  log: (line: string) => void;
  signal: AbortSignal;
}

/** Input of the pure container spec builder: only server-side values (validated task id, configured image, limits). */
export interface SpecInput {
  taskId: string; image: string; memoryMb: number; cpus: number; env: string[];
  mode: 'network' | 'local'; /** local mode: host port on 127.0.0.1 */ port?: number;
}

export interface TemplateStep {
  id: SandboxStepKey;
  /** i18n key below sandbox.steps */
  labelKey: SandboxStepKey;
  timeoutMs: number;
  /** slot where the user's own setup commands of this phase run (each one as its own step) */
  custom?: CommandPhase;
  optional?: boolean;
  /** 'skipped' = nothing to do (e.g. no dump uploaded) */
  run?: (ctx: StepCtx) => Promise<void | 'skipped'>;
}

export interface CommandArg { name: string; pattern: RegExp }
/** Where the synced code lives inside the container; known after the layout was detected. */
export interface CommandCtx { pluginDir: string }

export interface CommandSpec {
  id: SandboxCommandKey;
  /** i18n key below sandbox.commands */
  labelKey: SandboxCommandKey;
  args: CommandArg[];
  /** argv from validated args only (see resolveCommand) */
  argv: (args: Record<string, string>, ctx: CommandCtx) => string[];
  user: string;
  workdir: string;
  timeoutMs: number;
  /** output is cut after this many bytes */
  maxOutput: number;
}

export interface SandboxTemplate {
  id: string;
  labelKey: string;
  platform: 'shopware';
  /** the one allowed image must match this, e.g. ^dockware/shopware:<version>$ */
  imagePattern: RegExp;
  defaultImage: string;
  steps: TemplateStep[];
  commands: CommandSpec[];
  /** container create body, pure: user or AI input never reaches it */
  buildSpec: (o: SpecInput) => ContainerSpec;
  /** what the cloned repository is; throws a clear German error for unsupported layouts */
  detectLayout: (worktree: string) => TaskLayout;
  /** absolute directory in the container the workspace is mirrored to */
  syncTarget: (l: TaskLayout) => string;
  /** user and working directory for setup commands and own commands */
  execUser: string;
  workdir: string;
}
