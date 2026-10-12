# Review: Korrektheit
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung der Apply-, Auswahl- und Rückgängig-Pfade im Quelltext, ohne Server, Testlauf oder Shop.

## Urteil
Ampel rot. Ein freigegebenes Produkt-Set auf Magento 2 und OpenMage, das neben Text oder Preis den Bestand ändert, schreibt die Felder zuerst. Scheitert der Bestandsaufruf, gelten alle Zeilen dieses Produkts als fehlgeschlagen, und für die schon geschriebenen Werte gibt es keinen Rückgängig-Schritt. Auf Shopify schreibt die Freigabe eines Rabatt-Änderungssets auch die abgewählten Feldzeilen; der gespeicherte Rückgängig-Schritt nimmt danach das ganze Update zurück. Die übrigen geprüften Executor filtern die Zeilenauswahl, und ein Stopp vor der Freigabe schreibt nichts.

## Befunde
### B1 — Schwere: hoch
- Ort: src/server/platform/magento/catalog.ts:186 und src/server/platform/openmage/catalog.ts:180
- Befund: Eingabe ist ein freigegebenes Produkt-Set mit Name oder Preis und Bestand. Der Bestandsaufruf scheitert, nachdem Name und Preis schon geschrieben sind.
  1. `applyProduct` schreibt Name und Preis über `writeScoped` und legt die Rückgängig-Schritte nur in einer lokalen Variable ab.
  2. Danach setzt Magento `POST /V1/inventory/source-items` bzw. OpenMage `writeStock`. Wirft dieser Aufruf, endet die Funktion, bevor sie `return undo` erreicht. Die Exception trägt kein `undo`.
  3. Magento liest im `catch` nur `e.undo`. Der Kommentar dort, teilweise Geschriebenes bleibe rückgängig, trifft auf den Preis-Prüfpfad zu (`assertPriceInView` hängt `undo` an den Fehler) und nicht auf den Bestand. OpenMage liest `e.undo` nicht.
  4. Alle Zeilen des Produkts, auch Name und Preis, werden `ok: false`. Die Karte zeigt sie als nicht geschrieben.
  5. Rückgängig enthält diese Schritte nicht. Ein zweiter Klick kann den neuen Namen oder Preis nicht zurücknehmen.
  Dieselbe Lücke hat Magento innerhalb von `writeScoped`: der globale PUT hängt seinen Schritt erst nach Erfolg an die lokale Liste. Wirft der folgende Store-View-PUT, geht der globale Schritt mit der Exception verloren.
- Beleg: Magento schiebt `writeScoped` vor dem Bestand (`src/server/platform/magento/catalog.ts:179-188`). Der `catch` übernimmt nur `e.undo` (`src/server/platform/magento/catalog.ts:201`). `assertPriceInView` setzt `{ undo }` (`src/server/platform/magento/catalog.ts:167`). OpenMage ist dieselbe Reihenfolge (`src/server/platform/openmage/catalog.ts:178-181`) und verwirft die Exception ohne Schritte (`src/server/platform/openmage/catalog.ts:192`). `writeScoped` hat keinen `catch` um den zweiten `putEnt` (`src/server/platform/magento/write.ts:46-47`). Die Karte zeigt bei einem Ergebnis ohne Gesamtfehler die Zeilenkreuze (`src/components/chat/ChangeSetCard.tsx:135`).
- Auswirkung: Der Shop hat den neuen Namen oder Preis. Die Oberfläche sagt, diese Zeilen seien fehlgeschlagen. Rückgängig führt nicht zum Ausgang. Die übrigen Produkte des Sets behalten ihre eigenen Schritte.
- Empfehlung: Nach einem Folgefehler die schon erfolgreichen Aufrufe desselben Produkts sofort zurückrollen oder ihre Schritte an die Exception hängen und nur die gescheiterte Zeile als fehlgeschlagen markieren. OpenMage muss `e.undo` mindestens so lesen wie Magento.
- Vertrauen: sicher

### B2 — Schwere: hoch
- Ort: src/server/platform/shopify/index.ts:56
- Befund: Eingabe ist ein Shopify-Rabatt, an dem mindestens zwei Felder geändert werden, zum Beispiel Name und Rabattwert. Die Karte zeigt je Feld eine eigene Zeile `f:title`, `f:value` mit `entity: 'promotion'`. Der Nutzer nimmt den Haken beim Wert weg und gibt den Rest frei.
  1. `atomic: true` sperrt die Haken nicht. `ChangeSetCard` liest `atomic` nicht. Der Button zählt nur die angehakten Zeilen und sendet deren Ids.
  2. Die Session bildet daraus `selected` und übergibt das Set an den Adapter.
  3. Die Registrierung wirft `_sel` weg. `applyPromotion` schreibt `payload.input` vollständig, also auch den abgewählten Wert, und markiert jede Zeile `ok: true`.
  4. Weil jede Zeile ein Ergebnis hat, zählt die Karte keine Zeile als „nicht ausgewählt“. Der abgewählte Wert steht als angewendet.
  Erwartet ist, dass nur angehakte Felder in den GraphQL-Input kommen und abgewählte Zeilen kein `ok: true` bekommen. Anlegen hat nur die eine Zeile `neu`; ohne Haken bleibt der Button aus. Magento und OpenMage haben eine Zeile `promo` und schreiben nicht, wenn sie fehlt. Shopware-Updates filtern `selected` und patchen nur die gewählten Teile.
