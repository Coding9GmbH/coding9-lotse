@AGENTS.md

## Versionen & Changelog (Pflicht bei jeder Änderung)
Bei jeder Änderung, die in einen PR geht: 1. einen sauberen Abschnitt `## [x.y.z] – JJJJ-MM-TT` oben in `CHANGELOG.md` schreiben (Rubriken `### Sicherheit/Hinzugefügt/Geändert/Behoben/Entfernt`, ein Satz je Änderung aus Nutzersicht, Vergleichslink unten), 2. die Version per `npm version patch|minor|major --no-git-tag-version` erhöhen. Prüfen mit `node .github/scripts/check-release.mjs origin/main`. Details: CONTRIBUTING.md → „Versionen & Changelog“.
