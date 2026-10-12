# Review: Tests und CI
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung von Workflow, Scripts, Makefile und den genannten Tests; die Suite wurde nicht ausgeführt.

## Urteil
Ampel gelb. Der einzige Workflow-Job `check` lässt nichts absichtlich durchfallen: kein `allow_failure`, kein `continue-on-error`, kein `|| true`, kein `--exit-zero`, und in den Tests kein `skip`, `only` oder `todo`. Ein PR führt Typecheck, ESLint, `npm test`, Build und einen Smoke-Lauf aus; schlägt einer davon fehl, bleibt der Job rot. Gelb, weil zwei Sicherheitsgrenzen dabei nicht rot werden: die PHP-Tests des OpenMage-Moduls laufen gar nicht, und die Codex-Sperre hat keinen Test. Eine gelockerte Freigabeliste wird nur rot, wenn sie eine der fest verdrahteten Negativproben trifft.

## Befunde
### B1 — Schwere: hoch
- Ort: .github/workflows/docker.yml:31
- Befund: `integrations/openmage/tests/unit.php` und `tests/smoke.php` kommen im Job `check` nicht vor. `npm test` nimmt nur `src/**/*.test.ts` und `test-support/**/*.test.ts`. `make check` ruft dasselbe auf. Eine gelockerte IP-Freigabeliste, eine neue Kunden-Route oder ein aufgeweichter SSRF-Schutz im Modul bleiben in der Pipeline grün.
- Beleg: Der Job endet nach `npm test`, Build und Smoke (docker.yml:29–40), ohne `php`. `unit.php` prüft Freigabeliste, `isPublicIp` und die Routentabelle (`unit.php:27–49`, `unit.php:100–112`) und beendet sich mit Exit 1 bei Fehlern (`unit.php:116`). `smoke.php` verlangt ein laufendes OpenMage und ein Token (`smoke.php:14–18`). Beides ist nur in der Modul-README als Handbefehl beschrieben, nicht im Workflow.
- Auswirkung: Der Adapter in `src/server/platform/openmage/` ist durch Node-Tests abgedeckt, das Modul auf dem Shop nicht. Ein PR kann die Routentabelle erweitern, ohne dass GitHub rot wird.
- Empfehlung: `php integrations/openmage/tests/unit.php` in den Job `check` aufnehmen. `smoke.php` bleibt manuell, solange keine Instanz in der Pipeline steht.
- Vertrauen: sicher

### B2 — Schwere: hoch
- Ort: src/server/codex.ts:58
- Befund: Die Codex-Sperre (abgeschaltete Werkzeuge, `approval_policy`, Dateisystem `deny`, `sandboxMode: 'read-only'`, Abbruch bei Befehl, Datei oder Websuche) hat keinen Test. Entfernen oder Aufweichen lässt `npm test` grün.
- Beleg: `codexConfig` setzt `approval_policy: 'never'`, `features` aus `DISABLED_FEATURES` und `permissions.lotse.filesystem={":root"="deny"}` (`codex.ts:49–82`). `agent-codex.ts:25–26` setzt `sandboxMode: 'read-only'` und `networkAccessEnabled: false`; `agent-codex.ts:66–69` bricht ab, wenn `command_execution`, `file_change` oder `web_search` auftaucht. In `**/*.test.ts` gibt es keine Treffer auf `codexConfig`, `DISABLED_FEATURES`, `sandboxMode` oder `permissions.lotse`. `mcp.test.ts:16–24` prüft nur das MCP-Token, `sessions-run.test.ts:10` nur den Fehler „nicht angemeldet“. `src/app/api/codex/login/route.ts` startet den Gerätecode und wird von keinem Test importiert.
- Auswirkung: Die Kommentarzeile `codex.ts:55` („geprüft“) ist kein Beleg. Eine gelockerte Sperre fällt weder lokal bei `npm test` noch in CI auf.
- Empfehlung: Einen Test, der `codexConfig` und die Thread-Optionen ohne Codex-Binary festnagelt, und einen, der den Abbruchpfad in `runCodex` mit einem nachgebauten Ereignis trifft.
- Vertrauen: sicher

