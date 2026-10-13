// Allgemeine Texte, die mehrere Bereiche teilen (Knöpfe, Zeitangaben, Sprachwahl).
// Jeder Namensraum exportiert `de` (Referenz, legt die Form fest) und `en` (muss dieselbe Form haben).

export const de = {
  metaDescription: 'KI-Lotse für deinen Onlineshop (Shopware, Shopify, Magento, OpenMage) · by CODING 9',
  language: 'Sprache',
  languageHint: 'Sprache der Oberfläche und der KI-Antworten.',
  save: 'Speichern',
  cancel: 'Abbrechen',
  close: 'Schließen',
  delete: 'Löschen',
  retry: 'Erneut versuchen',
  loading: 'Lädt …',
  justNow: 'gerade eben',
  minutesAgo: (m: number) => `vor ${m} Min.`,
  hoursAgo: (h: number) => `vor ${h} Std.`,
  today: 'Heute',
  yesterday: 'Gestern',
  last7Days: 'Letzte 7 Tage',
  older: 'Älter',
  sampleSummary: (shown: string, total: string) => `Stichprobe: ${shown} von ${total}. Die Freigabe gilt für die angehakten Gruppen, nicht für jede einzelne Zeile.`,
};

export const en: typeof de = {
  metaDescription: 'AI pilot for your online shop (Shopware, Shopify, Magento, OpenMage) · by CODING 9',
  language: 'Language',
  languageHint: 'Language of the interface and the AI replies.',
  save: 'Save',
  cancel: 'Cancel',
  close: 'Close',
  delete: 'Delete',
  retry: 'Try again',
  loading: 'Loading…',
  justNow: 'just now',
  minutesAgo: (m: number) => `${m} min ago`,
  hoursAgo: (h: number) => `${h} h ago`,
  today: 'Today',
  yesterday: 'Yesterday',
  last7Days: 'Last 7 days',
  older: 'Older',
  sampleSummary: (shown: string, total: string) => `Sample: ${shown} of ${total}. Approval applies to the checked groups, not to every single row.`,
};
