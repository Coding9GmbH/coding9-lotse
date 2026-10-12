# Review: Zuverlässigkeit
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung der Apply-, Retry- und Undo-Pfade im Quelltext, ohne Server, Testlauf oder Shop.

## Urteil
Ampel rot. Bei Magento 2 und OpenMage schreibt ein Produkt-Set Namen und Preis, bevor der Bestand gesetzt wird. Scheitert der Bestand, markiert die Karte alle Felder dieses Produkts als fehlgeschlagen, und für die schon geschriebenen Werte gibt es keinen Rückgängig-Schritt. Shopware und Shopify lassen die übrigen Produkte weiterlaufen, zeigen den Teilfehler und behalten für gelungene Schritte ein Rückgängig. Verlorene Antworten beim Anlegen und beim Bild-Upload können danach ein zweites Objekt erzeugen; Stopp, Doppelklick und ein Plattformwechsel lösen kein zweites Anwenden aus und brechen einen schon laufenden Schreiblauf nicht ab.

## Befunde
### B1 — Schwere: kritisch
- Ort: src/server/platform/openmage/catalog.ts:192 und src/server/platform/magento/catalog.ts:186
- Befund: Ablauf für ein Set vieler Produkte, bei dem Produkt 23 Name und Bestand enthält und der Bestandsaufruf scheitert. Die anderen Produkte sind davon nicht der kritische Teil.
  1. Nach der Freigabe läuft je Produkt ein eigener Schreibvorgang, parallel bis `LOTSE_WRITE_CONCURRENCY`. Ein Fehler bricht die Runde nicht ab.
  2. Bei Produkt 23 schreibt `writeScoped` Name und Preis zuerst und kehrt erst nach erfolgreichem HTTP zurück. Der Rückgängig-Schritt liegt nur in einer lokalen Variable.
  3. Danach setzt `writeStock` (OpenMage) bzw. `POST /V1/inventory/source-items` (Magento) den Bestand und wirft.
  4. OpenMage verwirft die Exception, ohne ein am Fehler hängendes `undo` zu lesen. Magento liest `e.undo`, aber `applyProduct` hängt die schon erzeugten Schritte nicht an den Fehler. Der Kommentar in der Magento-Zeile trifft auf diesen Pfad nicht zu.
  5. Alle Zeilen von Produkt 23, auch Name und Preis, werden `ok: false` mit der Bestandsfehlermeldung. Die Karte zeigt damit, der Name sei nicht geschrieben.
  6. Die übrigen Produkte behalten ihre Rückgängig-Schritte. Die Session setzt den Status auf `partial`, weil kein Gesamt-`error` gesetzt ist. Die Fußzeile zählt angewendet gegen fehlgeschlagen. Der Knopf Rückgängig enthält Produkt 23 nicht.
  7. Rückgängig setzt die gelungenen Produkte zurück. Der neue Name von Produkt 23 bleibt. Ein zweiter Klick kann ihn nicht zurücknehmen, weil kein Schritt gespeichert ist.
  Shopware ist hier anders: alle Felder eines Produkts gehen in einen PATCH. Ein sauberer Fehler an Nummer 23 lässt dieses Produkt unverändert, die vorherigen bleiben rückgängig machbar, die Karte zeigt den Teilstand. Shopify schreibt Feldgruppen einzeln, vermerkt den Rückgängig-Schritt auch bei unklarem Ausgang und markiert nur die gescheiterte Gruppe.
- Beleg: OpenMage `applyProduct` schreibt erst `writeScoped`, dann `writeStock`, und gibt die Schritte erst am Ende zurück (`src/server/platform/openmage/catalog.ts:178-181`). `applyGrouped` macht im `catch` nur `ok: false` (`src/server/platform/openmage/catalog.ts:190-192`). Magento ist gleich gebaut (`src/server/platform/magento/catalog.ts:179-188`) und übernimmt im `catch` nur `e.undo` (`src/server/platform/magento/catalog.ts:201`). `writeScoped` schiebt den Schritt erst nach erfolgreichem `patchAttrs` bzw. `putEnt` (`src/server/platform/openmage/write.ts:55`, `src/server/platform/magento/write.ts:46`). Die Karte zeigt Zähler nur ohne `result.error`, sonst je Zeile das Kreuz mit der Fehlermeldung (`src/components/chat/ChangeSetCard.tsx:74-79` und `src/components/chat/ChangeSetCard.tsx:135`). Der Status `partial` entsteht, wenn Ergebnisse ohne Gesamtfehler gemischt sind (`src/server/sessions.ts:221-223`). Shopware bündelt die Felder in einem `update` und legt den Patch-Schritt erst danach an (`src/server/changes.ts:332-333` und `src/server/changes.ts:422-427`).
- Auswirkung: Der Shop hat den neuen Namen oder Preis von Produkt 23, die Oberfläche sagt, diese Zeilen seien fehlgeschlagen, und Rückgängig stellt sie nicht her. Der Händler kann die ersten Produkte zurücknehmen und Produkt 23 für unangetastet halten. Es gibt keine automatische Rückrollung.
- Empfehlung: Nach einem Folgefehler die schon erfolgreichen Aufrufe desselben Produkts sofort zurückrollen oder ihre Schritte an den Fehler hängen und nur die wirklich gescheiterte Zeile als fehlgeschlagen markieren. OpenMage muss `e.undo` mindestens so lesen wie Magento.
- Vertrauen: sicher

