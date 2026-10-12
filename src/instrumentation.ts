const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1']);

/** Die Felder, die die Startwarnung liest. Ein Teilobjekt reicht, der Test muss kein volles ProcessEnv bauen. */
export type BindEnv = {
  AICB_DOCKER?: string;
  LOTSE_BIND?: string;
  HOSTNAME?: string;
  HOST?: string;
  LOTSE_PASSWORD?: string;
  [key: string]: string | undefined;
};

/** Warnung, kein Startabbruch: außerhalb von Docker bei offenem Bind ohne Passwort, im Container wenn LOTSE_BIND fehlt oder nicht Loopback ist. */
export function bindWarning(env: BindEnv): string | null {
  if (env.AICB_DOCKER === '1') {
    const bind = (env.LOTSE_BIND ?? '').trim();
    if (LOOPBACK_BIND.has(bind)) return null;
    const shown = bind === '' ? 'nicht gesetzt' : bind;
    return `WARNUNG: LOTSE_BIND ist ${shown}, nicht Loopback – der Container sieht nicht, worauf der Port veröffentlicht ist. Setze LOTSE_BIND auf 127.0.0.1, localhost oder ::1.`;
  }
  const host = env.HOSTNAME || env.HOST || 'localhost';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !env.LOTSE_PASSWORD)
    return `WARNUNG: Lotse lauscht auf ${host} ohne LOTSE_PASSWORD – jeder im Netzwerk könnte Änderungen am Shop freigeben.`;
  return null;
}

// Einmalig beim Serverstart
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const warning = bindWarning(process.env);
  if (warning) console.warn(warning);
  console.log(`Lotse ${process.env.LOTSE_VERSION || 'dev'} bereit${process.env.LOTSE_PASSWORD ? ' (Login aktiv)' : ''}`);
}
