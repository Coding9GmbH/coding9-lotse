import 'server-only';
// OpenAI Codex (ChatGPT-Abo) als alternative KI-Laufzeit.
// Sicherheitsmodell wie bei Claude: Codex bekommt KEINE eigenen Werkzeuge (Shell, Dateien, Bilder, Plugins …; Websuche nur, wenn eingeschaltet),
// nur unsere Shop-Tools über MCP. Zusätzlich verbietet ein Berechtigungsprofil jeden Dateizugriff („:root“ = deny, nicht eskalierbar),
// Freigaben fragt Codex nie nach, und der Prozess sieht keine Zugangsdaten aus der Umgebung.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './db';
import { singleton } from './state';

/** Eigenes Codex-Verzeichnis (Anmeldung, Sitzungen) im Datenordner – getrennt von einer evtl. vorhandenen ~/.codex des Rechners. */
export const codexHome = () => path.join(dataDir(), 'codex');
/** Leeres Arbeitsverzeichnis: Codex sieht kein Projekt, keine AGENTS.md. */
const workDir = () => path.join(dataDir(), 'codex-work');

export const codexLoggedIn = () => fs.existsSync(path.join(codexHome(), 'auth.json'));

const TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** Pfad zum Codex-Programm aus @openai/codex (für Anmeldung/Status). Bewusst ohne require.resolve – der Bundler würde es umschreiben. */
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

/** Minimale Umgebung für den Codex-Prozess: keine SHOPWARE_/OPENAI_/ANTHROPIC_/Lotse-Variablen. */
export function codexEnv(extra: Record<string, string> = {}): Record<string, string> {
  fs.mkdirSync(codexHome(), { recursive: true, mode: 0o700 });
  fs.mkdirSync(workDir(), { recursive: true, mode: 0o700 });
  const e: Record<string, string> = { CODEX_HOME: codexHome(), HOME: process.env.HOME ?? codexHome(), PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'TZ']) if (process.env[k]) e[k] = process.env[k] as string;
  return { ...e, ...extra };
}

// Eingebaute Codex-Fähigkeiten, die Lotse abschaltet (Codex ist eigentlich ein Programmier-Agent)
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'view_image', 'image_generation', 'multi_agent', 'plugins', 'apps',
  'hooks', 'skill_search', 'skill_mcp_dependency_install', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser',
  'tool_suggest', 'goals', 'sleep_tool', 'memories', 'workspace_dependencies', 'worktrees', 'realtime_conversation',
  // zusätzlich (Stand codex 0.162, `codex features list`): Remote-Plugins, Browser-Vollzugriff, Rechte-Anfrage-Werkzeug, eigenständige Websuche
  'remote_plugin', 'plugin_sharing', 'browser_use_full_cdp_access', 'browser_annotation_api', 'request_permissions_tool', 'exec_permission_approvals', 'standalone_web_search',
];
// Bewusst AN: code_mode_host. Neuere Modelle rufen Tools nur über den Code-Modus auf (JavaScript-Isolat ohne require/fetch/
// Dateien/Umgebung – geprüft). Einziges Schreibwerkzeug darin ist apply_patch; das blockiert das Berechtigungsprofil.

/** Konfiguration für jeden Lauf (als `--config`-Überschreibungen). */
export function codexConfig(opts: { mcpUrl: string; instructions: string; web?: boolean }) {
  return {
    config: {
      developer_instructions: opts.instructions,
      approval_policy: 'never',
      web_search: opts.web ? 'live' : 'disabled', // Websuche nur bei eingeschalteter Internetrecherche (Einstellungen → KI-Zugriff)
      project_doc_max_bytes: 0, // keine AGENTS.md o. Ä. aus dem Arbeitsverzeichnis
      // Rückfragen und Freigaben warten auf den Menschen: der Code-Modus soll den Werkzeugaufruf nicht nach Sekunden
      // „zurückgeben“ (sonst beendet das Modell seinen Zug und die Antwort geht verloren)
      code_mode: { default_exec_yield_time_ms: 3_600_000 },
      default_permissions: 'lotse',
      features: Object.fromEntries(DISABLED_FEATURES.map(f => [f, false])),
      mcp_servers: {
        shop: {
          url: opts.mcpUrl,
          bearer_token_env_var: 'LOTSE_MCP_TOKEN',
          startup_timeout_sec: 20,
          tool_timeout_sec: 3600, // Rückfragen/Freigaben warten auf den Menschen
          // Shop-Tools lesen nur; Schreiben läuft ausschließlich über Lotses eigene Freigabe (Änderungssets) → keine Codex-Rückfrage
          default_tools_approval_mode: 'approve',
        },
      },
    },
    // Kein Dateizugriff für von Codex gestartete Befehle – nicht eskalierbar
    configOverrides: ['permissions.lotse.filesystem={":root"="deny"}'],
    workingDirectory: workDir(),
  };
}

// ---- Anmeldung mit ChatGPT (Gerätecode) ----
export interface CodexLoginState { status: 'idle' | 'pending' | 'done' | 'error'; url?: string; code?: string; message?: string; startedAt?: number }
const login = singleton('codexLogin', () => ({ proc: null as ChildProcess | null, state: { status: 'idle' } as CodexLoginState }));

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Startet `codex login --device-auth` und liefert Link + Code, sobald Codex sie ausgibt. */
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
  setTimeout(() => { if (login.proc === proc) proc.kill(); }, 16 * 60_000); // Code gilt 15 Minuten

  for (let i = 0; i < 100 && login.proc === proc && !login.state.code; i++) await new Promise(r => setTimeout(r, 100));
  if (login.proc === proc && !login.state.code) return { status: 'error', message: 'Codex hat keinen Anmeldecode geliefert. Ist das Internet erreichbar?' };
  return login.state;
}

export function codexLoginState(): CodexLoginState {
  if (login.state.status === 'pending' && !login.proc) login.state = { status: codexLoggedIn() ? 'done' : 'idle' };
  return login.state;
}

export function cancelCodexLogin() { login.proc?.kill(); login.proc = null; login.state = { status: 'idle' }; }

/** Abmelden: gespeicherte ChatGPT-Anmeldung löschen. */
export function codexLogout() {
  cancelCodexLogin();
  fs.rmSync(path.join(codexHome(), 'auth.json'), { force: true });
}

// ---- MCP-Zugang für laufende Codex-Sitzungen: ein zufälliges Token je Chat ----
const tokens = singleton('codexMcpTokens', () => new Map<string, string>());
export function mcpTokenFor(chatId: string): string {
  let t = tokens.get(chatId);
  if (!t) { t = crypto.randomBytes(32).toString('hex'); tokens.set(chatId, t); }
  return t;
}
/** Token weg, wenn die Runde endet oder der Chat gelöscht wird. Nicht bei dropSession: Reset behält den Chat, die laufende Runde räumt selbst ab. */
export function clearMcpToken(chatId: string): void { tokens.delete(chatId); }

/** Token bleibt in `run` gültig (auch beim Warten auf eine Freigabe) und wird danach immer entfernt. */
export async function bindRoundToken<T>(chatId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    clearMcpToken(chatId);
  }
}
/** Prüft das Bearer-Token in konstanter Zeit. */
export function mcpTokenValid(chatId: string, header: string | null): boolean {
  const want = tokens.get(chatId), got = header?.match(/^Bearer\s+(.+)$/)?.[1];
  if (!want || !got) return false;
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
