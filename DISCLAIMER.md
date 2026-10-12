# Haftungsausschluss

Lotse ist ein Open-Source-Werkzeug (MIT-Lizenz) der CODING 9 GmbH. Bitte lies diese Hinweise, bevor du Lotse mit einem Live-Shop verbindest.

## Keine Gewährleistung, Nutzung auf eigene Verantwortung
- Lotse wird **„wie besehen“** bereitgestellt, ohne Zusicherung von Eignung, Fehlerfreiheit oder Verfügbarkeit. Es gilt der Haftungsausschluss der [MIT-Lizenz](LICENSE).
- Du nutzt Lotse auf eigene Verantwortung. Das gilt besonders für Änderungen an einem Shop, der Umsatz macht.
- Die Software ist eine frühe Version (0.x). Funktionen, Einstellungen und Datenformate können sich ohne Ankündigung ändern.

## KI-Ergebnisse müssen geprüft werden
- Sprachmodelle machen Fehler: falsche Preise, erfundene Produkteigenschaften, ungeeignete Texte oder fehlerhafte Seitenstrukturen sind möglich.
- Lotse zeigt Änderungen vor dem Schreiben als Vergleich oder Vorschau. **Die Freigabe und damit die inhaltliche Prüfung liegt bei dir.**
- Rechtlich relevante Inhalte (Impressum, Datenschutz, Widerruf, Garantien, Lieferzeiten, Pflichtangaben, Preisangaben) prüfst du selbst oder lässt sie juristisch prüfen. Der „Shop-Check“ ist eine technische Prüfung und **keine Rechtsberatung**.

## Schutz deines Shops
- Teste neue Abläufe zuerst in einem **Staging-Shop**.
- Lege vor größeren Änderungen ein Backup des Shops an. „Rückgängig“ in Lotse stellt die von Lotse geschriebenen Werte wieder her, ersetzt aber kein Backup (z. B. nicht bei Änderungen, die du außerhalb von Lotse am selben Datensatz vorgenommen hast).
- Verwende eine eigene Integration mit eingeschränkter Rolle statt eines Admin-Benutzers.
- Die Sicherheitsmechanismen sind in [SECURITY.md](SECURITY.md) beschrieben. Sie verringern Risiken, können aber Fehlkonfiguration oder Fehlbedienung nicht ausschließen.

## Datenschutz und Datenübermittlung
- Damit die KI arbeiten kann, werden Shop-Inhalte (z. B. Produkt- und Seitentexte, Kategorien, Layouts, Bilder, die du anhängst) an den von dir gewählten KI-Anbieter übermittelt (Anthropic bzw. OpenAI). Für diese Verarbeitung bist du als Betreiber verantwortlich: Auftragsverarbeitungsvertrag, Rechtsgrundlage, Informationspflichten und Drittlandübermittlung musst du selbst regeln.
- Kunden-, Bestell-, Zahlungs- und Zugangsdaten sind in Lotse für die KI gesperrt. Gib sie trotzdem nicht in den Chat ein und hänge keine Dokumente mit personenbezogenen Daten an.
- Zugangsdaten werden verschlüsselt im Datenvolume gespeichert. Der Schutz dieses Volumes, des Servers und eines optionalen Passworts liegt bei dir.

## Kosten
- Die Nutzung der KI kostet Geld beim jeweiligen Anbieter (API-Verbrauch bzw. Limits deines Abos). Große Aufträge können hohe Kosten verursachen. Setze Limits in deinem Anbieter-Konto.

## Marken, keine Verbindung zu Dritten
Shopware®, Shopify®, Magento®, Adobe Commerce®, OpenMage, Mage-OS, Claude®, Anthropic®, OpenAI®, ChatGPT® und Codex sind Marken oder Produktnamen ihrer jeweiligen Inhaber. Lotse ist ein unabhängiges Projekt der CODING 9 GmbH und steht in keiner Verbindung zu diesen Unternehmen. Es wird weder von ihnen unterstützt noch empfohlen.

## Beiträge Dritter und Abhängigkeiten
Lotse nutzt Open-Source-Bibliotheken und Dienste Dritter (u. a. das Claude Agent SDK und den OpenAI Codex SDK) unter deren eigenen Lizenzen und Nutzungsbedingungen. Du bist selbst dafür verantwortlich, dass deine Nutzung dieser Dienste (z. B. mit einem Abo oder API-Schlüssel) deren Bedingungen entspricht.

---
Diese Hinweise sind keine Rechtsberatung. Bei Fragen zur rechtskonformen Nutzung wende dich an eine Rechtsberatung.
