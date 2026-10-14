import 'server-only';

// Process-wide state (DB, Shopware client, sessions, caches) lives on globalThis:
// survives HMR in dev mode and is shared by all route modules.
const G = globalThis as unknown as { __lotse?: Map<string, unknown> };

export function singleton<T>(key: string, init: () => T): T {
  const m = (G.__lotse ??= new Map());
  if (!m.has(key)) m.set(key, init());
  return m.get(key) as T;
}
