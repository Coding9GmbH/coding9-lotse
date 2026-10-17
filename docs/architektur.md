**Deutsch** · [English](en/architecture.md)

# Architektur

Wie Lotse intern funktioniert: Ablauf einer Chat-Runde, Schutzschichten, Datenhaltung, Vorschau, Layout-Veröffentlichung, Shop-Check, Prompts, Mehrsprachigkeit und Tests. Bedienung steht im [Benutzerhandbuch](benutzerhandbuch.md), die Plattform-Schnittstelle in [platform.md](platform.md).

## 1. Überblick

```
Browser ──► proxy.ts ──► Next.js (App Router)
              │            ├─ app/api/**        REST + Chat-Stream (NDJSON)
              │            ├─ app/shop/**       Storefront-Proxy für die Vorschau
              │            └─ Oberfläche        React 19, ein Reducer (lib/chat-state.ts)
              │
              └─ Host-/Origin-Prüfung, Login, Storefront-Pfade → /shop

Chat-Runde:  Agent (Claude SDK | Codex) ──► Werkzeuge (tools.ts) ──► geschützter Lese-Client ──► Shop
                                   │
                                   └─► propose_* / publish_page ──► Änderungsset ──► Freigabe (Mensch)
                                                                                      │
                                              Executor (changes.ts, einziger Schreiber) ◄┘
                                              ├─ Audit-Log + Rückgängig-Schritte (SQLite)
                                              └─ Shop (privilegierter Client)
```

Stack: Next.js 16 · React 19 · TypeScript (strict) · SQLite (`node:sqlite`) · Claude Agent SDK oder OpenAI Codex SDK. Lauffähig als Docker-Image (`output: 'standalone'`) oder `npm run dev`.

## 2. Ablauf einer Chat-Runde

1. **Start.** `POST /api/chat` startet eine Runde und antwortet als NDJSON-Stream, eine JSON-Zeile je Ereignis (`ChatEvent`, Typen in `lib/protocol.ts`). Die Runde läuft **serverseitig weiter**, auch wenn die Verbindung abbricht oder der Chat gewechselt wird. `GET /api/chat` verbindet wieder: erst ein `snapshot` des bisherigen Verlaufs, dann die Live-Ereignisse.
2. **Prompt.** `prompt.ts` setzt den System-Prompt aus `prompts/common/*.md` und `prompts/<plattform>/*.md` zusammen (Platzhalter wie `{{shop}}`), dazu der Styleguide-Block, die Regeln (`rulesPromptBlock`), die Antwortsprache (`REPLY_LANGUAGE`, Abschnitt 12) und bei Kontext ein Ziel-Hinweis (`target-hint.ts`).
3. **Werkzeuge.** Der Agent bekommt die Werkzeuge der Plattform und der Feature-Module (`tools.ts`, `features/`). Lesen läuft über den geschützten Lese-Client; **Schreiben gibt es nicht**, nur Vorschläge (`propose_*`, `publish_page`).
4. **Rückfragen.** `ask_user` erzeugt ein `question`-Ereignis; die Runde wartet, `POST /api/answer` setzt sie fort.
5. **Vorschlag → Freigabe.** Ein Vorschlag wird zu einem `ChangeSet` (Zeilen mit vorher/nachher, Warnungen, Auswahl). Das Werkzeug wartet auf die Entscheidung; `POST /api/approve` übergibt Freigabe und gewählte Zeilen.
6. **Schreiben.** Der Executor schreibt die gewählten Zeilen gedrosselt, hält je Zeile einen Rückgängig-Schritt fest und trägt das Ergebnis ins Audit-Log ein. `POST /api/changesets/undo` nimmt eine Anwendung zurück.
7. **Ende.** `done` schließt die Runde ab; offene Schritte werden in der Oberfläche abgeschlossen.

### Anbieter
- **Claude** (Agent SDK, In-Process-MCP-Server `shop`): Werkzeuge im selben Prozess.
- **Codex** (ChatGPT-Abo): eigene Codex-Werkzeuge (Shell, Dateien, Web) abgeschaltet, Dateizugriff per Profil gesperrt; Shop-Werkzeuge nur über `/api/mcp/<chat>` mit Zufalls-Token je Chat.

