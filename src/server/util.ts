import 'server-only';
// Small helpers without dependencies (one source instead of copies per module).

/** Error text of an unknown exception */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** fn over the list with at most n calls running at once; results in list order */
export const pool = async <T, R>(list: T[], n: number, fn: (x: T) => Promise<R>) => { const out: R[] = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } })); return out; };

/** Split a list into consecutive chunks of at most n items */
export const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
