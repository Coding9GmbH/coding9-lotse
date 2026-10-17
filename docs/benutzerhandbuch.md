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

**Entwurf auf der echten Seite (Shopware).** Kopf, Fuß, Menü, Kaufbox, Beschreibung/Bewertungen, Cross-Selling, Produktliste und Filter sind die echten Teile der Zielseite. Nur der Inhalt dazwischen wird durch deinen Entwurf ersetzt. Nennst du kein Produkt, wählt Lotse ein echtes aktives Produkt mit Bild (bei Kategorie-Layouts dessen Kategorie). 

**Entwurf im echten Theme (Shopify, Magento, OpenMage).** Die Vorschau zeigt die echte Zielseite des Shops (Produkt, Kategorie bzw. Kollektion; bei Landingpages die Startseite als Rahmen) mit Kopf, Fuß und Theme-CSS. Darin steht genau das HTML, das beim Veröffentlichen geschrieben wird: über und unter dem Theme-Inhalt (Produktliste, Produktbereich, Stelle des `theme-main`-Blocks), bei Produkten von Magento und OpenMage in der Produktbeschreibung, bei Landingpages anstelle des Seiteninhalts. Ist die Seite nicht erreichbar (z. B. passwortgeschützter Shop ohne Inhaltsbereich), zeigt Lotse die einfache Vorschau mit den Styleguide-Farben.

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

### Wirkung von Änderungen (Search Console)
Ist die Search Console verbunden, merkt sich Lotse beim Anwenden die Suchdaten der 28 Tage davor: für Meta-Title und -Description, Name, Beschreibung, Kurzbeschreibung, FAQ, Titel und Inhalt von CMS-Seiten sowie für neue Layouts bzw. Seiteninhalte bestehender Kategorien und Produkte (höchstens 50 Seiten je Änderungsset, nur Seiten, die Google schon kennt). Im Bereich **SEO → Wirkung deiner Änderungen** siehst du je Änderung den Stand: *Wartet auf Daten* (mit Datum, ab wann gemessen werden kann), *Vorläufig* (ab 14 Tagen) oder *Gemessen* (nach 28 Tagen), mit Klicks pro Tag, Klickrate und Position im Vergleich und einer Einschätzung (*Verbessert*, *Verschlechtert*, *Kein klarer Effekt*, *Zu wenig Daten*). **Jetzt messen** fragt die Search Console für alle offenen Änderungen ab, ohne etwas zu schreiben. Hat eine Änderung geschadet, führt **Zum Chat** zum Änderungsset, wo du sie rückgängig machen kannst; der Shop-Check meldet solche Änderungen zusätzlich. Messungen lassen sich ausblenden.

### Abverkauf: Top-Seller und Ladenhüter
Ist unter Einstellungen → KI-Zugriff der Schalter **Abverkauf** an, liest Lotse aus den Bestellungen eines Zeitraums nur **Summen je Produkt**: Stückzahl, Umsatz (Positionssummen) und Anzahl Bestellungen, ohne stornierte Bestellungen. Kunden, Adressen und einzelne Bestellungen sieht weder Lotse noch die KI. Damit kannst du fragen: „Was sind meine Top-Seller der letzten 30 Tage?“, „Welche Produkte verkaufen sich nicht?“ oder „Welche Top-Seller haben schwache Texte?“. Der Shop-Check meldet im Bereich **Abverkauf** Top-Seller mit dünner Beschreibung, fehlenden Metas oder ohne Bild sowie Ladenhüter (Bestand, aber kein Verkauf in 90 Tagen). Voraussetzung im Shop: Shopware-Integration mit Lesezugriff auf Bestellungen; Shopify-App mit `read_orders` (ohne `read_all_orders` nur 60 Tage); Magento-Integration mit Zugriff auf Vertrieb → Bestellungen; OpenMage mit Modul `Lotse_Connector` ab Version 1.3.0.

## 9. Einstellungen

