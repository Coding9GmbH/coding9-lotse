import 'server-only';
// Quick start for stored databases ("Gespeicherte Datenbanken", dumps.ts): instead of importing the same dump into every new sandbox,
// Lotse keeps a copy of MySQL's data directory per stored database and image in a label-managed Docker volume.
// - A task with a stored database gets its own data volume (lotse-taskdb-<task>) at MySQL's data directory (template.database).
// - After the first successful import (+ set-domain) into an image, before anything of the task changes the database: MySQL is stopped
//   cleanly (service mysql stop), a copy container copies the volume into lotse-db-<dump>-<image hash>, MySQL starts again.
// - Later tasks with the same dump and image: the copy container fills their fresh data volume from that snapshot before their
//   container – and MySQL – starts; the import step has nothing to do. Each task works on its own copy.
// - A snapshot counts only for the image it was taken with (a new image tag = a new import); the sweep removes snapshots of other
//   images, of deleted stored databases and unfinished copies, and data volumes of finished or deleted tasks.
// Measured with dockware/shopware:6.7.15.1 and a 241 MB dump (24,000 products): see docs (architecture). LOTSE_SANDBOX_DB_SNAPSHOTS=0
// switches the snapshot path off (every sandbox imports).
import { codeDumpGet, codeDumpPut } from '../db';
import { log } from '../log';
import { singleton } from '../state';
import { errMsg } from '../util';
import { buildCopySpec, snapshotVolume, taskDbVolume, volumeTask } from './db-snapshot-spec';
import { deleteDump, getDump, libraryDumps } from './dumps';
import { DB_COPY_ROLE, DB_SNAPSHOT_ROLE, DUMP_LABEL, IMAGE_LABEL, MANAGED, ROLE_LABEL, TASK_DB_ROLE, TASK_LABEL } from './labels';
import { getRunner } from './runner';
import type { DatabaseSpec } from './templates/types';

/** LOTSE_SANDBOX_DB_SNAPSHOTS=0 switches the snapshot path off (default on). */
export const snapshotsEnabled = (env: Record<string, string | undefined> = process.env) => !/^(0|false|off|no)$/i.test(env.LOTSE_SANDBOX_DB_SNAPSHOTS?.trim() ?? '');
const COPY_TIMEOUT_MS = 20 * 60_000;
const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

/** Snapshot volumes being written right now (the sweep leaves them alone; a second task does not start the same one). */
const busy = () => singleton('sandboxDbSnapshots', () => new Set<string>());

/** The recorded snapshot of this stored database for this image, if its volume still exists. */
export async function usableSnapshot(dumpId: string, image: string): Promise<string | null> {
  if (!snapshotsEnabled()) return null;
  const d = codeDumpGet(dumpId);
  const s = d?.library && d.status === 'ready' ? d.snapshots.find(x => x.image === image) : undefined;
  if (!s || busy().has(s.volume)) return null;
  if (await getRunner().inspectVolume(s.volume)) return s.volume;
  forgetSnapshot(dumpId, s.volume); // removed outside Lotse: import again (and take a new one)
  return null;
}
function forgetSnapshot(dumpId: string, volume: string) {
  const d = codeDumpGet(dumpId);
  if (d && d.snapshots.some(s => s.volume === volume)) codeDumpPut({ ...d, snapshots: d.snapshots.filter(s => s.volume !== volume) });
}

/** One copy container run: create, start, wait for its exit, always remove. A non-zero exit throws with the end of its output. */
async function runCopy(o: { taskId: string; image: string; from: string; to: string; signal?: AbortSignal }): Promise<void> {
  const r = getRunner(), spec = buildCopySpec(o);
  for (const c of await r.list({ [ROLE_LABEL]: DB_COPY_ROLE, [TASK_LABEL]: o.taskId })) await r.remove(c.id); // left over by a restart
  const id = await r.create(spec);
  try {
    await r.start(id);
    const code = await r.wait(id, { timeoutMs: COPY_TIMEOUT_MS, signal: o.signal });
    if (code !== 0) {
      const out = (await r.logs(id, { tail: 5 }).catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`Datenbank-Kopie fehlgeschlagen (Exit-Code ${code})${out ? `: ${out}` : ''}.`);
    }
  } finally { await r.remove(id).catch(e => log.warn('Kopier-Container nicht entfernt', { task: o.taskId, error: e })); }
}