### B2 — Schwere: hoch
- Ort: src/server/changes.ts:237
- Befund: Ablauf, Timeout mitten im Anlegen und erneutes Vorschlagen.
  1. Shopware, Magento und OpenMage legen das Produkt per POST an und bauen den Lösch-Schritt erst aus der zurückgekehrten Antwort.
  2. Läuft die Zeit ab, wirft der Client. Timeout wird nicht wiederholt. Es gibt keinen Schritt, der das Produkt löscht. Die Zeile ist fehlgeschlagen.
  3. Dieselbe Karte lässt sich nicht noch einmal anwenden. Ein neues Set ohne mitgegebene Nummer zieht eine neue Zufallsnummer oder SKU.
  4. Die Prüfung „schon vergeben“ sieht die neue Nummer nicht. Es entsteht ein zweites Produkt. Das erste hat keinen Rückgängig-Knopf.
  Shopify macht das für `productCreate` anders: bei einem Fehler, der kein `userErrors` ist, liest es die IDs vorher und nachher und merkt neue Produkte zum Löschen vor. Die Zeile bleibt fehlgeschlagen, der Lösch-Schritt liegt trotzdem in `undo`. Ein erneutes Anlegen ohne vorheriges Rückgängig erzeugt auch dort ein zweites Produkt, weil der Titel nicht eindeutig ist. Der erste ist dann aber löschbar.
- Beleg: Shopware gibt `{ op: 'delete' }` erst nach `create` zurück (`src/server/changes.ts:230-238`). Magento und OpenMage ebenso (`src/server/platform/magento/images.ts:297-298`, `src/server/platform/openmage/images.ts:298-299`). Die Zufallsnummer steht in `src/server/changes.ts:199`, `src/server/platform/magento/images.ts:237` und `src/server/platform/openmage/images.ts:235`. Timeout wirft ohne Wiederholung (`src/server/shopware.ts:24-27`, `src/server/platform/magento/client.ts:62-65`, `src/server/platform/openmage/client.ts:69-72`). Shopify `runCreating` merkt neue IDs auch im `catch` vor (`src/server/platform/shopify/ops.ts:69-74`), der Aufrufer schiebt die bekannte ID erst nach der Antwort (`src/server/platform/shopify/products.ts:289-296`).
- Auswirkung: Ein abgebrochener Schreibversuch kann das Produkt trotzdem angelegt haben. Rückgängig stellt den Ausgang nicht her. Der nächste Vorschlag legt ein weiteres an.
- Empfehlung: Den Lösch-Schritt vor dem POST an eine vorher vergebene ID binden oder, wie bei Shopify, nach einem unklaren Ausgang anhand einer eindeutigen Nummer nachlesen. Eine Wiederholung muss dieselbe Nummer verwenden und abbrechen, wenn sie schon existiert.
- Vertrauen: wahrscheinlich

### B3 — Schwere: hoch
- Ort: src/server/features/promotionen.ts:503
- Befund: Shopware-Promotionen sollen atomar sein. Im Fehlerfall wird zurückgerollt, das Ergebnis der Rückrollung aber nicht als Rückgängig behalten.
  1. Regeln werden angelegt, danach die Promotion. Jeder Schritt landet sofort in `undo`.
  2. Scheitert ein späterer Schritt, ruft `applyCreate` `undoOps` auf und gibt immer `undo: []` zurück. Ob die Rückrollung gelungen ist, wird nicht gelesen. Die Meldung ist nur der ursprüngliche Fehler.
  3. `applyUpdate` liest das Ergebnis, setzt `undo` aber ebenfalls auf leer. Nur der Text unterscheidet „nichts geändert“ und „Zurückrollen unvollständig, bitte prüfen“.
  4. Die Karte zeigt den Fehlertext. Der Knopf Rückgängig fehlt, weil `undo` leer ist. Was die Rückrollung nicht löschen konnte, bleibt ohne zweiten Versuch.
  Veröffentlichungen von Seiten machen das nicht so: Shopware, Shopify, Magento und OpenMage behalten bei unvollständiger Rücknahme die Restschritte (`src/server/changes.ts:365-368`, `src/server/platform/shopify/publish.ts:302-308`, `src/server/platform/magento/pages.ts:326-330`, `src/server/platform/openmage/pages.ts:243-245`).
