# Review: Datenschutz
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung von Prompts, Server-Pfaden und Oberfläche, ohne Laufzeit.

## Urteil
Gelb, für beide vorgesehenen Betriebsmodelle. Lokal (Docker-Compose bindet `127.0.0.1`, Passwort optional) und auf einem Server mit `LOTSE_PASSWORD` gilt dasselbe: Produkttexte, CMS-HTML, Wissensauszüge, Suchanfragen und GPSR-Kontaktdaten gehen im Chat an Anthropic oder OpenAI, die Oberfläche sagt das nicht, und „Alles bleibt lokal“ bei der Wissensbasis ist falsch. Das Passwort schützt nur, wer die lokale Oberfläche öffnet; es stoppt weder diese Übertragung noch löscht es Bestände beim Anbieter. Rot wäre der Betrieb, wenn der Prozess ohne Passwort nicht nur auf dem Loopback hängt: dann lägen Chats, Audit und Wissensbasis im Netz. Zugangsdaten und Kunden- oder Bestelldatensätze habe ich in den gelesenen Aufrufen an den Modellanbieter nicht gesehen; die Shop-Client-Sperre selbst ist Dokument 02.

## Befunde
### B1 — Schwere: hoch
- Ort: src/components/knowledge/KnowledgeView.tsx:52
- Befund: Die Wissensseite sagt „Alles bleibt lokal in Lotse.“ Der Prompt sagt dasselbe und ergänzt nur, nichts davon gehe in den Shop. Regeln stehen im System-Prompt jedes Chats, Suchtreffer kommen als Werkzeugtext zurück. Beides ist der Request an Claude (`query`) bzw. Codex (`developer_instructions` plus Tool-Ergebnis). Ein Upload prüft den Inhalt nicht; der Hinweis „keine Kunden- oder Bestelldaten“ ist nur Text.
- Beleg: `KnowledgeView.tsx:52`; `prompts/common/19-wissen.md:2` und `:5`; `src/server/prompt.ts:43` hängt `rulesPromptBlock()` an `buildSystem`; `src/server/knowledge.ts:194` schreibt den Regeltext in diesen Block; `src/server/features/wissen.ts:83` gibt die Auszüge über `ok(wrapHits(...))` zurück; `src/server/agent.ts:77-80` übergibt `systemPrompt: buildSystem(...)` an `query`; `src/server/agent-codex.ts:21` übergibt `buildSystem` als `instructions`, `src/server/codex.ts:61` setzt daraus `developer_instructions`. `src/app/api/knowledge/route.ts:22-23` speichert den extrahierten Dateitext ohne Inhaltsfilter.
- Auswirkung: Datenblätter, PDFs und Regeln verlassen den Rechner zum Modellanbieter, obwohl die Oberfläche das Gegenteil sagt. Lädt jemand doch eine Kundenliste hoch, liegt sie lokal und geht beim nächsten `search_knowledge` mit.
- Empfehlung: Den Satz auf den Speicherort begrenzen und den Anbieter nennen, oder Auszüge und Regeln nicht in den Modell-Request legen. Kunden- und Bestelldokumente technisch ablehnen, nicht nur beschreiben.
- Vertrauen: sicher

### B2 — Schwere: hoch
- Ort: src/server/platform/shopware/tools.ts:71
- Befund: Produktbeschreibung und CMS-Slot-HTML (je Wert gekürzt auf 1500 Zeichen) sowie bis zu 6000 Zeichen Storefront-Text gehen als Werkzeugergebnis an das Modell. Die Prompts sagen der KI, dass sie Produkte und Einkaufswelten sieht. Sie sagen nicht, dass der Inhalt den Rechner verlässt. Die Einstellungen sagen nur, Zugangsdaten gingen nie an die KI. Bild-Prompts gehen zusätzlich an `https://api.openai.com/v1/images/generations`, wenn ein OpenAI-Schlüssel gesetzt ist. GPSR-Felder (Anschrift, E-Mail oder URL, Name der verantwortlichen Person) liefert `get_gpsr_status` im Feld `values` mit; `prompts/shopware/16-recht.md` verlangt das von der KI, die Einstellungen nennen es nicht.
- Beleg: `src/server/platform/shopware/tools.ts:71` (`description: p.translated?.description`); `:104-109` (Slot-`config`, Schnitt bei 1500 Zeichen); `src/server/storefront.ts:61` und `:77` (`text` bis 6000 Zeichen), aufgerufen aus `tools.ts:122-124`; `src/server/agent.ts:77-80` und `src/server/agent-codex.ts:45` (`runStreamed(prompt)`); `prompts/common/02-3-datenschutz-regeln.md:4`; `prompts/shopware/02-2-freigegebene-daten.md:1`; `src/components/settings/SettingsView.tsx:93`; `src/server/media.ts:216-219`; `src/server/features/recht-rules.ts:33` und `:46`; `src/server/features/recht.ts:469`. `prompts/common/02-1-datenschutz.md` ist nur die Überschrift.
- Auswirkung: Im reinen Localhost-Betrieb und hinter dem Passwort gleich: Shop-Inhalte und personenbezogene Herstellerangaben liegen beim Anbieter, ohne Frist in diesem Repo und ohne Satz in der Oberfläche. Wer den Einstellungssatz als „die KI bekommt keine Shop-Daten“ liest, irrt.
- Empfehlung: In den Einstellungen beim Anbieter nennen, welche Inhalte (Chat, Produkttexte, CMS-HTML, GPSR, Bild-Prompt) den Rechner verlassen, und dass Löschen in Lotse die Kopie beim Anbieter nicht trifft.
- Vertrauen: sicher