### Chats mit Sandbox (Sandbox Coding)
Eine Sandbox hängt an einem normalen Chat der Arbeitsfläche (`code_tasks.chat_id`; höchstens eine nicht abgeschlossene je Chat, `attachedTask`). Angehängt wird sie nur durch den Nutzer (`POST /api/sandbox/tasks` mit `chatId`, aus dem Dialog „Sandbox starten“ oder der Karte des Werkzeugs `start_sandbox`, das die KI in normalen Chats bei eingeschaltetem Sandbox Coding hat und das nur ein `sandbox_offer` zeigt). `Session.taskId` wird zu Beginn jeder Runde neu bestimmt: Mit Sandbox bekommt die Runde **nur** die Sandbox-Werkzeuge – keine Shop-Werkzeuge, kein Live-Shop – und den Prompt aus `prompts/code/01-common.md` + `prompts/code/<vorlage>.md` (mit Arbeitsordner, Titel/Ziel als zitierte Daten). Die KI-Sitzung gehört zu Arbeitsordner und Werkzeugsatz: Wechselt die Sandbox (anhängen, abschließen), startet `agent.ts` eine neue Sitzung mit einer kurzen Zusammenfassung des bisherigen Verlaufs (`agentScope`, `recapOf`). Vor jeder Runde prüft `prepareCodeTurn`, dass Sandbox Coding an ist, wartet auf eine laufende Einrichtung und weckt einen pausierten Container (`sandbox_status`); während der Runde pausiert der Leerlauf-Sweeper ihn nicht. **Claude** arbeitet mit den eigenen Werkzeugen von Claude Code `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TodoWrite` mit `cwd` = Arbeitsordner (Bash, Task, NotebookEdit nie; Web nur mit Internetrecherche); jeder Aufruf läuft durch einen `PreToolUse`-Hook und `canUseTool` (`sandbox/native-tools.ts`: jeder Pfad realpath-geprüft im Arbeitsordner, `.git`/Geheimnisse/`config/jwt` gesperrt, Schreiben nicht in `vendor/`/`node_modules/`, Pfade mit `~` abgelehnt, `Grep` bekommt den Ausschluss der geheimen Dateien als letztes glob angehängt); nach `Edit`/`Write` überträgt ein `PostToolUse`-Hook die Datei in den Container und zeigt sie als `file_change`. **Codex** läuft mit `workingDirectory` = Arbeitsordner, `workspace-write` (Profil: nur der Arbeitsordner beschreibbar, `.git` gesperrt), ohne Netz und ohne eigene Shell; seine Patches (`file_change`) gelten nur, wenn alle Pfade im Arbeitsordner liegen und erlaubt sind; abgelehnte Pfade setzt `revertPaths` zurück (aus `HEAD` bzw. gelöscht), dann bricht die Runde ab; die übrigen werden übertragen. MCP-Werkzeuge (`sandbox/workspace-tools.ts`): `sandbox_bash` (beliebige Befehlszeile per `bash -lc` als `www-data` in `/var/www/html` **im Container**, vorher vollständiger Abgleich, unter der Sperre der Aufgabe, Zeitlimit 120 s/max. 600 s, Ausgabe redigiert und auf 12 KB gekürzt; nach `theme:compile`/`cache:clear` u. a. `preview_reload`), `delete_file`, `git_diff`, `read_sandbox_page`, `get_environment` (Variablen nur mit Namen), `ask_user`, `request_internet` (Karte `internet_request`, wartet wie ein Änderungsset auf die Entscheidung über `/api/approve`; erst die Zustimmung hängt den Container per `sandbox/internet.ts` an das Netz `lotse-sandbox-egress`), `propose_publish`; Codex zusätzlich `list_files`, `read_file`, `search_files`. Claude läuft ohne `settingSources`, mit höchstens 120 Schritten, unter der Kostenbremse. Rechts zeigt `Workspace.tsx` statt der Entwurfsvorschau `SandboxPanel` (Statuszeile, Reiter Vorschau/Einrichtung/Änderungen/Pull Request). Ehemalige getrennte Code-Chats (`mode: 'code'`) sind dadurch Chats mit angehängter Sandbox; ihre alte KI-Sitzung wird nicht fortgesetzt.

**Veröffentlichen** (`server/sandbox/publish.ts`, `POST /api/sandbox/tasks/[id]/publish`): nur per Klick im Reiter „Pull Request“; der Body hat nur Titel (≤ 200) und Beschreibung (≤ 20 000), Branch (`lotse/<slug>-<id>`, beim Anlegen festgelegt) und Basis kommen aus der Aufgabe. Die KI kann mit `propose_publish` nur eine Karte (`publish_proposal`) zeigen. Ablauf: eine Sperre je Aufgabe (`markPublishing`; zweiter Klick, laufende KI-Runde oder „Aufgabe abschließen“ → 409, eine neue KI-Runde wartet), Vorprüfung (Änderungen vorhanden, höchstens 300 Dateien/5 MB je Datei/25 MB, keine Pfade außerhalb, kein `.github/workflows`/`.github/actions` und kein `action.yml` (lokale Actions laufen mit den Secrets des Repositorys), keine geschützten Dateien, keine Symlinks nach außen, Geheimnis-Suche in allen gegenüber dem Basis-Branch neuen Zeilen der Dateien auf der Platte – Tokens, private Schlüssel, Adressen mit Zugangsdaten, alle in Lotse gespeicherten Geheimnisse; Titel und Beschreibung ebenso), Audit `kind: 'code-pr', status: 'started'`, `commitAll` (Autor `Lotse <lotse@users.noreply.github.com>`, angemeldeter Nutzer als `Co-Authored-By` mit Adresse unter `.invalid`), `pushBranch` (nur `refs/heads/lotse/*`, beim erneuten Push `--force-with-lease` auf den gespeicherten `pushed_sha` – ist der Branch auf GitHub gelöscht (etwa nach dem Mergen), wird er ohne Lease und ohne Force neu angelegt –, der sofort nach dem Push gesichert wird), dann ein offener Pull Request mit `head=<owner>:<branch>` wird wiederverwendet (PATCH von Titel und Beschreibung), sonst `POST /pulls` (nicht als Entwurf). `pr_number`, `pr_url` und `pushed_sha` stehen in `code_tasks`, der Fortschritt in `task.publish` (`check` → `commit` → `push` → `pr`, bei Fehler mit deutscher Ursache); ein Neustart macht aus `running` `interrupted` (`interruptStale`). Ein erneuter Versuch ist idempotent (nichts Neues zu committen, Push entfällt, offener Pull Request wird gefunden – auch nach einer verlorenen Antwort auf das Anlegen). Danach Audit-Ergebnis (`status: 'applied'`, Repository, Branch, Link, Dateien; Fehler `failed`, Sperre der Vorprüfung `decision: 'rejected'`), das Chat-Ereignis `pr` (sofort gespeichert) und `GET …/pr` für Status, Entwurf und Checks des Head-Commits (45 s im Speicher zwischengespeichert). Weil gits Ausgaben redigiert werden, prüft die Geheimnis-Suche die Dateien selbst, nicht den Patch, und vergleicht sie byteweise mit dem unredigierten Stand des Basis-Branches (`readBaseBlob`).

