import 'server-only';
// Sandbox environment (kv 'sandbox'): on/off switch, the one image, limits, environment variables and own setup commands.
// Off by default. LOTSE_SANDBOX=0 switches it off hard; it also stays off while Lotse is reachable from the network
// without LOTSE_PASSWORD (whoever reaches Lotse could otherwise run code in containers).
// Secret variable values are stored sealed and never returned; the AI never sees them.
import crypto from 'node:crypto';
import type { CommandPhase, InternetPolicy, SandboxCheckEvent, SandboxCommand, SandboxDocker, SandboxEnvPatch, SandboxEnvPublic, SandboxStatus } from '@/lib/protocol';
import { exposedWithoutPassword, sandboxSubnet } from '../access';
import { kvGet, kvSet, seal, unseal } from '../db';
import { assertRepoName } from '../github';
import { singleton } from '../state';
import { errMsg } from '../util';
import { ensureNetwork, networkMode } from './network';
import { getRunner } from './runner';
import { DEFAULT_TEMPLATE, canonicalTemplateId, getTemplate } from './templates';
import type { SandboxTemplate } from './templates/types';

interface StoredVar { key: string; secret: boolean; /** sealed when secret */ value: string }
interface StoredSandbox {
  enabled?: boolean; templateId?: string; image?: string; memoryMb?: number; cpus?: number; idleMinutes?: number;
  envVars?: StoredVar[]; commands?: SandboxCommand[]; updatedAt?: string; defaultRepo?: string; defaultBranch?: string; internet?: InternetPolicy;
}
const KV = 'sandbox';
const stored = (): StoredSandbox => {
  const s = kvGet<StoredSandbox>(KV) ?? {};
  return s.templateId ? { ...s, templateId: canonicalTemplateId(s.templateId) } : s; // 'dockware-play' was renamed to 'dockware'
};

export const LIMITS = {
  memoryMb: { min: 1024, max: 32768, def: 4096 },
  cpus: { min: 0.5, max: 16, def: 2 },
  idleMinutes: { min: 5, max: 1440, def: 30 },
  maxRunning: { min: 1, max: 10, def: 2 },
  envVars: 50, envValue: 4000, commands: 20, command: 2000, label: 80,
  timeoutSec: { min: 10, max: 3600, def: 600 },
} as const;
export const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
const COMMAND_ID = /^c_[a-z0-9]{8}$/;

const envNum = (v: string | undefined, l: { min: number; max: number; def: number }) => {
  const n = Number(v); return v?.trim() && Number.isFinite(n) ? Math.min(l.max, Math.max(l.min, Math.round(n))) : l.def;
};
/** LOTSE_SANDBOX_MAX: containers running at the same time (default 2). */
export const maxRunning = (env: Record<string, string | undefined> = process.env) => envNum(env.LOTSE_SANDBOX_MAX, LIMITS.maxRunning);
const defaultIdle = (env: Record<string, string | undefined> = process.env) => envNum(env.LOTSE_SANDBOX_IDLE_MINUTES, LIMITS.idleMinutes);
const envOff = (env: Record<string, string | undefined>) => /^(0|false|off|no)$/i.test(env.LOTSE_SANDBOX?.trim() ?? '');

export const SANDBOX_OFF = 'Sandbox Coding ist in den Einstellungen ausgeschaltet.';
const ENV_OFF = 'Sandbox Coding ist per LOTSE_SANDBOX=0 abgeschaltet.';
const OPEN_BIND = 'Sandbox Coding bleibt gesperrt: Lotse ist ohne LOTSE_PASSWORD aus dem Netzwerk erreichbar. Erst LOTSE_PASSWORD setzen.';
const OPEN_SUBNET = 'Sandbox Coding bleibt gesperrt: Die Aufgaben-Container könnten Lotse ohne Login erreichen, weil LOTSE_SANDBOX_SUBNET fehlt. docker-compose.sandbox.yml verwenden (make sandbox-up) oder LOTSE_PASSWORD setzen.';
/** Lotse shares the network lotse-sandbox with the task containers: without the pinned subnet the proxy cannot tell them apart from the local gateway. */
const openToSandbox = (env: Record<string, string | undefined>) => !env.LOTSE_PASSWORD && networkMode(env) === 'network' && !sandboxSubnet(env);
const blockedReason = (env: Record<string, string | undefined>) => (exposedWithoutPassword(env) ? OPEN_BIND : openToSandbox(env) ? OPEN_SUBNET : null);

