@AGENTS.md

## Sprache im Code
Code-Kommentare, Funktions-, Variablen-, Typ- und Dateinamen sowie alle anderen Bezeichner immer auf Englisch, auch wenn die Unterhaltung auf Deutsch läuft. Ausnahmen: UI-Texte (siehe CONTRIBUTING.md → „Sprachen“) und die Dokumentation in `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, die auf Deutsch bleiben.

## Versionen & Changelog (nur beim Release)
Gewöhnliche PRs ändern weder `CHANGELOG.md` noch die Version in `package.json`. Beides passiert erst, wenn eine neue getaggte Version veröffentlicht wird: Version per `npm version patch|minor|major --no-git-tag-version` erhöhen, in `CHANGELOG.md` oben einen Abschnitt `## [x.y.z] – JJJJ-MM-TT` anlegen (Rubriken `### Sicherheit/Hinzugefügt/Geändert/Behoben/Entfernt`, ein Satz je Änderung aus Nutzersicht, aus dem Git-Verlauf seit dem letzten Tag), unten den Vergleichslink `[x.y.z]: …/compare/v<vorher>...v<x.y.z>` ergänzen. Prüfen mit `node .github/scripts/check-release.mjs origin/main`. Details: CONTRIBUTING.md → „Versionen & Changelog“.