## 3. Schutzschichten

| Schicht | Wo | Wirkung |
|---|---|---|
| Host-/Origin-/Kennungsprüfung | `proxy.ts` | Nur freigegebene Hostnamen; Loopback-Namen nur von Loopback (im Container zusätzlich private Gateway-Adressen bei Loopback-Publish); `Origin` muss zu `Host` passen; schreibende Aufrufe brauchen `x-lotse: 1` |
| Login | `proxy.ts` | `LOTSE_PASSWORD` → Basic Auth (zeitkonstanter Vergleich), `/api/mcp/*` hat eigenes Token, `/api/ping` offen |
| Lese-Client mit Freigabeliste | `policy.ts` + Reader je Plattform | Nur freigegebene Entitäten/Beziehungen/Felder; Kunden-, Bestell-, Zahlungs- und Zugangsdaten gesperrt; Bereiche aus den Einstellungen; jeder Zugriff im Zugriffsprotokoll |
| Nur Vorschläge | `tools.ts`, `changes.ts` | Werkzeuge der KI enthalten kein Schreiben; Executor ist die einzige Schreibstelle |
| Freigabe + Audit + Rückgängig | `changes.ts`, `audit.ts` | Alt→Neu, Zeilenauswahl, Protokoll, Undo je Zeile |
| Shop-Schonung | `changes.ts`, Clients | Drosselung (`LOTSE_WRITE_CONCURRENCY`), max. 300 Einträge je Set (`MAX_ITEMS`), Timeouts, Backoff bei 429/503 |
| Zugangsdaten | `db.ts` | AES-256-GCM, Schlüssel `secret.key` im Datenvolume, nie an die KI, aus Fehlertexten entfernt |
| Git und GitHub | `git.ts`, `github.ts` | `git.ts` ist die einzige Stelle, die git startet: ohne Shell, minimale Umgebung, ohne System-/globale Konfiguration, Hooks, fsmonitor und Credential-Helper, nur https. Der GitHub-Token geht nur als `http.<host>/.extraheader` per `GIT_CONFIG_*` in die Umgebung eines einzelnen git-Prozesses, nie in argv, URLs, `.git/config` oder Ausgaben (alles läuft durch `redact()`). Git-Ordner liegt außerhalb des Arbeitsordners; Repository- und Branch-Namen werden geprüft, Push nur nach `refs/heads/lotse/*`, kein Force-Push (nur `--force-with-lease` auf den zuletzt selbst gepushten Stand) |
| Sandbox Coding | `sandbox/env.ts`, `sandbox/runner.ts`, `sandbox/docker-engine.ts`, `sandbox/templates/`, `sandbox/tasks.ts`, `sandbox/jobs.ts`, `sandbox/sync.ts`, `sandbox/native-tools.ts`, `sandbox/offer-tool.ts`, `sandbox/dumps.ts`, `sandbox/reconcile.ts` | Standardmäßig aus (Schalter in den Einstellungen, `LOTSE_SANDBOX=0` hart aus, gesperrt ohne `LOTSE_PASSWORD` bei offener Adresse). `runner.ts` ist die einzige Docker-Schnittstelle (Engine-API über `node:http`, Unix-Socket oder `tcp://` zum Socket-Proxy; Fake für Tests mit `LOTSE_SANDBOX_RUNNER=fake`): feste Operationen, nur Container mit Label `lotse.managed=1`, Spezifikation ohne Host-Pfade/Privilegien. Vorlagen sind Code (nur `dockware`: Image-Muster, Schritte, Befehls-Freigabeliste mit geprüften Argumenten). Umgebung in kv `sandbox`: Image, Limits, Variablen (geheime versiegelt, in `redact()` samt Base64/Hex; Code im Container kann sie lesen, gelten daher als für die KI sichtbar), eigene Einrichtungsbefehle. Aufgaben in der Tabelle `code_tasks` (JSON-Zeile): `jobs.ts` führt die Schritte losgelöst vom Request aus (AbortController und Sperre je Aufgabe, jeder Übergang sofort gespeichert, Protokolle redigiert und auf 200 Zeilen gekürzt), pausiert/weckt Container und hält `LOTSE_SANDBOX_MAX` ein; `sync.ts` überträgt den Arbeitsordner als Tar-Archiv (ohne `.git`/Geheimnisse); `dumps.ts` nimmt Datenbank-Dumps in Teilstücken entgegen (Tabelle `code_dumps` nur mit Metadaten, Datei in `<Daten>/dumps/<id>/data` mit Rechten 0600, nicht im Backup), der Schritt „Datenbank importieren“ streamt sie per Tar in den Container und löscht sie danach auf beiden Seiten; `reconcile.ts` räumt nach einem Neustart auf, pausiert untätige Container und löscht abgelaufene oder verwaiste Dumps |
| Vorschau-Isolation | `app/shop/**`, `DraftFrame.tsx` | Shop-HTML läuft in opakem Origin, siehe unten |