- Beleg: Zeilen entstehen in `src/server/platform/shopify/content.ts:188-200`, der volle `input` wird in `src/server/platform/shopify/content.ts:245-247` geschrieben. Die Registrierung ist `src/server/platform/shopify/index.ts:56`. Die Karte sendet die angehakten Ids (`src/components/chat/ChangeSetCard.tsx:119` und `src/components/chat/ChangeSetCard.tsx:182`), die Session filtert damit (`src/server/sessions.ts:211-212`). Der Vertrag nennt die Zeilenauswahl in `docs/platform.md:211-212`. Gegenprobe: `src/server/platform/magento/promo.ts:209`, `src/server/platform/openmage/promo.ts:181`, `src/server/features/promotionen.ts:519`.
- Auswirkung: Ein freigegebenes Teilset ändert den Rabatt an Stellen, die der Nutzer abgewählt hat, darunter Wert, Zeitraum, Name oder Kombinierbarkeit. Rückgängig setzt das gesamte Update auf den Stand vor dem Schreiben, nicht nur die angehakten Felder.
- Empfehlung: `selected` in `applyPromotion` auswerten und `input` auf die angehakten Schlüssel kürzen. Ergebnisse nur für diese Zeilen als angewendet melden. Solange der Input unteilbar ist, die Haken bei diesem Set sperren und den Button nicht als Teilmenge beschriften.
- Vertrauen: sicher

### B3 — Schwere: mittel
- Ort: src/server/changes.ts:325
- Befund: Eingabe ist eine freigegebene Preis- oder Streichpreisänderung an einem Shopware-Produkt, dessen erster Preiseintrag ein `regulationPrice` hat.
  1. `applyEntity` baut den ersten Preiseintrag neu aus Währung, Brutto, Netto, `linked` und optional `listPrice`.
  2. `regulationPrice` wird nicht übernommen. Der PATCH ersetzt das Preis-Array. Der regulierte Preis dieses Eintrags fehlt danach.
  3. Die Karte zeigt nur „Preis (brutto)“ bzw. „Streichpreis (brutto)“. Der weggefallene Wert steht nicht im Diff.
  4. Rückgängig speichert `cur.price` vollständig und kann den regulierten Preis wiederherstellen, wenn der Nutzer ihn auslöst.
  Der Stapel-Executor macht das nicht so: `planWrite` kopiert `regulationPrice`. Varianten schreiben über `priceArr` ebenfalls ohne dieses Feld (`src/server/features/varianten-variants.ts:287`).
- Beleg: Neubau in `src/server/changes.ts:325-330`. Der Stapel behält das Feld in `src/server/features/varianten-bulk.ts:261-272`. `priceArr` setzt es nicht (`src/server/features/varianten-variants.ts:215`).
- Auswirkung: Eine freigegebene Preisänderung löscht auf dem ersten Preiseintrag den regulierten Preis, bis jemand Rückgängig nutzt. Brutto und Netto des freigegebenen Preises stimmen mit der Karte überein.
- Empfehlung: `regulationPrice` wie in `planWrite` an den neuen Eintrag hängen.
- Vertrauen: sicher

### B4 — Schwere: mittel
- Ort: src/server/features/promotionen.ts:503
- Befund: Eingabe ist eine freigegebene neue Shopware-Promotion. Regeln und Promotion sind angelegt, ein späterer Schritt wirft, und die Rückrollung löscht nicht alles.
  1. Jeder gelungene Schritt liegt in `undo`.
  2. Im `catch` ruft `applyCreate` `undoOps` auf und gibt danach immer `undo: []` zurück. Das Ergebnis der Rückrollung wird nicht gelesen. Die Meldung ist nur der ursprüngliche Fehler.
  3. `applyUpdate` unterscheidet im Text „nichts geändert“ und „Zurückrollen unvollständig“, setzt `undo` aber ebenfalls leer.
  4. Der Knopf Rückgängig hängt an `result.undo.length`. Was die Rückrollung nicht entfernt hat, hat keinen zweiten Versuch.
  Erwartet ist das Verhalten der Seiten-Veröffentlichung: nicht gelungene Rückroll-Schritte bleiben im Ergebnis.
