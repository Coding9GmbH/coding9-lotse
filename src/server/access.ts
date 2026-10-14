// Zugangsschutz, geteilt von proxy.ts, instrumentation.ts und settings.ts (ohne server-only: proxy.ts importiert es).
//
// Echte Absender-Adresse: Next setzt X-Forwarded-For nur, wenn der Client keinen mitschickt
// (next/dist/server/base-server.js: `req.headers['x-forwarded-for'] ??= socket.remoteAddress`). Ein entfernter Client konnte so
// `Host: localhost` + `X-Forwarded-For: 127.0.0.1` senden und die Host-Prüfung umgehen. Der Proxy sieht den Socket nicht; darum
// stempelt instrumentation.ts jede Anfrage am HTTP-Server mit der Socket-Adresse (ein mitgeschickter Header gleichen Namens wird überschrieben).
import type { IncomingMessage } from 'node:http';

export const PEER_HEADER = 'x-lotse-peer';
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** IPv4 in IPv6 (::ffff:127.0.0.1, Dual-Stack-Bind auf ::) als IPv4; Kleinschreibung, ohne Klammern. */
export const normalizeIp = (ip: string) => ip.trim().toLowerCase().replace(/^\[(.*)]$/, '$1').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');

/** Setzt den Peer-Header auf die Socket-Adresse (leer, wenn unbekannt) – nie den Wert des Clients übernehmen. */
export function stampPeer(req: Pick<IncomingMessage, 'headers' | 'socket'>) {
  req.headers[PEER_HEADER] = normalizeIp(req.socket?.remoteAddress ?? '');
}

type Emitter = { emit: (event: string | symbol, ...args: unknown[]) => boolean };
const STAMPED = Symbol.for('lotse.peer-stamp');

/** Hängt sich einmal je Server-Klasse (http/https) vor das 'request'-Ereignis, bevor Next die Anfrage sieht. */
export function installPeerStamp(...protos: object[]) {
  for (const proto of protos) {
    const p = proto as Emitter & { [STAMPED]?: true };
    if (p[STAMPED]) continue;
    const emit = p.emit;
    p.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
      if (event === 'request' && args[0] && typeof args[0] === 'object') stampPeer(args[0] as IncomingMessage);
      return emit.call(this, event, ...args);
    };
    p[STAMPED] = true;
  }
}

/** Freigegebene Namen aus ALLOWED_HOSTS ohne die Loopback-Namen (die sind immer erlaubt, aber nur von Loopback). */
export const extraAllowedHosts = (raw: string | undefined) => (raw ?? '').split(',').map(h => h.trim()).filter(h => h && !LOCAL_HOSTS.includes(h.toLowerCase()));

/** Über ALLOWED_HOSTS von außen erreichbar, aber ohne LOTSE_PASSWORD: jeder, der den Namen erreicht, kann Änderungen freigeben. */
export const openWithoutPassword = (env: Record<string, string | undefined>) => !env.LOTSE_PASSWORD && extraAllowedHosts(env.ALLOWED_HOSTS).length > 0;
