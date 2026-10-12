# Review: Sicherheit
- Datum: 2026-10-12
- Stand: Commit c5f074c, Branch main
- Methode: Statische Prüfung von Proxy, API-Routen, Shop-Proxy, Verschlüsselung, Container-Dateien und dem OpenMage-Modul gegen den Code; nichts ausgeführt.

## Urteil
Ampel rot. Login, Kennung `x-lotse` und der Storefront-Proxy halten die einfachen Fälle: ohne Passwort bleibt der Compose-Port auf dem Loopback, Cookies gehen nicht an den Shop, und der Proxy folgt Weiterleitungen nicht. Rot, weil `read_page` für OpenMage und Magento eine URL, die nur die Origin des Shops teilt, serverseitig auf eine interne Adresse auflösen kann, sobald die öffentliche Shop-URL einen Pfad hat und von der internen URL abweicht. Das ist die von Docker beschriebene Konfiguration. Zusätzlich ist die Host-Prüfung per `Host: 127.0.0.1` erfüllbar, sobald der Port nicht nur am Loopback hängt.

## Befunde
### B1 — Schwere: kritisch
- Ort: src/server/platform/openmage/tools.ts:133
- Befund: `read_page` hängt den Teil hinter `publicUrl` roh an die interne Shop-Basis. `assertShopUrl` prüft nur die Origin. Hat die öffentliche URL einen Pfad, bleibt eine URL wie `https://shop.example.com/de@169.254.169.254/…` dieselbe Origin, der zusammengesetzte String ist aber ein anderer Host. Dieselbe Zeile steht in Magento. Der Abruf ist ein Lese-Werkzeug und wartet nicht auf eine Freigabe.
- Beleg: `assertShopUrl` vergleicht `u.origin` mit den Origins aus der erlaubten Liste (`src/server/storefront.ts:107-112`). Danach gilt `u.href.startsWith(ro().publicUrl)` ohne Grenze auf `/`, `?` oder Ende (`openmage/tools.ts:133`, gleich `magento/tools.ts:145`). `publicUrl` ist der gespeicherte Wert ohne abschließende Schrägstriche (`openmage/client.ts:49`). Für `publicUrl` `https://shop.example.com/de` und Basis `http://172.17.0.2` wird aus `https://shop.example.com/de@169.254.169.254/latest/meta-data` die Anfrage `http://172.17.0.2@169.254.169.254/latest/meta-data` (Host `169.254.169.254`). `https://shop.example.com/de.evil.example/x` wird zu `http://172.17.0.2.evil.example/x`. Ohne Pfad in `publicUrl` bleibt der Rest ein Pfad (`/…`) und der Host der Basis. Dieselbe Verkettung lädt Galerie-URLs (`openmage/images.ts:27`). Shopware macht das so nicht.
- Auswirkung: Im Container, mit interner Shop-URL und öffentlicher URL inklusive Pfad (Unterverzeichnis oder `/index.php`), kann das Modell oder ein MCP-Client mit gültigem Token die Metadaten-Adresse oder einen eigenen Host vom Server aus abrufen. Eine Freigabe im UI ist dafür nicht nötig. Eine öffentliche URL, die nur die Origin ist, trifft diesen Pfad nicht.
- Empfehlung: Nur anhängen, wenn der Rest leer ist oder mit `/`, `?` oder `#` beginnt; sonst die ursprüngliche URL behalten. Danach die fertige URL erneut auf die interne Basis prüfen, analog zu Shopware nach einer Weiterleitung.
- Vertrauen: sicher

### B2 — Schwere: hoch
- Ort: src/server/platform/openmage/tools.ts:134
- Befund: Dieselbe Funktion folgt Weiterleitungen und prüft die Endadresse nicht. Shopware prüft sie.
- Beleg: OpenMage und Magento rufen `fetch` mit `redirect: 'follow'` auf und lesen danach nur den Status (`openmage/tools.ts:134-135`, `magento/tools.ts:146-147`). Shopware ruft danach `assertShopUrl(r.url, allowed)` auf, wenn `r.url` von der Ausgangs-URL abweicht (`shopware/tools.ts:118-119`). Der Storefront-Proxy setzt dagegen `redirect: 'manual'` (`src/app/shop/[[...path]]/route.ts:23`).
- Auswirkung: Eine Seite auf der Shop-Origin, die nach `http://169.254.169.254/` oder auf einen anderen internen Host weiterleitet, wird vom Server geholt. Dafür reicht die Origin-Prüfung der ersten URL nicht. Wer die Weiterleitung erzeugt (offene Weiterleitung im Shop, oder ein Rewrite mit `options` `R`/`RP`, siehe B6), lenkt den Lese-Abruf.
- Empfehlung: `redirect: 'manual'` und jeden Hop mit `assertShopUrl` prüfen, wie beim Bild-Download (`src/server/media.ts:67-83`) und wie in `shopware/tools.ts:119`.
- Vertrauen: sicher

