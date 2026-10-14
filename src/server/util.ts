import 'server-only';
// Small helpers without dependencies (one source instead of copies per module).

/** Error text of an unknown exception */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