| Abschnitt | Inhalt |
|---|---|
| **Shop verbinden** | Plattform wählen, Zugangsdaten eintragen, Verbindung testen. Empfohlen: eigene Integration mit eingeschränkter Rolle statt Admin-Login |
| **KI verbinden** | Anbieter (Claude per API-Schlüssel oder Codex per ChatGPT-Abo), Modell, **Monatsbudget** (Kostenbremse für Claude: ist es erreicht, startet keine neue Runde; jede Runde verbraucht höchstens die Hälfte des freien Budgets, auch bei parallelen Chats; ab 80 % Hinweis im Chat; darunter die Kosten dieses Monats und von heute) |
| **Bild-KI** (optional) | OpenAI-Schlüssel und Modell für generierte Bilder; KI-Bilder werden sichtbar gekennzeichnet |
| **KI-Zugriff** | Welche Bereiche Lotse lesen darf (Produkte, Kategorien, Layouts, Medien, Marketing, Shop-Grunddaten). Gesperrte Bereiche werden nicht gelesen, auch nicht vom Shop-Check. Eigene Schalter (standardmäßig aus): **Abverkauf** (nur Summen je Produkt aus Bestellungen, siehe unten) und **Internet** (Websuche) |
| **Protokolle** | **Zugriffe** (jeder Lesezugriff der KI, abgewiesene markiert) und **Änderungen** (freigegeben, abgelehnt, rückgängig, geändert) |
| **Search Console** (optional) | Zugang für Chancen, Inhaltslücken und Erfolgsmessung |
| **GitHub** (optional, unter Integrationen) | Fine-grained Token für Code-Änderungen an Plugins und Themes. Auf GitHub unter *Settings → Developer settings → Fine-grained tokens* nur die nötigen Repositorys auswählen und **Contents** sowie **Pull requests** auf *Lesen & Schreiben* setzen. Der Token wird verschlüsselt gespeichert, automatisch getestet (zeigt den GitHub-Login und Repositorys ohne Schreibrecht) und nie wieder angezeigt, auch nicht der KI. Lotse schreibt nur auf eigene Branches `lotse/…`, nie auf `main` |
| **Sandbox** (optional) | Schaltet **Sandbox Coding** ein (standardmäßig aus): Code-Aufgaben in eigenen Shopware-Containern (Dockware) auf diesem Rechner, dazu Arbeitsspeicher, CPUs und die Pause nach Inaktivität (gestoppt, nicht gelöscht). Braucht Docker-Zugriff, siehe [Selbst hosten](self-hosting.md#sandbox-coding-aktivieren). Image, Umgebungsvariablen und eigene Einrichtungsbefehle legst du im Reiter **Sandbox Coding** fest; geheime Werte werden verschlüsselt und nie angezeigt; Code im Container (auch von der KI geschriebener) kann sie lesen, daher nur Zugangsdaten eintragen, die allein für die Sandbox gelten |
| **Sprache** | Deutsch oder Englisch für Oberfläche und KI-Antworten (siehe unten) |

Kunden-, Bestell-, Zahlungs- und Zugangsdaten sind fest gesperrt und nicht freischaltbar.

### Sandbox Coding: Sandbox im Chat

Eine Sandbox hängst du an einen ganz normalen Chat der Arbeitsfläche: **Sandbox** unter dem Eingabefeld öffnet „Sandbox starten“ mit Repository (aus GitHub), Basis-Branch (vorausgewählt aus den Vorgaben der Umgebung im Reiter **Sandbox Coding**), optionalem Titel und optionalem Datenbank-Dump. Die KI kann eine Sandbox auch selbst vorschlagen („Vorschlag: Sandbox starten“ mit Repository und Branch) – angelegt wird sie erst, wenn du **Sandbox starten** klickst (**Anpassen …** öffnet denselben Dialog). Je Chat gibt es höchstens eine Sandbox. Lotse richtet im Hintergrund einen eigenen Shopware-Container ein; rechts erscheint statt der Entwurfsvorschau die Sandbox mit einer kompakten Statuszeile (**Stoppen**, **Pausieren**/**Fortsetzen**, **Einrichtung fortsetzen**, **Aufgabe abschließen**) und den Reitern **Vorschau**, **Einrichtung**, **Änderungen** und **Pull Request**. Während der Einrichtung ist **Einrichtung** offen (jeder Schritt mit Status, Dauer und Protokoll; schlägt einer fehl, steht die Ursache darunter, und **Ab hier erneut versuchen** setzt dort wieder an); sobald die Sandbox bereit ist, wechselt die Ansicht zur **Vorschau**. Du kannst schon während der Einrichtung schreiben: Die KI startet, sobald die Sandbox bereit ist. **Pausieren**/**Fortsetzen** stoppt und startet den Container (Code, Datenbank und Änderungen bleiben; nach längerer Inaktivität pausiert Lotse von selbst). **Aufgabe abschließen** löscht Container und Dateien; die Sandbox ist dann vom Chat gelöst, der Chat bleibt und ist wieder ein normaler Chat, die Aufgabe bleibt als Eintrag im Reiter **Sandbox Coding**. Dort stehen alle Sandboxes mit Status, Repository und PR-Link; ein Klick öffnet ihren Chat, **Sandbox in neuem Chat** startet eine neue.

**Mit eigener Datenbank:** Im Dialog kannst du optional einen **Datenbank-Dump** (`.sql` oder `.sql.gz` aus `mysqldump`/`mariadb-dump`, ohne `--databases`/`--all-databases`) per Ziehen & Ablegen oder Dateiauswahl hochladen – nur bereinigte Dumps ohne Kundendaten. Der Upload läuft in Teilstücken mit Fortschritt; **Abbrechen** hält ihn an, **Fortsetzen** macht an derselben Stelle weiter. Die Einrichtung prüft zuerst, ob der Dump zur Shopware-Version des Images passt: Weicht die Hauptversion ab (z. B. Dump von 6.6, Image 6.7), stoppt sie mit einem Hinweis – besser in der Umgebung ein passendes Image wählen, oder mit **Trotzdem fortfahren** importieren. Danach importiert Lotse den Dump, setzt die Domain auf die Sandbox, installiert dein Plugin, führt die eigenen Befehle „nach der Datenbank“ aus und kompiliert das Theme. Der Dump wird **direkt nach dem Import gelöscht** (auch wenn er fehlschlägt); die Zeitleiste zeigt „Dump gelöscht ✓“. **Datenbank ersetzen** im Reiter **Einrichtung** spielt später einen neuen Dump ein; dein Code bleibt dabei unverändert.

Die **Vorschau** zeigt die Storefront der Sandbox – zum Ausprobieren wie ein echter Shop: Navigation, Suche, Warenkorb, Kasse und Kundenkonto funktionieren (die Sitzung hält Lotse pro Sandbox auf dem Server). Oben trägst du einen Pfad ein (z. B. `/checkout/cart`), lädst neu, wechselst zwischen Desktop- und Mobil-Breite oder öffnest die Vorschau **in einem neuen Tab**. **Admin** öffnet die Shopware-Administration der Sandbox (ohne Gewähr). Nach dem Kompilieren des Themes lädt die Vorschau von selbst neu. Ist die Sandbox pausiert, startet **Vorschau laden** sie wieder; bis Shopware antwortet, steht dort „Umgebung startet …“. Die Vorschau zählt als Aktivität.

**Mit der KI am Code arbeiten:** In einem Chat mit Sandbox arbeitet die KI wie ein Entwickler – und **nur** in der Sandbox: Der Live-Shop ist von dort nicht erreichbar (keine Shop-Werkzeuge, keine Änderungssets). Sie liest und ändert die Dateien des Repositorys mit ihren eigenen Datei-Werkzeugen, führt Befehle im Container aus (z. B. `bin/console theme:compile`, Logs, die Datenbank der Sandbox) und prüft die Seite selbst. Jede geänderte Datei erscheint als Karte mit „+/−“-Zeilen, jeder Befehl mit Ergebnis (z. B. „Theme kompilieren ✓ 7 s“ oder die Fehlermeldung); nach dem Kompilieren lädt die Vorschau neu. Der Reiter **Änderungen** zeigt alle Änderungen gegenüber dem Basis-Branch. Ist die Sandbox pausiert, startet deine Nachricht sie wieder („Umgebung startet …“) – der Chat wartet, bis Shopware antwortet. Mit **Anmerken** in der Vorschau markierte Wünsche schickst du direkt an die KI. Die KI kann Dateien nur im Repository der Sandbox ändern; `.git`, `.env` und Schlüssel sind für sie gesperrt, Befehle laufen nur im Container (ohne Internet, nie auf dem Lotse-Rechner), Umgebungsvariablen nennt ihr Lotse nur mit Namen (Befehle im Container können sie aber lesen; Ausgaben werden geschwärzt – trage dort nur Zugangsdaten ein, die allein für die Sandbox gelten), und sie veröffentlicht nichts selbst: Am Ende schlägt sie Titel und Beschreibung für den Pull Request vor. Claude-Runden zählen zur Kostenbremse; mit Codex läuft der Chat über das ChatGPT-Abo.

**Internet für die Sandbox (nur nach Freigabe):** Der Container der Sandbox ist offline. Braucht die KI Internet (z. B. für `composer require` oder `npm install`), bittet sie darum: Im Chat erscheint „Internetzugang für die Sandbox erlauben?“ mit ihrem Grund; erst dein Klick auf **Für diese Aufgabe erlauben** verbindet den Container mit dem Internet (**Ablehnen**: sie arbeitet ohne weiter). Du kannst es auch selbst in der Statuszeile rechts schalten: **Internet: aus**/**Internet: an** (ein Klick auf „an“ sperrt es wieder). Der Zugang gilt nur für diese Aufgabe und endet beim Sperren, Pausieren (auch automatisch nach Inaktivität) und Abschließen; nach „Fortsetzen“ ist der Container wieder offline. **Mit Internet erreicht der Container jede öffentliche Adresse – auch die Website deines Live-Shops** wie jede andere Seite. Erlaube es deshalb nur, wenn es gebraucht wird. Lotse selbst bleibt aus dem Container unerreichbar. In der Umgebung (Reiter **Sandbox Coding**) stellt **Internet im Container** auf „nur nach Freigabe“ (Standard) oder „nie“. Freigaben und Sperren stehen mit Nutzer im Audit-Log.

**Veröffentlichen (Pull Request):** Ist die Änderung in der Vorschau geprüft, schlägt die KI Titel und Beschreibung vor („Vorschlag für den Pull Request“); **Prüfen und veröffentlichen** öffnet rechts den Reiter **Pull Request** mit diesem Vorschlag. Dort siehst du die geänderten Dateien und den Weg `lotse/<titel>-<kennung> → <Basis-Branch>`, passt Titel und Beschreibung an und klickst **Pull Request erstellen** – erst dieser Klick veröffentlicht (Fortschritt: „Nehme Nachher-Screenshots auf … Committe … Pushe … Erstelle Pull Request …“). Lotse committet alle Änderungen der Sandbox (Autor „Lotse“, du als Co-Autor, wenn du mit `LOTSE_PASSWORD` angemeldet bist), pusht sie auf den eigenen Arbeits-Branch der Aufgabe und legt den Pull Request gegen den Basis-Branch an (kein Entwurf). Branch und Ziel legt Lotse fest, nicht die KI. Nicht veröffentlicht werden Änderungen an `.github/workflows` und `.github/actions` (sowie `action.yml` überall), geschützte Dateien (`.env*`, Schlüssel, `auth.json`) und alles, was wie ein Geheimnis aussieht (Tokens, private Schlüssel, Adressen mit Passwort, in Lotse gespeicherte Zugangsdaten): Dann bricht Lotse vor dem Push mit einem Hinweis ab. Danach zeigen Chat und Reiter die Karte „#42 … – offen“ mit Status (offen, gemergt, geschlossen), den Checks auf GitHub und **Auf GitHub öffnen**; die Aufgabenliste zeigt die Nummer. Weitere Änderungen veröffentlichst du mit **Pull Request aktualisieren** in denselben Pull Request. Bricht etwas ab (fehlende Schreibrechte, Branch-Schutz für `lotse/*`, GitHub-Anfragelimit, Neustart von Lotse), steht die Ursache im Reiter; ein erneuter Klick macht dort weiter, ohne etwas doppelt anzulegen. Während die KI arbeitet, wird nicht veröffentlicht (und umgekehrt).

**Rückmeldungen zum Pull Request:** Solange der Pull Request offen ist, fragt Lotse GitHub etwa alle zwei Minuten nach Neuem (nur bei eingeschaltetem Sandbox Coding und verbundenem GitHub). Reviews, Kommentare, Zeilenkommentare und fehlgeschlagene Checks erscheinen als Karte **Rückmeldung zu Pull Request #42** im Chat der Sandbox – jede Rückmeldung nur einmal. Die Texte stammen von Dritten; die KI sieht sie erst, wenn du **An KI übergeben** klickst. Dann startet eine neue Runde: Die KI bekommt die Rückmeldung als gekennzeichnete Daten (geschwärzt und gekürzt), arbeitet sie in der Sandbox ab – ein pausierter Container wird vorher geweckt – und schlägt danach eine neue Beschreibung vor; veröffentlicht wird wieder nur mit deinem Klick auf **Pull Request aktualisieren** in denselben Pull Request. Wird der Pull Request gemergt oder geschlossen, zeigt eine Karte das mit **Aufgabe abschließen** an, und Lotse fragt nicht mehr nach. Ist die Sandbox schon abgeschlossen, lässt sich eine Rückmeldung nicht mehr übergeben: Für weitere Änderungen eine neue Sandbox starten (und den Datenbank-Dump erneut hochladen).

**Vorher/Nachher-Screenshots:** Am Ende der Einrichtung fotografiert Lotse die Storefront der Sandbox (Schritt **Vorher-Screenshots**, auf Desktop und Mobil), beim Veröffentlichen noch einmal mit deiner Änderung („Nehme Nachher-Screenshots auf …“). Im Reiter **Pull Request** stehen beide nebeneinander; ein Klick öffnet ein Bild in voller Größe. Welche Seiten fotografiert werden, legst du in der Umgebung (Reiter **Sandbox Coding**) unter **Seiten für Screenshots** fest – ein Pfad je Zeile, höchstens 5, Standard `/`, leer = keine Screenshots. Die Bilder bleiben in Lotse (sie werden mit **Aufgabe abschließen** gelöscht); der Pull Request erwähnt sie nur in einem Satz, ohne Link und ohne Upload zu GitHub. Aufgenommen wird in einem kurzlebigen Container mit einem festen Browser-Image (`mcr.microsoft.com/playwright`, einmalig gut 2 GB, „Umgebung prüfen“ lädt es); er hängt nur am internen Netzwerk und erreicht nur die Storefront seiner Sandbox. Klappt eine Aufnahme nicht (Image fehlt, Seite antwortet nicht, Sandbox pausiert), steht der Grund im Reiter – Einrichtung und Veröffentlichen laufen trotzdem weiter. Vorher-Screenshots entstehen neu, wenn das Repository neu geklont oder eine andere Datenbank importiert wird – nach einem Datenbank-Wechsel aber nur, solange der Code noch unverändert ist; sonst bleibt der Bereich leer (mit Hinweis), damit „Vorher“ nicht schon die Änderung zeigt.

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
