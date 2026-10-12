// Einmalig beim Serverstart
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const host = process.env.HOSTNAME || process.env.HOST || 'localhost';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && process.env.AICB_DOCKER !== '1' && !process.env.LOTSE_PASSWORD)
    console.warn(`WARNUNG: Lotse lauscht auf ${host} ohne LOTSE_PASSWORD – jeder im Netzwerk könnte Änderungen am Shop freigeben.`);
  console.log(`Lotse ${process.env.LOTSE_VERSION || 'dev'} bereit${process.env.LOTSE_PASSWORD ? ' (Login aktiv)' : ''}`);
}