const taskVolumeLabels = (taskId: string) => ({ ...MANAGED, [ROLE_LABEL]: TASK_DB_ROLE, [TASK_LABEL]: taskId });

/** Before the task container is created (its old one is gone): a fresh data volume, filled from the snapshot of this stored database
 *  and image if there is one. A snapshot that cannot be found or copied only costs the quick start: the volume starts empty again (Docker fills
 *  it from the image on the first start) and the import runs as usual. */
export async function prepareTaskDb(o: { taskId: string; dumpId: string | null; image: string; log: (line: string) => void; signal?: AbortSignal }): Promise<{ volume: string; restored: boolean }> {
  const r = getRunner(), volume = taskDbVolume(o.taskId);
  await r.removeVolume(volume);
  await r.createVolume(volume, taskVolumeLabels(o.taskId));
  const snap = o.dumpId ? await usableSnapshot(o.dumpId, o.image).catch(e => {
    // e.g. a volume of that name not made by Lotse: no quick start, the import runs as usual
    o.log(`Snapshot nicht nutzbar (${errMsg(e)}) – die Datenbank wird stattdessen importiert.`);
    return null;
  }) : null;
  if (!snap) {
    if (o.dumpId && snapshotsEnabled()) o.log('Noch kein Snapshot dieser Datenbank für dieses Image – sie wird importiert, danach als Snapshot gesichert.');
    return { volume, restored: false };
  }
  o.log('Gespeicherte Datenbank: Snapshot für dieses Image vorhanden – die Daten werden übernommen …');
  const t0 = Date.now();
  try {
    await runCopy({ taskId: o.taskId, image: o.image, from: snap, to: volume, signal: o.signal });
    o.log(`Datenbank aus dem Snapshot übernommen (${secs(t0)}).`);
    return { volume, restored: true };
  } catch (e) {
    if (o.signal?.aborted) throw e;
    o.log(`Snapshot nicht nutzbar (${errMsg(e)}) – die Datenbank wird stattdessen importiert.`);
    await r.removeVolume(volume);
    await r.createVolume(volume, taskVolumeLabels(o.taskId));
    return { volume, restored: false };
  }
}

/** After the import of a stored database into a task whose data directory is its own volume: MySQL stopped cleanly, the volume
 *  copied into the snapshot volume of this database and image, MySQL started again. Without a clean stop nothing is copied.
 *  A failed copy is logged and skipped (the setup goes on); MySQL not starting again fails the step. */
