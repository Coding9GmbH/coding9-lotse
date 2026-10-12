# Review: Bedienbarkeit
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung der deutschen Oberfläche im Code, ohne Browser.

## Urteil
Gelb. Freigabe, Ablehnen und Rückgängig sind als eigene Karte gebaut, Löschen von Chat und Dokument fragt nach, und eine Rückfrage lässt sich anklicken. Zwei normale Knöpfe tun aber etwas anderes, als ihre Beschriftung sagt: „Stoppen“ bleibt während des Schreibens in den Shop sichtbar und behauptet, es werde nichts geschrieben; „Verbindung testen“ speichert vorher das ganze Formular und kann damit den verbundenen Shop wechseln. Dazu kommen Fehler, die wie ein leerer Katalog oder eine fertige Einrichtung aussehen, und Entwicklerbegriffe an Stellen, an denen ein Betreiber Schlüssel einträgt oder den Shop ansieht.

## Befunde
### B1 — Schwere: hoch
- Ort: src/components/chat/Composer.tsx:63
- Befund: Solange eine Runde läuft, steht statt „Senden“ der Knopf „Stoppen“. Sein Titel lautet immer „Laufende Anfrage abbrechen. Es wird nichts geschrieben.“ Der Knopf bleibt auch, nachdem „Anwenden“ geklickt wurde, denn `busy` gilt von Rundenbeginn bis zum Ende des Stroms. Der Klick setzt die Statuszeile auf „Wird abgebrochen …“. Abgebrochen werden nur Freigaben, die noch auf eine Antwort warten. Der Schreibaufruf an den Shop hängt nicht an diesem Abbruch.
- Beleg: Composer.tsx:62–63 zeigt „Stoppen“ bei `busy`, mit dem genannten Titel. Workspace.tsx:140–143 setzt beim Klick nur den Statustext und ruft `api.stop` auf. Workspace.tsx:174–177 und chat-state.ts:254–257 lassen nach der Freigabe `busy` an und setzen „Wendet Änderungen an …“. sessions.ts:88–98 löst nur Einträge in `approvals` mit Ablehnung auf und bricht danach den Agenten ab. sessions.ts:209 entfernt die Freigabe aus dieser Map, sobald entschieden wurde; sessions.ts:248–249 führt `apply` ohne dieses Abbruchsignal aus. sessions.ts:262–268 kann eine schon entschiedene Freigabe nicht mehr auf „ablehnen“ drehen.
- Auswirkung: Wer merkt, dass die Änderung zu groß ist, und auf Stoppen klickt, während „Wendet Änderungen an …“ steht, kann den Shop verlassen in dem Glauben, es sei nichts angekommen. Geschrieben wird weiter.
- Empfehlung: Sobald die Freigabe raus ist, den Knopf ausblenden oder den Satz streichen und in der Statuszeile sagen, dass der Schreibvorgang weiterläuft. Stoppen an den laufenden Schreibaufruf hängen, wenn es ihn wirklich abbrechen soll.
- Vertrauen: sicher

### B2 — Schwere: hoch
- Ort: src/components/settings/SettingsView.tsx:61
- Befund: „Verbindung testen“ speichert bei ungespeicherten Änderungen zuerst das gesamte Formular, einschließlich Plattform, Schlüssel und KI-Zugriff. Der Hinweis zum Plattformwechsel sagt, der neue Shop gelte „nach dem Speichern“, und der Speichern-Knopf liegt weiter unten. Der Test-Knopf sagt das Speichern nicht an. Dieselbe Reihenfolge hat der Test der Search Console.
- Beleg: SettingsView.tsx:58–64 ruft bei `dirty` zuerst `save()` auf, sonst den Test. SettingsView.tsx:218 sagt: „Nach dem Speichern ist {d.label} der verbundene Shop. Es ist immer genau ein Shop verbunden.“ SettingsView.tsx:256 beschriftet den Knopf nur mit „Verbindung testen“. „Gespeichert“ steht in der Leiste bei SettingsView.tsx:174, nicht neben dem Test. GscSettings.tsx:40–41 speichert vor `api.testGsc()` ebenfalls, wenn das Feld schmutzig ist. buildPatch in settings-form.ts:50–65 nimmt Plattform, Zugänge und Bereiche in einen Speichervorgang.
- Auswirkung: Wer die Plattform nur umschaltet, um die Felder zu sehen, und dann „Verbindung testen“ drückt, macht diesen Shop zum einzigen verbundenen Shop. Spätere Freigaben im Chat gehen dorthin. Ein Test ist dafür der naheliegende Knopf, nicht „Speichern“.
- Empfehlung: Testen darf nur den bereits gespeicherten Stand prüfen. Sind Felder offen, den Test sperren und auf „Speichern“ zeigen, statt still mitzuspeichern.
- Vertrauen: sicher

