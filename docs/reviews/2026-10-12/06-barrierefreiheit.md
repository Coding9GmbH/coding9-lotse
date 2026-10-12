# Review: Barrierefreiheit
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung von Markup, ARIA, Tastatur und CSS, ohne Axe und ohne Browser.

## Urteil
Gelb. Nachricht senden, Änderung freigeben, Einstellung speichern und Dialog schließen sind echte Knöpfe bzw. ein natives `dialog` und mit der Tastatur erreichbar. Deshalb gibt es keinen Befund der Schwere hoch. Gelb, weil die eingeklappte Navigation ihre Beschriftung nur noch als CSS-Tooltip führt, der Markiermodus an Mausereignissen hängt, das Start-Textfeld keinen sichtbaren Fokus hat und mehrere gelesene Farbpaare WCAG AA verfehlen.

## Befunde
### B1 — Schwere: mittel
- Ort: src/components/shell/SideNav.tsx:74
- Befund: In der eingeklappten Leiste verschwinden die Beschriftungen aus dem Namen. Ersetzt werden sie durch einen CSS-Tooltip, nicht durch `aria-label`. Der Tooltip lässt sich nicht ansteuern und nicht mit Escape schließen.
- Beleg: `collapsed` ist `s.collapsed && !s.mobileOpen` (SideNav.tsx:31). „Neuer Chat“ (Zeile 74), Arbeitsfläche (80), Kontext (85), Styleguide (92), Wissen (101), Einstellungen (106), Protokolle (112) und der Status-Link (158) haben dann nur `data-tip`. Die Texte stecken in `.label`. SideNav.module.css:108 setzt `.collapsed .label` auf `display: none` und nimmt sie damit aus dem Namen. Der Tooltip ist `::after { content: attr(data-tip) }` mit `opacity: 0` und `pointer-events: none` (Zeilen 117–125), sichtbar nur bei `:hover` und `:focus-visible`. Der Einklapp-Knopf lässt `title` im eingeklappten Zustand weg (SideNav.tsx:68) und hat ein `aria-label`. Die übrigen Einträge haben weder `title` noch `aria-label`. Die Icons sind `aria-hidden` (icons.tsx:9). Benannt bleiben Marke (61), Einklappen (66–67), Schließen (71) und „Verlauf anzeigen“ (120). Die mobile Schublade ist nicht eingeklappt, dort bleiben die Texte sichtbar. Ob ein Browser den `::after`-Text trotzdem in den Namen übernimmt, steht nicht im Markup.
- Auswirkung: Tastatur- und Screenreader-Nutzer bekommen in der gespeicherten Icon-Leiste entweder keinen Namen oder einen Namen, der nur als nicht bedienbarer Tooltip existiert (WCAG 4.1.2, 1.4.13). Die Leiste lässt sich ausklappen, der Umschalter ist benannt.
- Empfehlung: Im eingeklappten Zustand dieselben Namen als `aria-label` an den Knopf oder Link hängen. Den Tooltip nicht als einzigen Namen verwenden und ihn per Escape schließbar machen oder weglassen.
- Vertrauen: wahrscheinlich

