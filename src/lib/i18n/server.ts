import 'server-only';
// Language in server rendering (layouts, pages, metadata): cookie, otherwise Accept-Language.
import { cookies, headers } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, type Locale } from './locales';
import { messages, type Messages } from './index';

export async function getLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return resolveLocale(c.get(LOCALE_COOKIE)?.value, h.get('accept-language'));
}

export async function getMessages(): Promise<Messages> {
  return messages(await getLocale());
}
