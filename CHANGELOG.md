# Changelog

Alle nennenswerten Änderungen an Lotse stehen in dieser Datei.
Das Format folgt [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), die Versionen folgen [Semantic Versioning](https://semver.org/lang/de/).
Die Einträge bis 0.4.0 sind nachträglich aus dem Git-Verlauf und den Tags rekonstruiert.

## [Unveröffentlicht]

### Hinzugefügt
- Mehrsprachigkeit: Oberfläche und KI-Antworten auf Deutsch und Englisch, Sprachwahl in Einstellungen und Navigation (Cookie `lotse_lang`); englische Fassungen von README, Doku, CONTRIBUTING, SECURITY und DISCLAIMER, zweisprachige Issue-/PR-Vorlagen (#14).
- `CHANGELOG.md`, Dependabot für npm, GitHub Actions und das Docker-Basis-Image.

### Geändert
- Sicherheits-Härtung, DB-Migrationen, … (siehe PR)
- CI: Build und Smoke-Test laufen auch bei Pull Requests, `npm audit` (ab high) als Prüfschritt, Actions per Commit-SHA gepinnt.
- README positioniert Lotse als Multi-Plattform-Werkzeug (Shopware 6, Shopify, Magento 2, OpenMage) mit Abschnitt „Unterstützte Shopsysteme“.
- Test-Fakes (Google Search Console, Magento, OpenMage) liegen unter `tests/support/` statt im Produktionscode.

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

[Unveröffentlicht]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Coding9GmbH/coding9-lotse/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Coding9GmbH/coding9-lotse/releases/tag/v0.2.0
