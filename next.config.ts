import type { NextConfig } from 'next';

// For everything: /shop and /sbx (live and sandbox preview in the UI's iframe) and /staged set their own CSP, so only SAMEORIGIN here.
// Referrer-Policy same-origin also keeps the key in /sbx/<id>.<key> URLs from leaking to sites a sandbox page links to.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];
// UI and API: never embedded (clickjacking on "Freigeben"), no plugins, no <base>, forms only to Lotse.
// Deliberately without script-src: Next needs inline scripts (hydration); a nonce CSP would be a project of its own.
// The draft preview (srcdoc) inherits this CSP; it uses neither <base> nor <object>, and its sandbox blocks forms anyway.
const APP_CSP = "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const appHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: APP_CSP },
];
const APP_ROUTES = ['/', '/settings/:path*', '/wissen/:path*', '/sandbox-coding/:path*', '/api/:path*'];

const nextConfig: NextConfig = {
  output: 'standalone',           // slim Docker image: only the required files
  poweredByHeader: false,
  skipTrailingSlashRedirect: true, // Shopware SEO URLs end with /, otherwise redirect loop in the shop proxy
  compress: false,                // don't buffer the chat stream (NDJSON); Lotse runs locally
  reactStrictMode: true,
  devIndicators: { position: 'bottom-right' }, // the navigation status sits at the bottom left
  // AI runtimes (Claude Agent SDK, OpenAI Codex) launch native binaries from node_modules → don't bundle
  serverExternalPackages: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk'],
  outputFileTracingIncludes: {
    '/*': ['./prompts/**/*', './node_modules/@anthropic-ai/claude-agent-sdk-linux-*/**/*', './node_modules/@openai/codex/**/*', './node_modules/@openai/codex-linux-*/**/*'],
  },
  images: { unoptimized: true }, // next/image is not used → no sharp in the Docker image
  experimental: {
    proxyClientMaxBodySize: '30mb', // image uploads (max. 25 MB) pass through the proxy
  },
  async headers() {
    // Later entries override identical keys (X-Frame-Options): app routes DENY, everything else SAMEORIGIN
    return [{ source: '/:path*', headers: securityHeaders }, ...APP_ROUTES.map(source => ({ source, headers: appHeaders }))];
  },
};

export default nextConfig;
