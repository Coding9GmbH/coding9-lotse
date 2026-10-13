# Sicherheit

## Lücke melden
Bitte **keine öffentlichen Issues** für Sicherheitslücken. Melde sie vertraulich über
[GitHub Security Advisories](https://github.com/Coding9GmbH/coding9-lotse/security/advisories/new).
Wir bestätigen den Eingang innerhalb von 3 Werktagen.

## Sicherheitsmodell (Kurzfassung)
- **KI nur lesend**: Das Sprachmodell erhält ausschließlich geschützte Lese-Clients mit Freigabeliste (`ReadOnlyShopware` in `src/server/shopware.ts`, Regeln in `src/server/policy.ts`; je Plattform `reader.ts` unter `src/server/platform/<plattform>/`). Kunden-, Bestell-, Rechnungs-, Zahlungs-, Benutzer- und Integrationsdaten sind fest gesperrt; sensible Felder werden vor der Übergabe entfernt; jeder Zugriff landet im Zugriffsprotokoll. Ungenutzte Beispielcodes ohne Einlöser gehen mit; Kundendaten und wer einen Code eingelöst hat nicht.
- **Schreiben nur nach Freigabe**: Ausschließlich der Executor (`src/server/changes.ts`, plattformspezifische Schreiber unter `src/server/platform/`) schreibt. Die Freigabe ist die Kennung `x-lotse: 1` plus, falls gesetzt, `LOTSE_PASSWORD` – kein an den Klick gebundenes Geheimnis. Gedrosselt (`LOTSE_WRITE_CONCURRENCY`, Standard 2), mit Audit-Log und Rückgängig. Einzelvorschläge fassen höchstens 300 Zeilen. Stapel (eine Regel für viele Produkte) gehen bis 10.000 (Shopware, Shopify) bzw. 5.000 (Magento, OpenMage), der Import bis 2.000 Zeilen. Die Freigabe-Karte zeigt dabei die Gruppen und eine Stichprobe, nicht jede Zeile.
- **Shop-Schutz**: Timeouts für jede Shop-Anfrage (`LOTSE_SHOP_TIMEOUT_MS`), Backoff bei 429/503.
- **Zugangsdaten**: AES-256-GCM-verschlüsselt im Datenvolume; werden der KI nie übergeben und aus Fehlermeldungen entfernt.
- **Netzwerk**: Lotse ist für den lokalen Betrieb gebaut (Port nur auf `127.0.0.1`, Host-/Origin-Prüfung gegen DNS-Rebinding/CSRF; schreibende Aufrufe brauchen zusätzlich die Kennung `x-lotse: 1` der Oberfläche). Für Serverbetrieb `LOTSE_PASSWORD` und `ALLOWED_HOSTS` setzen und HTTPS per Reverse-Proxy vorschalten (Anleitung: [`docs/self-hosting.md`](docs/self-hosting.md)). Es gibt ein gemeinsames Passwort, keine Benutzerkonten und keine Sperre nach Fehlversuchen: Begrenzung und Zugriffskreis gehören an den Proxy.
- **Entwurfs-Vorschau**: läuft in einem sandboxed iframe (`sandbox="allow-scripts"`, eigener opaker Origin). Skripte aus KI-Blöcken oder Shop-HTML erreichen weder die Oberfläche noch die API; Teil-Updates und Markier-Modus laufen über `postMessage` (`src/lib/preview-frame.ts`). Die Vorschau sendet die Kennung nicht. Eine Freigabe ist `x-lotse: 1` plus optionales `LOTSE_PASSWORD`, kein Klick-Geheimnis.
- **Codex (ChatGPT-Abo)**: eigene Codex-Werkzeuge (Shell, Dateien, Web, Bilder, Plugins) abgeschaltet, Dateizugriff per Berechtigungsprofil gesperrt (nicht eskalierbar), `approval_policy=never`; Shop-Tools nur über `/api/mcp/<chat>` mit Zufalls-Token je Chat. Gesperrte Werkzeuge im Ereignisstrom führen zum sofortigen Abbruch der Runde.
- **Container**: läuft als Nicht-Root, schreibgeschütztes Dateisystem, keine Linux-Capabilities, `no-new-privileges`, Ressourcen-Limits.

## Empfehlungen für Live-Shops
1. Eigene Shopware-**Integration** mit einer Rolle anlegen, die nur die benötigten Bereiche (Produkte, Kategorien, Einkaufswelten, Medien) schreiben darf – keinen Admin-Benutzer verwenden.
2. Neue Abläufe zuerst in einem **Staging-Shop** testen.
3. Regelmäßig `make backup` (Lotse-Daten) und Shop-Backups.