### B3 — Schwere: hoch
- Ort: src/proxy.ts:27
- Befund: Die Host-Freigabe ist ein vom Client gesetzter Header und enthält immer `localhost`, `127.0.0.1` und `[::1]`. `ALLOWED_HOSTS` ergänzt nur. Im Image lauscht der Prozess auf `0.0.0.0`, die Warnung vor fehlendem Passwort ist im Container aus.
- Beleg: `allowedHosts` ist `LOCAL_HOSTS` plus `ALLOWED_HOSTS` (`proxy.ts:6-7`). Verglichen wird `Host` ohne angehängten Port (`proxy.ts:27-29`). `Dockerfile:49` setzt `HOSTNAME=0.0.0.0`. `instrumentation.ts:4-7` warnt nur, wenn der Host nicht Loopback ist, `AICB_DOCKER` nicht `1` ist und `LOTSE_PASSWORD` fehlt. `docker-compose.yml:18-19` veröffentlicht `127.0.0.1`. Ein Aufruf mit `Host: 127.0.0.1`, ohne `Origin` und mit `x-lotse: 1` besteht Host-, Origin- und Kennungsprüfung (`proxy.ts:32-39`). `/api/ping` überspringt die Host-Prüfung ganz (`proxy.ts:25`).
- Auswirkung: Mit dem mitgelieferten Compose bleibt der Port am Loopback, dann trifft das nur Prozesse auf dem Rechner. Sobald das Image mit `-p 3333:3333` oder hinter einem Proxy läuft, der `Host` durchreicht, und `LOTSE_PASSWORD` leer ist, ist die Host-Prüfung keine Schranke. Derselbe Client kann die Shop-URL auf eine interne Adresse setzen (`PUT /api/settings`) und sie über `/shop` und die API-Clients abrufen lassen; der Proxy prüft private Adressen nicht. Mit gesetztem Passwort bleibt die Basic-Auth-Prüfung.
- Empfehlung: Loopback-Namen nur akzeptieren, wenn die Verbindung wirklich vom Loopback kommt, oder sie nicht dauerhaft in die Liste nehmen. Die Warnung auch bei `AICB_DOCKER=1` ausgeben, wenn der veröffentlichte Port nicht `127.0.0.1` ist. Serverbetrieb weiter an `LOTSE_PASSWORD` binden.
- Vertrauen: sicher

### B4 — Schwere: mittel
- Ort: src/app/shop/[[...path]]/route.ts:25
- Befund: Der Storefront-Proxy folgt Weiterleitungen nicht, gibt ein fremdes `Location` aber unverändert an den Browser. Er ersetzt nur die bekannte Shop-Basis.
- Beleg: `redirect: 'manual'` steht in `route.ts:23`. `location` wird `storefrontRewrite(new URL(loc, b).href, b)` (`route.ts:25`). `storefrontRewrite` tauscht nur Vorkommen der Basis gegen `/shop` (`src/server/runtime.ts:46-48`). `new URL('https://evil.test/phish', 'https://shop.de')` und `new URL('//evil.test/a', b)` bleiben fremde Origins. `shop-proxy.test.ts:41-47` erwartet nur Ziele auf derselben Basis. Cookies und `Authorization` werden nicht gesendet, nur `accept` (`route.ts:23`); `Set-Cookie` wird nicht zurückgegeben (der Test erwartet das in `shop-proxy.test.ts:31-37`). Nicht-HTML bekommt `access-control-allow-origin: *` (`route.ts:31`), HTML nicht.
- Auswirkung: Kein serverseitiges SSRF über eine Weiterleitung des Proxys, und keine Kundensitzung des Browsers am Shop. Ein Shop, der auf eine fremde Origin weiterleitet, wird zur offenen Weiterleitung von Lotses Origin. Zusätzlich kann jede Herkunft nicht-HTML der Proxy-Antwort lesen, einschließlich JSON unter den Storefront-Präfixen `store-api`, `checkout`, `account`, `customer/section` (`src/lib/platforms.ts:58`, `:102`, `:126`). Ohne mitgeschickte Cookies ist das die anonyme Antwort, die der Server selbst holt.
- Empfehlung: `Location` nur ausliefern, wenn der Host die Shop-Basis ist, sonst 502. `access-control-allow-origin: *` auf Schriften und Bilder begrenzen, nicht auf jedes nicht-HTML.
- Vertrauen: sicher

