import { cookies } from 'next/headers';
import { Workspace } from '@/components/workspace/Workspace';
import { CHAT_COOKIE } from '@/lib/nav';
import { initialChat } from '@/server/initial';
import { getSession } from '@/server/sessions';
import { refreshDraftPreview } from '@/server/tools';

// Der zuletzt geöffnete Chat wird direkt mitgerendert (kein Umschalten Startseite → Chat beim Laden).
export default async function Page() {
  const id = (await cookies()).get(CHAT_COOKIE)?.value;
  let saved = initialChat(id);
  // Nur für vorhandene Chats eine Session anlegen (das Cookie kann auf einen nie benutzten Chat zeigen)
  if (saved && await refreshDraftPreview(getSession(saved.id))) saved = initialChat(saved.id); // alte Entwürfe im aktuellen Look
  return <Workspace initialChatId={saved?.id ?? crypto.randomUUID()} initialChat={saved} />;
}
