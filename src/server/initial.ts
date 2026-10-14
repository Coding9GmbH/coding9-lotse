import 'server-only';
// Initial data the server renders right away, so nothing jumps around after loading.
import type { ChatDetail, ChatSummary, Styleguide } from '@/lib/protocol';
import { chatListLive, chatSnapshot, peekSession } from './sessions';
import { aiConfigured, publicSettings } from './settings';
import { loadStyleguide } from './styleguide';
import { log } from './log';
import type { Locale } from '@/lib/i18n/locales';

export interface ShellInitial {
  chats: ChatSummary[];
  styleguide: Styleguide | null;
  /** Only "configured yes/no" (without network access); the UI checks afterwards whether the shop is reachable. */
  setup: { shopware: boolean; ai: boolean };
}

export function shellInitial(): ShellInitial | null {
  try {
    return { chats: chatListLive(), styleguide: loadStyleguide(), setup: { shopware: publicSettings().shopware.configured, ai: aiConfigured() } };
  } catch (e) {
    log.error('Startdaten nicht lesbar', { error: e });
    return null;
  }
}

const CHAT_ID = /^[A-Za-z0-9-]{1,200}$/;

/** Chat for the ID from the cookie (only if it exists and has events), even in the middle of a running turn. */
export function initialChat(id: string | undefined, locale?: Locale): ChatDetail | null {
  if (!id || !CHAT_ID.test(id)) return null;
  try {
    const c = chatSnapshot(id, locale);
    return c?.events?.length ? { ...c, running: !!peekSession(id)?.running } : null;
  } catch { return null; }
}