### B2 — Schwere: mittel
- Ort: src/lib/preview-frame.ts:38
- Befund: Der Markiermodus wählt Elemente nur über Mauszeiger und Klick. Überschriften, Absätze und Bilder haben keinen Tastaturweg. Das Notizfeld, das nach dem Klick aufgeht, hat keinen Namen.
- Beleg: `FRAME_SCRIPT` hört auf `mouseover`, `mouseleave` und `click` (preview-frame.ts:38–42), nicht auf Tastatur. Dieselbe Lücke im gleichen-Origin-Pfad: annotator.ts:53–78 registriert nur diese drei Ereignisse. `MEANINGFUL` (preview-frame.ts:28) umfasst auch `h1`–`h6`, `p`, `li`, `img`. Ein `click` entsteht bei Enter nur auf schon fokussierbaren Elementen wie Links und Knöpfen. Der Hinweis sagt „Klicke auf ein Element“ (PreviewPane.tsx:107). Die Notiz (PreviewPane.tsx:112) hat nur einen Platzhalter, kein `label` und kein `aria-label`. Enter und Escape gelten erst, wenn das Feld offen ist (Zeile 113).
- Auswirkung: Ohne Maus lässt sich ein konkretes Element in der Vorschau nicht markieren. Wer das Feld mit einem Screenreader erreicht, hört keinen Zweck. Eine Änderung beschreiben geht weiterhin über das Nachrichtenfeld.
- Empfehlung: Neben dem Klick eine Tastaturwahl anbieten (fokussierbare Ziele im Rahmen oder eine Liste der sinnvollen Elemente). Dem Textfeld ein `aria-label` geben, zum Beispiel „Was soll anders sein?“.
- Vertrauen: sicher

### B3 — Schwere: mittel
- Ort: src/components/chat/Composer.module.css:12
- Befund: Auf der Startseite hat das Nachrichtenfeld keinen sichtbaren Fokus. Die globale Fokuslinie ist dort abgeschaltet, und der Fokus setzt die Rahmenbreite auf null.
- Beleg: `.form textarea` setzt `outline: none` (Composer.module.css:2). Das schlägt `:focus-visible` aus globals.css:57, weil die Klasse spezifischer ist. Im Chat bleibt `.form textarea:focus { border-color: var(--green) }` (Zeile 3). Auf der Startseite gilt zusätzlich `.home textarea { border: 0 }` (Zeile 8) und `.home textarea:focus { border: 0 }` (Zeile 12), später und gleich spezifisch, also ohne Rand und ohne Linie. Der Knopf „Senden“ behält die globale Korallen-Linie.
- Auswirkung: Wer per Tastatur auf dem Startbildschirm in das Feld springt, sieht nicht, dass es Fokus hat (WCAG 2.4.7). Tippen und Senden gehen trotzdem.
- Empfehlung: `outline: none` nicht für den Start-Zustand verwenden, oder bei Fokus denselben sichtbaren Rand wie im Chat lassen.
- Vertrauen: sicher

