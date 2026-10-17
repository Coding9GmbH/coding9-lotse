// Labels on every Lotse container and network (no imports: templates and guards both use them).
export const MANAGED_LABEL = 'lotse.managed';
export const TASK_LABEL = 'lotse.task';
export const MANAGED = { [MANAGED_LABEL]: '1' } as const;
/** Network alias (and DNS name on lotse-sandbox) of a task container */
export const sandboxAlias = (taskId: string) => `lotse-sbx-${taskId.replace(/_/g, '-')}`;
/** Internal bridge network of the sandboxes (compose mode) */
export const SANDBOX_NET = 'lotse-sandbox';
/** Bridge option (Docker Engine 28+): with "isolated" the host gets no address on the bridge, so containers cannot reach host services */
export const ISOLATED_GATEWAY = 'com.docker.network.bridge.gateway_mode_ipv4';
