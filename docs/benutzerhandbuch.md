**Deutsch** · [English](en/user-guide.md)

# Benutzerhandbuch

Lotse ist ein KI-Assistent für deinen Onlineshop (Shopware 6, Shopify, Magento 2, OpenMage). Du schreibst, was im Shop passieren soll. Lotse fragt nach, zeigt dir vorher eine Vorschau oder einen Vergleich und schreibt **erst nach deiner Freigabe**.

> Die KI hat nur Lesezugriff. Geschrieben wird ausschließlich vom Server, nach deinem Klick auf „Anwenden“, und jede Änderung lässt sich zurücknehmen.

## 1. Die Oberfläche

| Bereich | Wofür |
|---|---|
| **Arbeitsfläche** | Chat, Kontext und Vorschau. Startseite mit Shop-Check und Beispielen |
| **Styleguide** | Marke (Farben, Schriften, Ton) und eigene Regeln, ein Dialog |
| **Wissen** | Dokumente (Datenblätter, PDFs) als Faktenquelle |
| **Verlauf** | alle Chats; ein Punkt zeigt, ob eine Runde läuft, auf dich wartet oder fertig ist |
| **Einstellungen** | Shop verbinden, KI verbinden, Bild-KI, KI-Zugriff, Protokolle, Sprache |

Neuer Chat: **Neuer Chat** oder **Neuer Chat mit Kontext** (Ziel gleich wählen). Chats bleiben im Verlauf und lassen sich wieder öffnen, samt Entwurf und Freigaben.

## 2. Ein Chat in Kürze

1. **Schreiben, was passieren soll.** Beispiele: „Ändere das Layout der Produktseite von Produkt XY“, „Senke alle Preise in der Kategorie Jacken um 20 %“, „Füge bei allen Produkten eine FAQ hinzu“.
2. **Rückfragen beantworten.** Lotse fragt gezielt nach (klickbare Antworten), wenn etwas offen ist: Umfang, Ton, Reihenfolge. Fehlende Fakten erfindet es nicht.
3. **Vorschau oder Vergleich ansehen.** Seiten erscheinen rechts im Entwurf, Datenänderungen als Alt→Neu-Liste.
4. **Freigeben.** Erst „Anwenden“ schreibt in den Shop.
5. **Bei Bedarf zurücknehmen.** „Rückgängig machen“ stellt den vorherigen Stand her.

Dateien lassen sich anhängen (Bilder, CSV, Excel, PDF, Word, Text; per Klick, Einfügen oder Ziehen). Lotse nutzt sie als Quelle, z. B. Fotos für neue Produkte oder eine Lieferantenliste für einen Import.

### Kontext
Über das Zielsymbol wählst du Kategorie, Produkt oder Landingpage. Dann bezieht sich der Chat darauf, und rechts erscheint die echte Seite. Ohne Auswahl findet Lotse das Ziel aus deiner Nachricht. Ein anderer Kontext in einem Chat mit Verlauf startet automatisch einen neuen Chat, damit die Verläufe sauber getrennt bleiben.

## 3. Vorschau

Die Vorschau rechts hat zwei Ansichten:

- **Aktuell**: die echte Seite im Shop.
- **Entwurf**: der Entwurf von Lotse, im Theme deines Shops.

**Entwurf auf der echten Seite (Shopware).** Kopf, Fuß, Menü, Kaufbox, Beschreibung/Bewertungen, Cross-Selling, Produktliste und Filter sind die echten Teile der Zielseite. Nur der Inhalt dazwischen wird durch deinen Entwurf ersetzt. Nennst du kein Produkt, wählt Lotse ein echtes aktives Produkt mit Bild (bei Kategorie-Layouts dessen Kategorie). Auf den anderen Plattformen übernimmt das Theme den Inhalt über einen `theme-main`-Block; dort zeigt die Vorschau Platzhalter für die Teile, die das Theme liefert.

