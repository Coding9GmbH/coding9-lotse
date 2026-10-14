// Namensraum "seo": SEO-Übersicht (src/components/seo). `de` legt die Form fest, `en` muss dieselben Schlüssel haben.

export const de = {
  title: 'SEO',
  lead: 'Die wirksamsten Hebel aus deinen Search-Console- und Sistrix-Daten. Ein Klick legt den fertigen Auftrag in einen neuen Chat; gesendet wird erst, wenn du es bestätigst, und geschrieben wird erst nach deiner Freigabe.',
  loading: 'Lade SEO-Daten …',
  refresh: 'Aktualisieren',
  failed: (e: string) => `SEO-Daten konnten nicht geladen werden: ${e}`,
  sourceFailed: (src: string, e: string) => `${src}: ${e}`,
  sources: { gsc: 'Search Console', sistrix: 'Sistrix' },
  groups: {
    gsc: { title: 'Search Console', hint: 'Echte Klicks und Impressionen deiner Seiten.' },
    sistrix: { title: 'Sistrix', hint: 'Marktdaten: Potenzial bei Keywords und technische Probleme.' },
  },
  kinds: { meta: 'Meta-Daten', gap: 'Inhaltslücke', keyword: 'Keyword', onpage: 'OnPage' },
  optimize: 'Optimieren',
  optimizeTitle: 'Legt den Auftrag in einen neuen Chat. Senden bleibt ein eigener Klick.',
  empty: 'Gerade keine Hebel gefunden. Entweder läuft alles gut, oder es gibt noch zu wenige Daten.',
  noSource: 'Verbinde die Search Console oder Sistrix, dann zeigt Lotse hier die wirksamsten SEO-Hebel.',
  toSettings: 'Zu den Einstellungen',
  disclaimer: 'Schätzungen (Potenzial, Gewinn) sind keine Zusagen. Daten der Search Console sind ca. 2 bis 3 Tage alt.',
  generated: (time: string) => `Stand ${time}`,
};

export const en: typeof de = {
  title: 'SEO',
  lead: 'The most effective levers from your Search Console and Sistrix data. One click puts the finished task into a new chat; it is only sent when you confirm, and nothing is written until you approve.',
  loading: 'Loading SEO data …',
  refresh: 'Refresh',
  failed: (e: string) => `SEO data could not be loaded: ${e}`,
  sourceFailed: (src: string, e: string) => `${src}: ${e}`,
  sources: { gsc: 'Search Console', sistrix: 'Sistrix' },
  groups: {
    gsc: { title: 'Search Console', hint: 'Real clicks and impressions of your pages.' },
    sistrix: { title: 'Sistrix', hint: 'Market data: keyword potential and technical issues.' },
  },
  kinds: { meta: 'Meta data', gap: 'Content gap', keyword: 'Keyword', onpage: 'OnPage' },
  optimize: 'Optimize',
  optimizeTitle: 'Puts the task into a new chat. Sending stays a separate click.',
  empty: 'No levers found right now. Either things are going well, or there is not enough data yet.',
  noSource: 'Connect Search Console or Sistrix and Lotse will show the most effective SEO levers here.',
  toSettings: 'Go to settings',
  disclaimer: 'Estimates (potential, gain) are not promises. Search Console data is about 2 to 3 days old.',
  generated: (time: string) => `As of ${time}`,
};
