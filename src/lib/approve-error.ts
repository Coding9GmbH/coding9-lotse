/** 404, nachdem diese Freigabe schon angenommen wurde: kein zweiter Fehler. Andere Fehler bleiben. */
export function approveError(status: number, alreadySent: boolean): string | null {
  if (status === 404 && alreadySent) return null;
  if (status === 404) return 'Diese Freigabe gibt es nicht mehr.';
  return 'Freigabe konnte nicht gesendet werden';
}
