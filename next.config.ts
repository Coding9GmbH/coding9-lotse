import type { NextConfig } from 'next';

// Für alles: /shop (Live-Vorschau im iframe der Oberfläche) und /staged setzen ihre eigene CSP, deshalb hier nur SAMEORIGIN.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];
// Oberfläche und API: nie eingebettet (Clickjacking auf „Freigeben“), keine Plugins, kein <base>, Formulare nur an Lotse.
// Bewusst ohne script-src: Next braucht Inline-Skripte (Hydration), eine Nonce-CSP wäre ein eigenes Projekt.
// Die Entwurfs-Vorschau (srcdoc) erbt diese CSP; sie nutzt weder <base> noch <object>, Formulare sperrt ihre Sandbox ohnehin.
const APP_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const appHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: APP_CSP },
];
const APP_ROUTES = ['/', '/settings/:path*', '/wissen/:path*', '/api/:path*'];

const nextConfig: NextConfig = {
  output: 'standalone',           // schlankes Docker-Image: nur die benötigten Dateien
  poweredByHeader: false,
  skipTrailingSlashRedirect: true, // Shopware-SEO-URLs enden auf / – sonst Redirect-Schleife im Shop-Proxy
  compress: false,                // Chat-Stream (NDJSON) nicht puffern; Lotse läuft lokal
  reactStrictMode: true,
  devIndicators: { position: 'bottom-right' }, // links unten liegt der Status der Navigation
  // KI-Laufzeiten (Claude Agent SDK, OpenAI Codex) starten native Programme aus node_modules → nicht bundeln
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
  outputFileTracingIncludes: {
    '/*': ['./prompts/**/*', './node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**/*', './node_modules/@openai/codex/**/*', './node_modules/@openai/codex-linux-*/**/*'],
  },
  images: { unoptimized: true }, // next/image wird nicht genutzt → sharp entfällt im Docker-Image
  experimental: {
    proxyClientMaxBodySize: '30mb', // Bild-Uploads (max. 25 MB) passieren den Proxy
  },
  async headers() {
    // Spätere Einträge überschreiben gleiche Schlüssel (X-Frame-Options): App-Routen DENY, Rest SAMEORIGIN
    return [{ source: '/:path*', headers: securityHeaders }, ...APP_ROUTES.map(source => ({ source, headers: appHeaders }))];
  },
};

export default nextConfig;