- Beleg: `src/server/features/promotionen.ts:503` und `src/server/features/promotionen.ts:544-546`. Der Knopf hängt an `result.undo.length` (`src/components/chat/ChangeSetCard.tsx:186-191`).
- Auswirkung: Eine halb angelegte oder halb geänderte Promotion kann im Shop bleiben. Der Händler sieht einen Fehlschlag und kann den Rest nicht über Rückgängig zu Ende bringen. Bei `applyCreate` sagt der Text nicht einmal, dass die Rücknahme scheitern kann.
- Empfehlung: Die nicht gelungenen Rückroll-Schritte zurückgeben, analog zur Seiten-Veröffentlichung, und `applyCreate` das Ergebnis von `undoOps` auswerten.
- Vertrauen: sicher

### B4 — Schwere: hoch
- Ort: src/server/shopware.ts:140 und src/server/platform/shopify/publish.ts:127
- Befund: Die Wiederholung der Bild-KI legt nichts im Shop an. Doppelt wird es, wenn ein schon angelegtes Shop-Bild bei einem späteren Fehler neu hochgeladen wird.
  1. `generateRaster` wiederholt 429 und 5xx über `fetchWithRetry`. Eine nicht erfolgreiche Antwort wird nicht als Datei gespeichert. Staging bleibt lokal.
  2. Shopware legt zuerst einen Medien-Datensatz an und lädt dann die Datei hoch. Gelöscht wird nur, wenn die Antwort da ist und nicht `ok` ist. Ein Timeout wirft vorher. `staging_map` wird erst nach vollständigem Upload geschrieben. Ein zweiter Lauf derselben `staged`-ID findet keinen Eintrag und legt einen neuen Medien-Datensatz an.
  3. `importFromUrl` hat keine solche Merkliste. Jeder neue Versuch importiert eine weitere Datei.
  4. Shopify `fileCreate` in der Veröffentlichung läuft über `run`, nicht über `runCreating`. Die Datei-ID kommt erst nach der Antwort in `undo`. Geht die Antwort verloren, rollt der `catch` nur die schon vermerkten Schritte zurück. Ein erneutes Veröffentlichen legt die Datei noch einmal an.
  Produktbilder auf Shopify, die über `runRecording` laufen, sind davon ausgenommen: der Rückgängig-Schritt wird auch bei unklarem Ausgang vermerkt.
- Beleg: `src/server/media.ts:215-220`, `src/server/media.ts:143-148`, `src/server/media.ts:90-92`, `src/server/shopware.ts:135-141`, `src/server/platform/shopify/publish.ts:127-129`, `src/server/platform/shopify/ops.ts:60-63`. Der Hinweis, hochgeladene Bilder blieben nach Rückgängig in der Medienverwaltung, gilt nur für den Shopware-Bild-Executor (`src/server/features/bilder.ts:149` und `src/server/features/bilder.ts:189-190`).
- Auswirkung: Ein Retry nach verlorener Upload-Antwort legt eine zweite Datei an. Die erste hat keinen Lösch-Schritt. Beim Seiten-Veröffentlichen kann der übrige Stand zurückgerollt sein, die Datei aber bleiben.
- Empfehlung: Medien-ID vor dem Upload festlegen und im Fehler immer löschen, auch wenn der Upload wirft. `fileCreate` wie `productCreate` über `runCreating` führen oder die Datei-ID vor dem nächsten Schritt sichern. URL-Importe an eine stabile Quelle binden, damit ein zweiter Lauf dieselbe Datei wiederverwendet.
- Vertrauen: wahrscheinlich

