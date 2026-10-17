import 'server-only';
// Before/after screenshots of a task's sandbox storefront (desktop and mobile per configured page).
// - before: setup step "screenshots" after theme:compile, i.e. before the first agent turn; kept until a new clone or database import
// - after: when publishing (publish.ts), before the commit; the PR body only mentions them (no link, no upload to GitHub)
// The capture runs in a short-lived container of the pinned screenshot image (screenshot-spec.ts); the PNGs come back through
// the archive API, are checked (PNG signature, size) and stored in <data>/screenshots/<task>. A failure never blocks the setup
// or publishing: the set then carries the reason. The AI has no tool for any of this.
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log';
import { redact } from '../settings';
import { errMsg } from '../util';
import { getSandboxConfig } from './env';
import { ROLE_LABEL, SHOT_ROLE, TASK_LABEL } from './labels';
import { getRunner } from './runner';
import { DEVICES, SCREENSHOT_IMAGE, SHOT_DIR, SHOT_OUT, SHOT_OWNER, SHOT_SCRIPT, buildShotJob, buildShotSpec, jobTimeoutMs, shotFile, validShotPaths, type ShotDevice } from './screenshot-spec';
import { readTarEntries, writeTar } from './tar';
import { mustTask, now, saveTask, taskPaths, type CodeTask, type ShotKind, type StoredShotSet } from './tasks';

export const SHOT_LIMITS = { pngBytes: 8 * 1024 * 1024, archiveBytes: 48 * 1024 * 1024 } as const;
/** Stored file names (also the only names the image route serves). */
export const SHOT_FILE = /^(before|after)-[1-5]-(desktop|mobile)\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length > PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/** Deletes the stored PNGs of one kind (or all). */
export function removeShotFiles(taskId: string, kind?: ShotKind) {
  const dir = taskPaths(taskId).screenshots;
  if (!kind) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) if (n.startsWith(`${kind}-`)) fs.rmSync(path.join(dir, n), { force: true });
}

export interface CaptureOpts { signal?: AbortSignal; log?: (line: string) => void; /** pull the image if missing (setup); otherwise a missing image is an error */ pull?: boolean }

/** Captures the configured pages of the task's running sandbox and stores them as `kind` (replacing the previous ones).
 *  Throws if nothing could be captured; single failed shots are listed in `error`. Returns null when no pages are configured. */
