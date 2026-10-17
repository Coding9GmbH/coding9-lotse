import 'server-only';
// OpenAI Codex (ChatGPT subscription) as an alternative AI runtime.
// Same security model as Claude: Codex gets NO tools of its own (shell, files, images, plugins …; web search only when enabled),
// only our shop tools via MCP. In addition, a permission profile forbids all file access (":root" = deny, not escalatable),
// Codex never asks for approvals, and the process sees no credentials from the environment.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db';
import { singleton } from './state';

/** Dedicated Codex directory (login, sessions) in the data folder, separate from any existing ~/.codex on the machine. */
export const codexHome = () => path.join(dataDir(), 'codex');
/** Empty working directory: Codex sees no project, no AGENTS.md. */
const workDir = () => path.join(dataDir(), 'codex-work');

export const codexLoggedIn = () => fs.existsSync(path.join(codexHome(), 'auth.json'));

const TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** Path to the Codex binary from @openai/codex (for login/status). Deliberately without require.resolve: the bundler would rewrite it. */
export function codexBinary(): string {
  const key = `${process.platform}-${process.arch}`, triple = TRIPLES[key];
  if (!triple) throw new Error(`Codex wird auf ${key} nicht unterstützt.`);
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const nm = path.join(/*turbopackIgnore: true*/ process.cwd(), 'node_modules', '@openai');
  for (const base of [path.join(nm, `codex-${key}`), path.join(nm, 'codex', 'node_modules', '@openai', `codex-${key}`)]) {
    const bin = path.join(base, 'vendor', triple, 'bin', exe);
    if (fs.existsSync(bin)) return bin;
  }
  throw new Error('Codex-Programm nicht gefunden (Paket @openai/codex unvollständig installiert).');
}

/** Minimal environment for the Codex process: no SHOPWARE_/OPENAI_/ANTHROPIC_/Lotse variables. */
export function codexEnv(extra: Record<string, string> = {}): Record<string, string> {
  fs.mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(workDir(), { recursive: true, mode: 0o700 });
  const e: Record<string, string> = { CODEX_HOME: codexHome(), HOME: process.env.HOME ?? codexHome(), PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'TZ']) if (process.env[k]) e[k] = process.env[k] as string;
  return { ...e, ...extra };
}

// Built-in Codex capabilities that Lotse disables (Codex is really a coding agent)
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'view_image', 'image_generation', 'multi_agent', 'plugins', 'apps',
  'hooks', 'skill_search', 'skill_mcp_dependency_install', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser',
  'tool_suggest', 'goals', 'sleep_tool', 'memories', 'workspace_dependencies', 'worktrees', 'realtime_conversation',
  // additionally (as of codex 0.162, `codex features list`): remote plugins, full browser access, permission request tool, standalone web search
  'remote_plugin', 'plugin_sharing', 'browser_use_full_cdp_access', 'browser_annotation_api', 'request_permissions_tool', 'exec_permission_approvals', 'standalone_web_search',
];
// Deliberately ON: code_mode_host. Newer models call tools only via code mode (JavaScript isolate without require/fetch/
// files/environment, verified). The only write tool in it is apply_patch; the permission profile blocks that.

/** Configuration for every run (as `--config` overrides). `workspace`: worktree of an attached sandbox, the only place Codex may write. */
export function codexConfig(opts: { mcpUrl: string; instructions: string; web?: boolean; workspace?: string }) {
  return {
    config: {
      developer_instructions: opts.instructions,
      approval_policy: 'never',
      web_search: opts.web ? 'live' : 'disabled', // web search only when internet research is enabled (Einstellungen → KI-Zugriff)
      project_doc_max_bytes: 0, // no AGENTS.md or similar from the working directory
      // Questions and approvals wait for the human: code mode must not "yield" the tool call after a few
      // seconds (otherwise the model ends its turn and the answer is lost)
      code_mode: { default_exec_yield_time_ms: 3_600_000 },
      default_permissions: 'lotse',
      features: Object.fromEntries(DISABLED_FEATURES.map(f => [f, false])),
      mcp_servers: {
        shop: {
          url: opts.mcpUrl,
          bearer_token_env_var: 'LOTSE_MCP_TOKEN',
          startup_timeout_sec: 20,
          tool_timeout_sec: 3600, // questions/approvals wait for the human
          // shop tools only read; writing goes exclusively through Lotse's own approval (change sets) → no Codex prompt
          default_tools_approval_mode: 'approve',
        },
      },
    },
    // No file access, not escalatable; with a sandbox only its worktree (without .git) for Codex' own patches
    configOverrides: [opts.workspace
      ? `permissions.lotse.filesystem={":root"="deny",${JSON.stringify(opts.workspace)}="write",${JSON.stringify(`${opts.workspace}/.git`)}="deny"}`
      : 'permissions.lotse.filesystem={":root"="deny"}'],
    workingDirectory: opts.workspace ?? workDir(),
  };
}