### B5 — Schwere: mittel
- Ort: src/components/chat/Composer.tsx:63
- Befund: Ablauf Stopp während eines halben Entwurfs und während des Anwendens.
  1. `draft_partial` wird nicht in den Verlauf geschrieben. `session.draft` setzt erst das abgeschlossene Werkzeug `draft_page`. Ein Stopp in der Vorschau schreibt nichts in den Shop. Nach dem Neuladen ist der halbe Entwurf weg.
  2. Hat der Mensch schon freigegeben, ist die Freigabe aus `approvals` entfernt. `stopChat` lehnt nur noch offene Freigaben ab und bricht das AbortSignal der KI-Runde ab. `requestChange` und die Shop-Clients prüfen dieses Signal nicht.
  3. Der Stopp-Knopf sagt, es werde nichts geschrieben. Ein laufender Executor schreibt weiter und liefert danach `changeset_result`.
- Beleg: `src/server/agent.ts:22`, `src/server/tools.ts:121-124`, `src/server/sessions.ts:87-98`, `src/server/sessions.ts:209-219`, `src/components/chat/Composer.tsx:62-63`, `src/app/api/chat/stop/route.ts:6-11`.
- Auswirkung: Stopp vor der Freigabe ist folgenlos für den Shop. Stopp nach der Freigabe erweckt den Eindruck, der Schreiblauf sei abgebrochen, während Produkte weiter geändert werden.
- Empfehlung: Den Knopftext auf die KI-Runde begrenzen. Einen laufenden Executor entweder zu Ende führen und das in der Statuszeile sagen oder ihn an dasselbe AbortSignal hängen und den letzten gesicherten Zwischenstand wie beim Neustart abschließen.
- Vertrauen: sicher

### B6 — Schwere: mittel
- Ort: src/server/changes.ts:448
- Befund: Rückgängig nach Plattformwechsel schreibt nicht. Rückgängig, wenn der Shop danach anders ist, schreibt die gespeicherten Vorher-Werte ohne erneuten Vergleich.
  1. Liegt die Plattform der Schritte nicht auf dem verbundenen Shop, liefert `undoWithPlatform` für jeden Schritt einen Fehler und ruft den Adapter nicht auf. Ein zweiter Klick wiederholt dieselben offenen Schritte, sobald wieder der ursprüngliche Shop verbunden ist.
  2. Beim Ausführen patcht Shopware die gespeicherten Felder direkt. Magento und OpenMage senden den gespeicherten Request. Es gibt keine Prüfung, ob das Feld noch den von Lotse geschriebenen Wert hat.
  3. Die Nachfrage sagt nur, das Set werde auf die vorherigen Werte zurückgesetzt.
- Beleg: `src/server/platform/index.ts:33-38`, `src/server/sessions.ts:274-285`, `src/server/changes.ts:446-448`, `src/server/platform/magento/write.ts:96-100`, `src/server/platform/openmage/write.ts:81-85`, `src/components/workspace/Workspace.tsx:181`. Der Stale-Vergleich gilt nur beim Anwenden (`src/server/changes.ts:84-100`).
- Auswirkung: Ein später von Hand geänderter Preis oder Text wird durch Rückgängig auf den Stand von vor der Freigabe gesetzt. Der Ausgang zum Zeitpunkt des Klicks wird nicht gehalten. Ein Wechsel der Plattform verändert den anderen Shop nicht.
- Empfehlung: Vor dem Rückschreiben den aktuellen Wert lesen und abbrechen, wenn er weder der gespeicherte Nachher- noch der Vorher-Wert ist.
- Vertrauen: sicher

### B7 — Schwere: mittel
- Ort: src/server/platform/shopify/client.ts:126
- Befund: `LOTSE_SHOP_TIMEOUT_MS` und `LOTSE_WRITE_CONCURRENCY` stehen in `.env.example`. Die Schreib-Parallelität wird gelesen und auf 1 bis 8 begrenzt, Standard 2. Das Zeitlimit gilt für Shopware, Magento und OpenMage, Standard 60 Sekunden, mindestens 5. Shopify setzt es nicht: der Client wird ohne `timeoutMs` gebaut und begrenzt jede Admin-Anfrage auf 30 Sekunden. `src/server/http.ts` prüft nur JSON-Bodies. 429 und 503 liegen in den Shop-Clients, nicht dort. OpenMage serialisiert schreibende Aufrufe zusätzlich, die Umgebungsvariable erhöht dort die Schreibparallelität nicht.
- Beleg: `.env.example:69-75`, `src/server/changes.ts:17-18`, `src/server/shopware.ts:20`, `src/server/platform/magento/client.ts:11`, `src/server/platform/openmage/client.ts:19` und `src/server/platform/openmage/client.ts:59-65`, `src/server/platform/shopify/index.ts:26`, `src/server/platform/shopify/client.ts:126`, `src/server/http.ts:10-24`.
- Auswirkung: Eine höhere Shop-Timeout-Einstellung verlängert Shopify-Schreibaufrufe nicht. Ein langsameres Anlegen fällt dort eher in den Verlustfall aus B2 und B4. Wer das Zeitlimit in `http.ts` sucht, findet es nicht.
- Empfehlung: `LOTSE_SHOP_TIMEOUT_MS` an den Shopify-Client durchreichen oder in `.env.example` als Ausnahme nennen.
- Vertrauen: sicher