Details und Meldeweg: [SECURITY.md](../SECURITY.md).

## 4. Datenhaltung

Alles liegt im Datenordner (`AICB_DATA`, im Container `/data` als Volume `lotse-data`).

| Datei | Inhalt |
|---|---|
| `aicb.db` | Chats samt Ereignisverlauf (nur der letzte Entwurf behält sein HTML), Audit-Log, Zugriffsprotokoll, Einstellungen und Key-Value-Daten: `styleguide`, `shopcheck_run`, `custom_checks`, `checks_disabled` |
| `knowledge.db` | Wissensbasis: Dokumente, Textabschnitte (BM25-Suche), eigene Regeln (`rules`, mit Bereich und optionaler Kategorie) |
| `secret.key` | Schlüssel für die verschlüsselten Zugangsdaten |
| `staging/`, Dateien | vorgemerkte Bilder und Anhänge, bis zur Freigabe nur lokal |
| `claude/`, `home/` | Sitzungen des Claude Agent SDK |

Sicherung: `make backup`, Einspielen: `make restore FILE=…`. Immer das ganze Volume, sonst sind gespeicherte Zugangsdaten unbrauchbar.

## 5. Vorschau

Drei Darstellungen, alle ohne Zugriff auf Lotse:

| Darstellung | Quelle | Isolation |
|---|---|---|
| **Aktuell** | Shop-Seite über den Proxy `/shop/…` im iframe | `sandbox="allow-scripts allow-forms"` (kein `allow-same-origin`) und CSP `sandbox allow-scripts allow-forms; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'` per Antwort-Header: opaker Origin auch bei direkter Navigation, keine Drittanbieter-Skripte |
| **Sandbox** (Sandbox Coding) | Storefront des Aufgaben-Containers über `/sbx/<id>.<schlüssel>/…` | wie **Aktuell**, dazu `connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'self'` |
| **Entwurf** (einfach) | `renderPreview` in `cms.ts` rendert die Spec im Theme-CSS des Shops | `srcdoc`, `sandbox="allow-scripts"` |
| **Entwurf auf der echten Seite** (Shopware) | echte Zielseite, nur `.cms-sections` ersetzt | wie Entwurf |
| **Entwurf im echten Theme** (Shopify, Magento, OpenMage) | echte Zielseite, veröffentlichtes HTML im Inhaltsbereich (`theme-preview.ts`) | wie Entwurf |

**Proxy `/shop`** (`app/shop/[[...path]]/route.ts`): ruft die Storefront über die interne Adresse ab, schreibt Shop-URLs auf `/shop` um, entfernt Cookies und Frame-Sperren, setzt die CSP, injiziert das Rahmen-Skript (`lib/preview-frame.ts`, Markieren, Scroll, per `postMessage`) und gibt Bilder/Schriften mit CORS frei. Weiterleitungen: gleiche Herkunft als `/shop`-Pfad; gleiche Site (Eltern-Domain, z. B. `stage.` → `www.`) serverseitig gefolgt (höchstens 3 Hops); fremde Domains nie. Wurzelrelative Pfade des Shops (`/theme`, `/media`, `/thumbnail` …) leitet `proxy.ts` an `/shop` um. Gemeinsame Teile (Header, CSP, Umschreiben, Rahmen-Skript) liegen in `server/storefront-proxy.ts`.