### B5 — Schwere: mittel
- Ort: src/app/api/approve/route.ts:9
- Befund: Der Executor startet, wenn `decideChange` die wartende Freigabe auflöst. Dafür reicht `POST /api/approve` mit `x-lotse: 1`. Die Kennung ist die Konstante `1`, kein an den Klick gebundenes Geheimnis. Ohne `LOTSE_PASSWORD` prüft der Proxy bei Schreibzugriffen nur diese Kennung und, falls vorhanden, `Origin`.
- Beleg: `requestChange` legt ein Promise in `approvals` und schreibt erst nach `dec.allow` (`src/server/sessions.ts:205-219`). `decideChange` löst es auf (`sessions.ts:262-268`). Die Route prüft kein weiteres Merkmal (`approve/route.ts:9-14`). `x-lotse` muss `1` sein (`proxy.ts:39`); der Browser sendet genau das (`src/lib/api.ts:14`). MCP-Werkzeuge rufen dieselben Tools auf, darunter `publish_page` → `requestChange` (`src/server/tools.ts:150-158`, `src/app/api/mcp/[chatId]/route.ts:15-17`). Der MCP-Pfad überspringt Passwort und Kennung (`proxy.ts:39-44`), der Handler verlangt das Bearer-Token (`route.ts:13`). Ein reines MCP-Tool setzt `allow` nicht selbst.
- Auswirkung: Die sandboxed Vorschau kommt nicht durch (Origin `null` scheitert in `proxy.ts:34`, und ihr fehlt die Kennung). Ein HTTP-Client auf dem Rechner, oder jeder, der das Passwort kennt, kann eine offene Freigabe erteilen, sobald er `chatId` und `approvalId` aus dem Chat-Strom hat (`GET /api/chat` ist lesend und braucht die Kennung nicht). Das ist kein Klick-Nachweis. Ohne offene Freigabe schreibt der Executor nicht.
- Empfehlung: Die Formulierung in `SECURITY.md` auf die Kennung und das optionale Passwort begrenzen, oder die Freigabe an ein einmaliges, nicht aus dem Ereignisstrom vorhersagbares Geheimnis binden, das nur die Oberfläche nach dem Klick sendet.
- Vertrauen: sicher

### B6 — Schwere: mittel
- Ort: integrations/openmage/app/code/community/Lotse/Connector/Model/Api/Urlrewrite.php:109
- Befund: `POST /v1/urlrewrites` speichert `target_path` nach einem `trim` der Schrägstriche, ohne Schema- oder Pfadprüfung. `options` darf `R` oder `RP` sein.
- Beleg: Fehlen Produkt und Kategorie, ist `target_path` ein Pflichtfeld und wird direkt übernommen (`Urlrewrite.php:108-123`). Erlaubt sind nur `R`, `RP` oder `null` (`Urlrewrite.php:111-113`). Der Kommentar nennt `R` 302 und `RP` 301 (`Urlrewrite.php:82-83`). Ob OpenMage ein `target_path` mit `http://` als externe Weiterleitung ausliefert, liegt im OpenMage-Kern, der hier nicht im Repo steht.
- Auswirkung: Der Token-Inhaber kann einen Rewrite anlegen, dessen Ziel nicht der Katalog ist. Zusammen mit B2 wird daraus, falls der Shop extern weiterleitet, ein serverseitiger Abruf durch `read_page`. Kunden- und Bestellsitzungen brauchen dafür den API-Token nicht; die Route ist tokenpflichtig (siehe unten).
- Empfehlung: `target_path` auf relative Katalogpfade beschränken (`catalog/product/view/…`, `catalog/category/view/…`, CMS) und Schemata sowie `//` ablehnen.
- Vertrauen: wahrscheinlich