### B3 — Schwere: mittel
- Ort: prompts/common/18-gsc.md:7
- Befund: Der Prompt behauptet, Suchanfragen seien nur Begriffe und keine Personendaten. `gsc_performance` gibt die Roh-Anfrage (`keys[0]`) an die KI zurück, ohne Filter. Die Oberfläche sagt nur „Lotse liest nur.“ Der private Schlüssel des Service-Kontos geht nicht an Browser oder KI; E-Mail, Projekt und `updatedAt` schon an den Browser.
- Beleg: `prompts/common/18-gsc.md:7`; `src/server/features/gsc.ts:148-150`; `src/components/settings/GscSettings.tsx:56` und `:74`; `src/server/features/gsc-google.ts:50-52` (`gscPublic` ohne `private_key`); `:59` speichert den Schlüssel nur über `seal`.
- Auswirkung: Anfragen, in denen Namen, Adressen oder Bestellnummern stehen, gehen an den Modellanbieter. Der Prompt weist die KI an, sie nicht als Personendaten zu behandeln.
- Empfehlung: Den Satz streichen oder Anfragen vor der Übergabe kürzen und in der Oberfläche sagen, dass die Begriffe an die KI gehen. `updatedAt` ist nur ein lokales Speicherdatum, kein Kunden-Zugangsdatum.
- Vertrauen: sicher

### B4 — Schwere: mittel
- Ort: src/app/api/reset/route.ts:13
- Befund: Es gibt keinen Löschweg für Chats, Audit, Zugriffsprotokoll, Staging, Wissensbasis und Codex-Anmeldung zusammen. `POST /api/reset` ruft nur `dropSession` auf; der Kommentar sagt, der Verlauf bleibe auf der Platte. Die Oberfläche ruft die Route nicht auf. Chat löschen entfernt die Chat-Zeile und `changeset_runs`, nicht Audit, Access-Log, Staging, Dateien oder `data/codex`. Abmelden löscht nur `auth.json`. Staging-Bilder werden geschrieben und nirgends entfernt. Audit und Access-Log haben kein `DELETE` und keine Frist. Das Audit speichert Vorher/Nachher und Undo; die Protokolltabelle zeigt sie nicht, `GET /api/audit` liefert sie.
- Beleg: `src/app/api/reset/route.ts:9-13`; `src/server/sessions.ts:57`; `src/app/api/chats/[id]/route.ts:18`; `src/server/db.ts:57` und `:69-74` (nur Insert und List); `src/server/sessions.ts:213` und `:224`; `src/server/media.ts:101-109`; `src/server/codex.ts:13-14` und `:129-131`; `src/components/settings/LogsPanel.tsx:97-100`; `src/app/api/audit/route.ts:6`. `docker-compose.yml:21` nennt Claude-Sitzungen im Volume; ein Löschen von `data/claude` gibt es in den gelesenen Pfaden nicht.
- Auswirkung: Lokal bleiben Texte, Bilder und Protokolle ohne Ende auf dem Rechner. Hinter dem Passwort sieht jeder, der es kennt, dieselben Altbestände. Die Kopie beim Modellanbieter trifft keiner dieser Schritte.
- Empfehlung: Einen echten Löschlauf bauen (Chat, Audit, Access-Log, Staging, Dateien, Codex- und Claude-Verzeichnis) oder in der Oberfläche sagen, dass Löschen nur die Chat-Zeile trifft und nichts davon befristet ist. `reset` nicht so nennen, solange es nur den Speicher leert.
- Vertrauen: sicher

### B5 — Schwere: mittel
- Ort: src/app/layout.tsx:27
- Befund: Jede Seite lädt Satoshi von Fontshare. Inter liegt lokal, `globals.css` hat keine externe URL. Ein Hinweis in der Oberfläche fehlt. Next-Telemetrie ist im Image aus (`NEXT_TELEMETRY_DISABLED=1`); `.env.example` und `npm run dev` setzen das nicht.
- Beleg: `src/app/layout.tsx:26-27`, URL `https://api.fontshare.com/v2/css?f[]=satoshi@500,700&display=swap`, dazu `preconnect` auf `https://api.fontshare.com` in Zeile 26; `src/app/layout.tsx:11`; `Dockerfile:13` und `:44`. `.env.example` enthält keine Telemetrie-Variable.
- Auswirkung: Auch bei reinem Localhost geht die IP des Browsers an Fontshare. Auf einem Server mit Passwort gilt das für jeden, der die Oberfläche öffnet. Shop-Inhalte stehen in dieser URL nicht.
- Empfehlung: Satoshi wie Inter aus dem Repo laden.
- Vertrauen: sicher

