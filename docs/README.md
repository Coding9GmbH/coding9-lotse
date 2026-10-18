**Deutsch** · [English](en/README.md)

# Dokumentation

| Dokument | Für wen | Inhalt |
|---|---|---|
| [Benutzerhandbuch](benutzerhandbuch.md) | Alle, die mit Lotse arbeiten | Wie die Oberfläche funktioniert: Chat, Kontext, Vorschau, Freigabe und Rückgängig, Layouts, Styleguide, Regeln, Wissen, Shop-Check, Einstellungen, Sandbox Coding, Sprache |
| [Selbst hosten](self-hosting.md) | Wer Lotse auf einem Server betreibt | Login per Umgebungsvariable, Hostnamen, HTTPS und Reverse-Proxy, Sandbox Coding aktivieren (Docker), Sicherung, Fehlerbilder |
| [Architektur](architektur.md) | Entwicklung und Sicherheitsprüfung | Ablauf einer Runde, Schutzschichten, Datenhaltung, Vorschau, Layout-Veröffentlichung, Shop-Check, Chats mit Sandbox, Prompts, Mehrsprachigkeit, Tests |
| [Plattform-Schicht](platform.md) | Wer eine Plattform ergänzt oder anpasst | Adapter-Vertrag, Fähigkeitsmatrix Shopware/Shopify/Magento 2/OpenMage, Checkliste für neue Adapter |

## Sandbox Coding

Code-Aufgaben in einer Entwicklungsumgebung mit Git und eigenem Test-Shop (Docker), in der Claude Code oder Codex arbeiten. Wo was steht:

- **Bedienen:** [Sandbox im Chat](benutzerhandbuch.md#sandbox-coding-sandbox-im-chat) (Reiter, Daten, Konsole, mit der KI arbeiten, zur Prüfung freigeben), [Sandbox starten: jeder Fall](benutzerhandbuch.md#sandbox-starten-jeder-fall) (Plugin, neues Plugin, ganzes Projekt, eigenes Setup, ohne Projekt, `.lotse/sandbox.json`, Hinweise für die KI), [Gespeicherte Umgebungen: einmal einrichten, für jeden Auftrag eine frische Sandbox](benutzerhandbuch.md#gespeicherte-umgebungen-einmal-einrichten-für-jeden-auftrag-eine-frische-sandbox), [Ganzes Shopware-Projekt](benutzerhandbuch.md#ganzes-shopware-projekt), [Ohne Entwickler: so baust du ein eigenes Plugin](benutzerhandbuch.md#ohne-entwickler-so-baust-du-ein-eigenes-plugin)
- **Betreiben:** [Sandbox Coding aktivieren](self-hosting.md#sandbox-coding-aktivieren) (Docker, Netze, Variablen, Einrichtungsschritte, Dumps)
- **Verstehen und prüfen:** [Chats mit Sandbox](architektur.md#chats-mit-sandbox-sandbox-coding) (Werkzeuge, Konsole, Veröffentlichen, alle Fälle), [`SECURITY.md`](../SECURITY.md) (Sicherheitsmodell)

Weitere Dateien im Repository:

- [`README.md`](../README.md) ([English](../README.en.md)): Schnellstart (Docker), Sicherheit, Konfiguration, Releases
- [`SECURITY.md`](../SECURITY.md) ([English](../SECURITY.en.md)): Sicherheitsmodell und Meldeweg
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) ([English](../CONTRIBUTING.en.md)): Beitragen, Tests, Konventionen
- [`.env.example`](../.env.example): alle Umgebungsvariablen mit Erklärung
- [`integrations/openmage/README.md`](../integrations/openmage/README.md) ([English](../integrations/openmage/README.en.md)): OpenMage-Modul `Lotse_Connector`
