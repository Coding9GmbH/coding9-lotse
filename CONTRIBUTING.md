**Deutsch** · [English](CONTRIBUTING.en.md)

# Mitwirken

Danke für dein Interesse an Lotse! Fehler, Ideen und Pull Requests sind willkommen.

## Fehler und Ideen
- Fehler und Wünsche als [Issue](../../issues) melden (die Formulare fragen alles Nötige ab) – mit Plattform (Shopware, Shopify, Magento, OpenMage), Lotse-Version und, falls möglich, Schritten zum Nachstellen.
- **Sicherheitslücken nicht öffentlich melden**, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.
- Bitte keine Zugangsdaten, Kundendaten oder Shop-URLs mit sensiblem Inhalt in Issues oder Screenshots posten.

## Entwicklung
```bash
npm install          # Node ≥ 22.13
make dev             # http://localhost:3333
make demo            # optional: Demo-Shop (dockware) dazu
npm run check        # Typecheck, ESLint, Tests – vor jedem Pull Request
npm run test:e2e     # End-to-End (Playwright): baut Lotse und testet gegen Shopify- und KI-Fake
```
Die E2E-Tests (`tests/e2e/*.spec.ts`) brauchen keinen echten Shop und keine echte KI: `tests/e2e/support/serve.ts` startet den
Shopify-Fake, einen Anthropic-Fake (`tests/support/anthropic-fake`, ein Drehbuch-Modell hinter `ANTHROPIC_BASE_URL`) und Lotse mit
leerem Datenordner. Browser einmalig mit `npx playwright install chromium`; schneller beim Entwickeln mit `E2E_DEV=1 npm run test:e2e`.

## Übersetzungen
Die Oberfläche gibt es auf Deutsch und Englisch.
- UI-Texte liegen in `src/lib/i18n/messages/<namensraum>.ts`. `de` gibt die Struktur vor, `en` muss exakt dieselben Schlüssel haben (`en: typeof de`); TypeScript und `tests/lib/i18n.test.ts` erzwingen das. Platzhalter und Mehrzahl als Funktion, z. B. `count: (n: number) => …`.
- Neue UI-Texte immer in beiden Sprachen anlegen, keine Texte fest im Code.
- Neue Sprache: in `LOCALES` (und `LOCALE_NAMES`, `INTL_LOCALE`) in `src/lib/i18n/locales.ts` eintragen und in jedem Namensraum ein Wörterbuch ergänzen.
- Die Antwortsprache der KI steht in `src/server/prompt.ts` (`REPLY_LANGUAGE`).

## Pull Requests
- Kleine, fokussierte Änderungen; ein Thema je PR.
- Tests ergänzen oder anpassen; `npm run check` muss grün sein.
- Jeder PR erhöht die Version und bekommt einen eigenen Abschnitt in [`CHANGELOG.md`](CHANGELOG.md), siehe [Versionen & Changelog](#versionen--changelog). Die CI prüft das (`release-check`).
- Die Sicherheitsgrenzen bleiben bestehen: Die KI liest nur (`ReadOnly…`-Clients), geschrieben wird ausschließlich im Executor nach Freigabe. Änderungen, die das aufweichen, brauchen eine ausführliche Begründung.
- Mit deinem Beitrag stimmst du zu, dass er unter der [MIT-Lizenz](LICENSE) veröffentlicht wird.

## Versionen & Changelog
Jede Änderung (jeder PR) bekommt eine neue Version – so ist jederzeit klar, welcher Stand was enthält.
1. **Version erhöhen** nach [SemVer](https://semver.org/lang/de/): `npm version patch --no-git-tag-version` für Fehlerbehebungen, `minor` für neue Funktionen oder Verhaltensänderungen, `major` für Brüche (z. B. Konfiguration, die von Hand angepasst werden muss). Das aktualisiert `package.json` und `package-lock.json`.
2. **CHANGELOG schreiben**: oben in [`CHANGELOG.md`](CHANGELOG.md) einen Abschnitt `## [x.y.z] – JJJJ-MM-TT` anlegen, darunter die passenden Rubriken (`### Sicherheit`, `### Hinzugefügt`, `### Geändert`, `### Behoben`, `### Entfernt`) mit je einem Satz pro Änderung aus Sicht der Nutzer – was ist anders, was müssen sie ggf. tun (neue Umgebungsvariable, Migration, Verhaltensänderung). Unten den Vergleichslink `[x.y.z]: https://github.com/Coding9GmbH/coding9-lotse/compare/v<vorher>...v<x.y.z>` ergänzen.
3. Prüfen: `node .github/scripts/check-release.mjs origin/main`.

Hat sich `main` inzwischen weiterbewegt und dieselbe Version vergeben, nach dem Merge die nächste Nummer nehmen. Reine Abhängigkeits-Updates von Dependabot sind ausgenommen; sie landen mit der nächsten Version im Changelog.