/** Effective state: switch in the settings, LOTSE_SANDBOX=0 and the open-bind rule (incl. network mode without pinned subnet). */
export function sandboxStatus(env: Record<string, string | undefined> = process.env): SandboxStatus {
  if (envOff(env)) return { enabled: false, reason: 'env', message: ENV_OFF };
  if (!stored().enabled) return { enabled: false, reason: 'off', message: SANDBOX_OFF };
  const blocked = blockedReason(env);
  if (blocked) return { enabled: false, reason: 'open-bind', message: blocked };
  return { enabled: true };
}
export const sandboxEnabled = () => sandboxStatus().enabled;

/** Image check against the template: only dockware/shopware (or the older dockware/play) with a fixed version. */
export function validateImage(image: string, t: SandboxTemplate = getTemplate(DEFAULT_TEMPLATE)): string {
  const s = image.trim();
  if (/[:-]latest$/i.test(s) || !s.includes(':')) throw new Error(`Bitte eine feste Version angeben (z. B. ${t.defaultImage}) – „latest“ ist nicht erlaubt.`);
  if (!t.imagePattern.test(s)) throw new Error(`Nur dockware/shopware von Docker Hub mit fester Version ist erlaubt (z. B. ${t.defaultImage}).`);
  return s;
}

const num = (v: number | undefined, l: { min: number; max: number; def: number }, label: string, int = true) => {
  if (v === undefined) return l.def;
  if (!Number.isFinite(v) || v < l.min || v > l.max || (int && !Number.isInteger(v))) throw new Error(`${label}: erlaubt sind ${l.min} bis ${l.max}.`);
  return v;
};

function mergeVars(prev: StoredVar[], next: NonNullable<SandboxEnvPatch['envVars']>): StoredVar[] {
  if (next.length > LIMITS.envVars) throw new Error(`Höchstens ${LIMITS.envVars} Umgebungsvariablen.`);
  const seen = new Set<string>();
  return next.map(v => {
    const key = v.key.trim();
    if (!ENV_KEY.test(key)) throw new Error(`Ungültiger Variablenname „${key.slice(0, 70)}“: nur GROSSBUCHSTABEN, Ziffern und _ (nicht mit Ziffer beginnend).`);
    if (seen.has(key)) throw new Error(`Variable ${key} ist doppelt.`);
    seen.add(key);
    const value = v.value ?? '';
    if (value.length > LIMITS.envValue || value.includes('\0')) throw new Error(`Wert von ${key} ist zu lang (max. ${LIMITS.envValue} Zeichen).`);
    const old = prev.find(p => p.key === key);
    // a secret never becomes visible by itself: unticking "geheim" needs a new value, otherwise the stored one would be lost silently
    if (!v.secret && old?.secret && old.value && !value) throw new Error(`${key}: Neuen Wert eingeben, um die Variable sichtbar zu machen (der geheime Wert wird nicht angezeigt).`);
    if (!v.secret) return { key, secret: false, value };
    if (value) return { key, secret: true, value: seal(value) ?? '' };
    if (old?.secret) return old; // unchanged secret
    if (old) return { key, secret: true, value: seal(old.value) ?? '' }; // plain value becomes secret
    throw new Error(`Wert für ${key} fehlt.`);
  });
}

const newCommandId = () => `c_${crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0').slice(0, 8)}`;
function checkCommands(next: NonNullable<SandboxEnvPatch['commands']>): SandboxCommand[] {
  if (next.length > LIMITS.commands) throw new Error(`Höchstens ${LIMITS.commands} eigene Befehle.`);
  const ids = new Set<string>();
  return next.map((c, i) => {
    const label = c.label.trim(), command = c.command.trim();
    const n = i + 1;
    if (!label || label.length > LIMITS.label) throw new Error(`Befehl ${n}: Bezeichnung fehlt oder ist zu lang (max. ${LIMITS.label} Zeichen).`);
    if (!command) throw new Error(`Befehl ${n} („${label}“): Befehl fehlt.`);
    if (command.length > LIMITS.command || command.includes('\0')) throw new Error(`Befehl ${n} („${label}“): zu lang (max. ${LIMITS.command} Zeichen).`);
    if (!(['after-db', 'final'] as CommandPhase[]).includes(c.phase)) throw new Error(`Befehl ${n}: unbekannte Phase.`);
    const timeoutSec = num(c.timeoutSec, LIMITS.timeoutSec, `Befehl ${n}: Zeitlimit (Sekunden)`);
    let id = c.id && COMMAND_ID.test(c.id) && !ids.has(c.id) ? c.id : newCommandId();
    while (ids.has(id)) id = newCommandId();
    ids.add(id);
    return { id, label, command, phase: c.phase, timeoutSec };
  });
}