// ---- Login with ChatGPT (device code) ----
export interface CodexLoginState { status: 'idle' | 'pending' | 'done' | 'error'; url?: string; code?: string; message?: string; startedAt?: number }
const login = singleton('codexLogin', () => ({ proc: null as ChildProcess | null, state: { status: 'idle' } as CodexLoginState }));

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Starts `codex login --device-auth` and returns link + code as soon as Codex prints them. */
export async function startCodexLogin(): Promise<CodexLoginState> {
  if (login.proc && login.state.status === 'pending' && login.state.code) return login.state;
  login.proc?.kill();
  const proc = spawn(codexBinary(), ['login', '--device-auth'], { env: codexEnv() as NodeJS.ProcessEnv, cwd: workDir(), stdio: ['ignore', 'pipe', 'pipe'] });
  login.proc = proc;
  login.state = { status: 'pending', startedAt: Date.now() };
  let out = '';
  const parse = (chunk: Buffer) => {
    out += stripAnsi(chunk.toString());
    const url = out.match(/https:\/\/auth\.openai\.com\/\S+/)?.[0], code = out.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/)?.[0];
    if (url && code && login.proc === proc) login.state = { ...login.state, url, code };
  };
  proc.stdout?.on('data', parse);
  proc.stderr?.on('data', parse);
  proc.on('close', codeNo => {
    if (login.proc !== proc) return;
    login.proc = null;
    login.state = codeNo === 0 && codexLoggedIn() ? { status: 'done', message: 'Mit ChatGPT angemeldet.' }
      : { status: 'error', message: (out.split('\n').map(l => l.trim()).filter(l => /error|fehl|expired|denied/i.test(l)).pop() ?? 'Anmeldung abgebrochen oder abgelaufen.').slice(0, 200) };
  });
  setTimeout(() => { if (login.proc === proc) proc.kill(); }, 16 * 60_000); // code is valid for 15 minutes

  for (let i = 0; i < 100 && login.proc === proc && !login.state.code; i++) await new Promise(r => setTimeout(r, 100));
  if (login.proc === proc && !login.state.code) return { status: 'error', message: 'Codex hat keinen Anmeldecode geliefert. Ist das Internet erreichbar?' };
  return login.state;
}

export function codexLoginState(): CodexLoginState {
  if (login.state.status === 'pending' && !login.proc) login.state = { status: codexLoggedIn() ? 'done' : 'idle' };
  return login.state;
}

export function cancelCodexLogin() { login.proc?.kill(); login.proc = null; login.state = { status: 'idle' }; }

/** Log out: delete the stored ChatGPT login. */
export function codexLogout() {
  cancelCodexLogin();
  fs.rmSync(path.join(codexHome(), 'auth.json'), { force: true });
}

// ---- MCP access for running Codex sessions: one random token per chat ----
const tokens = singleton('codexMcpTokens', () => new Map<string, string>());
export function mcpTokenFor(chatId: string): string {
  let t = tokens.get(chatId);
  if (!t) { t = crypto.randomBytes(32).toString('hex'); tokens.set(chatId, t); }
  return t;
}
/** Token removed when the turn ends or the chat is deleted. Not on dropSession: a reset keeps the chat, the running turn cleans up itself. */
export function clearMcpToken(chatId: string): void { tokens.delete(chatId); }

/** Token stays valid during `run` (also while waiting for an approval) and is always removed afterwards. */
export async function bindRoundToken<T>(chatId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    clearMcpToken(chatId);
  }
}
/** Checks the bearer token in constant time. */
export function mcpTokenValid(chatId: string, header: string | null): boolean {
  const want = tokens.get(chatId), got = header?.match(/^Bearer\s+(.+)$/)?.[1];
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
