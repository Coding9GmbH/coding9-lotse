/** Fester Satz für eine abgelehnte Shop-Anmeldung. Der Rohbody der Gegenstelle kommt nie in die Oberfläche. */
export function shopLoginMessage(status: number, body: string): string {
  void status;
  void body;
  return 'Zugang abgelehnt. Prüfe die Zugangsdaten und versuche es erneut.';
}

/** Shopware-Login hängt den Rohbody an diese Meldung. Andere Fehler (Shop nicht erreichbar) bleiben. */
export function isShopLoginFailure(message: string): boolean {
  return /Login fehlgeschlagen/i.test(message);
}