**JavaScript in der Vorschau.** Menü, Slider und Galerie des Shops laufen, aber isoliert: die Vorschau hat keinen Zugriff auf Lotse, Cookies oder deine Sitzung, und Skripte von Drittanbietern (Tracking, Consent-Dienste) werden nicht ausgeführt. Funktionen, die Anfragen an den Shop brauchen (z. B. Warenkorb-Fenster), arbeiten in der Vorschau nicht.

**Anmerken.** Mit **Anmerken** klickst du Elemente in der Vorschau an und notierst, was anders sein soll. Die Notizen („Wünsche“) sammeln sich und werden mit **… Wünsche an Lotse senden** gemeinsam als Auftrag abgeschickt. Das geht in „Aktuell“ und „Entwurf“.

**Mobil-Ansicht.** Das Handysymbol schaltet auf eine schmale Darstellung um.

**SEO/CRO-Prüfung.** Zum Entwurf zeigt Lotse eine Bewertung mit konkreten Punkten (Überschriften, Links, Bilder, Struktur). Ein Klick öffnet die Liste.

## 4. Freigabe und Rückgängig

Jede Änderung am Shop läuft über ein **Änderungsset**:

- Du siehst je Zeile **vorher → nachher** mit Warnungen (z. B. Preis −99 %, Preis unter Einkaufspreis).
- Du kannst **Zeilen abwählen**; angewendet wird nur, was ausgewählt ist.
- „Anwenden“ schreibt gedrosselt in den Shop (höchstens 300 Einträge je Set; Stapelregeln darüber hinaus, siehe unten).
- Jede Anwendung steht im Protokoll **Änderungen** (Einstellungen → Protokolle), mit Zeitpunkt, Umfang und Ergebnis.
- **Rückgängig machen** stellt die alten Werte wieder her. Bei Layouts wird jede Seite einzeln zurückgesetzt und das neue Layout wieder entfernt.

**Schreiben ist atomar, wo es Sinn ergibt:** Schlägt bei einer Layout-Veröffentlichung ein Schritt fehl, wird alles zurückgenommen, und im Shop bleibt nichts Halbes.

**Stapel.** Regeln für viele Produkte („alle Preise um 20 % senken und auf .99 runden“) rechnet der Server, nicht die KI. Du siehst Gruppen, Stichprobe und Fehler statt tausender Zeilen.

## 5. Layouts und Seiten

Lotse baut Einkaufswelten-Layouts (Shopware) bzw. Seiteninhalte aus Blöcken: Texte, Bild-Text, Slider, FAQ, eigene HTML-Bereiche u. a. Der Entwurf passt zu deinem **Styleguide** und übernimmt vorhandene Bausteine deines Shops.

### Wo soll ein Layout gelten? (Shopware)
Bevor ein Layout für Kategorien oder Produkte veröffentlicht wird, fragt Lotse mit echten Zahlen nach, **wo** es gelten soll:

| Ziel | Auswahl |
|---|---|
| Kategorie | eine Kategorie · mehrere ausgewählte · alle Kategorien |
| Produkt | ein Produkt · mehrere ausgewählte · alle Produkte einer Kategorie (inkl. Unterkategorien) · alle Produkte im Shop |
| Landingpage | eigene Seite mit URL und Verkaufskanal |

Die Übersicht zeigt, wie viele Seiten dadurch **ein eigenes Layout verlieren** („30 Produkte, davon 4 mit eigenem Layout, wird ersetzt“). Höchstens 1000 Seiten je Veröffentlichung; für mehr zuerst eingrenzen. Meta-Title und -Description gelten nur bei einer einzelnen Kategorie; bei mehreren ergänzt du sie danach per Chat je Kategorie.

## 6. Styleguide und eigene Regeln

Der **Styleguide** beschreibt, wie deine Marke aussieht und klingt: Farben, Schriften, Radius, Ton (Du/Sie, Dos und Don’ts), typische Bausteine. Lotse leitet ihn aus Theme, CSS, Logo und echten Texten ab („Styleguide analysieren“) und wendet ihn auf alles an.

- **Farben** kannst du im Dialog direkt anpassen und speichern.
- **Alles Weitere** änderst du im Chat („Setze die Ansprache auf Du“).
- **Erkannte Bausteine** sind eingeklappt; sie sind Material für die KI.

