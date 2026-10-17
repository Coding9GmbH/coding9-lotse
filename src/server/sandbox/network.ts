import 'server-only';
// Where the sandboxes live on the network. In both modes every task container is attached ONLY to the internal bridge
// "lotse-sandbox" (Internal: no route to the internet or the live shop) and publishes no ports.
// network: Lotse itself runs in Docker (docker-compose.sandbox.yml), is attached to lotse-sandbox and reaches the containers there.
// local:   Lotse runs directly on a Linux host (bare metal) and reaches the container's IP on lotse-sandbox through the bridge
//          interface of the host. Where the host has no route into Docker's networks (Docker Desktop on macOS/Windows), the setup
//          stops with a clear message instead of falling back to a network with internet access.
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

const ROUTE_WAIT_MS = 20_000;
const UNREACHABLE = 'Lotse erreicht den Sandbox-Container nicht über das interne Docker-Netzwerk „lotse-sandbox“ (z. B. Docker Desktop auf macOS/Windows: der Host hat keine Route in Docker-Netzwerke). Lotse dann selbst in Docker betreiben (docker-compose.sandbox.yml, make sandbox-up). Ein Netzwerk mit Internetzugang wird bewusst nicht verwendet.';

/** Is there a route to host:port? A refused connection counts as reachable (the web server inside is just not up yet);
 *  host/network unreachable or silence until the deadline does not. */
export async function probeRoute(host: string, port: number, o: { waitMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const end = Date.now() + (o.waitMs ?? ROUTE_WAIT_MS);
  for (;;) {
    const r = await new Promise<'ok' | 'retry' | 'no-route'>(resolve => {
      const sock = net.connect({ host, port });
      const done = (v: 'ok' | 'retry' | 'no-route') => { sock.destroy(); resolve(v); };
      sock.setTimeout(3000, () => done('retry'));
      sock.once('connect', () => done('ok'));
      sock.once('error', (e: NodeJS.ErrnoException) => done(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' ? 'ok' : e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' ? 'no-route' : 'retry'));
    });
    if (r === 'ok') return;
    if (r === 'no-route' || Date.now() > end) throw new Error(UNREACHABLE);
    if (o.signal?.aborted) throw new Error('Abgebrochen.');
    await new Promise(res => setTimeout(res, 1000));
  }
}
