import 'server-only';
// Where the sandboxes live on the network.
// network: Lotse itself runs in Docker (docker-compose.sandbox.yml) and reaches the containers over the internal bridge
//          "lotse-sandbox" (Internal: no route to the internet or the live shop), no published ports.
// local:   Lotse runs directly on the host (bare metal); each container publishes port 80 on 127.0.0.1 only,
//          on a port Lotse picks. Containers still get no host paths and no privileges.
import net from 'node:net';
import { sandboxSubnet } from '../access';
import { MANAGED } from './guards';
import { getRunner, type SandboxRunner } from './runner';

export const SANDBOX_NETWORK = 'lotse-sandbox';
export type NetworkMode = 'network' | 'local';

/** LOTSE_SANDBOX_NETWORK=network|local overrides; default: network inside the Lotse container, local on bare metal. */
export function networkMode(env: Record<string, string | undefined> = process.env): NetworkMode {
  const v = env.LOTSE_SANDBOX_NETWORK?.trim();
  if (v === 'network' || v === 'local') return v;
  return env.AICB_DOCKER === '1' ? 'network' : 'local';
}

/** Creates the internal network or accepts an existing one only if it is internal, labelled by Lotse and (if set) on LOTSE_SANDBOX_SUBNET,
 *  the subnet proxy.ts refuses requests from. */
export async function ensureNetwork(r: SandboxRunner = getRunner(), subnet = sandboxSubnet()): Promise<{ created: boolean }> {
  const n = await r.inspectNetwork(SANDBOX_NETWORK);
  if (!n) { await r.createNetwork(SANDBOX_NETWORK, { internal: true, labels: { ...MANAGED }, ...(subnet ? { subnet } : {}) }); return { created: true }; }
  if (subnet && !n.subnets.includes(subnet)) throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ hat nicht das Subnetz ${subnet} (LOTSE_SANDBOX_SUBNET), sondern ${n.subnets.join(', ') || 'keines'}. Netzwerk entfernen und Lotse neu starten.`);
  if (!n.internal) throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ ist nicht intern (Internal: true fehlt) – Sandboxes hätten Internetzugang. Netzwerk entfernen oder korrigieren.`);
  if (n.labels['lotse.managed'] !== '1') throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ gehört nicht zu Lotse (Label lotse.managed=1 fehlt).`);
  return { created: false };
}

/** Free port on 127.0.0.1 for the local mode (the task registry remembers it). */
export function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

/** Port binding for the local mode: loopback only, never 0.0.0.0. */
export const localPortBinding = (port: number) => ({ '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] });
