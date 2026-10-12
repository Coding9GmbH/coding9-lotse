import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { AppShell } from '@/components/shell/AppShell';
import { cookies } from 'next/headers';
import { ShellProvider } from '@/components/shell/ShellProvider';
import { NAV_COOKIE } from '@/lib/nav';
import { shellInitial } from '@/server/initial';
import './globals.css';

// Inter liegt als Variable-Font im Repo (src/app/fonts, SIL OFL) – der Build braucht kein Netz. Satoshi kommt (wie bisher) von Fontshare.
const inter = localFont({ src: './fonts/inter-latin-wght-normal.woff2', weight: '100 900', display: 'swap', variable: '--font-inter' });

export const metadata: Metadata = {
  title: { default: 'Lotse', template: '%s · Lotse' },
  description: 'KI-Lotse für deinen Onlineshop (Shopware, Shopify, Magento, OpenMage) · by CODING 9',
  icons: { icon: '/lotse-mark.svg' },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#2e2e38' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const navCollapsed = (await cookies()).get(NAV_COOKIE)?.value === 'collapsed';
  return (
    <html lang="de" className={inter.variable}>
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=satoshi@500,700&display=swap" />
      </head>
      <body>
        <ShellProvider initialCollapsed={navCollapsed} initial={shellInitial()}>
          <AppShell>{children}</AppShell>
        </ShellProvider>
      </body>
    </html>
  );
}
