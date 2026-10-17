import 'server-only';
// Where the sandboxes live on the network. In both modes every task container is attached ONLY to the internal bridge
// "lotse-sandbox" (Internal: no route to the internet) and publishes no ports.
// network: Lotse itself runs in Docker (docker-compose.sandbox.yml), is attached to lotse-sandbox and reaches the containers there.
//          The bridge is "isolated" (Docker Engine 28+): the host has no address on it, so host services (a live shop on the same
//          server, its database) are out of reach too.
// local:   Lotse runs directly on a Linux host (bare metal) and reaches the container's IP on lotse-sandbox through the bridge
//          interface of the host. That address is also the container's way to the host: services listening on 0.0.0.0 are reachable
//          unless a firewall rule drops traffic from the subnet (docs); the setup probes common ports and warns. Where the host has
//          no route into Docker's networks (Docker Desktop on macOS/Windows), the setup stops with a clear message instead of
//          falling back to a network with internet access.
import net from 'node:net';
import { sandboxSubnet } from '../access';
import { MANAGED } from './guards';
import { ISOLATED_GATEWAY } from './labels';
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
 *  the subnet proxy.ts refuses requests from. Network mode: isolated from the host (needs Docker Engine 28+); local mode: not
 *  isolated (Lotse on the host reaches the containers through the bridge). */
export async function ensureNetwork(r: SandboxRunner = getRunner(), subnet = sandboxSubnet(), mode: NetworkMode = networkMode()): Promise<{ created: boolean }> {
  const isolated = mode === 'network';
  if (isolated) {
    const major = parseInt((await r.version()).version, 10);
    if (major < 28) throw new Error(`Docker ${major} ist zu alt: Für Lotse in Docker braucht die Sandbox Docker Engine 28 oder neuer (Netz ohne Zugang zum Host).`);
  }
  const n = await r.inspectNetwork(SANDBOX_NETWORK);
  if (!n) { await r.createNetwork(SANDBOX_NETWORK, { internal: true, labels: { ...MANAGED }, ...(subnet ? { subnet } : {}), ...(isolated ? { isolated } : {}) }); return { created: true }; }
  if (subnet && !n.subnets.includes(subnet)) throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ hat nicht das Subnetz ${subnet} (LOTSE_SANDBOX_SUBNET), sondern ${n.subnets.join(', ') || 'keines'}. Netzwerk entfernen und Lotse neu starten.`);
  if (!n.internal) throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ ist nicht intern (Internal: true fehlt) – Sandboxes hätten Internetzugang. Netzwerk entfernen oder korrigieren.`);
  if (n.labels['lotse.managed'] !== '1') throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ gehört nicht zu Lotse (Label lotse.managed=1 fehlt).`);
  if (isolated && !n.isolated) throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ ist nicht vom Host getrennt (${ISOLATED_GATEWAY}=isolated fehlt) – Sandboxes erreichten Dienste auf dem Host. Lotse stoppen, Netzwerk entfernen (docker network rm ${SANDBOX_NETWORK}) und mit der aktuellen docker-compose.sandbox.yml neu starten.`);
  if (!isolated && n.isolated) throw new Error(`Das Docker-Netzwerk „${SANDBOX_NETWORK}“ ist vom Host getrennt (für Lotse in Docker angelegt) – Lotse auf dem Host erreicht die Container darin nicht. Netzwerk entfernen oder LOTSE_SANDBOX_NETWORK=network verwenden.`);
  return { created: false };
}

/** Ports probed on the host (local mode): ssh, web server, databases, caches, search – and Lotse itself. */
export const HOST_PORTS = [22, 80, 443, 3306, 5432, 6379, 9200, 11211, 27017] as const;
const PROBE_SCRIPT = 'gw=$1; shift; for p in "$@"; do (timeout 2 bash -c ": </dev/tcp/$gw/$p" 2>/dev/null && echo "$p") & done; wait';

/** Which ports of the host answer the container through the bridge gateway (local mode). The gateway comes from Docker, never from input. */
export async function openHostPorts(r: SandboxRunner, containerId: string, gateway: string, user: string, ports: readonly number[] = [...HOST_PORTS, Number(process.env.PORT) || 3333]): Promise<number[]> {
  if (!net.isIPv4(gateway)) return [];
  const res = await r.exec(containerId, ['bash', '-c', PROBE_SCRIPT, 'probe', gateway, ...ports.map(String)], { user, workdir: '/', timeoutMs: 15_000 });
  return [...new Set(res.output.split(/\s+/).map(Number).filter(p => ports.includes(p)))].sort((a, b) => a - b);
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