**Proxy `/sbx`** (`app/sbx/[task]/[[...path]]/route.ts`, `server/sandbox/preview.ts`): Vorschau der Storefront einer Code-Aufgabe, zum Testen bedienbar (GET/HEAD/POST/PUT/PATCH/DELETE, Body höchstens 2 MB). Das Ziel kommt nur aus Lotses eigenem Eintrag für den Container, den es gestartet hat (Alias im Netz `lotse-sandbox` bzw. der von Docker gemeldete Port auf `127.0.0.1`), nie aus der Anfrage; Anfragen gehen mit `Host: localhost` hinaus, Weiterleitungen gibt Lotse nur innerhalb der Sandbox als `/sbx`-Pfad zurück und folgt ihnen nicht selbst. Die Seite läuft in einem opaken Origin: Der Browser schickt weder Cookies noch Referer. Darum trägt der Pfad einen Schlüssel (HMAC der Aufgaben-ID mit dem Schlüssel im Datenordner), der Formular- und Ajax-Anfragen an die Aufgabe bindet (falscher Schlüssel = 404), Cookies der Sandbox hält Lotse in einer Keksdose pro Aufgabe im Speicher (nie an den Browser), und ein kleines Skript am Anfang von `<head>` ersetzt `document.cookie` (lesbare Cookies aus der Keksdose, Schreiben per `sendBeacon` an `…/__lotse/cookie`) und Web Storage (im Speicher) und hält `fetch`/XHR-Pfade unter dem Präfix. Absolute Adressen `http://localhost` und wurzelrelative Pfade in HTML/CSS werden auf das Präfix umgeschrieben; Anfragen aus einem Vorschau-Stylesheet ohne Präfix leitet `proxy.ts` anhand des Referers in dieselbe Sandbox. Eine pausierte Aufgabe weckt der Aufruf („Umgebung startet …“ mit automatischem Neuladen); jeder Aufruf zählt als Aktivität.

**Entwurf auf der echten Seite** (`real-page.ts`, `platform/shopware/pages.ts`):
1. `previewData` lädt die Zielseite (`/detail/{id}`, `/navigation/{id}`, höchstens 2 Weiterleitungen, nur im Shop, 12 s, 1,5 MB, 60 s Zwischenspeicher).
2. `stripScripts` entfernt Kommentare sowie Skripte und Vorladehinweise fremder Domains; Shop-Skripte bleiben.
3. `extractBlocks` zieht die echten dynamischen Blöcke heraus (Kaufbox, Überschrift, Beschreibung/Bewertungen, Cross-Selling, Produktliste, Filter), auch für Themes mit eigenen Blocktypen (Markup-Erkennung).
4. `renderPreview` setzt Entwurf und echte Blöcke in `.cms-sections` ein (`spliceSections`). Findet es den CMS-Bereich nicht, fällt es auf die einfache Darstellung zurück.
5. Ohne genanntes Ziel wählt `withPreviewDefaults` ein aktives Produkt mit Titelbild.

**Entwurf im echten Theme** (`theme-preview.ts`, HTML-Plattformen): Zielseite über `lookup.entityPaths` (Produkt, Kategorie/Kollektion) bzw. die Startseite bei Landingpages, Abruf wie oben (Weiterleitungen nur im Shop, 12 s, 1,5 MB, 60 s Zwischenspeicher, `stripScripts`, Shop-URLs auf `/shop`). Inhaltsbereich ist `<main>` (Shopify, Magento 2) bzw. `.col-main` (OpenMage); dort setzt `spliceMain` `renderPageParts` vor und hinter den Theme-Inhalt, Landingpages ersetzen ihn (`renderPageHtml`). Produktinhalte ohne `theme-main` (Magento, OpenMage) landen wie beim Veröffentlichen in der Produktbeschreibung (`.product.attribute.description .value` bzw. `.box-description .std`). Protokoll-relative Shop-Adressen (`//host/…`, Shopify) gehen ebenfalls über `/shop`, damit die Theme-Skripte erhalten bleiben. Beim Streaming nur aus dem Zwischenspeicher; ohne Inhaltsbereich die einfache Darstellung.

Streaming: Beim Schreiben schickt der Server `draft_partial` (nur `<body>` per `postMessage`, Theme-CSS und Scroll bleiben), danach `draft` (Dokument neu, Scroll wiederhergestellt). `PREVIEW_VERSION` (`tools.ts`) erzwingt beim Laden eine Neuerzeugung gespeicherter Entwürfe.

## 6. Layouts veröffentlichen (Shopware)

`publish_page` → `buildPublish` (`platform/shopware/pages.ts`) → `buildPublishChangeSet` (`changes.ts`) → Applier `applyPublish`.

1. **Bereich auflösen.** `resolvePublishScope` macht aus `allCategories`, `allProducts`, `productsInCategoryId` usw. feste ID-Listen (Seiten à 500, Deckel `SCOPE_MAX = 1000`). Mehrdeutige Angaben werden abgewiesen. Produkte: aktive Hauptprodukte (Varianten erben). Kategorien: Typ `page`, ohne Wurzel.
2. **Änderungsset.** Bis 15 Ziele eine Zeile je Ziel; darüber eine Zusammenfassung („N, davon M mit eigenem Layout, wird ersetzt“) plus Bereich und 8 Stichproben. Meta-Daten nur bei einer einzelnen Kategorie.
3. **Anwenden.** Layout (`cms-page`) anlegen, dann Zuweisungen mit begrenzter Parallelität; beim ersten Fehler startet kein weiteres Ziel, alles wird zurückgenommen (atomar). Je Ziel ein Undo-Schritt mit dem vorherigen `cmsPageId`.
4. **Zwischenstände.** `trackedUndo` meldet jeden Schritt sofort; ein Absturz verliert kein Rückgängig.