### B3 — Schwere: mittel
- Ort: src/components/chat/ChangeSetCard.tsx:179
- Befund: Der Satz „Es wird erst nach deiner Freigabe geschrieben.“ steht nur bei einem Set ohne auswählbare Zeilen. Sobald es Zeilen gibt, heißt der primäre Knopf „übernehmen“, „anwenden“ oder ein vom Server gesetztes `applyLabel` wie „Stammdaten übernehmen“, nicht „jetzt im Shop schreiben“. „Rückgängig“ erscheint erst im Ergebnis und nur, wenn der Server Undo-Schritte mitliefert. Vorher steht nicht, ob sich der Klick zurücknehmen lässt.
- Beleg: ChangeSetCard.tsx:179 zeigt den Schreibhinweis nur bei `interactive && !selectable`. ChangeSetCard.tsx:183 setzt den Knopftext; ohne eigenes `applyLabel` heißt er bei Zeilen „N Änderungen anwenden“, ohne Zeilen „Freigeben & veröffentlichen“. ChangeSetCard.tsx:190–191 rendert „Rückgängig machen“ nur bei `undoTotal > 0`, also nach einem Ergebnis mit `result.undo`. Workspace.tsx:181 fragt erst beim späteren Klick: „Alle Änderungen dieses Sets auf die vorherigen Werte zurücksetzen?“
- Auswirkung: Neben dem Entwurf („Vorschau“) kann „übernehmen“ wie eine Bestätigung für den Chat wirken, nicht wie ein sofortiger Schreibvorgang im Shop. Ob Rückgängig geht, sieht man erst, wenn schon geschrieben wurde. Fehlt der Knopf, steht auch nicht da, dass es kein Zurück gibt.
- Empfehlung: Bei jedem offenen Set denselben Satz zeigen: der Klick schreibt die ausgewählten Zeilen in den verbundenen Shop. Dazu vor dem Klick sagen, ob Rückgängig vorgesehen ist.
- Vertrauen: sicher

### B4 — Schwere: mittel
- Ort: src/components/chat/ShopCheck.tsx:110
- Befund: „Beheben“ am Shop-Check startet keine Reparatur und keinen Chat. Der Klick legt nur den Reparaturtext ins Eingabefeld und setzt den Fokus.
- Beleg: ShopCheck.tsx:110 ruft `onFix(f.fixPrompt)` auf, die Beschriftung ist „Beheben“. Home.tsx:59 gibt `onExample` als `onFix` durch. Workspace.tsx:324 setzt damit `setInput` und Fokus, nicht `send`.
- Auswirkung: Der Knopf verspricht eine Reparatur. Ausgeführt wird sie nicht. Im Feld steht danach der Auftrag, und der Betreiber muss noch senden und freigeben. Wer nur die Beschriftung liest, hält den Punkt für angestoßen. Ob der Fokus das Feld ins Bild scrollt, ist hier nicht geprüft.
- Empfehlung: „Als Auftrag ins Feld“ oder „Text übernehmen“, und den gesetzten Text sichtbar lassen. Senden bleibt ein eigener Klick.
- Vertrauen: sicher

