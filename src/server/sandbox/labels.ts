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
