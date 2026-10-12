# Lotse-Review, Zusammenfassung
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Zehn getrennte statische Reviews, danach ein zweiter Durchgang auf die zwei schärfsten Befunde. Kein laufender Shop, kein Browser, die Testsuite nicht ausgeführt.

## Urteil
Das Kernversprechen hält: die KI schreibt den Shop nicht selbst, Kunden- und Bestelldaten stehen auf keiner Freigabeliste, und Zugangsdaten gehen nicht an den Modellanbieter. Rot wird es an zwei Stellen, die der zweite Durchgang am Quelltext bestätigt hat. Auf Magento 2 und OpenMage kann ein Bestandsfehler einen schon geschriebenen Namen oder Preis zurücklassen, während die Karte alle Zeilen als fehlgeschlagen zeigt und Rückgängig diese Zeilen nicht enthält. `read_page` auf denselben beiden Plattformen kann die interne Shop-Basis mit einem Pfad aus der öffentlichen URL zu einem anderen Host zusammensetzen, sobald diese URL selbst einen Pfad trägt.

## Was zuerst
1. **Geschriebener Name ohne Rückgängig (Magento 2, OpenMage).** `applyProduct` schreibt Text und Preis, bevor der Bestand gesetzt wird. Scheitert der Bestand, markiert die Karte auch die schon geschriebenen Zeilen als fehlgeschlagen, und die Schritte liegen nicht in Rückgängig. Shopware bündelt die Felder in einem PATCH. Beleg: `src/server/platform/magento/catalog.ts:179-201`, `src/server/platform/openmage/catalog.ts:178-192`. Dokumente 03 und 08, nachgelesen in 11.
2. **`read_page` wechselt den Host (Magento 2, OpenMage).** Die Origin-Prüfung besteht, der zusammengesetzte Abruf nicht, wenn die öffentliche URL einen Pfad hat und von der internen Basis abweicht. Weiterleitungen werden gefolgt und nicht erneut geprüft. Die Shopware-Demo aus der README (öffentliche URL ohne Pfad) trifft das nicht. Beleg: `src/server/platform/openmage/tools.ts:133-134`, `src/server/platform/magento/tools.ts:145-146`. Dokument 01, nachgelesen in 11.
3. **Shopify-Rabatt ignoriert abgewählte Zeilen.** Die Freigabe schickt die angehakten Ids, der Adapter wirft sie weg und schreibt den vollen Input. Beleg: `src/server/platform/shopify/index.ts:56`. Dokument 03.
4. **„Stoppen“ während des Schreibens.** Der Knopf bleibt sichtbar und sagt, es werde nichts geschrieben. Der Executor hängt nicht am Abbruch. Beleg: `src/components/chat/Composer.tsx:63`. Dokumente 04 und 08.
5. **„Verbindung testen“ speichert.** Ungespeicherte Felder, einschließlich eines Plattformwechsels, werden vorher geschrieben. Beleg: `src/components/settings/SettingsView.tsx:61`. Dokument 04.
6. **Eine Freigabe kann tausende Zeilen schreiben.** SECURITY.md nennt 300 Einträge. Stapel gehen bis 10.000 (Shopware, Shopify) bzw. 5.000 (Magento, OpenMage), der Import bis 2.000. Die Karte zeigt Gruppen und eine Stichprobe. Beleg: `src/server/features/varianten-bulk.ts:9`, `SECURITY.md`. Dokument 02.
7. **„Alles bleibt lokal“ stimmt für die Wissensbasis nicht.** Regeln und Suchtreffer gehen an Anthropic oder OpenAI. Produkttexte und CMS-HTML ebenfalls, ohne Satz in den Einstellungen. Beleg: `src/components/knowledge/KnowledgeView.tsx:52`. Dokument 07.
8. **Stale-Write-Guard nur auf Shopware.** `docs/platform.md` beschreibt ihn als gleichwertig auf allen vier Plattformen. `assertFresh` läuft im Shopware-Pfad. Beleg: `docs/platform.md:219`, `src/server/changes.ts:100`. Dokument 10.
9. **Vorschau-Leiste wird abgeschnitten.** Das Segment ist 250px breit und bricht erst bei Viewport ≤640px um. Mit ausgeklappter Navigation ist die Spalte bei 1101px schmaler als die Leiste, `overflow: hidden` schneidet sie ab. Nicht im Browser geprüft. Dokument 05.
10. **Zwei Grenzen hat kein Test.** Die PHP-Unit-Tests des OpenMage-Moduls laufen nicht in CI. Die Codex-Sperre hat keinen Test. `allow_failure` kommt im Workflow nicht vor. Dokument 09.

## Was hält
- Schreiben läuft über `requestChange` und eine menschliche Entscheidung. Das Modell hat keine Shop-Schreibwerkzeuge. Ablehnen und Stopp vor der Freigabe schreiben nicht.
- Kunden, Bestellungen, Warenkörbe, Benutzer, Zahlung und Integrationen stehen auf keiner der vier Freigabelisten. Shopify ist der lockerste Leser, Shopware der engste.
- Geheimnisse liegen als AES-256-GCM im Datenverzeichnis und kommen in `publicSettings` nicht zurück. Compose bindet den Port an `127.0.0.1` und setzt die genannten Container-Limits. Das nackte Image setzt diese Limits nicht.
- Senden, Freigeben, Speichern und Dialog schließen sind mit der Tastatur erreichbar. Das Layout fällt bis 1100px auf zwei Flächen und bis 720px auf eine Spalte.
- Der Job `check` lässt keinen Schritt absichtlich durchfallen.

## Grenzen
Statische Prüfung am Commit c5f074c. Kein Shop, kein Browser, keine Suite. Viewport-Schnitte und Kontrast sind aus dem CSS gerechnet, nicht fotografiert. Ob `fetch` im Container die Metadaten-Adresse aus Befund 2 erreicht, ist nicht gelaufen.

## Dokumente
- [00-zusammenfassung.md](00-zusammenfassung.md)
- [01-sicherheit.md](01-sicherheit.md) — rot
- [02-freigabe-agent.md](02-freigabe-agent.md) — gelb
- [03-korrektheit.md](03-korrektheit.md) — rot
- [04-bedienbarkeit.md](04-bedienbarkeit.md) — gelb
- [05-responsiveness.md](05-responsiveness.md) — gelb
- [06-barrierefreiheit.md](06-barrierefreiheit.md) — gelb
- [07-datenschutz.md](07-datenschutz.md) — gelb
- [08-zuverlaessigkeit.md](08-zuverlaessigkeit.md) — rot
- [09-tests-ci.md](09-tests-ci.md) — gelb
- [10-architektur.md](10-architektur.md) — gelb
- [11-zweiter-durchgang.md](11-zweiter-durchgang.md)