### B4 — Schwere: mittel
- Ort: src/components/preview/PreviewPane.module.css:35
- Befund: Mehrere gelesene Text- und Flächenfarben liegen unter WCAG AA. Der Primary-Knopf im Ruhezustand besteht. Hover, die weiße Schrift auf Koralle, Fehler- und Statusfarben, die ausgeblendete Änderungszeile und die gedämpfte Navigationsschrift nicht.
- Beleg: Formel: Kanal c = Wert/255; linear = c/12.92 wenn c ≤ 0.04045, sonst ((c+0.055)/1.055)^2.4; L = 0.2126 R + 0.7152 G + 0.0722 B; Kontrast = (Lhell+0.05)/(Ldunkel+0.05). Alpha vorher auf den Hintergrund gemischt: Ergebnis = Vordergrund·a + Hintergrund·(1−a). Normaler Text braucht 4.5:1 (unter 24 px, auch bei Gewicht 600, solange unter etwa 18.7 px). UI-Grenzen 3:1 (1.4.11). Link gegen umgebenden Text 3:1, wenn die Farbe der einzige Unterschied ist (1.4.1). Beispiel Alpha: `--fg-3` ist `#ffffff` bei a = 122/255 auf `#2e2e38` → Kanal R = 122 + 46·133/255 = 146, B = 122 + 56·133/255 = 151, also `#929297`, Kontrast 4.34:1.
  Verfehlt, Text:
  - `#ffffff` auf `#ff786d` = 2.57:1. „Markieren beenden“ (PreviewPane.module.css:35) und die Wunsch-Ziffern (Zeilen 46 und 50).
  - `#1e1e1e` bei `opacity: .45` auf `#ffffff` → `#9a9a9a` = 2.81:1. Abgewählte Zeile im Änderungsset (ChangeSetCard.module.css:30, gesetzt in ChangeSetCard.tsx:117). Die Checkbox bleibt bedienbar, solange `locked` falsch ist (ChangeSetCard.tsx:119). Deaktivierte Knöpfe mit `opacity: .45` sind ausgenommen und hier nicht gezählt.
  - `#e85a50` auf `#ffe0dc` = 2.82:1. Badge „Wichtig“ (ShopCheck.module.css:19, Wortlaut shopcheck.ts:21, Ausgabe ShopCheck.tsx:99), „nicht eingerichtet“ (Settings.module.css:17), „wird entfernt“ (34), Alarm (41), Badge „entfernt“ (ChangeSetCard.module.css:20).
  - `#b8860b` auf `#ffffff` = 3.25:1. Score „mid“ (PreviewPane.module.css:27), 12 px, Gewicht 600, Fläche der Leiste ist `#fff`.
  - `#e85a50` auf `#ffffff` = 3.49:1. Shop-Check-Summe (ShopCheck.module.css:5), Fehlerzeile (48), `.bad` (Settings.module.css:50), Danger-Knopf (Button.module.css:7 und Settings.module.css:35), Score „lo“ (PreviewPane.module.css:28).
  - `#2e2e38` auf `#e85a50` = 3.84:1. Primary und „Neuer Chat“ nur bei Hover (Button.module.css:3, SideNav.module.css:43). Der Ruhezustand steht unter Was hält.
  - Speichern während `busy`: `opacity: .7` (Button.module.css:10), nicht `disabled` (SettingsView.tsx:178, `disabled` nur bei `!dirty`). Text und Fläche mischen sich einzeln mit `#ffffff` zu etwa `#6d6d74` auf `#ffa199` = 2.64:1.
  - `#3f7a6b` auf `#e6f0ec` = 4.29:1. Hinweis-Kasten und „eingerichtet“ (Settings.module.css:40 und 16), Badge „Hinweis“ (ShopCheck.module.css:21), Badge „neu“ (ChangeSetCard.module.css:19), Entwurfs-Badge (PreviewPane.module.css:29).
  - `#929297` auf `#2e2e38` = 4.34:1, auf der Suchfläche `#393942` = 3.69:1. `--fg-3` (SideNav.module.css:5) für Kontext-Unterzeile (58), Verlaufskopf (67), Platzhalter (72), Gruppen (75), Hinweis (77), Zeitstempel (85).
  - Shop-Check-Disclaimer: `#66666d` bei `opacity: .8` auf `#ffffff` → `#85858a` = 3.67:1 (ShopCheck.module.css:15).
  Verfehlt, nicht Text:
  - Schalter aus: `#e9e2d6` auf `#ffffff` = 1.29:1 (Settings.module.css:59). Die Checkbox ist `opacity: 0` (Zeile 56), der Balken ist der Zustand. Ein steht bei `#3f7a6b` auf `#ffffff` = 4.99:1.
  - Link `#3f7a6b` gegen Nebentext `#66666d` = 1.14:1, ohne Unterstreichung (globals.css:54, Unterstreichung erst bei Hover in Zeile 55). Beispiel der Schlüssel-Hinweis in SettingsView.tsx:117, Hint-Farbe Settings.module.css:24.
- Auswirkung: Fehler, Schweregrade, der aktive Anmerken-Knopf und abgewählte Änderungen sind schwer lesbar. Die gedämpfte Schrift in der dunklen Navigation liegt knapp unter 4.5:1. Der ausgeschaltete KI-Zugriff-Schalter hebt sich kaum von der Karte ab.
- Empfehlung: Fehler und Badges abdunkeln (Richtung `#8a5a00` auf der jeweiligen Fläche, das Paar hält). Auf Koralle die dunkle Schrift `#2e2e38` auch für „Markieren beenden“ und die Ziffern nutzen. Hover von Primary nicht nach `#e85a50` ziehen, ohne die Schrift zu ändern. Abgewählte Zeilen nicht per `opacity` auf der ganzen Zeile abschwächen. `--fg-3` anheben. Den Schalter-aus-Balken dunkler als `#e9e2d6` färben. Links im Fließtext unterstreichen.
- Vertrauen: sicher

