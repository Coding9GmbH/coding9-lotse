// Access protection, shared by proxy.ts, instrumentation.ts and settings.ts (without server-only: proxy.ts imports it).
//
// Real sender address: Next sets X-Forwarded-For only if the client doesn't send one
// (next/dist/server/base-server.js: `req.headers['x-forwarded-for'] ??= socket.remoteAddress`). A remote client could thus
// send `Host: localhost` + `X-Forwarded-For: 127.0.0.1` and bypass the host check. The proxy doesn't see the socket; therefore
// instrumentation.ts stamps every request at the HTTP server with the socket address (a header of the same name sent by the client is overwritten).
import type { IncomingMessage } from 'node:http';

export const PEER_HEADER = 'x-lotse-peer';
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** IPv4 in IPv6 (::ffff:127.0.0.1, dual-stack bind on ::) as IPv4; lowercase, without brackets. */
export const normalizeIp = (ip: string) => ip.trim().toLowerCase().replace(/^\[(.*)]$/, '$1').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');

/** Sets the peer header to the socket address (empty if unknown); never take the client's value. */
export function stampPeer(req: Pick<IncomingMessage, 'headers' | 'socket'>) {
  req.headers[PEER_HEADER] = normalizeIp(req.socket?.remoteAddress ?? '');
}

type Emitter = { emit: (event: string | symbol, ...args: unknown[]) => boolean };
const STAMPED = Symbol.for('lotse.peer-stamp');

/** Hooks in once per server class (http/https) before the 'request' event, before Next sees the request. */
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

/** Allowed names from ALLOWED_HOSTS without the loopback names (those are always allowed, but only from loopback). */
export const extraAllowedHosts = (raw: string | undefined) => (raw ?? '').split(',').map(h => h.trim()).filter(h => h && !LOCAL_HOSTS.includes(h.toLowerCase()));

/** Reachable from outside via ALLOWED_HOSTS, but without LOTSE_PASSWORD: anyone who reaches the name can approve changes. */
export const openWithoutPassword = (env: Record<string, string | undefined>) => !env.LOTSE_PASSWORD && extraAllowedHosts(env.ALLOWED_HOSTS).length > 0;
