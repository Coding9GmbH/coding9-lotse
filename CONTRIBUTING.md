# Mitwirken

Danke für dein Interesse an Lotse! Fehler, Ideen und Pull Requests sind willkommen.

## Fehler und Ideen
- Fehler und Wünsche als [Issue](../../issues) melden – mit Plattform (Shopware, Shopify, Magento, OpenMage), Lotse-Version und, falls möglich, Schritten zum Nachstellen.
- **Sicherheitslücken nicht öffentlich melden**, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.
- Bitte keine Zugangsdaten, Kundendaten oder Shop-URLs mit sensiblem Inhalt in Issues oder Screenshots posten.

## Entwicklung
```bash
npm install          # Node ≥ 22.13
make dev             # http://localhost:3333
make demo            # optional: Demo-Shop (dockware) dazu
npm run check        # Typecheck, ESLint, Tests – vor jedem Pull Request
```

## Pull Requests
- Kleine, fokussierte Änderungen; ein Thema je PR.
- Tests ergänzen oder anpassen; `npm run check` muss grün sein.
- Die Sicherheitsgrenzen bleiben bestehen: Die KI liest nur (`ReadOnly…`-Clients), geschrieben wird ausschließlich im Executor nach Freigabe. Änderungen, die das aufweichen, brauchen eine ausführliche Begründung.
- Mit deinem Beitrag stimmst du zu, dass er unter der [MIT-Lizenz](LICENSE) veröffentlicht wird.
