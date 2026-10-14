# Changelog

Alle nennenswerten Änderungen an Lotse stehen in dieser Datei.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionen folgen [Semantic Versioning](https://semver.org/lang/de/).
Die Einträge bis 0.4.0 sind nachträglich aus dem Git-Verlauf und den Tags rekonstruiert.
Jede Änderung bekommt einen eigenen Abschnitt mit neuer Versionsnummer (siehe [CONTRIBUTING.md](CONTRIBUTING.md#versionen--changelog)).

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

[0.5.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Coding9GmbH/coding9-lotse/releases/tag/v0.2.0