Andere Plattformen veröffentlichen über ihre eigenen Pfade (Shopify: Theme-Vorlagen, Magento/OpenMage: CMS-Seiten bzw. Page Builder), siehe [platform.md](platform.md).

## 7. Styleguide, Regeln, Wissen

- **Styleguide** (`styleguide.ts`): wird aus Theme-Konfiguration, Storefront-CSS, Logo und Texten abgeleitet (`get_brand_signals` → `save_styleguide`) und im Prompt als verbindlicher Block mitgegeben. Er liefert zusätzlich CSS-Variablen (`--sg-*`) für Vorschau und Custom-HTML. Freitexte darin gelten als Daten, nicht als Anweisung.
- **Regeln** (`knowledge.ts`, Tabelle `rules`): Text, Bereich (`all|products|pages|seo`), optional `target` (Kategorie). Der Prompt-Block ist gedeckelt (40 Regeln, 3000 Zeichen), der Rest über `list_rules`. Kategorie-Regeln stehen mit Name und ID im Block; die KI prüft die Zugehörigkeit über die Kategorien des Produkts.
- **Wissen**: Dokumente werden in Abschnitte zerlegt und lokal per BM25 durchsucht (`search_knowledge`, `get_product_knowledge`). Auszüge sind Daten, keine Anweisungen, und erscheinen mit Quelle. Hochgeladene Inhalte werden vor der Aufnahme mit dem Nutzer bestätigt.

## 8. Shop-Check und eigene Prüfungen

- **Register** (`checks.ts`): `registerCheck`/`registerPlatformCheck` mit `id`, `area`, `scopes`, `platforms`, `run`. `run` liest nur über den geschützten Lese-Client des Durchlaufs und liefert `CheckFinding`s mit `fixPrompt`.
- **Durchlauf** (`shopcheck.ts`, `shopcheck-run.ts`): höchstens ein Lauf gleichzeitig, Parallelität 3, 90 s je Prüfung, Fehler je Prüfung isoliert; Ergebnis im kv-Speicher, gültig für denselben Shop und dieselben Bereiche. Veraltet nach 6 Stunden (unvollständige Läufe nach 5 Minuten). Bereiche, die in den Einstellungen gesperrt sind, werden übersprungen.
- **An/Aus**: `checks_disabled` (Liste von IDs); der Durchlauf filtert sie.
- **Eigene Prüfungen** (`lib/custom-checks.ts`, `server/custom-checks.ts`): deklarativ, Bedingungen über feste Felder (`descriptionWords`, `descriptionChars`, `metaTitleChars`, `metaDescriptionChars`, `nameChars`, `price`, `listPrice`, `stock`, `hasImage`), Vergleiche `lt|lte|gt|gte|eq|neq`, Verknüpfung `all|any`. Kein Code, keine freien Abfragen.
- **Neutrale Produktsicht**: `PlatformAdapter.scanProducts(reader)` liefert aktive Produkte als `NeutralProduct` (Deckel 2500 Produkte, bei Shopify 1000; `capped` → „mindestens“). Shopware: `platform/shopware/scan.ts`; Shopify, Magento, OpenMage: `neutralScan` in ihrer `checks.ts`, aus demselben Scan wie die eingebauten Prüfungen (je Durchlauf einmal gelesen). Unbekannte Werte (`null`) treffen nie zu.
- **Chat-Werkzeuge** (`features/shopcheck.ts`): `list_checks`, `create_check` (mit Probelauf: Trefferzahl vor dem Speichern), `update_check`, `set_check_enabled`, `delete_check`. Anlegen, Ändern, Löschen und Ausschalten fragen den Nutzer.
- **API**: `GET /api/shopcheck`, `POST /api/shopcheck` (neu prüfen), `GET /api/shopcheck/checks`, `PUT|DELETE /api/shopcheck/checks/{id}`.

## 9. API-Übersicht