- Beleg: `src/server/features/promotionen.ts:503` und `src/server/features/promotionen.ts:544-546`. Der Knopf steht in `src/components/chat/ChangeSetCard.tsx:186-191`. Die Veröffentlichung behält die Restschritte (`src/server/changes.ts:367-368`).
- Auswirkung: Eine halb angelegte oder halb geänderte Promotion kann im Shop bleiben. Die Karte zeigt einen Fehlschlag ohne Rückgängig. Bei `applyCreate` sagt der Text nicht, dass die Rücknahme scheitern kann.
- Empfehlung: Nicht gelungene Rückroll-Schritte zurückgeben, analog zur Seiten-Veröffentlichung.
- Vertrauen: sicher

## Was hält
- Shopware-Produkt- und Kategorie-Sets filtern die Auswahl und schreiben je Datensatz einen PATCH. Rückgängig der Textfelder nimmt `cur[field]`, bei Varianten mit leerem Eigenwert also wieder die Vererbung. Der Preis-Undo speichert das gelesene `price`-Array (`src/server/changes.ts:311` und `src/server/changes.ts:330`).
- Shopware-Promotions zum Ändern patchen nur gewählte Teile (`src/server/features/promotionen.ts:519`). Anlegen besteht aus Hinweiszeilen; die Karte bietet dafür keine Teilauswahl.
- Magento- und OpenMage-Promotionen sind eine Zeile `promo`. Ohne diese Id schreiben sie nicht (`src/server/platform/magento/promo.ts:209`, `src/server/platform/openmage/promo.ts:181`).
- Shopify filtert die Auswahl bei Produkten, Stapel (`grp:`), Übersetzungen und Rabatt-Status. Seiten-Veröffentlichungen ignorieren `_sel`, ihre Zeilen sind `entity: 'info'` und damit nicht anhakbar (`src/server/platform/shopify/publish.ts:53`, `src/server/platform/magento/pages.ts:192`).
- Magento schreibt Preise nur mit gesetzter Preisbasis und rechnet `price`/`special_price` aus Verkaufs- und Streichpreis (`src/server/platform/magento/map.ts:64-88`, `src/server/platform/magento/catalog.ts:80-87`). Eine Store-View, die nicht die Haupt-View der Website ist, bekommt Texte nur in dieser View (`src/server/platform/magento/write.ts:33-35`).
- Shopware-Import nimmt Brutto, sonst Netto mal Steuersatz, und schreibt den Einkaufspreis als Netto (`src/server/features/import-plan.ts:183-184` und `src/server/features/import-plan.ts:231-232`). Die Karte zeigt den gerechneten Bruttopreis.
- Stapel auf Shopware und Shopify filtern `grp:` (`src/server/features/varianten-bulk.ts:290`, `src/server/platform/shopify/products.ts:521`).
- Ein Stopp, solange die Freigabe noch wartet, löst sie mit `allow: false` auf. `requestChange` emittiert dann `rejected` und ruft den Executor nicht (`src/server/sessions.ts:91-95` und `src/server/sessions.ts:210`).
- Der Reducer legt `changeset_result` auf das Set mit derselben Id und ignoriert ein Ergebnis ohne Set (`src/lib/chat-state.ts:199-201`). Der NDJSON-Splitter puffert Restzeilen und schließt sie in `end()` (`src/lib/ndjson.ts:14-16`).
- Plattformwechsel sendet die Klartextfelder aller Plattformen aus dem Formular. Leere Geheimnisse bleiben unverändert, `null` löscht (`src/lib/settings-form.ts:50-65`, `src/server/settings.ts:93-94`). Shopware bevorzugt Integration vor Admin-Benutzer, wenn Zugangs-ID und Schlüssel gesetzt sind; der Hinweis am Feld sagt das (`src/lib/platforms.ts:72`, `src/server/shopware.ts:92-94`).

## Nicht geprüft
- Ob Shopify `discountCodeBasicUpdate` ein `customerGets` ohne `items` den Geltungsbereich des Rabatts löscht. Der Code sendet beim reinen Wertwechsel nur `{ value }` (`src/server/platform/shopify/content.ts:194` und `src/server/platform/shopify/content.ts:241`). Das API-Verhalten steht nicht im Repo.
- Ob ein Stopp nach begonnenem Apply den Shop-Schreibaufruf abbricht. `AbortController` geht an Claude oder Codex (`src/server/agent.ts:92`, `src/server/agent-codex.ts:45`), nicht an `requestChange`.
- OpenMage-Katalog und -Preise nur an der Auswahl und am Bestandsfehler, nicht Feld für Feld gegen Magento.
- Shopware-CMS außer dem Rollback in `applyPublish`. Ob die KI schreiben darf, bleibt bei Dokument 02. Darstellung und Auth sind nicht Gegenstand.

## Für den zweiten Durchgang
Soll ein Bestandsfehler nach bereits geschriebenem Namen oder Preis bei Magento und OpenMage diese Felder sofort zurückrollen, oder sollen sie als angewendet stehen bleiben und nur der Bestand als fehlgeschlagen gelten?