/** Base branch preset: the same character rules as git check-ref-format (checked again with git when a task is created). */
const branchName = (b: string) => {
  if (b.length > 200 || b.startsWith('-') || b.includes('@{') || b.includes('..') || /[\s\x00-\x1f\x7f~^:?*[\\]/.test(b)) throw new Error('Ungültiger Branch-Name.');
  return b;
};

/** Saves the environment. Returns the changed field names (for the audit; never values). */
export function saveSandbox(p: SandboxEnvPatch, env: Record<string, string | undefined> = process.env): { changed: string[] } {
  const s = stored(), next: StoredSandbox = { ...s };
  const changed: string[] = [];
  if (p.enabled !== undefined && p.enabled !== !!s.enabled) {
    if (p.enabled && envOff(env)) throw new Error(ENV_OFF);
    const blocked = p.enabled ? blockedReason(env) : null;
    if (blocked) throw new Error(blocked);
    next.enabled = p.enabled; changed.push('enabled');
  }
  const t = getTemplate(s.templateId ?? DEFAULT_TEMPLATE);
  if (p.image !== undefined) { const image = validateImage(p.image, t); if (image !== (s.image ?? t.defaultImage)) { next.image = image; changed.push('image'); } }
  if (p.memoryMb !== undefined) { next.memoryMb = num(p.memoryMb, LIMITS.memoryMb, 'Arbeitsspeicher (MB)'); if (next.memoryMb !== s.memoryMb) changed.push('memoryMb'); }
  if (p.cpus !== undefined) { next.cpus = num(p.cpus, LIMITS.cpus, 'CPUs', false); if (next.cpus !== s.cpus) changed.push('cpus'); }
  if (p.idleMinutes !== undefined) { next.idleMinutes = num(p.idleMinutes, LIMITS.idleMinutes, 'Pause nach Inaktivität (Minuten)'); if (next.idleMinutes !== s.idleMinutes) changed.push('idleMinutes'); }
  if (p.defaultRepo !== undefined) { const r = p.defaultRepo.trim(); next.defaultRepo = r ? assertRepoName(r) : ''; if (next.defaultRepo !== (s.defaultRepo ?? '')) changed.push('defaultRepo'); }
  if (p.defaultBranch !== undefined) { const b = p.defaultBranch.trim(); next.defaultBranch = b ? branchName(b) : ''; if (next.defaultBranch !== (s.defaultBranch ?? '')) changed.push('defaultBranch'); }
  if (p.internet !== undefined) {
    if (p.internet !== 'approval' && p.internet !== 'never') throw new Error('Internet im Container: erlaubt sind „nur nach Freigabe“ oder „nie“.');
    if (p.internet !== (s.internet ?? 'approval')) { next.internet = p.internet; changed.push('internet'); }
  }
  if (p.envVars !== undefined) {
    next.envVars = mergeVars(s.envVars ?? [], p.envVars);
    const before = new Map((s.envVars ?? []).map(v => [v.key, v]));
    for (const v of next.envVars) { const o = before.get(v.key); if (!o || o.value !== v.value || o.secret !== v.secret) changed.push(`env.${v.key}`); before.delete(v.key); }
    for (const k of before.keys()) changed.push(`env.${k}`);
  }
  if (p.commands !== undefined) {
    next.commands = checkCommands(p.commands);
    if (JSON.stringify(next.commands) !== JSON.stringify(s.commands ?? [])) changed.push('commands');
  }
  if (changed.length) kvSet(KV, { ...next, templateId: t.id, updatedAt: new Date().toISOString() } satisfies StoredSandbox);
  return { changed };
}

/** Masked view for the browser: secret values never leave the server. */
export function sandboxPublic(env: Record<string, string | undefined> = process.env): SandboxEnvPublic {
  const s = stored(), t = getTemplate(s.templateId ?? DEFAULT_TEMPLATE);
  return {
    enabled: !!s.enabled, status: sandboxStatus(env), templateId: t.id, image: s.image ?? t.defaultImage,
    memoryMb: s.memoryMb ?? LIMITS.memoryMb.def, cpus: s.cpus ?? LIMITS.cpus.def, idleMinutes: s.idleMinutes ?? defaultIdle(env), maxRunning: maxRunning(env),
    envVars: (s.envVars ?? []).map(v => ({ key: v.key, secret: v.secret, value: v.secret ? '' : v.value, hasValue: !!v.value })),
    commands: s.commands ?? [], updatedAt: s.updatedAt ?? null, defaultRepo: s.defaultRepo ?? '', defaultBranch: s.defaultBranch ?? '', internet: s.internet ?? 'approval',
  };
}

/** Server only: complete configuration with decrypted values (for the container Env at create). */
export function getSandboxConfig() {
  const pub = sandboxPublic(), s = stored();
  const env = (s.envVars ?? []).flatMap(v => { const val = v.secret ? unseal(v.value) : v.value; return val === null ? [] : [`${v.key}=${val}`]; });
  return { ...pub, template: getTemplate(pub.templateId), env };
}

/** Decrypted secret values, for redact(): they must never appear in logs or AI input. */
export const sandboxSecretValues = (): string[] => (stored().envVars ?? []).filter(v => v.secret).map(v => unseal(v.value)).filter((v): v is string => !!v);

// ---- Docker state (short cache: the health route polls) ----
const dockerCache = () => singleton<{ at: number; value: SandboxDocker | null; pending: Promise<SandboxDocker> | null }>('sandboxDocker', () => ({ at: 0, value: null, pending: null }));
async function probeDocker(): Promise<SandboxDocker> {
  const mode = networkMode();
  try {
    const r = getRunner();
    await r.ping();
    const v = await r.version();
    return { reachable: true, apiVersion: v.apiVersion || null, version: v.version || null, mode };
  } catch (e) { return { reachable: false, apiVersion: null, version: null, mode, error: errMsg(e).slice(0, 300) }; }
}
/** Cached 15 s; concurrent callers (tabs, health after every chat turn) share one probe. */
export function dockerState(force = false): Promise<SandboxDocker> {
  const c = dockerCache();
  if (!force && c.value && Date.now() - c.at < 15_000) return Promise.resolve(c.value);
  c.pending ??= probeDocker().then(value => { c.at = Date.now(); c.value = value; return value; }).finally(() => { c.pending = null; });
  return c.pending;
}
export const forgetDockerState = () => { dockerCache().value = null; };

/** Switched off: stop (not remove) every running Lotse container; code, database and changes stay. */
export async function stopRunningSandboxes(): Promise<number> {
  const r = getRunner();
  let n = 0;
  for (const c of await r.list()) if (c.running) { await r.stop(c.id).then(() => n++, () => {}); }
  return n;
}

/** For sandbox routes: 403 with the German reason while Sandbox Coding is off. */
export function sandboxForbidden(): Response | null {
  const s = sandboxStatus();
  return s.enabled ? null : Response.json({ error: s.message ?? SANDBOX_OFF, reason: s.reason }, { status: 403 });
}

/** "Umgebung prüfen": Docker reachable, internal network (network mode), image present or pulled now. One at a time. */
export async function checkEnvironment(onProgress: (text: string, pct?: number) => void, signal?: AbortSignal): Promise<Extract<SandboxCheckEvent, { t: 'result' }>> {
  const lock = singleton('sandboxCheck', () => ({ busy: false }));
  const docker = await dockerState(true);
  const image = sandboxPublic().image;
  if (!docker.reachable) return { t: 'result', ok: false, docker, imagePresent: false, message: docker.error ?? 'Docker ist nicht erreichbar – Docker-Socket bzw. DOCKER_HOST einrichten.' };
  if (lock.busy) return { t: 'result', ok: false, docker, imagePresent: false, message: 'Die Umgebung wird bereits geprüft.' };
  lock.busy = true;
  try {
    const r = getRunner();
    if (docker.mode === 'network') { onProgress('Netzwerk lotse-sandbox prüfen …'); await ensureNetwork(r); }
    onProgress(`Image ${image} prüfen …`);
    const { pulled } = await r.ensureImage(validateImage(image), p => onProgress(p.text, p.pct), signal);
    return { t: 'result', ok: true, docker, imagePresent: true, pulled, message: pulled ? `Image ${image} geladen. Umgebung bereit.` : `Image ${image} ist vorhanden. Umgebung bereit.` };
  } catch (e) {
    return { t: 'result', ok: false, docker, imagePresent: await getRunner().imagePresent(image).catch(() => false), message: errMsg(e).slice(0, 300) };
  } finally { lock.busy = false; }
}
