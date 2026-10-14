import 'server-only';
// Who applied / undid it? Username from the browser login (Basic Auth, only when LOTSE_PASSWORD is set).
// proxy.ts checks the password; only the name before the ':' matters here. Without login: null.
import { AsyncLocalStorage } from 'node:async_hooks';
import { singleton } from './state';

export function actorFromAuth(header: string | null | undefined): string | null {
  if (!process.env.LOTSE_PASSWORD || !header) return null;
  const [scheme, b64 = ''] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'basic' || !b64) return null;
  const decoded = Buffer.from(b64, 'base64').toString('utf8'), i = decoded.indexOf(':');
  const user = (i < 0 ? '' : decoded.slice(0, i)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return user || null;
}
export const actorFromRequest = (req: Request) => actorFromAuth(req.headers.get('authorization'));

// Undo runs within the request (AsyncLocalStorage). Applying continues in the AI's turn that waits for approval,
// so the approval route remembers the name per chat; the following audit entries of this chat carry it.
const store = () => singleton('actorStore', () => new AsyncLocalStorage<string | null>());
const byChat = () => singleton('actorByChat', () => new Map<string, string | null>());
export const withActor = <T>(actor: string | null, fn: () => T): T => store().run(actor, fn);
export const noteChatActor = (chatId: string, actor: string | null) => { byChat().set(chatId, actor); };
export function currentActor(chatId?: unknown): string | null {
  const s = store().getStore();
  if (s !== undefined) return s;
  return typeof chatId === 'string' ? byChat().get(chatId) ?? null : null;
}
