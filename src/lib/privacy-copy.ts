/** Was den Rechner Richtung Anthropic oder OpenAI verlässt. Steht neben dem Satz zu den Zugangsdaten. */
export const EGRESS_NOTICE =
  'Chat, Produkttexte, CMS-HTML, GPSR und Bild-Prompt verlassen diesen Rechner und gehen an Anthropic oder OpenAI. Löschen in Lotse löscht die Kopie dort nicht.';

/** Suchbegriffe aus der Search Console gehen mit an die KI. Kein Zugangsdatum. */
export const GSC_QUERY_NOTICE = 'Die Suchbegriffe gehen an die KI.';

/** Kurzfrage vor dem Entfernen eines Chats. Audit, Dateien und die Anbieter-Kopie bleiben. */
export function chatDeleteQuestion(title: string): string {
  return `„${title}“ löschen? Nur dieser Chat wird entfernt. Audit, Dateien und die Kopie bei Anthropic oder OpenAI bleiben.`;
}
