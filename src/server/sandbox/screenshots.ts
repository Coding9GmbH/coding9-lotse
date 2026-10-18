import 'server-only';
// Screenshots of a task's sandbox storefront (desktop and mobile per configured page) – only by hand: the "Screenshot" button of the
// preview, offered when "Screenshots" is switched on in the environment (off by default). Neither the setup nor publishing takes any;
// the "Pull Request" tab shows the sets the user took, the PR body only mentions them (no link, no upload to GitHub).
// The capture runs in a short-lived container of the pinned screenshot image (screenshot-spec.ts); the PNGs come back through
// the archive API, are checked (PNG signature, size) and stored in <data>/screenshots/<task>. The AI has no tool for any of this.
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../log';
import { redact } from '../settings';
import { singleton } from '../state';
import { getSandboxConfig } from './env';
import { ROLE_LABEL, SHOT_ROLE, TASK_LABEL } from './labels';
import { getRunner } from './runner';
import { DEVICES, SCREENSHOT_IMAGE, SHOT_DIR, SHOT_OUT, SHOT_OWNER, SHOT_SCRIPT, buildShotJob, buildShotSpec, jobTimeoutMs, shotFile, validShotPaths, type ShotDevice } from './screenshot-spec';
import { readTarEntries, writeTar } from './tar';
import { getTask, mustTask, now, saveTask, taskPaths, type CodeTask, type StoredShotSet } from './tasks';

export const SHOT_LIMITS = { pngBytes: 8 * 1024 * 1024, archiveBytes: 48 * 1024 * 1024 } as const;
/** Sets kept per task: an older one is removed with its files when a new one is taken. */
export const MAX_SHOT_SETS = 6;
/** Stored file names (also the only names the image route serves): <set id>-<n>-<device>.png */
export const SHOT_FILE = /^s[0-9a-z]{6,12}-[1-5]-(desktop|mobile)\.png$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer) => b.length > PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
/** The task's stored sets; rows from before manual screenshots (an object) count as none. */
export const shotSets = (t: Pick<CodeTask, 'shots'>): StoredShotSet[] => (Array.isArray(t.shots) ? t.shots : []);

/** Deletes the stored PNGs of one set (or all). */
export function removeShotFiles(taskId: string, setId?: string) {
  const dir = taskPaths(taskId).screenshots;
  if (!setId) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) if (n.startsWith(`${setId}-`)) fs.rmSync(path.join(dir, n), { force: true });
}

export interface CaptureOpts { signal?: AbortSignal; log?: (line: string) => void; /** pull the image if missing; otherwise a missing image is an error */ pull?: boolean }

/** Captures the configured pages of the task's running sandbox and stores them as a new set (files only; the caller stores the row).
 *  Throws if nothing could be captured or no pages are configured; single failed shots are listed in `error`. */
export async function captureShots(t: CodeTask, o: CaptureOpts = {}): Promise<StoredShotSet> {
  const paths = validShotPaths(getSandboxConfig().screenshotPaths);
  if (!paths.length) throw new Error('Keine Seiten für Screenshots eingestellt (Sandbox Coding → Umgebung).');
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
  const setId = newSetId(t);
  const items: StoredShotSet['items'] = [], missing: string[] = [], keep: { name: string; data: Buffer }[] = [];
  paths.forEach((p, i) => (Object.keys(DEVICES) as ShotDevice[]).forEach(device => {
    const f = shotFile(i, device), data = got.get(f);
    if (!data || !isPng(data) || data.length > SHOT_LIMITS.pngBytes) { missing.push(`${p} (${device}): ${data ? 'kein gültiges PNG oder zu groß' : why(f)}`); return; }
    const name = `${setId}-${f}`;
    keep.push({ name, data }); items.push({ path: p, device, file: name });
  }));
  if (!items.length) throw new Error(`Keine Screenshots entstanden: ${missing[0] ?? 'unbekannter Fehler'}`);
  const dir = taskPaths(t.id).screenshots;
  fs.mkdirSync(dir, { recursive: true });
  for (const k of keep) { const tmp = path.join(dir, `.${k.name}.tmp`); fs.writeFileSync(tmp, k.data); fs.renameSync(tmp, path.join(dir, k.name)); }
  return { id: setId, at: now(), items, ...(missing.length ? { error: redact(`${missing.length} von ${job.shots.length} Aufnahmen fehlen – ${missing[0]}`).slice(0, 400) } : {}) };
}
/** s + time in base 36; never the id of an existing set of the task. */
function newSetId(t: Pick<CodeTask, 'shots'>): string {
  const taken = new Set(shotSets(t).map(x => x.id));
  let n = Date.now();
  while (taken.has(`s${n.toString(36)}`)) n++;
  return `s${n.toString(36)}`;
}

const capturing = () => singleton('sandboxShotsRunning', () => new Set<string>());
/** A manual capture runs for the task: the idle sweeper and LOTSE_SANDBOX_MAX leave its container running meanwhile. */
export const captureRunning = (id: string) => capturing().has(id);
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

/** "Screenshot" in the preview: captures the configured pages now and adds the set to the task (the oldest beyond MAX_SHOT_SETS goes).
 *  Only while "Screenshots" is on and the sandbox runs. Throws with a status (409 conflict, 400 off, 502 capture failed). */
export async function takeScreenshots(id: string, timeoutMs = 15 * 60_000): Promise<CodeTask> {
  const t = mustTask(id);
  if (!getSandboxConfig().screenshots) throw Object.assign(new Error('Screenshots sind in der Sandbox-Umgebung ausgeschaltet (Sandbox Coding → Sandbox-Umgebung).'), { status: 400 });
  if (t.status !== 'ready' || !t.containerRunning) throw conflict('Die Sandbox läuft nicht – erst „Fortsetzen“, dann den Screenshot aufnehmen.');
  if (captureRunning(id)) throw conflict('Es wird bereits ein Screenshot aufgenommen.');
  capturing().add(id);
  try {
    let set: StoredShotSet;
    try { set = await captureShots(t, { signal: AbortSignal.timeout(timeoutMs), pull: true }); } catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 400);
      log.warn('Screenshot nicht möglich', { task: id, error: msg });
      throw Object.assign(new Error(`Kein Screenshot: ${msg}`), { status: 502 });
    }
    const fresh = getTask(id);
    if (!fresh || fresh.status === 'done') { removeShotFiles(id, set.id); throw conflict('Die Aufgabe wurde inzwischen abgeschlossen.'); }
    const all = [...shotSets(fresh), set], drop = all.slice(0, Math.max(0, all.length - MAX_SHOT_SETS));
    for (const d of drop) removeShotFiles(id, d.id);
    fresh.shots = all.slice(drop.length);
    fresh.lastActiveAt = now();
    saveTask(fresh);
    return fresh;
  } finally { capturing().delete(id); }
}

/** Link-free mention for the pull request body (the images stay in Lotse). Empty without any screenshot the user took. */
export function shotNote(t: Pick<CodeTask, 'shots'>): string {
  const items = shotSets(t).flatMap(s => s.items);
  if (!items.length) return '';
  const pages = [...new Set(items.map(i => i.path))].map(p => `\`${p}\``).join(', ');
  return `\n\n**Screenshots:** ${items.length === 1 ? '1 Screenshot' : `${items.length} Screenshots`} der Sandbox-Storefront (${pages}) liegen in Lotse bei dieser Aufgabe (Reiter „Freigabe“). Sie werden nicht auf GitHub hochgeladen.`;
}
