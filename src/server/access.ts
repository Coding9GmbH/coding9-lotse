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

const ipv4 = (ip: string) => { const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); return m && m.slice(1).every(x => Number(x) <= 255) ? m.slice(1).reduce((n, x) => n * 256 + Number(x), 0) : null; };
/** ip equals an entry or lies in an IPv4 CIDR entry. */
export function inCidr(ip: string, entry: string): boolean {
  const [net, bits] = entry.trim().toLowerCase().split('/');
  if (bits === undefined) return normalizeIp(net) === ip;
  const a = ipv4(ip), b = ipv4(net), n = Number(bits);
  return a !== null && b !== null && /^\d+$/.test(bits) && n >= 0 && n <= 32 && (n === 0 || (a >>> (32 - n)) === (b >>> (32 - n)));
}
export const DEFAULT_SANDBOX_SUBNET = '10.213.0.0/24';
/** LOTSE_SANDBOX_SUBNET: IPv4 CIDR of the internal network lotse-sandbox (same default as docker-compose.sandbox.yml).
 *  Task containers live there; requests from it are never trusted (see proxy.ts). Unset = default; null = invalid. */
export const sandboxSubnet = (env: Record<string, string | undefined> = process.env): string | null => env.LOTSE_SANDBOX_SUBNET?.trim() ? cidr(env.LOTSE_SANDBOX_SUBNET) : DEFAULT_SANDBOX_SUBNET;
/** LOTSE_SANDBOX_EGRESS_SUBNET: IPv4 CIDR of lotse-sandbox-egress, the network a task container joins only while internet is allowed
 *  (pinned in docker-compose.sandbox.yml). Requests from it are never trusted either. null = unset or invalid. */
export const egressSubnet = (env: Record<string, string | undefined> = process.env): string | null => cidr(env.LOTSE_SANDBOX_EGRESS_SUBNET);
function cidr(raw: string | undefined): string | null {
  const v = raw?.trim() ?? '';
  const [net, bits] = v.split('/');
  return ipv4(net ?? '') !== null && /^\d+$/.test(bits ?? '') && Number(bits) >= 8 && Number(bits) <= 30 ? v : null;
}

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

const LOOPBACK_BIND = ['127.0.0.1', 'localhost', '::1'];
/** Address Lotse listens on: in the container LOTSE_BIND (the published port), otherwise HOSTNAME/HOST as `next start` uses them. */
export const bindAddress = (env: Record<string, string | undefined>) => (env.AICB_DOCKER === '1' ? (env.LOTSE_BIND ?? '').trim() : env.HOSTNAME || env.HOST || 'localhost');
export const loopbackBind = (env: Record<string, string | undefined>) => LOOPBACK_BIND.includes(bindAddress(env));
/** Reachable from the network (open bind or ALLOWED_HOSTS) without LOTSE_PASSWORD. */
export const exposedWithoutPassword = (env: Record<string, string | undefined>) => !env.LOTSE_PASSWORD && (!loopbackBind(env) || openWithoutPassword(env));
