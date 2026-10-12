import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppShell } from '@/components/shell/AppShell';
import { cookies } from 'next/headers';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { NAV_COOKIE } from '@/lib/nav';
import { shellInitial } from '@/server/initial';
import './globals.css';

// Inter und Satoshi liegen im Repo (src/app/fonts). Der Build braucht dafür kein Netz.
const inter = localFont({ src: './fonts/inter-latin-wght-normal.woff2', weight: '100 900', display: 'swap', variable: '--font-inter' });
const satoshi = localFont({
  src: [
    { path: './fonts/satoshi-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/satoshi-700.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-satoshi',
});

export const metadata: Metadata = {
  title: { default: 'Lotse', template: '%s · Lotse' },
  description: 'KI-Lotse für deinen Onlineshop (Shopware, Shopify, Magento, OpenMage) · by CODING 9',
  icons: { icon: '/lotse-mark.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2e2e38' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const navCollapsed = (await cookies()).get(NAV_COOKIE)?.value === 'collapsed';
  return (
    <html lang="de" className={`${inter.variable} ${satoshi.variable}`}>
      <body>
        <ShellProvider initialCollapsed={navCollapsed} initial={shellInitial()}>
          <AppShell>{children}</AppShell>
        </ShellProvider>
      </body>
    </html>
  );
}