### Eigene Regeln
Feste Vorgaben für alle Texte, zum Beispiel:

- „SEO-Texte auf Produktseiten haben mindestens 2000 Zeichen.“
- „Wir sagen nie ‚günstig‘, sondern ‚fair kalkuliert‘.“
- „Maße immer in cm.“

Jede Regel hat einen **Bereich** (überall, Produkttexte, Seiten, SEO) und optional eine **Kategorie**, für die sie ausschließlich gilt (dann auch für deren Unterkategorien und Produkte). Regeln legst du im Styleguide-Dialog an oder im Chat („Merk dir: wir duzen unsere Kunden“); Lotse fragt vor dem Speichern nach. Sie gelten in jedem Chat zusätzlich zum Styleguide und gehen bei Widerspruch vor. Höchstens 100 Regeln mit je 300 Zeichen.

## 7. Wissen

Auf der Seite **Wissen** hinterlegst du Dokumente: Datenblätter, PDFs, Word, Excel, CSV, Text (bis 25 MB, keine Kunden- oder Bestelldaten). Lotse speichert sie lokal und nutzt sie als **Faktenquelle** für Produkttexte, FAQ und Sicherheitsinformationen (z. B. GPSR).

- Dokumente lassen sich mit Produkten und Kategorien verknüpfen.
- Jede Angabe aus der Wissensbasis nennt ihre **Quelle** (Dokument und Seite).
- Fehlt ein Fakt, wird er weggelassen oder erfragt, nie erfunden.
- Auszüge gehen als Teil des Prompts an den KI-Anbieter (Anthropic oder OpenAI).

## 8. Shop-Check und eigene Prüfungen

Auf der Startseite zeigt der **Shop-Check**, was im Shop gerade nicht stimmt: SEO, Bilder, Daten, Preise, Links, Sprachen, Recht und Barrierefreiheit (technische Prüfung, keine Rechtsberatung) und Search Console. Jeder Punkt hat Gewicht (Wichtig, Mittel, Hinweis), Anzahl, Beispiele und **Als Auftrag ins Feld**: das legt einen fertigen Auftrag in das Eingabefeld, abgeschickt wird erst mit deinem Klick.

Der Check läuft im Hintergrund (veraltet nach 6 Stunden) oder mit **Neu prüfen**, und nach angewendeten Änderungen automatisch.

### Prüfungen verwalten
Mit **Prüfungen** öffnest du die Liste aller Prüfungen:

- **An/Aus** je Prüfung. Eine ausgeschaltete Prüfung läuft nicht und erscheint nicht.
- **Eigene Prüfungen** (Kennzeichnung „eigene“) lassen sich löschen.
- **Neue Prüfung im Chat anlegen**.

### Eigene Prüfung per Chat
Beispiele:

- „Warne mich, wenn Produktbeschreibungen kürzer als 2000 Zeichen sind.“
- „Melde Produkte mit weniger als 5 Stück Bestand.“
- „Prüfe, ob die Meta-Description fehlt und es kein Bild gibt.“

Lotse formuliert daraus Bedingungen über feste Felder und zeigt dir **vor dem Speichern die Regel in Worten und die Trefferzahl in deinem Shop**. Erst nach „Ja“ wird sie angelegt und erscheint als normaler Befund.

| Feld | Bedeutung |
|---|---|
| Wörter / Zeichen der Beschreibung | Länge ohne HTML |
| Zeichen des Meta-Titles / der Meta-Description | 0 = fehlt |
| Zeichen des Produktnamens | |
| Preis, Streichpreis | brutto |
| Bestand | wo die Plattform ihn liefert |
| Hat ein Bild | ja / nein |

Bedingungen lassen sich mit **und** (alle) oder **oder** (mindestens eine) verknüpfen; Vergleiche: <, ≤, >, ≥, =, ≠. Unbekannte Werte treffen nie zu, es wird nichts geraten. Eigene Prüfungen sehen aktive Produkte, keine Kategorien, Seiten oder Links. Höchstens 20 eigene Prüfungen mit je 5 Bedingungen.

