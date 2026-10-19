// Sandbox templates: a fixed recipe per platform (image pattern, setup steps, allow-listed commands).
// Templates are code, never configuration: neither the AI nor chat input can add steps or commands.
import type { CommandPhase, ProjectInstall, SandboxMode, SandboxStepKey, SandboxCommandKey, TaskLayout } from '@/lib/protocol';
import type { ConfigPlan } from '../project';
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
  /** A20: how the code goes into the container (start dialog, else .lotse/sandbox.json, else detected = 'auto') */
  mode: () => SandboxMode;
  /** target folder of an own setup (mode 'custom') */
  targetPath: () => string;
  /** technical name the user chose for a new plugin (used only if the cloned repository is empty) */
  newPluginName: string | null;
  /** a full project whose Shopware version differs from the image: the user chose "Trotzdem fortfahren" */
  ignoreProjectVersion: boolean;
  /** a fixed argv or the id of an allow-listed command; never a shell string from input. Throws on a non-zero exit (with the output's tail). */
  run: (cmd: readonly string[] | { command: SandboxCommandKey; args?: Record<string, string> }, o?: { timeoutMs?: number; okCodes?: number[]; /** another working directory (own commands of an own setup: its target) */ workdir?: string; /** polling: neither the command nor its output go to the log */ quiet?: boolean }) => Promise<{ exitCode: number; output: string }>;
  ensureImage: () => Promise<void>;
  /** fresh clone of repo@baseBranch into the task workspace (an old one is removed first) */
  clone: () => Promise<{ head: string }>;
  /** absolute path of the cloned worktree (read-only use: layout detection) */
  worktree: string;
  /** the repository's subfolder that holds the Shopware project, from .lotse/sandbox.json ("projectDir"); '' = look for it */
  projectDir: () => string;
  /** absolute path of the project's folder in the worktree: the worktree itself, or the layout's subfolder (read-only use) */
  projectRoot: () => string;
  /** names of the variables of the environment and of this sandbox (no values; COMPOSER_AUTH left out) */
  envNames: () => string[];
  /** how a whole project is installed: .lotse/sandbox.json "projectInstall", default full */
  projectInstall: () => ProjectInstall;
  /** internet for the setup itself (a whole project's composer install, the storefront build): only a human allows it (a click or "immer an"), as for the AI (internet.ts) */
  internet: {
    /** why internet cannot be allowed at all (environment "nie", no egress subnet); null = a human can allow it */
    blocked: () => string | null;
    /** "immer an" and not switched off for this task: await() connects without a click */
    auto: () => boolean;
    /** waits until a human allowed internet for this task (switch in the panel or the chat's line); the task shows that it waits */
    await: () => Promise<void>;
    /** detaches the container again (the setup goes on offline) */
    end: () => Promise<void>;
  };
  /** removes an old container of the task, creates one from buildSpec and starts it */
  createContainer: () => Promise<void>;
  /** HTTP status of a storefront path, requested by Lotse with Host: localhost (the domain Dockware knows) */
  httpStatus: (path: string) => Promise<number>;
  /** workspace → container (full mirror of the plugin directory; a project: its synced parts, with the config plan it returns) */
  syncAll: () => Promise<ConfigPlan | null>;
  /** the task's uploaded dump waiting for the import (metadata only; the AI never gets this context). library = a stored database
   *  (kept after the import); restored = its MySQL data came from a snapshot before the container started (nothing to import) */
  dump: () => { name: string; size: number; ignoreVersion: boolean; library: boolean; restored: boolean } | null;
  /** the task has a dump at all (waiting or already imported): its themes need compiling even when nothing else does */
  hasDump: () => boolean;
  /** Shopware major.minor recorded in the dump's core migrations, null = not recognizable */
  dumpVersion: () => Promise<string | null>;
  /** dump version differs from the image: shown with "Trotzdem fortfahren" (null clears it) */
  setVersionMismatch: (v: { dump: string; image: string } | null) => void;
  /** streams the dump as <dir>/dump (owner www-data, mode 0600) into the container */
  copyDump: (dir: string) => Promise<void>;
  /** after the import (success or not): deletes a one-off dump on the host (a stored database stays) and `containerDir` in the
   *  container (null = nothing was copied), records the result */
  discardDump: (imported: boolean, containerDir: string | null) => Promise<void>;
  /** after the import of a stored database: MySQL stopped cleanly, its data directory copied into the snapshot volume for this image,
   *  MySQL started again. 'skipped' (with the reason in the log) when there is nothing to save or snapshots are off; a failed copy
   *  only costs the snapshot, never the setup */
  saveDbSnapshot: () => Promise<void | 'skipped'>;
  /** while waiting for the container: throws a clear German error (exit code, end of the container log) once it is no longer running */
  checkAlive: () => Promise<void>;
  log: (line: string) => void;
  signal: AbortSignal;
}

/** A file written into the (possibly stopped) container before every start, e.g. a boot hook of the image. Constant content. */
export interface BootFile { dir: string; name: string; content: string; mode: number }
/** The template's database: its data directory (a volume of the task when it uses a stored database) and how to stop and start it
 *  cleanly (as root) around a snapshot. */
export interface DatabaseSpec { dataDir: string; stop: { argv: string[]; user: string }; start: { argv: string[]; user: string } }
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
  /** the task's database volume (stored databases), mounted at the template's database.dataDir */
  dbVolume?: string;
}

export interface TemplateStep {
  id: SandboxStepKey;
  /** i18n key below sandbox.steps */
  labelKey: SandboxStepKey;
  timeoutMs: number;
  /** slot where the user's own setup commands of this phase run (each one as its own step) */
  custom?: CommandPhase;
  optional?: boolean;
  /** a different time limit for a layout (e.g. a whole project installs much more than one plugin); default timeoutMs */
  timeoutFor?: (layout: TaskLayout | null) => number;
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
  detectLayout: (worktree: string, o?: { newPluginName?: string | null; repo?: string; projectDir?: string }) => TaskLayout;
  /** absolute directory in the container the workspace is mirrored to */
  syncTarget: (l: TaskLayout) => string;
  /** user and working directory for setup commands and own commands */
  execUser: string;
  workdir: string;
  bootFile?: BootFile;
  gracefulStop?: GracefulStop;
  /** missing = no snapshots of stored databases (they are imported every time) */
  database?: DatabaseSpec;
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
