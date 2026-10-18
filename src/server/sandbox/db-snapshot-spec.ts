// Stored databases (pure part, no I/O): volume names and the short-lived copy container.
// A task with a stored database keeps its MySQL data directory in a label-managed volume of its own (lotse-taskdb-<task>), so the data
// can be copied without the task container: after the first import into an image, from the cleanly stopped MySQL into a snapshot volume
// (lotse-db-<dump>-<image hash>), and for later tasks from that snapshot into their fresh volume before their container (and MySQL)
// starts. The copy runs in a container of the task image with a fixed command: no network, root with only the capabilities a
// `cp -a` needs (read every file, keep owners and modes), no-new-privileges, exactly two volume mounts (/from read-only, /to).
import crypto from 'node:crypto';
import type { ContainerSpec } from './runner';
import { DB_COPY_ROLE, MANAGED, ROLE_LABEL, SNAPSHOT_VOLUME, TASK_DB_VOLUME, TASK_LABEL, sandboxAlias, taskDbVolume } from './labels';

export { taskDbVolume } from './labels';
/** 12 hex characters of the image name's SHA-256: part of the snapshot volume's name (a new image tag = a new name) */
export const imageHash = (image: string) => crypto.createHash('sha256').update(image).digest('hex').slice(0, 12);
export function snapshotVolume(dumpId: string, image: string): string {
  const name = `lotse-db-${dumpId}-${imageHash(image)}`;
  if (!SNAPSHOT_VOLUME.test(name)) throw new Error('Ungültige Dump-ID.');
  return name;
}
/** Only the two kinds of volumes Lotse creates. */
export function assertVolumeName(name: string): string {
  if (typeof name !== 'string' || !(SNAPSHOT_VOLUME.test(name) || TASK_DB_VOLUME.test(name))) throw new Error(`Volume „${String(name).slice(0, 80)}“ wird von Lotse nicht verwaltet.`);
  return name;
}
/** The task a task database volume belongs to (null for a snapshot volume). */
export const volumeTask = (name: string) => (TASK_DB_VOLUME.test(name) ? name.slice('lotse-taskdb-'.length) : null);

export const COPY_FROM = '/from';
export const COPY_TO = '/to';
/** Fixed command: both mounts there, source not empty, target empty (never mixes two copies), then cp -a and sync. Exit 3/4 = refused. */
export const COPY_ENTRYPOINT = ['sh', '-c', `set -e; [ -n "$(ls -A ${COPY_FROM})" ] || { echo 'Quelle ist leer' >&2; exit 4; }; [ -z "$(ls -A ${COPY_TO})" ] || { echo 'Ziel ist nicht leer' >&2; exit 3; }; cp -a ${COPY_FROM}/. ${COPY_TO}/; sync`] as const;
export const COPY_USER = 'root';
/** Docker's default capabilities except CHOWN, DAC_OVERRIDE, FOWNER and FSETID (what cp -a as root needs for MySQL's 0750 files) */
export const COPY_CAP_DROP = ['AUDIT_WRITE', 'KILL', 'MKNOD', 'NET_BIND_SERVICE', 'NET_RAW', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT'] as const;
export const copyContainerName = (taskId: string) => `lotse-dbcopy-${sandboxAlias(taskId).slice('lotse-sbx-'.length)}`;

/** Create body of the copy container: from snapshot to the task's volume (restore) or from the task's volume to a snapshot (save). */
export function buildCopySpec(o: { taskId: string; image: string; from: string; to: string }): ContainerSpec {
  if (!/^t_[a-z0-9]{12}$/.test(o.taskId)) throw new Error('Ungültige Aufgaben-ID.');
  const own = taskDbVolume(o.taskId);
  if (!((o.from === own && SNAPSHOT_VOLUME.test(o.to)) || (o.to === own && SNAPSHOT_VOLUME.test(o.from)))) throw new Error('Ungültige Volumes für die Datenbank-Kopie.');
  return {
    name: copyContainerName(o.taskId), Image: o.image, Labels: { ...MANAGED, [ROLE_LABEL]: DB_COPY_ROLE, [TASK_LABEL]: o.taskId },
    Entrypoint: [...COPY_ENTRYPOINT], User: COPY_USER,
    HostConfig: {
      NetworkMode: 'none', CapDrop: [...COPY_CAP_DROP], SecurityOpt: ['no-new-privileges:true'], Memory: 512 * 1024 * 1024, PidsLimit: 64,
      RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      Mounts: [{ Type: 'volume', Source: o.from, Target: COPY_FROM, ReadOnly: true }, { Type: 'volume', Source: o.to, Target: COPY_TO, ReadOnly: false }],
    },
  };
}
