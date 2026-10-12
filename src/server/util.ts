import 'server-only';
// Kleine Helfer ohne Abhängigkeiten (eine Quelle statt Kopien je Modul).

/** Fehlertext einer unbekannten Ausnahme */
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