### B5 — Schwere: mittel
- Ort: src/components/shell/ShellProvider.tsx:74
- Befund: Schlägt der Statusabruf fehl, setzt der Fehlerhandler `configured` für Shop und KI auf wahr. Die Seitenleiste zeigt die KI deshalb als verbunden; der Shop bleibt „nicht erreichbar“, weil `ok` falsch ist. Die Startseite behandelt beide Flags als fertigen Anschluss: die Einrichtungskarte verschwindet, Styleguide-Empfehlung und Shop-Check erscheinen. Ein fehlgeschlagener erster Abruf der Chatliste wird zu „Noch keine Chats“. Ein Fehler bei Kategorien oder Produkten wird zu „Keine Treffer“.
- Beleg: ShellProvider.tsx:74 setzt im `catch` `shopware.configured: true`, `shopware.ok: false` und `ai.configured: true`. SideNav.tsx:17–20 zeigt bei fehlendem `ok` „nicht erreichbar“ und bei `ai.configured` „KI verbunden“; `shopware.error` wird dort nicht ausgegeben. Home.tsx:34–35 und 52–59 blenden die Einrichtungskarte aus und Shop-Check sowie Styleguide ein, sobald beide `configured`-Flags wahr sind. ShellProvider.tsx:84 macht aus dem ersten Fehlschlag eine leere Chatliste; SideNav.tsx:139 sagt dann „Noch keine Chats. Starte oben mit „Neuer Chat“.“ Workspace.tsx:78 setzt Kategorien bei Fehler auf `[]`. ContextPicker.tsx:29 macht dasselbe für Produkte, ContextPicker.tsx:58 und 79 zeigen dafür „Keine Treffer“. Die Wissensseite zeigt denselben Produktfehler als Text (KnowledgeView.tsx:158).
- Auswirkung: Ein Ausfall des Statusaufrufs sieht aus wie „die KI ist da, richte den Styleguide ein“. Ein Ausfall von Katalog oder Chatliste sieht aus wie ein leerer Shop oder ein neuer Nutzer. Der Betreiber sucht an der falschen Stelle, statt den Anschluss zu prüfen.
- Empfehlung: Fehlertext statt Ersatzzustand. „Nicht verbunden“, „nicht geladen“ und „keine Treffer“ getrennt halten.
- Vertrauen: sicher

### B6 — Schwere: mittel
- Ort: src/server/shopware.ts:98
- Befund: Schlägt die Shopware-Anmeldung fehl, hängt der Test die rohe Antwort des Shops an die Meldung. Die Einstellungen zeigen diesen Text unverändert neben „Verbindung testen“. Andere API-Fehler gelangen ähnlich ungefiltert in den Chat: der Strom übernimmt den Body, wenn kein `error`- oder `message`-Feld da ist; die Freigabe-Route antwortet auf Englisch mit „unknown approval“.
- Beleg: shopware.ts:98 wirft `Shopware-Login fehlgeschlagen (Status):` plus `await r.text()` ohne Auswertung. Die Test-Route src/app/api/settings/test/route.ts:20 kürzt diese Meldung nur auf 300 Zeichen und gibt sie als `message` zurück. SettingsView.tsx:258 schreibt `state.result.message` in die Zeile. useChatStream.ts:29–31 setzt die Fehlermeldung auf `error`, sonst `message`, sonst den gesamten Body. src/app/api/approve/route.ts:13 liefert `unknown approval`; Workspace.tsx:177 setzt das hinter „Freigabe konnte nicht gesendet werden:“. api.ts:21–24 macht aus einem Fehlerobjekt den Text des Feldes `error` und aus einem Nicht-JSON-Body die ersten 200 Zeichen.
- Auswirkung: Ein falscher Schlüssel endet als Rohtext der Shop-Antwort neben dem Test, nicht als Satz wie „Zugang abgelehnt, Schlüssel prüfen“. Im Chat steht im selben Fall der weitergereichte Body oder der englische Kurztext.
- Empfehlung: Anmeldungsfehler auf einen festen deutschen Satz begrenzen. Rohbody nicht in die Oberfläche geben. „unknown approval“ übersetzen.
- Vertrauen: sicher

### B7 — Schwere: mittel
- Ort: src/components/settings/GscSettings.tsx:86
- Befund: „Trennen“ bei der Search Console löscht den gespeicherten JSON-Schlüssel sofort, ohne Nachfrage. Der Schlüssel wird danach nie wieder angezeigt. Dokument und Chat fragen vor dem Löschen nach; dieser Knopf nicht.
- Beleg: GscSettings.tsx:46–49 ruft `api.disconnectGsc()` direkt auf. GscSettings.tsx:86 ist der Knopf „Trennen“ ohne weiteren Dialog. GscSettings.tsx:74 sagt zum Schlüssel: „danach nie wieder angezeigt“. SideNav.tsx:176 fragt „löschen?“ vor dem Chat-Löschen. KnowledgeView.tsx:123 fragt „Löschen?“ vor dem Dokument.
- Auswirkung: Ein Fehlklick zwingt dazu, die JSON-Datei des Service-Kontos neu zu besorgen. Der Betreiber kann den Schlüssel in Lotse nicht nachsehen.
- Empfehlung: Dieselbe Kurzfrage wie beim Chat: „Schlüssel trennen? Er lässt sich hier nicht wieder anzeigen.“
- Vertrauen: sicher