### B8 — Schwere: niedrig
- Ort: src/components/workspace/Workspace.tsx:177
- Befund: Doppelklick auf Anwenden schreibt nicht zweimal. Der erste Klick setzt die Karte lokal auf nicht bedienbar und löst die eine Freigabe auf. Ein zweites `decideChange`, bevor der Eintrag aus `approvals` entfernt ist, ruft denselben Promise ein zweites Mal auf. Wirken tut nur die erste Auflösung. Danach antwortet die Route 404, und die Oberfläche meldet, die Freigabe habe nicht gesendet werden können, während der erste Lauf anwendet.
- Beleg: `src/components/workspace/Workspace.tsx:174-177`, `src/lib/chat-state.ts:254-257`, `src/server/sessions.ts:262-268`, `src/app/api/approve/route.ts:13`.
- Auswirkung: Kein zweites Schreiben. Der Händler kann eine Fehlermeldung sehen, obwohl der Lauf läuft.
- Empfehlung: Den Knopf im Klick sofort sperren und eine 404 auf eine schon angenommene Freigabe nicht als Fehler zeigen.
- Vertrauen: sicher

## Was hält
- Shopware-Produktfelder eines Datensatzes sind ein PATCH. Ein sauberer Fehler an Nummer 23 lässt dieses Produkt aus, die gelungenen bleiben in `undo`, der Status ist `partial`, die Karte zählt beides. Stale Felder werden ausgelassen, die übrigen desselben Datensatzes geschrieben (`src/server/changes.ts:299-333`).
- Shopify vermerkt bei Mutationen den Rückgängig-Schritt auch bei Netzfehler, Zeitlimit und 5xx, außer bei `userErrors` (`src/server/platform/shopify/ops.ts:55-63`). Neue Produkte, Varianten, Kollektionen und Rabatte werden bei verlorener Antwort nachgelesen.
- Seiten-Veröffentlichung auf allen vier Plattformen rollt bei einem späteren Fehler zurück und behält Restschritte, wenn die Rücknahme nicht ganz gelingt. Shopware-Promotionen sind die Ausnahme in B3.
- Ein Plattformwechsel blockt Anwenden und Rückgängig, bevor etwas geschrieben wird (`src/server/sessions.ts:243-246`, `src/server/platform/index.ts:36-37`).
- 429 wird auf Shopware, Magento und OpenMage auch bei Schreibaufrufen wiederholt, 503 nur bei GET. Shopify wiederholt 5xx und Timeout nicht für Mutationen. Die Kommentare setzen voraus, dass 429 vor der Ausführung entsteht.
- `uploadStaged` lädt eine `staged`-ID kein zweites Mal hoch, wenn der erste Lauf den Medieneintrag eingetragen hat und er noch da ist (`src/server/media.ts:144`).
- Bricht der Prozess während des Anwendens ab, bleibt der Zwischenstand in `changeset_runs`. Der Neuaufbau setzt `partial` oder `failed`, sagt, wenn der Stand unvollständig ist, und hängt die gesicherten Schritte an Rückgängig (`src/server/sessions.ts:139-143`).
- Stopp, solange die Freigabe noch offen ist, lehnt sie ab. Es wird nichts geschrieben (`src/server/sessions.ts:91-95`).

## Nicht geprüft
- Kein Lauf gegen Shopware, Shopify, Magento oder OpenMage. Ob ein Timeout nach dem Commit der Gegenseite kommt, ist nur aus der Reihenfolge im Client geschlossen.
- Ob das Modell ohne diese Freigabe selbst schreiben kann, ist Dokument 02.
- `src/server/retry.ts` wird von der Bild-KI und der Search Console benutzt, nicht von den Shop-Schreibclients. Deren 429/503-Verhalten steht in den Clients.
- Keine Prüfung, ob der Shopify-Fake einen 429 nach ausgeführter Mutation erzeugen kann.

## Für den zweiten Durchgang
Soll ein Bestandsfehler nach bereits geschriebenem Namen bei Magento und OpenMage die Texte sofort zurückrollen, oder sollen die geschriebenen Felder als angewendet stehen bleiben und nur der Bestand als fehlgeschlagen gelten?
