// Labels on every Lotse container and network (no imports: templates and guards both use them).
export const MANAGED_LABEL = 'lotse.managed';
export const TASK_LABEL = 'lotse.task';
export const MANAGED = { [MANAGED_LABEL]: '1' } as const;
/** Network alias (and DNS name on lotse-sandbox) of a task container */
export const sandboxAlias = (taskId: string) => `lotse-sbx-${taskId.replace(/_/g, '-')}`;
/** Internal bridge network of the sandboxes (compose mode) */
export const SANDBOX_NET = 'lotse-sandbox';
/** Second bridge with internet access (not internal): a task container is attached to it only while a human allowed internet for its task */
export const EGRESS_NET = 'lotse-sandbox-egress';
/** Bridge option: false = containers on the bridge cannot talk to each other (two tasks with internet stay apart) */
export const ICC_OPTION = 'com.docker.network.bridge.enable_icc';
/** Bridge option (Docker Engine 28+): with "isolated" the host gets no address on the bridge, so containers cannot reach host services */
export const ISOLATED_GATEWAY = 'com.docker.network.bridge.gateway_mode_ipv4';
/** What a managed container is for; only the short-lived screenshot containers carry it (the task container has none) */
export const ROLE_LABEL = 'lotse.role';
export const SHOT_ROLE = 'screenshot';
/** Docker volumes of stored databases (db-snapshots.ts), all labelled lotse.managed=1 and one of these roles:
 *  a MySQL snapshot of a stored database for one image, the MySQL data directory of one task, the short-lived container that copies between them */
export const DB_SNAPSHOT_ROLE = 'db-snapshot';
export const TASK_DB_ROLE = 'task-db';
export const DB_COPY_ROLE = 'db-copy';
/** stored database (dump id) of a snapshot volume */
export const DUMP_LABEL = 'lotse.dump';
/** the image a snapshot was taken with (full name; the volume name carries its hash) */
export const IMAGE_LABEL = 'lotse.image';
/** lotse-db-<dump id>-<12 hex of the image's SHA-256> */
export const SNAPSHOT_VOLUME = /^lotse-db-d_[a-z0-9]{16}-[0-9a-f]{12}$/;
/** lotse-taskdb-<task id> */
export const TASK_DB_VOLUME = /^lotse-taskdb-t_[a-z0-9]{12}$/;
export const taskDbVolume = (taskId: string) => `lotse-taskdb-${taskId}`;
