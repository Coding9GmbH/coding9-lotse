# Dokumentation

| Dokument | Für wen | Inhalt |
|---|---|---|
| [Benutzerhandbuch](benutzerhandbuch.md) | Alle, die mit Lotse arbeiten | Wie die Oberfläche funktioniert: Chat, Kontext, Vorschau, Freigabe und Rückgängig, Layouts, Styleguide, Regeln, Wissen, Shop-Check, Einstellungen |
| [Selbst hosten](self-hosting.md) | Wer Lotse auf einem Server betreibt | Login per Umgebungsvariable, Hostnamen, HTTPS und Reverse-Proxy, Sicherung, Fehlerbilder |
| [Architektur](architektur.md) | Entwicklung und Sicherheitsprüfung | Ablauf einer Runde, Schutzschichten, Datenhaltung, Vorschau, Layout-Veröffentlichung, Shop-Check, Prompts, Tests |
| [Plattform-Schicht](platform.md) | Wer eine Plattform ergänzt oder anpasst | Adapter-Vertrag, Fähigkeitsmatrix Shopware/Shopify/Magento 2/OpenMage, Checkliste für neue Adapter |

Weitere Dateien im Repository:

- [`README.md`](../README.md): Schnellstart (Docker), Sicherheit, Konfiguration, Releases
- [`SECURITY.md`](../SECURITY.md): Sicherheitsmodell und Meldeweg
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): Beitragen, Tests, Konventionen
- [`.env.example`](../.env.example): alle Umgebungsvariablen mit Erklärung
- [`integrations/openmage/README.md`](../integrations/openmage/README.md): OpenMage-Modul `Lotse_Connector`