### B3 — Schwere: mittel
- Ort: src/server/policy.test.ts:6
- Befund: Die Freigabelisten sind nicht eingefroren, sondern an einzelnen verbotenen Namen geprüft. Eine Erweiterung um einen nicht genannten Eintrag bleibt grün. Bei Magento und OpenMage bleibt sie auch grün, wenn ein schon von `DENY_PATH` geblockter Pfad zusätzlich auf die Allow-Liste kommt.
- Beleg: Shopware: `policy.test.ts:6–9` und `:43–47` erwarten nur, dass `customer`, `order`, `GET /user` und `POST /_info/version` werfen. `GET_ALLOW` und `SCOPES` (`policy.ts:6–12`, `policy.ts:35`) werden nicht als Menge verglichen. Ein neues Entity oder ein neues GET-Muster außer `/user` hat keinen Gegentest. Shopify: `shopify.test.ts:140–143` lehnt feste Dokumente ab; `customers` trifft zusätzlich `DENIED_TERMS` (`reader.ts:85–100`). Ein neues Root-Feld, das diese Begriffe nicht enthält, scheitert an keinem Test. Magento und OpenMage prüfen erst `DENY_PATH`, dann `ALLOW` (`magento/reader.ts:85–87`, `openmage/reader.ts:66–70`). Die Tests (`magento.test.ts:103–105`, `openmage.test.ts:96–97`) akzeptieren jede Verweigerung, die `/ZUGRIFF VERWEIGERT/` trifft.
- Auswirkung: Shopware wird rot, wenn `customer` auf die Entity-Liste kommt (`policy.test.ts:8` ruft `checkSearch` ohne weitere Kriterien). Shopify, Magento und OpenMage bleiben grün, wenn derselbe Name nur auf die Allow-Liste kommt und `DENIED_TERMS` oder `DENY_PATH` ihn weiter wirft. Eine neue, harmlos benannte Route oder ein neues GraphQL-Root bleibt grün.
- Empfehlung: Die Mengen `SCOPES`-Entities, `GET_ALLOW`, `ROOTS`, Magento-`ALLOW` und OpenMage-`ALLOW` im Test als exakte Liste vergleichen, nicht nur Stichproben.
- Vertrauen: sicher

### B4 — Schwere: mittel
- Ort: src/server/sessions-recover.test.ts:71
- Befund: Wiederherstellung und Retry koppeln den Erfolg an die Wanduhr und an die Reihenfolge in derselben Datei. Die Spanne zum Bündeln ist 50 ms.
- Beleg: `RUN_FLUSH_MS` ist 250 (`sessions.ts:158`). Der Test wartet nach dem zweiten Tick `tick(300)` (`sessions-recover.test.ts:71–73`) und davor pauschal 5 ms (`:41`, `:67`). Liegt zwischen den beiden `progress`-Aufrufen mehr als 250 ms, ist der zweite Stand schon geschrieben und die Zusicherung „length 1“ (`:70`) scheitert. Feuert der Timer später als 300 ms, scheitert „length 2“ (`:73`). `sessions.test.ts:36` und `settings-route.test.ts:21` warten ebenfalls 5 ms auf den Executor. `retry.test.ts:35–37` verlangt `Date.now()` minus Start mindestens 950 ms. Dieselbe Datei teilt sich veränderlichen Zustand: `apply` (`sessions-recover.test.ts:23–24`), das Passwort aus dem vorherigen Test (`settings.test.ts:13–14` und `:24–27`). `package.json:11` setzt keine Concurrency.
- Auswirkung: Unter Last kann `sessions-recover` rot werden, ohne dass sich das Verhalten geändert hat. Vertauschte Reihenfolge in der Datei lässt `settings.test.ts` am verschlüsselten Passwort scheitern.
- Empfehlung: Den Flush über eine eingesetzte Uhr oder ein explizites Flush steuern, `retryDelay` ohne Echzeit prüfen, und jeden Test mit eigenem Datenstand starten.
- Vertrauen: sicher

### B5 — Schwere: niedrig
- Ort: src/app/shop/[[...path]]/route.ts:25
- Befund: Die Host-Prüfung vor jeder Anfrage würde rot. Eine Weiterleitung des Storefront-Proxys auf eine fremde Origin würde nicht rot.
- Beleg: `proxy.test.ts:24` erwartet für `Host: boese.test` den Status 403. Fehlt die Prüfung in `proxy.ts:27–29`, liefert `GET /api/chats` 200 und der Test scheitert. Der Shop-Proxy setzt `Location` über `storefrontRewrite` (`route.ts:25`). Die Funktion ersetzt nur die bekannte Basis-URL (`runtime.ts:46–48`). `shop-proxy.test.ts:41–47` erwartet `/shop/neu/` und `/shop/relativ?x=1`, kein fremdes Ziel.
- Auswirkung: Ein entfernter Host-Check am Next-Proxy fällt in CI auf. Ein durchgereichtes fremdes `Location` nicht. Die fachliche Bewertung dieser Weiterleitung gehört in die Sicherheits-Reviews, nicht hier.
- Empfehlung: Einen Fall, in dem der Fake auf eine andere Origin weiterleitet, und den erwarteten Status oder die umgeschriebene Location festschreiben.
- Vertrauen: sicher

