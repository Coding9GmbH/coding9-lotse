import 'server-only';
// Small helpers without dependencies (one source instead of copies per module).

/** Error text of an unknown exception */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Split a list into consecutive chunks of at most n items */
export const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
