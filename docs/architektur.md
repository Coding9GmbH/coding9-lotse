# Architektur

Wie Lotse intern funktioniert: Ablauf einer Chat-Runde, Schutzschichten, Datenhaltung, Vorschau, Layout-Veröffentlichung, Shop-Check, Prompts und Tests. Bedienung steht im [Benutzerhandbuch](benutzerhandbuch.md), die Plattform-Schnittstelle in [platform.md](platform.md).

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
2. **Prompt.** `prompt.ts` setzt den System-Prompt aus `prompts/common/*.md` und `prompts/<plattform>/*.md` zusammen (Platzhalter wie `{{shop}}`), dazu der Styleguide-Block, die Regeln (`rulesPromptBlock`) und bei Kontext ein Ziel-Hinweis (`target-hint.ts`).
3. **Werkzeuge.** Der Agent bekommt die Werkzeuge der Plattform und der Feature-Module (`tools.ts`, `features/`). Lesen läuft über den geschützten Lese-Client; **Schreiben gibt es nicht**, nur Vorschläge (`propose_*`, `publish_page`).
4. **Rückfragen.** `ask_user` erzeugt ein `question`-Ereignis; die Runde wartet, `POST /api/answer` setzt sie fort.
5. **Vorschlag → Freigabe.** Ein Vorschlag wird zu einem `ChangeSet` (Zeilen mit vorher/nachher, Warnungen, Auswahl). Das Werkzeug wartet auf die Entscheidung; `POST /api/approve` übergibt Freigabe und gewählte Zeilen.
6. **Schreiben.** Der Executor schreibt die gewählten Zeilen gedrosselt, hält je Zeile einen Rückgängig-Schritt fest und trägt das Ergebnis ins Audit-Log ein. `POST /api/changesets/undo` nimmt eine Anwendung zurück.
7. **Ende.** `done` schließt die Runde ab; offene Schritte werden in der Oberfläche abgeschlossen.

### Anbieter
- **Claude** (Agent SDK, In-Process-MCP-Server `shop`): Werkzeuge im selben Prozess.
- **Codex** (ChatGPT-Abo): eigene Codex-Werkzeuge (Shell, Dateien, Web) abgeschaltet, Dateizugriff per Profil gesperrt; Shop-Werkzeuge nur über `/api/mcp/<chat>` mit Zufalls-Token je Chat.

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
| **Entwurf** (einfach) | `renderPreview` in `cms.ts` rendert die Spec im Theme-CSS des Shops | `srcdoc`, `sandbox="allow-scripts"` |
| **Entwurf auf der echten Seite** (Shopware) | echte Zielseite, nur `.cms-sections` ersetzt | wie Entwurf |

**Proxy `/shop`** (`app/shop/[[...path]]/route.ts`): ruft die Storefront über die interne Adresse ab, schreibt Shop-URLs auf `/shop` um, entfernt Cookies und Frame-Sperren, setzt die CSP, injiziert das Rahmen-Skript (`lib/preview-frame.ts`, Markieren, Scroll, per `postMessage`) und gibt Bilder/Schriften mit CORS frei. Weiterleitungen: gleiche Herkunft als `/shop`-Pfad; gleiche Site (Eltern-Domain, z. B. `stage.` → `www.`) serverseitig gefolgt (höchstens 3 Hops); fremde Domains nie. Wurzelrelative Pfade des Shops (`/theme`, `/media`, `/thumbnail` …) leitet `proxy.ts` an `/shop` um.

**Entwurf auf der echten Seite** (`real-page.ts`, `platform/shopware/pages.ts`):
1. `previewData` lädt die Zielseite (`/detail/{id}`, `/navigation/{id}`, höchstens 2 Weiterleitungen, nur im Shop, 12 s, 1,5 MB, 60 s Zwischenspeicher).
2. `stripScripts` entfernt Kommentare sowie Skripte und Vorladehinweise fremder Domains; Shop-Skripte bleiben.
3. `extractBlocks` zieht die echten dynamischen Blöcke heraus (Kaufbox, Überschrift, Beschreibung/Bewertungen, Cross-Selling, Produktliste, Filter), auch für Themes mit eigenen Blocktypen (Markup-Erkennung).
4. `renderPreview` setzt Entwurf und echte Blöcke in `.cms-sections` ein (`spliceSections`). Findet es den CMS-Bereich nicht, fällt es auf die einfache Darstellung zurück.
5. Ohne genanntes Ziel wählt `withPreviewDefaults` ein aktives Produkt mit Titelbild.

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
| `GET/PUT /api/settings`, `GET /api/config`, `GET /api/health`, `GET /api/ping` | Einstellungen, Pfadvorlagen/Version, Status, Healthcheck |
| `GET/PUT /api/styleguide` | Styleguide |
| `/api/knowledge`, `PATCH|DELETE /api/knowledge/docs/{id}`, `POST /api/knowledge/rules`, `PUT|DELETE /api/knowledge/rules/{id}` | Wissensbasis und Regeln |
| `/api/shopcheck`, `/api/shopcheck/checks[/{id}]` | Shop-Check, Prüfungen |
| `GET /api/categories`, `GET /api/products` | Kontext-Auswahl |
| `GET /api/audit`, `GET /api/access-log` | Protokolle |
| `/api/gsc`, `/api/codex/login` | Search Console, Codex-Anmeldung |
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
