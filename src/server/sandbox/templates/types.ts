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
  /** technical name the user chose for a new plugin (used only if the cloned repository is empty) */
  newPluginName: string | null;
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
  /** the task's uploaded dump waiting for the import (metadata only; the AI never gets this context) */
  dump: () => { name: string; size: number; ignoreVersion: boolean } | null;
  /** the task has a dump at all (waiting or already imported): its themes need compiling even when nothing else does */
  hasDump: () => boolean;
  /** Shopware major.minor recorded in the dump's core migrations, null = not recognizable */
  dumpVersion: () => Promise<string | null>;
  /** dump version differs from the image: shown with "Trotzdem fortfahren" (null clears it) */
  setVersionMismatch: (v: { dump: string; image: string } | null) => void;
  /** streams the dump as <dir>/dump (owner www-data, mode 0600) into the container */
  copyDump: (dir: string) => Promise<void>;
  /** after the import (success or not): deletes the dump on the host and `containerDir` in the container, records the result */
  discardDump: (imported: boolean, containerDir: string) => Promise<void>;
  /** while waiting for the container: throws a clear German error (exit code, end of the container log) once it is no longer running */
  checkAlive: () => Promise<void>;
  log: (line: string) => void;
  signal: AbortSignal;
}

/** A file written into the (possibly stopped) container before every start, e.g. a boot hook of the image. Constant content. */
export interface BootFile { dir: string; name: string; content: string; mode: number }
/** Shutting the container's services down cleanly before `docker stop` (whose signal the image may ignore). */
export interface GracefulStop { argv: string[]; user: string; timeoutMs: number; /** docker stop's grace period afterwards */ stopTimeoutSec: number }

/** The user's interactive console (console.ts): the shell's user, directory, environment and the commands that start and end it.
 *  Template code, never input; the AI never gets a console tool. `sid` is the console session id (24 hex characters, from Lotse). */
export interface ConsoleSpec {
  /** the shell's user (shown and audited; the wrapper may start as another user and drop to it) */
  user: string;
  workdir: string;
  env: string[];
  /** the shell's wrapper (exec with a TTY): it records the shell's pid (with a TTY also its session id) for sid, so it can be ended later */
  start: (sid: string) => { argv: string[]; user: string };
  /** ends that console: its whole process tree, also commands started with sudo in a session of their own (hence its own user) */
  stop: (sid: string) => { argv: string[]; user: string };
  /** ends every console session of the container (after a Lotse restart nobody holds them any more); its output is the number ended */
  stopAll: { argv: string[]; user: string };
}

/** Input of the pure container spec builder: only server-side values (validated task id, configured image, limits). */
export interface SpecInput {
  taskId: string; image: string; memoryMb: number; cpus: number; env: string[];
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

/** Where a template's code runs: in a task container (Docker), or nowhere local ('none': the platform itself hosts the preview). */
export type TemplateRuntime = 'container' | 'none';
/** Where the preview comes from. 'sandbox': the task container's storefront through the /sbx proxy (preview.ts). 'platform': a preview
 *  the platform hosts (Shopify: the storefront with ?preview_theme_id= of an unpublished theme); the URL is built from server-side values only. */
export type PreviewProvider = { kind: 'sandbox' } | { kind: 'platform'; previewUrl: (o: { shopDomain: string; themeId: number }) => string };

export interface SandboxTemplate {
  id: string;
  labelKey: string;
  platform: 'shopware';
  runtime: 'container';
  /** only enabled templates can be chosen and run (the registry may list prepared ones) */
  enabled: boolean;
  /** missing = { kind: 'sandbox' } */
  previewProvider?: PreviewProvider;
  /** the one allowed image must match this, e.g. ^dockware/shopware:<version>$ */
  imagePattern: RegExp;
  defaultImage: string;
  steps: TemplateStep[];
  commands: CommandSpec[];
  /** container create body, pure: user or AI input never reaches it */
  buildSpec: (o: SpecInput) => ContainerSpec;
  /** what the cloned repository is (an empty one: a new plugin named `newPluginName`); throws a clear German error for unsupported layouts */
  detectLayout: (worktree: string, o?: { newPluginName?: string | null; repo?: string }) => TaskLayout;
  /** absolute directory in the container the workspace is mirrored to */
  syncTarget: (l: TaskLayout) => string;
  /** user and working directory for setup commands and own commands */
  execUser: string;
  workdir: string;
  bootFile?: BootFile;
  gracefulStop?: GracefulStop;
  /** missing = no console tab */
  console?: ConsoleSpec;
}

/**
 * A template without a container (runtime 'none'), e.g. a Shopify theme: no Docker, no commands, no setup steps in Lotse. The code is
 * edited in the task workspace as usual; the platform renders the preview. The only write is a human-triggered executor that pushes
 * the workspace to a theme Lotse created itself and that is never published (`target`); the live theme is never touched.
 */
export interface ContainerlessTemplate {
  id: string;
  labelKey: string;
  platform: 'shopify';
  runtime: 'none';
  enabled: boolean;
  previewProvider: Extract<PreviewProvider, { kind: 'platform' }>;
  /** where the executor writes: always an unpublished theme created by Lotse */
  target: 'unpublished-theme';
  /** checks that the cloned repository is what the template expects; throws a clear German error otherwise */
  checkRepo: (worktree: string) => void;
}
export type AnyTemplate = SandboxTemplate | ContainerlessTemplate;