## 9. Einstellungen

| Abschnitt | Inhalt |
|---|---|
| **Shop verbinden** | Plattform wählen, Zugangsdaten eintragen, Verbindung testen. Empfohlen: eigene Integration mit eingeschränkter Rolle statt Admin-Login |
| **KI verbinden** | Anbieter (Claude per API-Schlüssel oder Codex per ChatGPT-Abo), Modell |
| **Bild-KI** (optional) | OpenAI-Schlüssel und Modell für generierte Bilder; KI-Bilder werden sichtbar gekennzeichnet |
| **KI-Zugriff** | Welche Bereiche Lotse lesen darf (Produkte, Kategorien, Layouts, Medien, Marketing, Shop-Grunddaten). Gesperrte Bereiche werden nicht gelesen, auch nicht vom Shop-Check |
| **Protokolle** | **Zugriffe** (jeder Lesezugriff der KI, abgewiesene markiert) und **Änderungen** (freigegeben, abgelehnt, rückgängig, geändert) |
| **Search Console** (optional) | Zugang für Chancen, Inhaltslücken und Erfolgsmessung |
| **Sprache** | Deutsch oder Englisch für Oberfläche und KI-Antworten (siehe unten) |

Kunden-, Bestell-, Zahlungs- und Zugangsdaten sind fest gesperrt und nicht freischaltbar.

### Sprache
Oberfläche und KI-Antworten gibt es auf **Deutsch** und **Englisch**. Umschalten kannst du in den **Einstellungen** und unten in der seitlichen Navigation (DE/EN). Ohne eigene Wahl richtet sich Lotse nach der Sprache deines Browsers (sonst Deutsch); deine Wahl wird im Cookie `lotse_lang` gespeichert und gilt sofort.

- **Chat-Antworten** der KI (Antworten, Rückfragen, Zusammenfassungen, Begründungen in Vorschlägen) folgen der Sprache der Oberfläche.
- **Inhalte für den Shop** (Produkttexte, Seiten, SEO, Übersetzungen) schreibt Lotse in der Sprache, die der Shop bzw. der Verkaufskanal verlangt, nicht automatisch in der Sprache der Oberfläche.
- Texte, die direkt aus dem Shop oder vom Server kommen (Shop-Daten, einzelne Fehlermeldungen), bleiben in ihrer Originalsprache.

## 10. Was Lotse nicht tut

- Es schreibt nie ohne Freigabe und liest keine Kunden-, Bestell- oder Zahlungsdaten.
- Es schätzt keine Preise, Bestände oder Einkaufspreise. Diese Werte entscheidest du.
- Es gibt keine Rechtsberatung; Recht- und Barrierefreiheits-Prüfungen sind technische Hinweise.
- Es ersetzt kein Staging: neue Abläufe zuerst in einem Testshop ausprobieren.

## 11. Hilfe bei Problemen

| Symptom | Was tun |
|---|---|
| „Host nicht erlaubt“ | Du rufst Lotse unter einem Namen auf, der nicht freigegeben ist. Bei Serverbetrieb den Namen in `ALLOWED_HOSTS` eintragen ([Selbst hosten](self-hosting.md)) |
| Chat zeigt dauerhaft „läuft“ | Seite neu laden; Lotse verbindet sich wieder. Ein Punkt im Verlauf zeigt den echten Stand |
| Vorschau zeigt „Weiterleitung außerhalb des Shops“ | Der Shop leitet auf eine fremde Domain um. Gleiche Site (z. B. `stage.` → `www.`) wird gefolgt, fremde Domains nicht |
| Shop-Check „unvollständig“ | Mindestens die Hälfte der Prüfungen ist gescheitert (Shop nicht erreichbar, Zugriff gesperrt). Verbindung testen, dann „Neu prüfen“ |
| Neue Prüfung meldet nichts | Die Regel trifft aktuell auf kein aktives Produkt zu; die Trefferzahl vor dem Speichern zeigt das |