### B5 — Schwere: mittel
- Ort: src/components/chat/Message.tsx:8
- Befund: Eigene und KI-Nachrichten sind unbenannte `div`s. Wer spricht, steht nur in der Darstellung (Ausrichtung und Fläche).
- Beleg: `UserMessage` ist ein `div` ohne Rolle und ohne Namen (Message.tsx:8), `AiMessage` ebenso (Zeile 28). Die Flächen trennt Message.module.css:2–3 (`#2e2e38` gegen `--panel`). Karten daneben haben Namen („Rückfrage“ in QuestionCard.tsx:15, „Änderungsset“ in ChangeSetCard.tsx:90). Fehler haben `role="alert"` (Message.tsx:32).
- Auswirkung: Im Verlauf ist der Sprecher für assistive Technik nicht bestimmbar (WCAG 1.3.1). Der Text selbst ist lesbar.
- Empfehlung: Pro Nachricht einen sichtbaren oder nur für assistive Technik vorhandenen Namen „Du“ bzw. „Lotse“ setzen.
- Vertrauen: sicher

### B6 — Schwere: mittel
- Ort: src/components/chat/ChatLog.tsx:44
- Befund: Der Verlauf ist eine Live-Region, die nur neue Knoten ankündigt. Die KI-Antwort wächst im bestehenden Knoten und fällt damit aus der Ansage.
- Beleg: Der Container hat `role="log"`, `aria-live="polite"` und `aria-relevant="additions"` (ChatLog.tsx:44). `role="log"` impliziert dasselbe. `AiMessage` ersetzt bei jedem neuen Text das HTML im selben `div` (Message.tsx:27–28). Ergänzungen von Text in einem vorhandenen Knoten sind bei `additions` nicht relevant. Neue Karten (Frage, Änderungsset) sind neue Knoten und fallen unter die Ansage. Die Statuszeile daneben ist eine eigene `role="status"` (StatusLine.tsx:6) und hängt nicht von diesem Relevant-Wert ab.
- Auswirkung: Eine nachwachsende Antwort wird nach dem ersten Erscheinen voraussichtlich nicht vorgelesen (WCAG 4.1.3). Ob ein Screenreader den Log-Inhalt trotzdem nachzieht, ist nicht ausgeführt.
- Empfehlung: Fertige Antworten als neuen Status ankündigen, oder `aria-relevant` nicht auf `additions` begrenzen, ohne die ganze Karte bei jedem Token zu wiederholen.
- Vertrauen: wahrscheinlich

### B7 — Schwere: mittel
- Ort: src/components/context/ContextPanel.tsx:25
- Befund: Das Kontext-Panel übernimmt beim Öffnen den Fokus und schließt mit Escape, fängt den Fokus aber nicht ein und gibt ihn nicht zurück. Dieselbe Lücke hat die mobile Navigationsschublade.
- Beleg: Beim Öffnen wird das erste Feld fokussiert und Escape ruft `onClose` (ContextPanel.tsx:16–18). Das Scrim ist ein `div` mit `onClick` und `aria-hidden` (Zeile 25), ohne Tastatur. Das `aside` hat `aria-label` und `inert` nur solange es zu ist (Zeile 26), kein `aria-modal`. Der zuvor fokussierte Knopf wird nicht gespeichert. Die Schublade: Escape in AppShell.tsx:19, Schließen-Knopf mit Namen in SideNav.tsx:71, Backdrop nur Klick und `aria-hidden` (AppShell.tsx:35). Der Inhalt dahinter wird nicht `inert`, der Fokus bleibt auf „Navigation öffnen“. Das 720-px-Layout selbst gehört zu Dokument 05.
- Auswirkung: Mit der Tastatur lässt sich das Panel schließen, der Fokus wandert aber in den verdeckten Chat und kehrt nicht zum Auslöser zurück (WCAG 2.4.3).
- Empfehlung: Solange Panel oder Schublade offen ist, den restlichen Inhalt `inert` setzen und den Fokus an den Auslöser zurückgeben. Das Scrim braucht keine eigene Tastatur, wenn Escape und der Schließen-Knopf bleiben.
- Vertrauen: sicher