### B7 — Schwere: mittel
- Ort: src/app/api/upload/route.ts:11
- Befund: Der Bild-Upload prüft den Header `content-type`, nicht den Inhalt. `image/svg+xml` wird ungeprüft nach `staging` geschrieben. `sanitizeSvg` läuft dort nicht.
- Beleg: Die Route lehnt nur ab, wenn der Typ nicht mit `image/` beginnt (`upload/route.ts:11-12`), und ruft `stageImage` (`upload/route.ts:19`). `stageImage` mappt den MIME-Typ auf eine Endung, inklusive `image/svg+xml`, und schreibt die Bytes (`src/server/media.ts:16`, `media.ts:101-108`). `sanitizeSvg` wird von `create_svg_image` aufgerufen (`src/server/tools.ts:82-83`), nicht vom Upload. Die Auslieferung `/staged` setzt `sandbox` und `default-src 'none'` (`src/app/staged/[...file]/route.ts:12`). Der Kommentar bei `sanitizeSvg` sagt, die Datei liege nach Freigabe unverändert in der Medienverwaltung (`media.ts:163-166`).
- Auswirkung: Unter `/staged` hält das CSP Skripte. Nach einer Freigabe, die das vorgemerkte Bild verwendet, steht das SVG so im Shop, wie es hochgeladen wurde. Ein Shop ohne CSP führt ein Script darin aus.
- Empfehlung: SVG im Upload durch `sanitizeSvg` schicken oder `image/svg+xml` an dieser Route ablehnen.
- Vertrauen: sicher

### B8 — Schwere: niedrig
- Ort: src/server/codex.ts:136
- Befund: Das MCP-Token hat 256 Bit und ist an die Chat-ID gebunden, läuft aber nicht ab und wird beim Löschen des Chats nicht entfernt.
- Beleg: `crypto.randomBytes(32).toString('hex')` (`codex.ts:138`), Vergleich über `timingSafeEqual` bei gleicher Länge (`codex.ts:142-146`). Die Map ist ein Singleton (`codex.ts:135`). Weder `chatDelete` (`src/server/db.ts:57`) noch die MCP-Route löschen einen Eintrag. `getSession` legt eine fehlende Sitzung neu an (`src/server/sessions.ts:183-192`). `pingCodex` erzeugt ein Token für die feste ID `ping` (`src/server/agent-codex.ts:85`).
- Auswirkung: Ein mitgelesenes Token gilt bis zum Prozessende, auch nach gelöschtem Chat, und öffnet die Shop-Werkzeuge ohne `LOTSE_PASSWORD`. Die Entropie reicht zum Raten nicht. Schreiben bleibt an der offenen Freigabe hängen (B5).
- Empfehlung: Token beim Löschen der Sitzung entfernen und an die Laufzeit der Codex-Runde binden.
- Vertrauen: sicher

## Was hält
`LOTSE_PASSWORD` gilt für jede Route außer `GET` und jede Methode auf `/api/ping` (`proxy.ts:25`) und außer `/api/mcp/` (`proxy.ts:42-44`). Leer heißt kein Login; das ist der lokale Standard. Der Vergleich hasht beide Seiten mit SHA-256 und vergleicht feste Längen (`proxy.ts:13-20`). Der Nutzername wird ignoriert. Schreibende Methoden außer MCP brauchen `x-lotse: 1`. `Origin`, falls vorhanden, muss zum `Host` passen; `Origin: null` fällt durch (`proxy.ts:32-36`). `GET`, `HEAD` und `OPTIONS` brauchen die Kennung nicht. Es gibt keinen zweiten Präfix, der die Prüfung auslässt.

Der Shop-Proxy baut die Ziel-URL als Basis plus Pfad, und der Pfad aus `/shop/…` beginnt nach dem Slice mit `/` oder wird zu `/` (`route.ts:15`). Damit wechselt die Verkettung den Host nicht. `redirect` ist `manual`. Mitgeschickt wird `accept`, nicht `cookie` oder `authorization`. Die Antwort übernimmt nicht `Set-Cookie`. Private Ziele sperrt dieser Pfad nicht: die Shop-URL darf intern sein (Docker). Das ist Absicht, kein zweites SSRF neben B1 und B3.

`stagedFile` verlangt genau ein Segment `^[a-z0-9]+\.[a-z0-9]+$` und denselben Ordner nach `path.resolve` (`media.ts:151-160`). Dateien liegen unter `f_[0-9a-f]{20}` (`src/server/files.ts:19`, `files.ts:35-36`); der Dateiname wird `path.basename` (`files.ts:30`). Die Wissensbasis liest über diese ID, nicht über einen Client-Pfad.

