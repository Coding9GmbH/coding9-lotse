import 'server-only';
// Wer hat angewendet / rückgängig gemacht? Benutzername aus dem Browser-Login (Basic Auth, nur wenn LOTSE_PASSWORD gesetzt ist).
// Das Passwort prüft proxy.ts; hier zählt nur der Name vor dem ':'. Ohne Login: null.
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

// Rückgängig läuft innerhalb der Anfrage (AsyncLocalStorage). Anwenden läuft in der Runde der KI weiter, die auf die Freigabe wartet –
// dafür merkt sich die Freigabe-Route den Namen je Chat; die folgenden Audit-Einträge dieses Chats tragen ihn.
const store = () => singleton('actorStore', () => new AsyncLocalStorage<string | null>());
const byChat = () => singleton('actorByChat', () => new Map<string, string | null>());
export const withActor = <T>(actor: string | null, fn: () => T): T => store().run(actor, fn);
export const noteChatActor = (chatId: string, actor: string | null) => { byChat().set(chatId, actor); };
export function currentActor(chatId?: unknown): string | null {
  const s = store().getStore();
  if (s !== undefined) return s;
  return typeof chatId === 'string' ? byChat().get(chatId) ?? null : null;
}