### B8 — Schwere: niedrig
- Ort: src/components/chat/ChangeSetCard.tsx:129
- Befund: „Vorher“ und „Nachher“ stehen als `aria-label` auf einem `div` ohne Rolle. Ein generisches Element muss keinen Namen tragen, Browser dürfen das Label verwerfen.
- Beleg: Die Vergleichsspalten sind `<div aria-label="Vorher">` und `<div aria-label="Nachher">` (ChangeSetCard.tsx:129–130), ohne `role`. Der sichtbare Unterschied ist die Anordnung in `.cmp` (ChangeSetCard.module.css:36).
- Auswirkung: Der Vergleichstext kann ohne die Spaltenbezeichnung vorgelesen werden.
- Empfehlung: Den Spalten eine Rolle geben, die Namen erlaubt (`role="region"`), oder die Bezeichnung als Text in die Spalte setzen.
- Vertrauen: wahrscheinlich

## Was hält
Nachricht senden, Freigabe, Speichern und Dialog zu sind per Tastatur erreichbar. Der Composer beschriftet das Feld mit `aria-label="Nachricht an Lotse"` (Composer.tsx:58), Enter sendet, Umschalt+Enter nicht (Zeile 60), „Senden“ ist `type="submit"` mit sichtbarem Text (Zeile 64), „Stoppen“ ebenso (Zeile 63). Anhänge-Entfernen und der Büroklammer-Knopf haben Namen (Zeilen 48 und 54). Das Änderungsset gibt jeder Checkbox einen Namen (ChangeSetCard.tsx:120), „alle“ hängt per `htmlFor` (174), „Anwenden“ und „Ablehnen“ sind Knöpfe mit Text (182–185). Speichern ist `type="submit"` in einem Formular (SettingsView.tsx:99 und 178). `Field` umschließt das Eingabefeld mit `label` (SettingsView.tsx:241). `SecretField` verbindet `label` und Feld per `htmlFor` und den Hinweis per `aria-describedby` (SecretField.tsx:24–29).

Der Dialog nutzt `showModal` und `close` (Dialog.tsx:16–17). Fokusfalle, Escape und Rückgabe des Fokus an das zuvor fokussierte Element kommen vom Browser, sobald `close()` läuft. `aria-labelledby` zeigt auf die `h2` (Zeilen 21 und 26). `aria-modal` steht nicht als Attribut im Markup; ein mit `showModal` geöffnetes `dialog` wird von der HTML-Abbildung als modaler Dialog exponiert. „Schließen“ ist ein Knopf mit Text (Zeile 27). Der Backdrop von App-Schublade und Kontext-Scrim ist nur für die Maus, Schließen geht daneben per Escape und benanntem Knopf.

`Segmented` ist eine `radiogroup` mit `aria-checked`, wechselndem `tabIndex` und Pfeiltasten (Segmented.tsx:7–20). Icons setzen `aria-hidden` und `focusable="false"` (icons.tsx:9). Beide iframes haben Titel: „Aktuelle Seite im Shop“ (PreviewPane.tsx:148) und „Entwurf mit dem Theme des Shops“ (DraftFrame.tsx:52); `hidden` nimmt das inaktive Frame aus der Tab-Reihenfolge. `html` hat `lang="de"` (layout.tsx:24). Navigation und `main` sind Landmarken (SideNav.tsx:59, Workspace.tsx:313, SettingsView.tsx:91). Der Chat-Container ist `role="log"` (ChatLog.tsx:44), eine zusätzliche Liste ist dafür nicht nötig. Arbeitsschritte legen den Zustand zusätzlich in `.visually-hidden` (Steps.tsx:22). `prefers-reduced-motion` setzt Animationen und Transitionen global zurück (globals.css:70–72), zusätzlich in SideNav.module.css:137 und AppShell.module.css:31.