| Pfad | Zweck |
|---|---|
| `POST/GET /api/chat` | Runde starten (NDJSON) / wieder verbinden |
| `GET /api/chats`, `POST /api/reset` | Verlauf, Chat leeren |
| `POST /api/answer`, `POST /api/approve`, `POST /api/changesets/undo` | Rückfrage beantworten, Freigabe, Rückgängig |
| `POST /api/files`, `POST /api/upload` | Anhänge, Bilder |
| `GET/PUT /api/settings`, `GET /api/config`, `GET /api/health`, `GET /api/ping` | Einstellungen, Pfadvorlagen/Version, Status (inkl. Kostenbremse), Healthcheck |
| `GET /api/usage` | KI-Kosten: Monat, heute, letzte 30 Tage, Monatsbudget |
| `GET/PUT /api/styleguide` | Styleguide |
| `/api/knowledge`, `PATCH|DELETE /api/knowledge/docs/{id}`, `POST /api/knowledge/rules`, `PUT|DELETE /api/knowledge/rules/{id}` | Wissensbasis und Regeln |
| `/api/shopcheck`, `/api/shopcheck/checks[/{id}]` | Shop-Check, Prüfungen |
| `GET /api/categories`, `GET /api/products` | Kontext-Auswahl |
| `GET /api/audit`, `GET /api/access-log` | Protokolle |
| `/api/gsc`, `/api/sistrix`, `/api/codex/login` | Search Console, Sistrix, Codex-Anmeldung |
| `GET/PUT/DELETE /api/github`, `POST /api/github/test`, `GET /api/github/repos`, `GET /api/github/branches?repo=` | GitHub-Token (nur „vorhanden“ + Login), Verbindungstest, Repositorys, Branches |
| `GET/PUT /api/sandbox/env`, `POST /api/sandbox/env/check` | Sandbox-Umgebung (Schalter, Image, Limits, Variablen nur maskiert, eigene Befehle; Docker wird nur bei eingeschalteter Sandbox angesprochen), „Umgebung prüfen“ als NDJSON mit Fortschritt (403 solange aus) |
| `POST /api/sandbox/dumps`, `GET/PUT/DELETE /api/sandbox/dumps/{id}` (`PUT ?offset=`), `POST …/{id}/complete`, `POST /api/sandbox/tasks/{id}/dump` | Datenbank-Dump: Upload ankündigen (Name, Größe ≤ `LOTSE_DUMP_MAX_MB`), Teilstücke ≤ 16 MB roh an der bisherigen Länge (sonst 409 mit `received`, optional `x-chunk-sha256`), abschließen (Größe, SHA-256, gzip/SQL geprüft, sonst 415/422 und gelöscht), verwerfen; „Datenbank ersetzen“ für eine Aufgabe. Antworten enthalten nur Metadaten, nie den Inhalt |
| `GET/POST /api/sandbox/tasks`, `GET/DELETE /api/sandbox/tasks/{id}`, `POST …/{id}/start\|stop\|pause\|resume\|finish`, `GET …/{id}/events`, `GET …/{id}/diff` | Sandboxes: an einen Chat anhängen (`chatId`, eine je Chat, 409 sonst; prüft vorher den Repository-Zugriff; Zeile `sandbox_attached` im Chat), Einrichtung starten/ab Schritt wiederholen, stoppen, pausieren, fortsetzen, abschließen (löst die Sandbox vom Chat), löschen (nur der Eintrag, der Chat bleibt; alle Aktionen im Audit); Ereignisse als NDJSON (Stand, dann live); „Änderungen“ gegen den Basis-Branch (redigiert, ohne Geheimnisse, höchstens 400 KB). Der Chat läuft wie jeder andere über `POST /api/chat`; `GET /api/chats/{id}` und die Chat-Liste nennen die angehängte Sandbox (`taskId`), das Löschen eines Chats schließt sie ab |
| `GET /api/seo`, `PUT /api/seo/marks`, `GET\|POST\|PUT /api/seo/impact` | SEO-Bereich: Hebel, Erledigt/Ignoriert, Wirkung angewendeter Änderungen (gespeichert / jetzt messen / ausblenden) |
| `/api/mcp/{chat}` | MCP-Endpunkt für Codex (Token je Chat) |
| `GET /shop/**` | Storefront-Proxy (nur GET) |

## 10. Tests und Qualität

- `npm run check`: Typecheck (`next typegen && tsc`), ESLint, Tests.
- Tests (`node:test`, Struktur wie `src/`): reine Logik, Executor gegen Fake-Shopware, Plattform-Adapter gegen Fakes (`tests/support/`: Shopify, Magento, OpenMage), Proxy- und Reducer-Tests.
- CI (`.github/workflows/docker.yml`): Typecheck, Lint, Tests auf Pull Requests und `main`; Image-Build und Smoke-Test bei `main`; Veröffentlichung bei Tag `vX.Y.Z`.

## 11. Erweitern

| Vorhaben | Wo |
|---|---|
| Neuer Blocktyp | `BLOCKS` in `cms.ts` + Vorschau-Renderer; der Agent bekommt den Katalog automatisch |
| Neue Prüfung (eingebaut) | `registerCheck` in einem Feature-Modul bzw. `registerPlatformCheck` im Adapter; Titel in `lib/custom-checks.ts` (`builtinTitle`) ergänzen |
| Neues Feld für eigene Prüfungen | `CHECK_FIELDS` + `fieldValue` in `lib/custom-checks.ts`, Wert in `NeutralProduct` und in allen vier `scanProducts` |
| Neues Feature-Modul | `features/<name>.ts` (`Feature`) in `features/index.ts` eintragen; Werkzeugnamen in `lib/labels.ts` |
| Neue Plattform | [platform.md](platform.md), Abschnitt 11 |
| Neue Sprache | `LOCALES` und `LOCALE_NAMES` in `lib/i18n/locales.ts`, Wörterbuch je Namensraum in `lib/i18n/messages/`, `INTL_LOCALE`, `REPLY_LANGUAGE` in `server/prompt.ts` |