### B8 — Schwere: mittel
- Ort: src/lib/platforms.ts:89
- Befund: An mehreren Stellen, die ein Betreiber zum Anschließen und Ansehen braucht, steht Entwicklersprache. Der empfohlene Shopify-Zugang erklärt Dev Dashboard, Client-ID, Client-Secret, Organisation und Admin-API-Berechtigungen. Daneben gibt es ein zweites Geheimnis, „Admin-API-Zugriffstoken“. OpenMage nennt im selben Formular einen Shell-Befehl. Die Bereiche unter „KI-Zugriff“ heißen für jeden Shop „Einkaufswelten-Layouts“ und sprechen von Produktstreams und Verkaufskanälen. Im Chat heißen der Shop-Link „Storefront“, ein Reiter „JSON“, der leere Entwurf spricht vom „Agent“. Die Protokolle zeigen Vorgang und Bereich als technische Namen. Aufgeklappte Arbeitsschritte sind das Roh-JSON des Werkzeugaufrufs. Der KI-Schalter sagt „ChatGPT-Abo (Codex)“.
- Beleg: platforms.ts:89–97 ist der Shopify-Hilfetext mit „Shopify Dev Dashboard“, „Client-ID“, „Client-Secret“ und „Zugriffstoken“. platforms.ts:134 nennt `php shell/lotse.php --generate-token`. policy.ts:9 setzt das Bereichslabel „Einkaufswelten-Layouts“; settings.ts:82 legt `scopeInfo` fest daraus, ohne Blick auf die Plattform, SettingsView.tsx:158 gibt `info.label` aus. TargetCard.tsx:20 verlinkt „Storefront“. PreviewPane.tsx:93 beschriftet den dritten Reiter mit „JSON“, PreviewPane.tsx:145 sagt „während der Agent schreibt“. LogsPanel.tsx:76–77 gibt `r.op` und `r.entity` aus. Steps.tsx:26 zeigt `JSON.stringify` der Eingabe. SettingsView.tsx:110 hängt „(Codex)“ an das ChatGPT-Abo.
- Auswirkung: Beim Verbinden ist unklar, welcher Schlüssel aus dem Shopify-Admin gemeint ist und welcher Befehl nur für jemanden mit Shell-Zugang gilt. „Einkaufswelten“ auf einem Shopify- oder Magento-Shop lässt sich nicht zu „Seiten“ zuordnen; der Schalter wird falsch gelesen. „Storefront“ und „JSON“ sehen nach einer Entwickleransicht aus, nicht nach dem eigenen Shop.
- Empfehlung: Pro Plattform einen Satz „diesen Wert kopierst du hierher“, ohne Shell und ohne Scope-Listen im Fließtext. Bereichsnamen an die gewählte Plattform koppeln. „Storefront“ durch „Im Shop ansehen“ ersetzen, den JSON-Reiter und die Roh-Schritte aus der normalen Ansicht nehmen.
- Vertrauen: sicher

### B9 — Schwere: niedrig
- Ort: src/components/workspace/Workspace.tsx:337
- Befund: Die Vorschläge unter einem gewählten Kontext senden die Nachricht sofort. Die Beispielkarten auf der Startseite, die genauso wie fertige Aufträge aussehen, legen den Text nur ins Feld.
- Beleg: Workspace.tsx:337 übergibt `onPick={s => send(s)}`. Chips.tsx:8 sind schlichte Knöpfe ohne „Senden“. Workspace.tsx:324 legt Beispiele nur per `setInput` ab. Die Chip-Texte stehen in labels.ts:56–58, darunter „Schreibe zusätzlich Beschreibung und SEO-Meta“.
- Auswirkung: Wer auf der Startseite gelernt hat, dass ein Vorschlag erst im Feld landet, startet im Chat versehentlich eine Runde. In den Shop schreibt der Klick noch nicht; die Freigabe kommt später.
- Empfehlung: Dieselbe Folge wie auf der Startseite: Text ins Feld, Senden bleibt der eigene Knopf.
- Vertrauen: sicher

