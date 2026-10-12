import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

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
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
