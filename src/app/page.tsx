import { cookies } from 'next/headers';
import { Workspace } from '@/components/workspace/Workspace';
import { CHAT_COOKIE } from '@/lib/nav';
import { getLocale } from '@/lib/i18n/server';
import { initialChat } from '@/server/initial';
import { getSession } from '@/server/sessions';
import { refreshDraftPreview } from '@/server/tools';

// The most recently opened chat is rendered right away (no switching home page → chat on load).
export default async function Page() {
  const id = (await cookies()).get(CHAT_COOKIE)?.value;
  const locale = await getLocale();
  let saved = initialChat(id, locale);
  // Only create a session for existing chats (the cookie may point to a chat that was never used)
  if (saved && await refreshDraftPreview(getSession(saved.id))) saved = initialChat(saved.id, locale); // old drafts in the current look
  return <Workspace initialChatId={saved?.id ?? crypto.randomUUID()} initialChat={saved} />;
}