Sichtbarer Fokus: globals.css:57 zeichnet `:focus-visible` mit 2 px `#ff786d`. Knöpfe überschreiben das nicht. Eingaben im Chat, in den Einstellungen und in der Rückfrage ersetzen die Linie durch einen Rand in `#7ebbae` (Composer.module.css:3, Settings.module.css:27, QuestionCard.module.css:9). Das ist ein sichtbarer Wechsel und hier kein Verstoß gegen 2.4.7. Ausnahme ist das Start-Feld, siehe B3. Die 3:1-Fläche der Fokuslinie ist Erfolgskriterium 2.4.13 und AAA, deshalb nicht als AA-Befund gewertet. Auf `#2e2e38` erreicht `#ff786d` 5.22:1.

Bestandene Kontraste, gleiche Formel wie in B4:
- `#1e1e1e` auf `#fbf7f0` = 15.61:1 (Fließtext), auf `#ffffff` = 16.67:1 (Karten), auf `#fff3e2` = 15.22:1 (Kopf der Änderung).
- `#ffffff` auf `#2e2e38` = 13.43:1 (eigene Nachricht, helle Navigationsschrift).
- `--fg-2` `#ffffff` bei Alpha `b8` auf `#2e2e38` → `#c5c5c8` = 7.80:1 (Navigationspunkte).
- `#66666d` auf `#fbf7f0` = 5.33:1 und auf `#ffffff` = 5.70:1 (Nebenzeilen, inaktives Segment).
- `#2e2e38` auf `#ff786d` = 5.22:1 (Primary im Ruhezustand: Senden, Speichern, Freigeben, Neuer Chat, Confirm „Löschen“).
- `#3f7a6b` auf `#ffffff` = 4.99:1 und auf `#fbf7f0` = 4.67:1 (Links und grüne Werte auf Hell, knapp über 4.5).
- `#7ebbae` auf `#2e2e38` = 6.14:1 (Wortmarke). Aktiver Punkt `#7ebbae` auf gemischtem `#394249` (`#7ebbae` bei Alpha `24` auf `#2e2e38`) = 4.69:1.
- `#8a5a00` auf `#fff1d6` = 5.31:1 und auf `#ffffff` = 5.93:1 (Warnung, Badge „Mittel“).
- `#2e2e38` auf `#7ebbae` = 6.14:1 (Badge „einrichten“).
- `#ff786d` auf `#2e2e38` = 5.22:1 (Status „wartet“ in der Navigation).
- Link `#3f7a6b` gegen Fließtext `#1e1e1e` = 3.34:1, also über der 3:1-Grenze von 1.4.1, wenn der umgebende Text die Tinte und nicht `#66666d` ist.

## Nicht geprüft
Kein Browser, kein Screenreader, kein Axe, keine gerenderte Schriftglättung. Breakpoints und die Geometrie der Schublade: Dokument 05. Server-Sicherheit nicht. Alt-Texte und Tastatur im Shop-Dokument im iframe nicht, nur das Markier-Protokoll und die iframe-Titel. Wissen, Protokolle und Search Console nicht Zeile für Zeile. Ob der Verlauf mit `overflow: auto` ohne `tabIndex` (ChatLog.module.css:1) bei `overflow: clip` an der Hülle (AppShell.module.css:9) im Browser einen Fokus-Stopp bekommt. Platzhalterfarben, für die das CSS keinen eigenen Wert setzt.

## Für den zweiten Durchgang
Übernimmt der Accessibility-Tree an der eingeklappten Leiste den Text aus `::after { content: attr(data-tip) }` als Namen, oder sind „Neuer Chat“, die Bereiche und der Status dort stumm?