### B10 — Schwere: niedrig
- Ort: src/components/knowledge/KnowledgeView.tsx:111
- Befund: Das Kreuz an einer Produkt-Verknüpfung löst die Verknüpfung sofort aus. Für das Löschen desselben Dokuments gibt es in derselben Zeile die Frage „Löschen?“.
- Beleg: KnowledgeView.tsx:111 filtert den Link und ruft `setLinks` auf, das in Zeile 91 ein `PATCH` schickt. KnowledgeView.tsx:121–125 schaltet beim Dokument erst auf „Löschen?“ und „Abbrechen“.
- Auswirkung: Ein Klick auf das Kreuz ist kein Vorschau-Entfernen, sondern ein Schreibvorgang in der Wissensbasis. Er lässt sich nur durch neues Verknüpfen rückgängig machen, nicht über eine Frage.
- Empfehlung: Dieselbe Kurzfrage wie beim Dokument, oder die Verknüpfung erst nach „Speichern“ lösen.
- Vertrauen: sicher

## Was hält
- Die Änderungskarte zeigt vorher und nachher, Warnungen, eine Stichprobe bei Stapeln und die Zahl der ausgewählten Zeilen im Knopf. Standard ist alles ausgewählt, „Ablehnen“ steht daneben. Rückgängig fragt mit „Alle Änderungen dieses Sets auf die vorherigen Werte zurücksetzen?“ und bietet bei einem Teilabbruch „Rest rückgängig machen“ (Workspace.tsx:181, ChangeSetCard.tsx:189–191).
- Vor der Freigabe lehnt Stoppen offene Rückfragen und offene Sets ab. Der Kommentar der Stop-Route und sessions.ts:88–95 treffen diesen Fall. Der Titel am Knopf ist dafür richtig, für den Fall in B1 nicht.
- Eine Rückfrage hat anklickbare Antworten und ein Feld „Oder eigene Antwort …“. Der Platzhalter sagt „Antwort eintippen oder oben anklicken …“ (QuestionCard.tsx:20–30, Workspace.tsx:299). Die erste Option ist immer der primäre Knopf (QuestionCard.tsx:23); das legt nahe, sie sei die empfohlene, ohne das zu sagen.
- Alte Chats stehen links nach Tag, mit „läuft“, „wartet auf dich“ und „fertig“. Ab sieben Chats gibt es eine Suche (SideNav.tsx:131–134). Auf der Startseite liegen die letzten vier unter „Zuletzt“ (Home.tsx:74). Eingeklappt bleibt ein Punkt am Verlauf-Symbol; die Liste selbst gibt es erst nach dem Ausklappen (SideNav.tsx:118–124). Löschen fragt in der Zeile nach.
- Anhänge gehen über den Knopf, über Einfügen und über Ziehen auf den Chat. Der Upload-Fehler landet im Verlauf, Senden wartet, solange noch hochgeladen wird (Composer.tsx:54–61, Workspace.tsx:164, useAttachments.ts:25–27). Welche Dateien gelten, steht nur im Tooltip der Büroklammer, nicht als sichtbarer Satz. Am Anhang steht nicht, dass die Datei noch nicht im Shop liegt.
- Geheimnisse werden nicht vorausgefüllt. „gespeichert“, „Entfernen“ und „wird entfernt“ sind erst mit „Speichern“ wirksam (SecretField.tsx:25–35). Der Plattformwechsel ist als Satz erklärt, wenn man „Speichern“ benutzt (SettingsView.tsx:218). Kundendaten sind als immer gesperrt beschriftet (SettingsView.tsx:170).
- Laden der Einstellungen, der Wissensbasis und des Shop-Checks zeigen einen Fehlertext, nicht nur eine leere Fläche (SettingsView.tsx:95, KnowledgeView.tsx:53, ShopCheck.tsx:73–77). Leere Wissensbasis und leere Regeln sagen, was als Nächstes geht.

## Nicht geprüft
- CSS-Umbrüche und schmale Fenster: Dokument 05. Ob der Server eine Freigabe erzwingt: Dokument 02. Tastatur und ARIA: Dokument 06.
- Kein Browser, kein laufender Shop. Ob Shopware bei einem falschen Schlüssel tatsächlich JSON liefert, folgt aus dem unverarbeiteten Body, nicht aus einem gesehenen Dialog. Ob jeder Set-Typ Undo-Schritte erzeugt, ist hier nur an der Anzeige geprüft, nicht an den Ausführungsstellen.

## Für den zweiten Durchgang
Soll „Stoppen“ einen schon laufenden Schreibvorgang abbrechen und das in der Statuszeile sagen, oder soll der Knopf verschwinden, sobald „Anwenden“ geklickt wurde?
