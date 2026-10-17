// Sandbox templates: a fixed recipe per platform (image pattern, setup steps, allow-listed commands).
// Templates are code, never configuration: neither the AI nor chat input can add steps or commands.
import type { CommandPhase, SandboxStepKey, SandboxCommandKey } from '@/lib/protocol';

/** What a step may do: a restricted facade over the runner, bound to one task container. */
export interface StepCtx {
  taskId: string;
  /** a fixed argv or the id of an allow-listed command; never a shell string from input */
  exec: (cmd: readonly string[] | { command: SandboxCommandKey; args?: Record<string, string> }) => Promise<{ exitCode: number; output: string }>;
  putArchive: (dir: string, tar: Buffer) => Promise<void>;
  log: (line: string) => void;
  setMeta: (patch: Record<string, unknown>) => void;
  signal: AbortSignal;
}

export interface TemplateStep {
  id: SandboxStepKey;
  /** i18n key below sandbox.steps */
  labelKey: SandboxStepKey;
  timeoutMs: number;
  /** slot where the user's own setup commands of this phase run (each one as its own step) */
  custom?: CommandPhase;
  optional?: boolean;
  run?: (ctx: StepCtx) => Promise<void>;
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
  /** the one allowed image must match this, e.g. ^dockware/play:<version>$ */
  imagePattern: RegExp;
  defaultImage: string;
  steps: TemplateStep[];
  commands: CommandSpec[];
}