export async function saveSnapshot(o: { taskId: string; dumpId: string; image: string; db: DatabaseSpec; containerId: string; log: (line: string) => void; signal?: AbortSignal }): Promise<void | 'skipped'> {
  if (!snapshotsEnabled()) { o.log('Snapshots sind ausgeschaltet (LOTSE_SANDBOX_DB_SNAPSHOTS=0) – jede Sandbox importiert die Datenbank.'); return 'skipped'; }
  const d = codeDumpGet(o.dumpId);
  if (!d?.library || d.status !== 'ready') { o.log('Die gespeicherte Datenbank wurde inzwischen gelöscht – kein Snapshot.'); return 'skipped'; }
  // Docker trouble or a volume of that name not made by Lotse: no snapshot, the setup goes on (such a volume is not touched)
  const skip = (e: unknown) => { o.log(`Snapshot nicht angelegt: ${errMsg(e)} Die nächste Sandbox mit dieser Datenbank importiert sie wieder.`); return 'skipped' as const; };
  try {
    if (await usableSnapshot(o.dumpId, o.image)) { o.log('Für diese Datenbank und dieses Image gibt es bereits einen Snapshot.'); return 'skipped'; }
  } catch (e) { return skip(e); }
  const volume = snapshotVolume(o.dumpId, o.image), B = busy();
  if (B.has(volume)) { o.log('Eine andere Sandbox legt den Snapshot dieser Datenbank gerade an.'); return 'skipped'; }
  B.add(volume);
  const r = getRunner(), t0 = Date.now();
  const exec = (c: { argv: string[]; user: string }) => r.exec(o.containerId, c.argv, { user: c.user, workdir: '/', timeoutMs: 120_000 });
  try {
    try {
      if (await r.inspectVolume(volume)) await r.removeVolume(volume); // an unfinished copy from before (never recorded)
      await r.createVolume(volume, { ...MANAGED, [ROLE_LABEL]: DB_SNAPSHOT_ROLE, [DUMP_LABEL]: o.dumpId, [IMAGE_LABEL]: o.image });
    } catch (e) { return skip(e); }
    o.log('MySQL sauber beenden …');
    let saved = false;
    try {
      const stop = await exec(o.db.stop);
      if (stop.exitCode !== 0) throw new Error(`MySQL ließ sich nicht sauber beenden (Exit-Code ${stop.exitCode}).`);
      o.log('Datenverzeichnis in den Snapshot kopieren …');
      await runCopy({ taskId: o.taskId, image: o.image, from: taskDbVolume(o.taskId), to: volume, signal: o.signal });
      saved = true;
    } catch (e) {
      if (o.signal?.aborted) throw e;
      o.log(`Snapshot nicht angelegt: ${errMsg(e)} Die nächste Sandbox mit dieser Datenbank importiert sie wieder.`);
    } finally {
      const start = await exec(o.db.start).catch(e => ({ exitCode: -1, output: errMsg(e) }));
      if (start.exitCode !== 0) throw new Error(`MySQL startet nach dem Snapshot nicht wieder (Exit-Code ${start.exitCode}): ${start.output.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    }
    const fresh = codeDumpGet(o.dumpId);
    if (!saved || !fresh?.library || fresh.status !== 'ready') {
      await r.removeVolume(volume).catch(() => {});
      if (saved) o.log('Die gespeicherte Datenbank wurde inzwischen gelöscht – Snapshot verworfen.');
      return 'skipped';
    }
    codeDumpPut({ ...fresh, snapshots: [...fresh.snapshots.filter(s => s.image !== o.image), { image: o.image, volume, createdAt: new Date().toISOString() }] });
    o.log(`Snapshot gesichert (${secs(t0)}): weitere Sandboxes mit dieser Datenbank starten ohne Import.`);
  } catch (e) {
    await r.removeVolume(volume).catch(() => {});
    throw e;
  } finally { B.delete(volume); }
}

/** "Löschen" in the list: the file, the row and every snapshot volume of this stored database. A volume Docker cannot remove now
 *  (unreachable, in use by a running copy) is left to the sweep; the database is gone for Lotse either way. */
export async function deleteStoredDb(id: string): Promise<{ volumesLeft: number }> {
  const d = getDump(id);
  if (!d.library) throw Object.assign(new Error('Keine gespeicherte Datenbank.'), { status: 409 });
  deleteDump(id);
  let left = 0;
  try {
    const r = getRunner();
    for (const v of await r.listVolumes({ [ROLE_LABEL]: DB_SNAPSHOT_ROLE, [DUMP_LABEL]: id })) {
      await r.removeVolume(v.name).catch(e => { left++; log.warn('Snapshot-Volume nicht gelöscht', { volume: v.name, error: e }); });
    }
  } catch (e) { left++; log.warn('Snapshot-Volumes nicht gelöscht', { dump: id, error: e }); }
  return { volumesLeft: left };
}

/** Startup, interval and a new image: snapshot volumes that are not the recorded snapshot of a stored database for `image` (deleted
 *  database, other image tag, unfinished copy) and data volumes of tasks that are finished or gone. Rows forget snapshots of other images. */
export async function sweepDbVolumes(image: string, taskStatus: (taskId: string) => string | null): Promise<string[]> {
  const r = getRunner(), removed: string[] = [], B = busy();
  for (const d of libraryDumps()) if (d.snapshots.some(s => s.image !== image)) codeDumpPut({ ...d, snapshots: d.snapshots.filter(s => s.image === image) });
  const keep = new Set(libraryDumps().flatMap(d => d.snapshots.map(s => s.volume)));
  for (const v of await r.listVolumes({ [ROLE_LABEL]: DB_SNAPSHOT_ROLE })) {
    if (keep.has(v.name) || B.has(v.name)) continue;
    await r.removeVolume(v.name).then(() => removed.push(v.name), e => log.warn('Snapshot-Volume nicht gelöscht', { volume: v.name, error: e }));
  }
  for (const v of await r.listVolumes({ [ROLE_LABEL]: TASK_DB_ROLE })) {
    const task = volumeTask(v.name);
    if (task && ![null, 'done'].includes(taskStatus(task))) continue;
    await r.removeVolume(v.name).then(() => removed.push(v.name), e => log.warn('Datenbank-Volume nicht gelöscht', { volume: v.name, error: e }));
  }
  return removed;
}