### B6 — Schwere: niedrig
- Ort: src/server/platform/magento/promo.ts:58
- Befund: Die Freigabe-Prompts sagen bei Gutscheinen „nur Zählwerte, keine Einlöser“. Gelesene Aufrufe liefern den Code-String und ein paar ungenutzte Beispielcodes. Einlöser (Kunden, Bestellungen, `payload`) kommen nicht mit. Die sichtbare Protokolltabelle zeigt keine Schlüssel. Der Claude-Chat zeigt die ersten 300 Zeichen eines Werkzeugergebnisses ohne `redact`; Codex schwärzt diese Vorschau. Fehlertexte laufen über `fail` und `redact`. Ein Shop-Passwort in einem Erfolgsergebnis habe ich nicht gesehen.
- Beleg: `prompts/magento/02-2-freigegebene-daten.md:1`; `prompts/shopware/02-2-freigegebene-daten.md:1`; `src/server/platform/magento/promo.ts:58-60`; `src/server/features/promotionen.ts:565-577` und `:621-625`; `src/server/agent.ts:118`; `src/server/agent-codex.ts:64`; `src/server/tool-kit.ts:7-8`; `src/server/settings.ts:133-137`; `src/components/settings/LogsPanel.tsx:79`. `src/app/api/settings/route.ts:39` schreibt ins Audit nur Feldnamen.
- Auswirkung: Der Code selbst ist kein Personendatensatz, aber der Prompt verspricht weniger, als der Aufruf zurückgibt. Ein Geheimnis in den ersten 300 Zeichen eines Claude-Ergebnisses stünde im Chat; die Protokolltabelle zeigt es nicht.
- Empfehlung: Prompt und Rückgabe angleichen (Codes ja oder nein). Die Claude-Vorschau wie bei Codex durch `redact` schicken.
- Vertrauen: sicher

## Was hält
`publicSettings` gibt Shop-Passwort, Client-Secret, Anthropic- und OpenAI-Schlüssel nicht zurück, nur `hasPassword` und ähnliche Flags (`src/server/settings.ts:73-80`). Der Test prüft, dass das Passwort nicht im JSON steht (`src/server/settings.test.ts:28-30`). `aiEnv` lässt `SHOPWARE_PASSWORD` und `OPENAI_API_KEY` nicht in den Claude-Prozess (`src/server/settings.ts:118-129`). `codexEnv` setzt eine kurze Umgebung ohne Shop-Variablen (`src/server/codex.ts:39-45`). Der GSC-Privatschlüssel steht nicht in `gscPublic`. `check_legal_pages` gibt Probleme zurück, nicht den Impressumstext (`src/server/features/recht-rules.ts:290-301`). Shopware schwärzt Schlüssel wie `email` vor der weiteren Verwendung (`src/server/policy.ts:44-59`); Magento entfernt Attribute, deren Code dazu passt (`src/server/platform/magento/reader.ts:55-63`). Ob jede Plattform das für jeden Aufruf hält, ist Dokument 02. Der Gerätecode der Codex-Anmeldung ist absichtlich in der Oberfläche (`src/components/settings/CodexLogin.tsx:59`). Compose veröffentlicht den Port auf `127.0.0.1` (`docker-compose.yml:18-19`). Mit `LOTSE_PASSWORD` verlangt der Proxy Basic-Auth (`src/proxy.ts:42-44`).

## Nicht geprüft
Keine Requests an Anthropic, OpenAI, Google oder Fontshare. Speicherdauer bei diesen Anbietern. Ob das Claude-SDK unter `data/claude` Transkripte schreibt (der Compose-Kommentar behauptet Sitzungen, ein Löschpfad fehlt). Shopify-Gutscheinlesen nur überflogen, nicht Zeile für Zeile wie Magento und Shopware. Verschlüsselung von `seal` (Dokument 01). Ob `next dev` ohne `NEXT_TELEMETRY_DISABLED` telemetriert. Kunden- und Bestellsperre der Shop-Clients außer dort, wo ein Datenschutzsatz mehr verspricht als der gelesene Aufruf.

## Für den zweiten Durchgang
Soll „Alles bleibt lokal“ nur heißen, dass die Wissensbasis nicht in den Shop geschrieben wird, oder muss die Oberfläche sagen, dass Auszüge und Regeln an Anthropic bzw. OpenAI gehen?