### Gemeinsame Bausteine

Vor einem neuen Helfer hier nachsehen; Kopien derselben Logik in mehreren Modulen vermeiden.

| Zweck | Baustein |
|---|---|
| HTML-Text: Blöcke entfernen, Text extrahieren, Entities dekodieren, Attribut lesen (linear, ReDoS-sicher) | `lib/text.ts`: `stripBlocks`, `htmlToText`, `decodeEntities`, `attr`, `HEADINGS` |
| HTML escapen, HTML entfernen | `lib/format.ts`: `esc`, `stripHtml` |
| Fremdes HTML in Shop-Inhalte übernehmen (Allowlist) | `server/html-sanitize.ts`: `sanitizeHtml`, `safeUrl` |
| Shop-HTTP mit Parallelitätsgrenze und 429/503-Retry | `server/shop-http.ts`: `createLimiter`, `shopFetch`; `sleep` aus `server/retry.ts` |
| Shopseiten abrufen, jede Weiterleitung geprüft (SSRF) | `server/storefront.ts`: `fetchShopPage`, `assertShopUrl` |
| Antworten/Bodies mit Größengrenze lesen | `server/http.ts`: `readLimited`, `readBodyLimited`; `server/media.ts`: `readCapped`, `MAX_IMAGE_BYTES` |
| Dateien auswerten (PDF, DOCX, XLSX mit Zip-Bomb-Schutz) | `server/knowledge-text.ts`: `extractSegments` |
| Listen aufteilen, Fehlertext | `server/util.ts`: `chunks`, `errMsg` |
| Werkzeuge: Ergebnis, Fehler, Limit | `server/tool-kit.ts`: `ok`, `guard`, `lim` |
| Magento/OpenMage: Apply-Helfer, Linkprüfung | `platform/magento/kit.ts`, `platform/magento/grouped.ts`, `checkLinksWith` in `platform/magento/links.ts` |

## 12. Mehrsprachigkeit / Internationalization

Oberfläche und KI-Antworten gibt es auf Deutsch (Standard) und Englisch. Alles liegt in `src/lib/i18n/`:

| Datei | Aufgabe |
|---|---|
| `locales.ts` | `LOCALES` (`'de' \| 'en'`), `DEFAULT_LOCALE = 'de'`, `LOCALE_NAMES`, `INTL_LOCALE` (BCP-47-Tag für `Intl`: Datum, Zahlen), Cookie `LOCALE_COOKIE = 'lotse_lang'`; `resolveLocale` (Cookie vor `Accept-Language` vor Standard) und `requestLocale(req)` für Route-Handler |
| `messages/<ns>.ts` | typisierte Wörterbücher je Namensraum (`common`, `chat`, `settings` …): `export const de = {…}` und `export const en: typeof de = {…}`. Der Typ erzwingt dieselben Schlüssel; Texte mit Platzhaltern oder Plural sind Funktionen (`t.common.minutesAgo(5)`). `tests/lib/i18n.test.ts` prüft, dass beide Sprachen dieselbe Form haben |
| `index.ts` | `messages(locale)` → `Messages`, `formatNumber(n, locale)` |
| `I18nProvider.tsx` | Client-Kontext: `useT()` (Wörterbuch), `useLocale()`, `useI18n()` (mit `setLocale`). Ein Wechsel setzt das Cookie, `<html lang>` und lädt die Server-Teile per `router.refresh()` neu |
| `server.ts` | `getLocale()`/`getMessages()` für Server-Komponenten und `generateMetadata` (Cookie, sonst `Accept-Language`) |

Der Umschalter (`components/i18n/LanguageSwitch.tsx`) steht in den Einstellungen und in der seitlichen Navigation. Es gibt keine Sprach-Präfixe in den URLs; Server und Client rendern mit derselben Sprache aus dem Cookie.

**KI-Antworten.** `POST /api/chat` bestimmt die Sprache mit `requestLocale(req)` und setzt sie als `Session.locale`. `buildSystem(kind, locale)` (`server/prompt.ts`) hängt den passenden `REPLY_LANGUAGE`-Block an: Chat-Antworten, Rückfragen und Begründungen in der Sprache der Oberfläche; Inhalte für den Shop in der Sprache, die der Nutzer bzw. der Shop/Verkaufskanal verlangt. Die Prompts in `prompts/` bleiben bewusst deutsch (interne Anweisungen an das Modell, keine Nutzertexte).

Nicht übersetzt werden Texte, die vom Server oder aus dem Shop kommen (Fehlertexte der API, Ausgaben der KI, Shop-Daten).
