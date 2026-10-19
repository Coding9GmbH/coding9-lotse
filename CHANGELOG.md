# Changelog

Alle nennenswerten Änderungen an Lotse stehen in dieser Datei.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionen folgen [Semantic Versioning](https://semver.org/lang/de/).
Die Einträge bis 0.4.0 sind nachträglich aus dem Git-Verlauf und den Tags rekonstruiert.
Die Einträge werden beim Release aus dem Git-Verlauf seit dem letzten Tag geschrieben (siehe [CONTRIBUTING.md](CONTRIBUTING.md#versionen--changelog)).

## [0.9.5] – 2026-10-19

### Hinzugefügt
- Sandbox Coding: In den Einstellungen der Sandbox-Umgebung lässt sich ein eigenes Dockerfile hinterlegen (Anweisungen nach `FROM`, z. B. PHP-Erweiterungen oder Pakete). Lotse baut daraus beim ersten Start ein eigenes Image auf Basis des Dockware-Images der Sandbox; eine Änderung baut ein neues Image.
- Sandbox Coding: Verweigert packages.shopware.com beim `composer install` den Download, fragt der fehlgeschlagene Schritt den Composer-Token deines Shopware-Kontos ab, speichert ihn verschlüsselt als geheime Variable `COMPOSER_AUTH` und versucht den Schritt sofort erneut.

### Geändert
- Sandbox Coding: Die Hinweise bei fehlgeschlagenem `composer install` erkennen eine fehlende PHP-Version oder -Erweiterung genauer (kein falscher Alarm mehr bei Paketen wie `shopware/platform`) und nennen bei zu wenig Arbeitsspeicher die Einstellung dafür; composer läuft ohne eigenes Speicherlimit.

## [0.9.4] – 2026-10-19

### Geändert
- Sandbox Coding: Große Repositorys lassen sich in den Test-Shop übertragen – die Meldung „Zu viele Dateien im Repository (mehr als 20000)“ entfällt. Die Dateien werden beim Hochladen nacheinander gelesen statt vorab im Speicher gehalten; begrenzt ist nur noch die Gesamtgröße (2 GB statt 256 MB).

## [0.9.3] – 2026-10-19

### Geändert
- Sandbox Coding: Ein ganzes Shopware-Projekt wird jetzt vollständig im Test-Shop installiert (`composer install` aus der `composer.lock` des Projekts, Datenbank-Migrationen, Plugins, Apps und Theme). Da Composer Internet braucht, wartet die Einrichtung auf deine Freigabe („Internet: aus“ oben in der Sandbox) und trennt den Container danach wieder; private Pakete lassen sich über das Geheimnis `COMPOSER_AUTH` der Sandbox-Umgebung anmelden. Das bisherige Verhalten bleibt mit `"projectInstall": "overlay"` in `.lotse/sandbox.json` verfügbar.

### Behoben
- Sandbox Coding: Nach dem Datenbank-Snapshot wartet die Einrichtung nur noch auf MySQL statt auf eine HTTP-200-Antwort des Shops.

## [0.9.2] – 2026-10-19

### Hinzugefügt
- Sandbox Coding: Ein Shopware-Projekt darf in einem Unterordner des Repositorys liegen (z. B. `shop/`, daneben ein Frontend oder Infrastruktur). Lotse findet den Ordner selbst oder liest `projectDir` aus `.lotse/sandbox.json`; in den Test-Shop kommt nur dieser Ordner, Dateien daneben kann die KI trotzdem ändern, sie werden mit veröffentlicht (nie `vendor/`, `node_modules/`, Workflows oder Geheimnisse).

### Geändert
- Sandbox Coding: Schlüsselordner `config/jwt/` sind jetzt auf jeder Ebene des Repositorys für die KI gesperrt, nicht nur im Hauptordner.

## [0.9.1] – 2026-10-19

### Behoben
- Der Hinweis zu den Integrationen unter Einstellungen → KI-Zugriff zeigte `**lesen**` mit den Sternchen an.
- Das Docker-Image von 0.9.0 wurde wegen eines fehlschlagenden Tests nicht veröffentlicht; 0.9.1 enthält denselben Stand mit den Korrekturen.

### Geändert
- README (Deutsch und Englisch): SEO-Bereich, Abverkauf, Kostenbremse, Internetrecherche und die ZIP-Karte beschrieben, neue Screenshots aus einer frischen Instanz.

## [0.9.0] – 2026-10-19

### Hinzugefügt
- **Sandbox Coding** (einschaltbar unter Einstellungen → Sandbox, standardmäßig aus): Eine Entwicklungsumgebung mit Git-Anbindung, in der Claude Code oder Codex ein Plugin, Theme oder ganzes Shopware-Projekt in einem eigenen Test-Shop in Docker ändern, prüfen und Schritt für Schritt committen; der Live-Shop bleibt unberührt.
- Sandbox: Storefront der Aufgabe als bedienbare Vorschau mit „Anmerken“, Vorher/Nachher-Screenshots, Konsole mit eigener Shell im Container, Datenbank-Dumps und gespeicherte Datenbanken mit schnellem Start.
- Sandbox: Gespeicherte Umgebungen („einmal einrichten, für jeden Auftrag eine frische Sandbox“), Start in drei Schritten, eigenes Setup, Start ohne Projekt und Einstellungen im Repository über `.lotse/sandbox.json` (Befehle daraus laufen erst nach deiner Freigabe).
- Sandbox: Neue Plugins in einem leeren Repository bauen, GitHub-Projekt per Klick anlegen, Änderungen als Pull Request zur Prüfung freigeben und Rückmeldungen zum Pull Request an die KI übergeben.
- Sandbox: Plugin als ZIP für den Live-Shop herunterladen; die KI kann es per Karte im Chat vorschlagen, geprüft und geladen wird erst mit deinem Klick.
- Sandbox: Internet im Container nur nach deiner Freigabe, Dateien aus dem Container ins Projekt übernehmen.
- Wirkungsmessung: Im SEO-Bereich zeigt eine eigene Ansicht, was Änderungen an Texten und Layouts bewirkt haben.
- Abverkauf: Top-Seller und Ladenhüter aus Summen je Produkt (ohne Kunden- und Bestelldaten); standardmäßig aus.
- Kostenbremse: Monatsbudget für Claude, KI-Kosten je Runde und Hinweis im Chat ab 80 %.
- Styleguide-Onboarding auf allen Plattformen.
- Entwurfsvorschau im echten Theme für Shopify, Magento und OpenMage.
- Sistrix OnPage: Zeigt die Seiten, die ein defektes Bild, eine defekte Datei oder einen defekten Link einbinden.

### Geändert
- Abhängigkeiten aktualisiert (u. a. Next.js 16.4.2, React 19.3.1, Codex SDK 0.163).
- Sandbox im Docker-Betrieb: Das Subnetz `LOTSE_SANDBOX_SUBNET` hat den Standard `10.213.0.0/24`; die Sandbox bleibt nur noch bei einem ungültigen Wert gesperrt.
- Sandbox im Docker-Betrieb (`docker-compose.sandbox.yml`): Der Lotse-Container läuft mit einem eigenen Seccomp-Profil (`docker/seccomp-codex.json`), damit Codex Dateien schreiben kann. Wer Sandbox Coding mit Codex nutzt, startet mit `make sandbox-up` neu.

### Behoben
- Codex konnte im gehärteten Container keine Dateien schreiben („Failed to write file“).

## [0.8.1] – 2026-10-15

### Sicherheit
- Lieferanten-Import: HTML aus Importdateien wird jetzt über eine Allowlist bereinigt; bisherige Umgehungen der Blockliste (etwa `<svg onload>`, `<img onerror>`, verschachtelte Script-Tags) sind geschlossen.
- Schutz vor extrem langsamer Verarbeitung (ReDoS) bei manipuliertem HTML mit ungeschlossenen Tags.
- Schutz vor Server-Side-Request-Forgery: Weiterleitungen beim Abruf von Shop-Seiten, im Shop-Proxy und bei Stylesheets der Styleguide-Analyse werden geprüft und nur zu vertrauenswürdigen Adressen verfolgt.
- Seitenübergreifende (Cross-Site) GET-Anfragen an die API werden abgewiesen.
- Auswertung hochgeladener Rechtstext-Dateien nutzt die abgesicherten Parser mit Zip-Bomb-Schutz sowie Seiten- und Textlimits.
- Abruf generierter Bilder und OpenMage-Medien hat Größen- und Zeitlimits.
- Die Schlüsseldatei wird auf Länge geprüft und mit restriktiven Rechten (0600) angelegt; fehlgeschlagenes Entschlüsseln wird protokolliert.

### Behoben
- Das Upload-Limit gilt jetzt einheitlich für Upload und Bildaufbereitung.
- `&amp;lt;` wurde in Texten doppelt dekodiert.
- Abgelehnte Antworten des Shops (429/503) geben die Verbindung sofort wieder frei.

## [0.8.0] – 2026-10-14

### Hinzugefügt
- KI-Zugriff: neuer Schalter „Internetrecherche“ (Einstellungen → KI-Zugriff → Internet). Ist er an, darf die KI im Internet suchen und öffentliche Webseiten lesen, etwa Herstellerangaben, Datenblätter oder Pflichtangaben, und nennt dabei ihre Quellen; geschrieben wird weiterhin nur nach Freigabe.
- SEO-Bereich: technische Probleme aus dem OnPage-Crawl des Sistrix-Optimizers (Fehler und Warnungen mit Fundstellen, letzter Crawl mit Seiten-, Fehler- und Warnungszahl).
- SEO-Bereich: Gibt es im Sistrix-Konto mehrere Optimizer-Projekte, wählst du das Projekt des Shops direkt dort aus; die Wahl gilt auch für die KI-Werkzeuge und den Shop-Check.
- SEO-Bereich: Hebel lassen sich als „Erledigt“ (taucht wieder auf, wenn die Quelle ihn eine Woche später noch meldet) oder „Ignoriert“ (dauerhaft) ausblenden und jederzeit wieder einblenden; was eine Quelle nicht mehr meldet, verschwindet von selbst.
- SEO-Bereich zeigt die SEO-Befunde aus dem Shop-Check, die Arbeitsfläche eine Karte mit den wichtigsten offenen SEO-Hebeln; „In Bearbeitung“ gilt in beiden Richtungen.
- SEO-Bereich und KI: neue Search-Console-Auswertungen „Kurz vor Seite 1“ (Suchanfragen auf Position 4 bis 15 mit geschätztem Gewinn), „Kannibalisierung“ (eigene Seiten konkurrieren um dieselbe Suchanfrage) und „Klickverlust“ (deutlich weniger Klicks als in den 28 Tagen davor, bereinigt um den Trend des ganzen Shops), jeweils mit fertigem Auftrag nach SEO-Best-Practice.
- Shop-Check: neue Prüfungen für Kannibalisierung und Klickverluste aus der Search Console.
- Technik-Check der Shop-Seiten (alle Plattformen, ohne Sistrix): Lotse liest Startseite, eine Kategorie- und eine Produktseite sowie robots.txt und Sitemap und meldet im SEO-Bereich gesperrte Seiten (noindex, robots.txt), fehlende oder fremde Canonicals, fehlende Title/Descriptions, falsche H1-Anzahl, fehlende strukturierte Produkt- und Breadcrumb-Daten, Viewport und Sprache; die KI kann den Check als Werkzeug nutzen.

### Geändert
- Shopify, Magento 2 und OpenMage sind jetzt als „Alpha“ gekennzeichnet (Plattformauswahl, Hinweis unter „Shop verbinden“, Statuszeile in der Seitenleiste und README), weil bisher nur Shopware aktiv getestet wird.
- Der Menüpunkt „SEO“ ist jetzt immer sichtbar, weil der Technik-Check keine Anbindung braucht.
- Ist die Internetrecherche aus (Standard), sagt die KI das offen und verweist auf den Schalter, statt Angaben zu erfinden.
- SEO-Bereich übersichtlicher: Kennzahlen als Filter, Gruppen für Technik, Keywords, Meta-Daten und Shop-Check, je fünf Einträge mit „Alle anzeigen“.
- SEO-Daten werden gespeichert und erst per „Neu abholen“, nach einem Tag oder bei geänderter Anbindung neu geholt; ein Seitenaufruf kostet so keine Sistrix-Credits mehr.

### Behoben
- Sistrix-OnPage-Fehler fehlten im SEO-Bereich stillschweigend, wenn mehrere Optimizer-Projekte existieren und keines nach der Domain benannt ist.
- Die betroffenen URLs einer OnPage-Fehlerart kamen bei der KI nicht an, weil Sistrix sie verschachtelt liefert.

## [0.7.2] – 2026-10-14

### Behoben
- E2E-Test der Einstellungen an die neue Überschrift „Allgemein“ angepasst. Für Nutzer ändert sich nichts.

## [0.7.1] – 2026-10-14

### Geändert
- Entwicklungs-Werkzeuge aktualisiert: ESLint 10, TypeScript 6 und die Node-26-Typdefinitionen. Für Nutzer ändert sich nichts. TypeScript 7 folgt, sobald typescript-eslint es unterstützt.

## [0.7.0] – 2026-10-14

### Hinzugefügt
- KI-Zugriff: eigener Schalter für Hersteller (bisher bei den Produkten) sowie neue Schalter „Search Console“ und „Sistrix“ im Bereich Integrationen. Ist ein Schalter aus, verschwinden die zugehörigen Werkzeuge, Shop-Prüfungen, Beispiele und der Bereich in der SEO-Übersicht.

### Geändert
- Einstellungen sind in Unterseiten aufgeteilt: Allgemein (Sprache, Shop, KI, Bild-KI), KI-Zugriff, Integrationen (Search Console, Sistrix) und Protokolle, mit eigener Navigation und eigenen Adressen unter `/settings/…`.
- Hinweistexte der KI verweisen jetzt auf „Einstellungen → Integrationen“ bzw. „KI-Zugriff“.

## [0.6.0] – 2026-10-14

### Hinzugefügt
- Sistrix-Anbindung (optional, nur lesend): Unter Einstellungen → Sistrix API-Schlüssel und Domain eintragen, danach liest die KI Sichtbarkeitsindex, Top-Seiten, Chancen, Wettbewerber, Keyword-Kennzahlen und den OnPage-Crawl des Optimizers; Seiten werden Produkten, Kategorien und Landingpages des Shops zugeordnet. Anfragen sind gedeckelt und werden zwischengespeichert, damit Credits nicht unnötig verbraucht werden.
- Neuer Menüpunkt „SEO“ (nur sichtbar, wenn Search Console oder Sistrix verbunden ist): bündelt die wirksamsten Hebel (schwache Klickraten, Inhaltslücken, Keyword-Potenzial, OnPage-Fehler) mit Kennzahlen. „Optimieren“ legt den fertigen Auftrag in einen neuen Chat; gesendet wird erst nach deiner Bestätigung, geschrieben erst nach deiner Freigabe.
- Startseite: Karte „Sistrix-Sichtbarkeit“ mit Wert, Veränderung und Verlauf der letzten Wochen; neue Beispiel-Aufträge für Sistrix und Hersteller. Beispiele, Karte und Prüfungen zu Search Console und Sistrix erscheinen nur, wenn die jeweilige Anbindung verbunden ist.
- Zwei neue Shop-Prüfungen: gesunkene Sistrix-Sichtbarkeit und OnPage-Fehler aus dem letzten Crawl (nur, wenn Sistrix verbunden ist).
- Shopware: Hersteller lassen sich per Chat anlegen, bearbeiten (Name, Beschreibung, Webseite, Logo) und einzeln lesen, mit Alt-Neu-Vergleich, Freigabe und Rückgängig. Vorhandene Namen werden nicht doppelt angelegt, zwischenzeitliche Änderungen im Shop nicht überschrieben.
- Shopware: Ein Landingpage-Layout lässt sich einer Kategorie zuweisen (`publish_page` mit `target=category`), insbesondere der Startseite eines Verkaufskanals (dessen Einstiegskategorie). Für „alle Kategorien“ gilt das bewusst nicht.

### Geändert
- Shopware: Nach dem Anwenden oder Rückgängigmachen einer Änderung, auch beim Veröffentlichen einer Seite, leert Lotse den Shop-Cache, damit sie sofort sichtbar ist. Schlägt das fehl (etwa wegen fehlender Berechtigung), bleibt die Änderung gültig und es steht ein Hinweis im Log; abschaltbar mit `LOTSE_CLEAR_CACHE=0`.
- Shopware: Beim Veröffentlichen eines Layouts auf Kategorien wird der Kategorietyp beachtet. Strukturelemente und Links zeigen kein Layout und werden schon vor der Freigabe mit verständlicher Begründung abgelehnt.

### Behoben
- Shopware: Ein Landingpage-Entwurf wurde für die Startseite bzw. Kategorien abgelehnt („erwartet product_list“), obwohl Shopware es erlaubt; die Zuordnung musste im Shopware-Admin erfolgen.

## [0.5.0] – 2026-10-14

### Sicherheit
- Shop-Vorschau-Proxy: Jede Antwort, die kein HTML ist (SVG, XML, XHTML, CSS, JS, Schriften, Bilder), läuft in einer CSP-Sandbox mit `nosniff`; der MIME-Typ wird ohne Groß-/Kleinschreibung geprüft. Vorher konnte ein Skript in einer SVG aus den Shop-Medien auf Lotses eigener Adresse laufen.
- Gespeicherte Zugangsdaten gelten nicht mehr, sobald die Shop-Adresse auf eine andere Herkunft (Schema, Host oder Port) zeigt, damit sie nie an einen fremden Server gehen; die Oberfläche bittet um erneute Eingabe. Zeigt die Adresse wieder auf die alte Herkunft (z. B. nach einem Tippfehler), sind sie wieder da.
- Host-Prüfung nutzt die echte Socket-Adresse: `Host: localhost` plus gefälschtes `X-Forwarded-For` öffnet keinen Zugang von außen mehr.
- Login-Bremse: nach 10 falschen Passwörtern in 15 Minuten je Adresse 5 Minuten Sperre (429). Steht der Reverse-Proxy auf einem anderen Rechner, dessen Adresse in `LOTSE_TRUSTED_PROXIES` eintragen. Passwörter mit Umlauten funktionieren.
- Sicherheits-Header für Oberfläche und API (`X-Frame-Options: DENY`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`, `form-action`).
- Warnung beim Start und in den Einstellungen, wenn `ALLOWED_HOSTS` ohne `LOTSE_PASSWORD` gesetzt ist.
- Bild-Downloads: Schutz gegen DNS-Rebinding (geprüfte IP wird für die Verbindung festgehalten), Größenlimit 20 MB, Cloud-Metadaten- und Link-Local-Adressen immer gesperrt.
- Freigabekarte warnt deutlich, wenn eine Änderung JavaScript enthält, und listet die Domains, von denen sie lädt oder an die sie sendet.
- KI-Vorschau darf keine Netzwerkanfragen absetzen (`connect-src 'none'`, `form-action 'none'`).
- Uploads: Schutz vor Zip-Bomben (Einträge, entpackte Größe, Kompressionsrate) für Excel/Word; Zeilen- und Seitenlimits für Tabellen und PDFs im Wissen.
- Codex: zusätzliche Funktionen (Plugins, Browser-Zugriff, Rechte-Anfragen, Websuche) ausdrücklich abgeschaltet.
- Datenbankdatei wird auch außerhalb von Docker nur für den Besitzer lesbar angelegt (600).

### Hinzugefügt
- Mehrsprachigkeit: Oberfläche und KI-Antworten auf Deutsch und Englisch, Sprachwahl in Einstellungen und Navigation (Cookie `lotse_lang`); englische Fassungen von README, Doku, CONTRIBUTING, SECURITY und DISCLAIMER, zweisprachige Issue-/PR-Vorlagen (#14).
- Audit-Log zeigt, wer eine Änderung angewendet oder rückgängig gemacht hat (Login-Name bei `LOTSE_PASSWORD`).
- Seitenleiste: ältere Chats nachladen (mehr als 200 Chats).
- Automatisches Aufräumen alter Protokolle: `LOTSE_LOG_RETENTION_DAYS` (Standard 180) und `LOTSE_AUDIT_RETENTION_DAYS` (Standard 365).
- Strukturiertes Server-Log mit Dauer, Modell, Tokens und Kosten je Chat-Runde: `LOTSE_LOG_FORMAT=json`, `LOTSE_LOG_LEVEL`.
- Ende-zu-Ende-Tests mit Playwright (Vorschlag → Anwenden → Rückgängig, Ablehnen, Einstellungen, Wissen, Barrierefreiheit per axe) gegen Shopify-Fake und Fake-KI: `npm run test:e2e`.
- `CHANGELOG.md`, Dependabot für npm, GitHub Actions und das Docker-Basis-Image.

### Geändert
- Datenbank-Schema mit echten Migrationen (`PRAGMA user_version`) und Indizes; bestehende Datenbanken werden beim Start automatisch aktualisiert.
- `make backup` sichert einen konsistenten Datenbank-Schnappschuss (`VACUUM INTO`) statt der laufenden Datei; das Archivformat bleibt gleich.
- Chats werden beim Streaming gebündelt gespeichert (höchstens alle 500 ms); Rückfragen, Änderungssets und Freigaben weiterhin sofort.
- Server-Meldungen (Abbruch, Neustart, Anmeldefehler u. a.) auf Deutsch und Englisch.
- README positioniert Lotse als Multi-Plattform-Werkzeug (Shopware 6, Shopify, Magento 2, OpenMage) mit Abschnitt „Unterstützte Shopsysteme“.
- CI: Build, Smoke-Test und E2E laufen auch bei Pull Requests, `npm audit` (ab high) als Prüfschritt, Actions per Commit-SHA gepinnt; jeder PR braucht einen CHANGELOG-Eintrag und eine höhere Version.
- Test-Fakes (Google Search Console, Magento, OpenMage) liegen unter `tests/support/` statt im Produktionscode.

### Behoben
- Docker-Schnellstart in der README setzt `LOTSE_BIND=127.0.0.1`; ohne kam im Browser „Host nicht erlaubt“.

## [0.4.0] – 2026-10-13

### Hinzugefügt
- Layout mit Bereichswahl (Shopware): eine Kategorie, mehrere Kategorien, einzelne Produkte, alle Produkte einer Kategorie oder der ganze Shop; atomares Schreiben, Rückgängig je Seite.
- Entwurf auf der echten Seite: Kopf, Fuß, Theme, Kaufbox und Produktliste der Zielseite bleiben, nur der Inhalt wird ersetzt.
- Eigene Shop-Prüfungen per Chat (alle Plattformen), Prüfungen an- und ausschaltbar.
- JavaScript in der Vorschau, isoliert per CSP-Sandbox.
- Dokumentation: Selbst hosten (`LOTSE_PASSWORD`, `ALLOWED_HOSTS`, Reverse-Proxy), Benutzerhandbuch, Architektur, Dokumentationsindex.

### Geändert
- Regeln werden im Styleguide gepflegt, die Wissen-Seite nur noch für Dokumente.

### Behoben
- Chat-Schritte ohne Ergebnis bleiben nicht mehr dauerhaft auf „läuft“.

## [0.3.3] – 2026-10-13

### Hinzugefügt
- Eigene Regeln im Styleguide, optional auf eine Kategorie begrenzt.

### Behoben
- Vorschau-Proxy folgt Weiterleitungen auf dieselbe Site (z. B. `stage.` → `www.`), fremde Domains bleiben gesperrt.

## [0.3.2] – 2026-10-13

### Behoben
- Docker-Bridge-Gateway gilt bei Loopback-Publish als lokal („Host nicht erlaubt“ beim Zugriff auf localhost).

## [0.3.1] – 2026-10-13

### Geändert
- CI: zurück auf öffentliche GitHub-Runner; Fork-PRs laufen nie auf eigenen Runnern.

## [0.3.0] – 2026-10-13

### Hinzugefügt
- Überarbeitete Navigation, Kontext-Chip direkt im Eingabefeld, Einrichtungs-Checkliste solange Shop oder KI fehlen.
- Einstellungen speichern automatisch; Abschnitts-Navigation mit Status.
- Kompakter Shop-Check mit Bereichs-Reitern, „in Arbeit“-Verknüpfung zwischen Befund und Chat, Neuprüfung nach Anwenden und Rückgängig.
- Verlauf nach Kontext filterbar.

### Behoben
- Abschnitts-Navigation der Einstellungen markiert den richtigen Abschnitt.

## [0.2.2] – 2026-10-12

### Sicherheit
- Restliche Befunde des Oktober-Reviews: Felder, die sich seit dem Vorschlag geändert haben, werden nicht überschrieben; Loopback-Hosts nur von Loopback; Wildcard-CORS nur für Schriften und Bilder; externe Rewrite-Ziele in OpenMage abgewiesen; MCP-Token endet mit der Runde; Rückgängig bleibt erhalten, wenn das Anlegen eines Produkts in einen Timeout läuft.

### Geändert
- Hinweise vor Klicks, die in den Shop schreiben; Ladefehler statt leerer Zustände; Barrierefreiheit (Namen, sichtbarer Fokus).
- Prompts versprechen keine Felder mehr, die der Shop nicht speichert; Massenänderungs-Grenzen je Plattform dokumentiert.

## [0.2.1] – 2026-10-12

### Sicherheit
- Befunde des Oktober-Reviews behoben.

### Geändert
- CI veröffentlicht das Image bei einem Tag `v*` automatisch.
- Tests unter `tests/` gebündelt, Test-Hilfen unter `tests/support/`.
- README mit Demo-Video, Screenshots und eigenen Demo-Bildern.

## [0.2.0] – 2026-10-12

### Hinzugefügt
- Erste öffentliche Version: KI-Interface für Shopware 6, Shopify, Magento 2 und OpenMage (Magento 1, mit Modul `Lotse_Connector`). Chat mit Rückfragen, Änderungssets mit Freigabe, Audit-Log und Rückgängig, Styleguide-Onboarding, Shop-Check, Docker-Image.

[0.9.5]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.9.4...v0.9.5
[0.9.4]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Coding9GmbH/coding9-lotse/releases/tag/v0.2.0