## Was hält
Es gibt keine übersprungenen Tests und keinen Job, der fehlschlagen darf. `npm run check` (`package.json:13`) ist Typecheck, ESLint und Test. Die Pipeline ruft dasselbe in drei Schritten auf und hängt Build sowie Smoke an (`docker.yml:29–40`): Ping, `/api/health`, `/` und `/settings`. Schlägt der Server nicht an, scheitert der folgende `curl -fs`, nicht die Warteschleife davor. Ein Image entsteht nur bei `workflow_dispatch` und nur nach grünem `check` (`docker.yml:42–44`); `make update` holt ein Image, prüft nichts. Ein Git-Hook, der „vor jedem Commit `npm run check`“ erzwingt, steht weder in `package.json` noch im Workflow. Durchgesetzt wird das auf PR und auf `main` durch den Job, nicht durch den Commit.

`test-support/shopify-fake/*.test.ts` liegt im Glob von `npm test` und ist damit Pflicht im PR. `npm run shopify-fake` startet nur den Server von Hand. `test-support/openmage-live/verify.ts` und `test-support/shopify-live/verify-pages.ts` heißen nicht `*.test.ts`; ohne `OPENMAGE_URL` und Token endet die OpenMage-Live-Prüfung mit Exit 2 (`verify.ts:14–15`). Beides ist manuell.

Schreib- und Rückgängig-Tests, alle vier in `npm test`, keine Plattform nur als Leser: Shopware in `changes.test.ts:88–101` (PATCH und Undo-Payload), dazu CMS, Features und `upload-staging.test.ts:85–116`. `shopware.test.ts` prüft vor allem Lesen und dass ein Vorschlag nichts schreibt (`shopware.test.ts:148–150`). Shopify in `shopify.test.ts`, `pages.test.ts` und `import.test.ts` gegen den Fake, Zustand vor und nach `undo`. Magento in `magento.test.ts`, `magento-pages.test.ts` und `magento-scope.test.ts`. OpenMage in `openmage.test.ts:128–136` und `openmage-pages.test.ts:86–93` gegen den Modul-Fake.

Apply ohne Audit auf dem Sitzungsweg wird rot: `sessions-recover.test.ts:52–53` erwartet die Stände `started` und `applied`, `sessions.test.ts:52–53` die Entscheidung `approved`, `sessions.test.ts:119` die Entscheidung `undo`. Der Test liest das Audit erst nach dem abgeschlossenen Apply (`sessions-recover.test.ts:46` zählt währenddessen nur die Lauf-Zeile). Ein Apply ganz ohne Zeile fällt auf; eine Zeile erst nach dem Schreiben nicht zwingend.

Die Umgebungs-Freigabeliste für den KI-Prozess wird rot, wenn die im Test genannten Geheimnisse durchrutschen (`settings.test.ts:36–43`, Liste in `settings.ts:118–125`). Ein neuer, dort nicht genannter Variablenname nicht.

Gut geprüft, gruppiert: Policy-Stichproben und Scrubbing (`policy.test.ts`), Sitzung, Freigabe, Teil-Undo und Neustart (`sessions.test.ts`, `sessions-recover.test.ts`), Einstellungen, Geheimnisse und Wechsel während eines Schreibens (`settings.test.ts`, `settings-route.test.ts`), MCP-Token (`mcp.test.ts`), Upload nur vormerken und einmal hochladen (`upload-staging.test.ts`), Host, Origin und Kennung (`proxy.test.ts`), Shop-Präfix und kein Cookie an den Shop (`shop-proxy.test.ts`), Bild-SSRF (`media.test.ts`).

Gefährlich und ohne eigenen Test, neben B1 und B2: die HTTP-Handler `api/approve`, `api/answer`, `api/changesets/undo` (die Funktionen darunter sind geprüft, die Routen importiert kein Test), `api/gsc` (Schlüssel hinein), `api/files`, `staged/[...file]` (Pfadprüfung nur über `stagedFile` in `media.test.ts`). `src/server/agent-codex.ts` insgesamt. Kein Test importiert diese Route-Dateien; das ist der Rand, nicht die Executor-Logik.

Ob eine fachliche Lücke aus den anderen Reviews hier auffiele, nur als Fangfrage: eine neue erlaubte Entity, ein neues Root-Feld oder eine PHP-Route ohne die Wörter aus `unit.php:107` nicht. Ein Apply ohne Audit-Zeile, ein fehlender Host-Check in `proxy.ts` und ein durchgereichtes Shopware-Kunden-Entity schon.

## Nicht geprüft
Die Suite lief nicht. Ob sie heute grün ist, ob der Smoke unter 30 Sekunden bleibt und ob die 5-ms-Ticks auf dem Runner reißen, ist offen. Keine Abdeckungszahl. Live-Shops, `smoke.php` gegen OpenMage und der Inhalt der anderen Review-Dokumente nicht. Fachliche Lücken sind dort, nicht hier.

## Für den zweiten Durchgang
Soll `php integrations/openmage/tests/unit.php` in den Job `check`, und `smoke.php` weiter nur von Hand, weil es eine laufende Instanz braucht?
