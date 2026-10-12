import 'server-only';

// Prozessweiter Zustand (DB, Shopware-Client, Sessions, Caches) liegt auf globalThis:
// überlebt HMR im Dev-Modus und wird von allen Route-Modulen geteilt.
const G = globalThis as unknown as { __lotse?: Map<string, unknown> };

export function singleton<T>(key: string, init: () => T): T {
  const m = (G.__lotse ??= new Map());
  if (!m.has(key)) m.set(key, init());
  return m.get(key) as T;
}