export async function captureShots(t: CodeTask, kind: ShotKind, o: CaptureOpts = {}): Promise<StoredShotSet | null> {
  const paths = validShotPaths(getSandboxConfig().screenshotPaths);
  if (!paths.length) return null;
  const r = getRunner(), note = o.log ?? (() => {});
  const info = t.containerId ? await r.inspect(t.containerId) : null;
  if (!info?.running) throw new Error('Der Sandbox-Container läuft nicht.');
  if (o.pull) {
    let last = 0;
    const { pulled } = await r.ensureImage(SCREENSHOT_IMAGE, p => { if (Date.now() - last > 2000 || p.pct === 100) { last = Date.now(); note(`${p.text}${p.pct !== undefined ? ` (${p.pct} %)` : ''}`); } }, o.signal);
    if (pulled) note(`Image ${SCREENSHOT_IMAGE} geladen.`);
  } else if (!(await r.imagePresent(SCREENSHOT_IMAGE))) throw new Error(`Das Screenshot-Image ${SCREENSHOT_IMAGE} fehlt – „Umgebung prüfen“ lädt es.`);
  for (const c of await r.list({ [TASK_LABEL]: t.id, [ROLE_LABEL]: SHOT_ROLE })) await r.remove(c.id); // left over from an aborted capture

  const job = buildShotJob(t.id, paths);
  note(`Screenshots von ${paths.join(', ')} (Desktop und Mobil) …`);
  const id = await r.create(buildShotSpec(t.id));
  let tar: Buffer;
  try {
    const files = writeTar([
      { path: SHOT_DIR.slice(1), type: 'dir' }, { path: SHOT_OUT.slice(1), type: 'dir' },
      { path: `${SHOT_DIR.slice(1)}/shot.mjs`, type: 'file', data: Buffer.from(SHOT_SCRIPT) },
      { path: `${SHOT_DIR.slice(1)}/job.json`, type: 'file', data: Buffer.from(JSON.stringify(job)) },
    ], SHOT_OWNER);
    await r.putArchive(id, '/', files, { signal: o.signal });
    await r.start(id);
    const code = await r.wait(id, { timeoutMs: jobTimeoutMs(job), signal: o.signal });
    if (code !== 0) throw new Error(`Der Screenshot-Container endete mit Exit-Code ${code}.`);
    tar = await r.getArchive(id, SHOT_OUT, { maxBytes: SHOT_LIMITS.archiveBytes });
  } finally {
    await r.remove(id).catch(e => log.warn('Screenshot-Container nicht entfernt', { task: t.id, error: e }));
  }

  // archive entries are "out/<file>"; only the expected names count
  const got = new Map(readTarEntries(tar).filter(e => e.type === 'file').map(e => [e.path.split('/').pop() ?? '', e.data]));
  let reported: { file?: string; error?: string }[] = [];
  try { reported = JSON.parse(got.get('result.json')?.toString('utf8') ?? '[]'); } catch { /* no report: judged by the files */ }
  const why = (file: string) => String(reported.find(x => x.file === file)?.error ?? 'kein Bild').slice(0, 200);
  const items: StoredShotSet['items'] = [], missing: string[] = [], keep: { name: string; data: Buffer }[] = [];
  paths.forEach((p, i) => (Object.keys(DEVICES) as ShotDevice[]).forEach(device => {
    const f = shotFile(i, device), data = got.get(f);
    if (!data || !isPng(data) || data.length > SHOT_LIMITS.pngBytes) { missing.push(`${p} (${device}): ${data ? 'kein gültiges PNG oder zu groß' : why(f)}`); return; }
    const name = `${kind}-${f}`;
    keep.push({ name, data }); items.push({ path: p, device, file: name });
  }));
  if (!items.length) throw new Error(`Keine Screenshots entstanden: ${missing[0] ?? 'unbekannter Fehler'}`);
  const dir = taskPaths(t.id).screenshots;
  fs.mkdirSync(dir, { recursive: true });
  removeShotFiles(t.id, kind);
  for (const k of keep) { const tmp = path.join(dir, `.${k.name}.tmp`); fs.writeFileSync(tmp, k.data); fs.renameSync(tmp, path.join(dir, k.name)); }
  return { at: now(), items, ...(missing.length ? { error: redact(`${missing.length} von ${job.shots.length} Aufnahmen fehlen – ${missing[0]}`).slice(0, 400) } : {}) };
}

const PAUSED = 'Die Sandbox war beim Veröffentlichen nicht bereit (pausiert oder gestoppt) – „Fortsetzen“ und erneut veröffentlichen, dann entstehen Nachher-Screenshots.';
/** At publishing: the after set. Never throws; a failure is stored as the set's reason (and the old after set is gone). */
export async function captureAfter(id: string, timeoutMs = 6 * 60_000): Promise<StoredShotSet | null> {
  if (!getSandboxConfig().screenshotPaths.length) return null;
  const t = mustTask(id);
  let set: StoredShotSet | null;
  try {
    if (t.status !== 'ready' || !t.containerRunning) throw new Error(PAUSED);
    set = await captureShots(t, 'after', { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    removeShotFiles(id, 'after');
    set = { at: now(), items: [], error: redact(errMsg(e)).slice(0, 400) };
    log.warn('Nachher-Screenshots nicht möglich', { task: id, error: set.error });
  }
  const fresh = mustTask(id); // the capture took a while: store on the current row
  fresh.shots = { ...fresh.shots, after: set };
  saveTask(fresh);
  return set;
}

/** Link-free mention for the pull request body (the images stay in Lotse). Empty without any stored screenshot. */
export function shotNote(t: Pick<CodeTask, 'shots'>): string {
  const b = t.shots?.before?.items ?? [], a = t.shots?.after?.items ?? [];
  if (!a.length && !b.length) return '';
  const pages = [...new Set([...b, ...a].map(i => i.path))].map(p => `\`${p}\``).join(', ');
  const what = a.length && b.length ? 'Vorher-/Nachher-Screenshots' : a.length ? 'Nachher-Screenshots' : 'Vorher-Screenshots';
  return `\n\n**Screenshots:** ${what} der Sandbox-Storefront (Desktop und Mobil; ${pages}) liegen in Lotse bei dieser Aufgabe (Reiter „Pull Request“). Sie werden nicht auf GitHub hochgeladen.`;
}
