import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppShell } from '@/components/shell/AppShell';
import { cookies } from 'next/headers';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { NAV_COOKIE } from '@/lib/nav';
import { shellInitial } from '@/server/initial';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import { getLocale, getMessages } from '@/lib/i18n/server';
import './globals.css';

// Inter and Satoshi live in the repo (src/app/fonts), so the build needs no network for them.
const inter = localFont({ src: './fonts/inter-latin-wght-normal.woff2', weight: '100 900', display: 'swap', variable: '--font-inter' });
const satoshi = localFont({
  src: [
    { path: './fonts/satoshi-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/satoshi-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-satoshi',
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getMessages();
  return { title: { default: 'Lotse', template: '%s · Lotse' }, description: t.common.metaDescription, icons: { icon: '/lotse-mark.svg' } };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2e2e38' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const navCollapsed = (await cookies()).get(NAV_COOKIE)?.value === 'collapsed';
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${inter.variable} ${satoshi.variable}`}>
      <body>
        <I18nProvider locale={locale}>
          <ShellProvider initialCollapsed={navCollapsed} initial={shellInitial()}>
            <AppShell>{children}</AppShell>
          </ShellProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