AES-256-GCM: 32 Byte aus `crypto.randomBytes`, IV 12 Byte, Auth-Tag, Datei `secret.key` mit Modus `0o600` im Datenverzeichnis (`src/server/db.ts:76-88`). Der Schlüssel liegt neben der Datenbank; wer das Volume kopiert, liest beides. `seal` schreibt `enc:v1:`. `publicSettings` gibt Geheimnisse als `hasPassword` / `has*` aus, nicht als Wert (`src/server/settings.ts:73-83`). `redact` läuft in Werkzeugfehlern (`src/server/tool-kit.ts:8`) und in den Health-Meldungen von Magento und OpenMage. Shopware-`health` (`src/server/platform/shopware/index.ts:35`) und der `catch` von `api/settings/test` (`src/app/api/settings/test/route.ts:20`) rufen `redact` nicht auf. In den gelesenen Wurfstellen steht das Passwort im Request-Body, nicht in der Meldung. Ein Leak aus diesen zwei Stellen ist damit nicht belegt.

Das MCP-Token ist nicht das Browser-Passwort. Codex bekommt es nur in der Prozessumgebung (`agent-codex.ts:22`). `networkAccessEnabled: false` steht in `agent-codex.ts:26`.

`docker-compose.yml` setzt `read_only`, `no-new-privileges`, `cap_drop: [ALL]`, `pids_limit`, `mem_limit`, `cpus` und den Port auf `127.0.0.1` (`docker-compose.yml:18-32`). Das Image selbst setzt nur `USER node` (`Dockerfile:66`) und die genannten Limits nicht. `docker/entrypoint.sh:4` setzt `umask 077`. Die Härtung aus `SECURITY.md` gilt für Compose, nicht für ein nacktes `docker run`.

OpenMage: `/lotse-api` ist ein Frontend-Router (`Controller/Router.php:22-26`), also per URL erreichbar, aber `ApiController::authenticate` verlangt immer `Bearer` (`ApiController.php:99-117`). Leerer Token scheitert (`Helper/Data.php:45-51`). Der Vergleich ist `hash_equals` über SHA-256. Der Token ist `lotse_` plus 24 Byte (`Helper/Data.php:29-31`). Eine leere IP-Liste erlaubt alle Adressen (`Model/Net.php:50-53`); Standard ist `enabled` 0 (`etc/config.xml:56-59`). `trust_proxy` ist standardmäßig aus; gezählt wird sonst der letzte `X-Forwarded-For`-Eintrag (`Model/Net.php:13-30`). Kunden-, Bestell- und Admin-Sitzungen öffnen die API nicht. Die Routentabelle hat keine Kunden-, Bestell- oder Benutzerpfade (`Model/Route.php:12-16`). Token erzeugen im Admin verlangt ACL `system/config/lotse`, POST und Form-Key (`ConnectorController.php:8-18`). SQL in den gelesenen Filtern läuft über Platzhalter oder `intParam`; `category_id` wird vor dem Einsetzen in `joinField` auf int geprüft (`Model/Api/Product.php:124-125`). Der Bild-Download prüft jeden Hop auf eine öffentliche Adresse (`Model/Api/Media.php:211-272`). Ob die danach geöffnete Verbindung dieselbe Adresse trifft, ist nicht belegt.

Ob die KI-Policy Kundenfelder fachlich vollständig sperrt, gehört in Dokument 02. Hier nur: der Executor für Schreibzugriffe ist `requestChange` plus `decideChange`, nicht ein zweiter HTTP-Pfad ohne Freigabe.

## Nicht geprüft
Kein laufender Server, kein Exploit, kein Browser. Nicht geprüft: ob Chrome einen Public-Origin-Zugriff auf `127.0.0.1` vor dem Preflight abfängt, ob ein DNS-Wechsel zwischen `dns.lookup` und `fetch` in `media.ts:63-77` oder zwischen `assertPublicHost` und `Varien_Http_Client` in `Media.php:248-221` praktisch zieht, und wie der OpenMage-Kern `target_path` mit Schema ausliefert. CSS, Tests und die Vollständigkeit der Lese-Policy nicht.

## Für den zweiten Durchgang
Ist eine öffentliche Shop-URL mit Pfad (Unterverzeichnis oder `/index.php`) eine unterstützte Docker-Konfiguration, sodass B1 vor dem nächsten Release geschlossen werden muss und nicht nur für reine Origins gilt?
