@AGENTS.md

## Versionen & Changelog (Pflicht bei jeder Änderung)
Bei jeder Änderung, die in einen PR geht: Eintrag oben in `CHANGELOG.md` unter `## [Unreleased]` (Rubriken `### Sicherheit/Hinzugefügt/Geändert/Behoben/Entfernt`, ein Satz je Änderung aus Nutzersicht, Vergleichslink `[Unreleased]: …/compare/v<aktuell>...HEAD` unten). Die Version bleibt dabei unverändert. Erst beim echten Release `[Unreleased]` in `## [x.y.z] – JJJJ-MM-TT` umbenennen, Vergleichslink anpassen und die Version per `npm version patch|minor|major --no-git-tag-version` erhöhen. Prüfen mit `node .github/scripts/check-release.mjs origin/main`. Details: CONTRIBUTING.md → „Versionen & Changelog“.
