**Deutsch** · [English](en/self-hosting.md)

# Lotse selbst hosten (Server, Login, HTTPS)

Lotse läuft standardmäßig nur auf deinem Rechner (`127.0.0.1`). Du kannst es auch auf einem Server betreiben, damit ein Team darauf zugreift. Dann gilt: **Login setzen, HTTPS vorschalten, Hostnamen freigeben.** Dieses Dokument beschreibt den Weg und was Lotse dabei erzwingt.

> Wer Lotse erreicht, kann nach dem Login Änderungen am Shop freigeben. Behandle das Passwort wie einen Admin-Zugang.

## Was Lotse für den Serverbetrieb mitbringt

| Funktion | Verhalten |
|---|---|
| **Login** | `LOTSE_PASSWORD` gesetzt → jede Seite und jeder API-Aufruf verlangt HTTP Basic Auth. Der **Passwortwert** zählt, der Benutzername ist beliebig (z. B. `lotse`). Das Passwort wird zeitkonstant verglichen (UTF-8, Umlaute gehen). |
| **Login-Bremse** | Nach 10 falschen Passwörtern in 15 Minuten antwortet Lotse der Absender-Adresse 5 Minuten lang `429` (im Arbeitsspeicher, nach Neustart zurückgesetzt). Hinter einem lokalen Reverse-Proxy zählt der letzte Eintrag in `X-Forwarded-For`; läuft der Proxy auf einem anderen Rechner (oder als Kubernetes-Ingress), seine Adresse in `LOTSE_TRUSTED_PROXIES` eintragen (IPs oder IPv4-CIDR, kommagetrennt) – sonst teilen sich alle Nutzer einen Zähler. |
| **Hostname-Freigabe** | Nur `localhost`, `127.0.0.1` und `[::1]` (und nur von dort) sowie die Namen aus `ALLOWED_HOSTS` werden bedient. Alles andere antwortet `403 Host nicht erlaubt` (Schutz gegen DNS-Rebinding). „Von dort“ prüft Lotse an der echten Socket-Adresse, nicht nur an `X-Forwarded-For` (das kann ein Client selbst setzen). |
| **Schutz vor fremden Seiten** | Schreibende Aufrufe brauchen die Kennung der Oberfläche (`x-lotse: 1`), und ein `Origin` muss zum `Host` passen (CSRF). |
| **Gesundheitsabfrage** | `GET /api/ping` ist ohne Login erreichbar (liefert nur `{"ok":true,"version":…}`), z. B. für Docker-Healthcheck oder Monitoring. |
| **Startwarnung** | Außerhalb von Docker meldet Lotse beim Start, wenn es auf einer offenen Adresse ohne `LOTSE_PASSWORD` lauscht. `ALLOWED_HOSTS` ohne `LOTSE_PASSWORD` meldet es immer, beim Start und als Hinweis in den Einstellungen. |
| **Sicherheits-Header** | Oberfläche und API: `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`, `nosniff`, `Referrer-Policy: same-origin`. Die Shop-Vorschau (`/shop`) setzt ihre eigene Sandbox-CSP. |

Was es **nicht** gibt: eigene Benutzerkonten oder Rollen (ein gemeinsames Passwort), eigenes TLS (dafür der Reverse-Proxy) und eine dauerhafte Kontosperre (die Login-Bremse oben ist bewusst einfach; weitere Begrenzung am Proxy, siehe unten).

## Konfiguration

In der `.env` neben der `docker-compose.yml`:

```env
# Login (Pflicht im Serverbetrieb). Lang und zufällig: openssl rand -base64 32
LOTSE_PASSWORD=…
# Namen, unter denen Lotse erreichbar ist (kommagetrennt, ohne Schema und Port)
ALLOWED_HOSTS=lotse.example.com
# KI-Zugang. Auf Servern ist der API-Schlüssel der einfache Weg
ANTHROPIC_API_KEY=…
```

Shop-Zugang und weitere Werte wie auf dem eigenen Rechner (siehe [`.env.example`](../.env.example) oder Einstellungen in der Oberfläche). `LOTSE_BIND` bleibt `127.0.0.1`: Es beschreibt, dass der Container-Port nur auf Loopback veröffentlicht ist, und sorgt dafür, dass Lotse keine falsche Warnung ausgibt.

## Variante A: Reverse-Proxy auf demselben Server (empfohlen)

Lotse bleibt auf `127.0.0.1:3333` (so setzt es `docker-compose.yml`), ein Proxy auf dem Host nimmt HTTPS an und reicht weiter.

```sh
git clone https://github.com/Coding9GmbH/coding9-lotse.git lotse && cd lotse
cp .env.example .env     # LOTSE_PASSWORD, ALLOWED_HOSTS, KI- und Shop-Zugang eintragen
make up                  # baut das Image und startet auf 127.0.0.1:3333
```

**Caddy** (HTTPS-Zertifikat automatisch):

```caddyfile
lotse.example.com {
  reverse_proxy 127.0.0.1:3333 {
    flush_interval -1          # Chat-Antworten werden gestreamt, nicht puffern
    transport http { read_timeout 10m }
  }
}
```

**nginx** (Zertifikat z. B. mit certbot):

```nginx
server {
  listen 443 ssl http2;
  server_name lotse.example.com;
  # ssl_certificate … / ssl_certificate_key …

  client_max_body_size 30m;            # Bild-/Dateianhänge (Lotse erlaubt bis 25 MB)
  location / {
    proxy_pass http://127.0.0.1:3333;
    proxy_set_header Host $host;        # PFLICHT: ohne den Originalnamen schlägt die Origin-Prüfung fehl
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                # NDJSON-Stream des Chats
    proxy_read_timeout 600s;            # lange KI-Runden
  }
}
```

Wichtig für jeden Proxy: **`Host` unverändert weiterreichen**, **Antworten nicht puffern**, **Lese-Timeout großzügig** (KI-Runden und Shop-Schreibvorgänge dauern).

## Variante B: Proxy im selben Docker-Netzwerk

Läuft dein Proxy (Traefik, Caddy, nginx) selbst als Container, braucht Lotse keinen veröffentlichten Port. Ergänze in einer `docker-compose.override.yml`:

```yaml
services:
  lotse:
    ports: !reset []             # nichts veröffentlichen (Compose ≥ 2.24)
    networks: [default, proxy]
networks:
  proxy:
    external: true               # das Netzwerk deines Proxys
```

Der Proxy zeigt dann auf `http://lotse:3333`. Es gelten dieselben Hinweise wie oben (`Host`, kein Puffern, Timeouts). Healthcheck des Containers: `/api/ping`.

## Härtung am Proxy

- **Nur HTTPS.** Basic Auth sendet das Passwort bei jedem Aufruf; über HTTP wäre es mitlesbar. HTTP auf HTTPS umleiten.
- **Fehlversuche begrenzen**, z. B. mit `limit_req` (nginx), dem Rate-Limit-Modul von Caddy/Traefik oder fail2ban auf das Proxy-Log (Antwort 401).
- **Zugriff einschränken**, wenn möglich: VPN, Tailscale/WireGuard oder IP-Freigabe am Proxy. Je kleiner der Kreis, desto weniger hängt am Passwort.
- **Eigene Integration mit eingeschränkter Rolle** für den Shop-Zugang verwenden, nicht den Admin-Login (siehe [SECURITY.md](../SECURITY.md)).

## Sandbox Coding aktivieren

Sandbox Coding startet pro Code-Aufgabe einen eigenen Shopware-Container (`dockware/shopware`), in dem die KI an einem Plugin oder Theme, einem neuen Plugin, einem ganzen Shopware-Projekt, einem eigenen Setup oder ganz ohne Projekt arbeitet (die Fälle aus Sicht der Nutzer: [Benutzerhandbuch](benutzerhandbuch.md#sandbox-starten-jeder-fall)). Dafür braucht Lotse Zugriff auf Docker. Die Funktion ist **standardmäßig aus** und wird unter **Einstellungen → Sandbox** eingeschaltet.

> **Docker-Zugriff ist Root-Zugriff auf den Host.** Wer Lotse bedienen kann, kann Container starten. Der Socket-Proxy unten ist eine zusätzliche Schutzschicht; die eigentliche Grenze ist die Container-Spezifikation, die nur der Lotse-Server baut: ein fest eingestelltes, versioniertes `dockware/shopware`-Image, keine Host-Pfade, keine Privilegien, keine Geräte, Ressourcen-Limits und nur Container mit dem Label `lotse.managed=1`. Die KI bekommt nie Docker-Zugriff.

Lotse schaltet die Sandbox **nicht** ein (und sperrt sie, falls schon an), solange es ohne `LOTSE_PASSWORD` aus dem Netzwerk erreichbar ist (offene Adresse oder `ALLOWED_HOSTS`). `LOTSE_SANDBOX=0` schaltet sie hart ab, unabhängig vom Schalter.

**Variante 1: Lotse in Docker (empfohlen).** `make sandbox-up` startet Lotse zusammen mit [`docker-compose.sandbox.yml`](../docker-compose.sandbox.yml):

```sh
make sandbox-up
# entspricht: docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

- Ein Socket-Proxy (`tecnativa/docker-socket-proxy`, per Digest fest) bekommt den Docker-Socket; Lotse spricht ihn über `DOCKER_HOST=tcp://docker-proxy:2375` in einem internen Netz an. Erlaubt sind nur Container (inkl. Start/Stopp), Images, Netzwerke, Exec und Volumes (für gespeicherte Datenbanken; Lotse legt nur eigene mit Label an); Build, Swarm, Secrets, System u. a. sind gesperrt.
- Die Aufgaben-Container hängen am internen Netz `lotse-sandbox` (`internal: true`, Subnetz fest `10.213.0.0/24`, Gateway `isolated`): kein Internet, keine veröffentlichten Ports, und der Host hat in diesem Netz keine Adresse – Dienste auf dem Host (etwa ein Live-Shop oder seine Datenbank auf demselben Server) sind aus den Containern nicht erreichbar. Dafür braucht es Docker Engine 28 oder neuer; ältere Versionen lehnt die Einrichtung ab. Lotse erreicht sie direkt; die Vorschau läuft über Lotse. Umgekehrt lehnt Lotse jede Anfrage aus diesem Subnetz ab (`LOTSE_SANDBOX_SUBNET`), auch ohne `LOTSE_PASSWORD`. Kollidiert das Subnetz mit deinem Netz, ändere es in der Datei an beiden Stellen.
- **Internet nur nach Freigabe:** Erlaubt ein Mensch für eine Aufgabe Internet (Karte im Chat oder Schalter „Internet: aus/an“), hängt Lotse ihren Container zusätzlich an das Netz `lotse-sandbox-egress` – ein normales Bridge-Netz mit Internet, das Lotse bei Bedarf anlegt (Label `lotse.managed=1`, Subnetz fest `10.214.0.0/24` über `LOTSE_SANDBOX_EGRESS_SUBNET`, `enable_icc=false`: Aufgaben-Container erreichen sich dort nicht gegenseitig). Lotse selbst hängt nicht an diesem Netz und lehnt auch Anfragen aus dessen Subnetz ab. Sperren, Pausieren und Abschließen trennen den Container wieder; nach dem Fortsetzen ist er offline. **Mit Internet erreicht der Container jede öffentliche Adresse – auch die öffentliche Adresse deines Live-Shops – und über das Gateway dieses Netzes Dienste des Hosts**, die nicht nur auf `127.0.0.1` lauschen. Freigeben deshalb nur, wenn nötig; ganz abschalten mit „Internet im Container: nie“ in der Umgebung. Mit „immer an“ ist jede bereite Sandbox ohne Klick online (nach der Einrichtung und nach dem Fortsetzen; `composer install` wartet nicht); abschalten im Kopf der Sandbox gilt für diese Sandbox, bis man es dort wieder einschaltet.
- Die normale `docker-compose.yml` bleibt unverändert gehärtet (schreibgeschützt, keine Capabilities, kein Socket).

**Variante 2: Lotse direkt auf einem Linux-Host.** Lotse nutzt `DOCKER_HOST` (Standard `unix:///var/run/docker.sock`); der Benutzer, unter dem Lotse läuft, braucht Zugriff auf den Socket. Auch hier hängen die Aufgaben-Container nur am internen Netz `lotse-sandbox` (kein Internet, keine veröffentlichten Ports); Lotse erreicht die Storefront über die IP des Containers in diesem Netz (der Host hat unter Linux eine Route in Docker-Bridges). **Achtung:** Umgekehrt erreicht der Container den Host über die Gateway-Adresse dieses Netzes – jeden Dienst, der nicht nur auf `127.0.0.1` lauscht, z. B. nginx und MySQL eines Live-Shops auf demselben Server. Die Einrichtung prüft gängige Ports (SSH, HTTP/S, MySQL, PostgreSQL, Redis, Elasticsearch, Memcached, MongoDB, Lotse) und schreibt eine Warnung ins Protokoll, wenn einer antwortet. Abhilfe: eine Firewall-Regel, die neue Verbindungen aus dem Subnetz verwirft und Antworten durchlässt, z. B. `iptables -I INPUT -s <Subnetz> -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP` (Subnetz aus `docker network inspect lotse-sandbox`, mit `LOTSE_SANDBOX_SUBNET` fest wählbar; Regel dauerhaft speichern) – oder Variante 1 verwenden. Wo das nicht geht (Docker Desktop auf macOS/Windows), bricht die Einrichtung beim Schritt „Container starten“ mit einem klaren Hinweis ab – dann Variante 1 verwenden; ein Netz mit Internetzugang nutzt Lotse bewusst nicht. Lotse sollte dabei nur auf `127.0.0.1` lauschen (Standard), sonst wäre es aus dem Container über die Gateway-Adresse erreichbar; ohne `LOTSE_PASSWORD` bleibt die Sandbox auf offenen Adressen ohnehin gesperrt. Container, die noch mit veröffentlichtem Port (ältere Lotse-Version) angelegt wurden, startet Lotse nicht mehr: Einrichtung ab „Container starten“ erneut versuchen. Internet nach Freigabe läuft auch hier über das Netz `lotse-sandbox-egress`; die Firewall-Regel sollte dann auch dessen Subnetz abdecken (`docker network inspect lotse-sandbox-egress`, fest wählbar mit `LOTSE_SANDBOX_EGRESS_SUBNET`).

**Weitere Einstellungen**

| Variable | Bedeutung |
|---|---|
| `LOTSE_SANDBOX` | `0` = hart aus. Leer = der Schalter in den Einstellungen entscheidet. |
| `DOCKER_HOST` | `unix:///pfad/docker.sock` oder `tcp://host:port`. Andere Schemata (ssh, TLS) werden nicht unterstützt. |
| `LOTSE_SANDBOX_MAX` | Gleichzeitig laufende Container (Standard 2). Ein weiterer pausiert den am längsten unbenutzten. |
| `LOTSE_SANDBOX_IDLE_MINUTES` | Standard für die Pause nach Inaktivität (30 Minuten); der Wert in den Einstellungen hat Vorrang. Pausiert heißt gestoppt, nicht gelöscht. |
| `LOTSE_SANDBOX_NETWORK` | `network` (Lotse selbst im Netz `lotse-sandbox`) oder `local` (Lotse auf dem Host erreicht die Container-IP). Die Container sind in beiden Fällen nur im internen Netz. Leer = automatisch. |
| `LOTSE_DUMP_MAX_MB` | Größter Datenbank-Dump in MB (Standard 2048). |
| `LOTSE_SANDBOX_DB_SNAPSHOTS` | `0` = keine Snapshots gespeicherter Datenbanken (jede Sandbox importiert den Dump). Standard: an. |
| `LOTSE_SANDBOX_SUBNET` | IPv4-Subnetz (CIDR) von `lotse-sandbox`; Anfragen daraus lehnt Lotse ab. Standard `10.213.0.0/24` (wie in `docker-compose.sandbox.yml`). Ist der Wert ungültig, braucht die Sandbox im Netzwerk-Betrieb `LOTSE_PASSWORD`. |
| `LOTSE_SANDBOX_EGRESS_SUBNET` | IPv4-Subnetz (CIDR) von `lotse-sandbox-egress` (Internet nach Freigabe); Anfragen daraus lehnt Lotse ebenfalls ab. Setzt `docker-compose.sandbox.yml` (`10.214.0.0/24`). Fehlt es im Netzwerk-Betrieb, lässt sich Internet nur mit `LOTSE_PASSWORD` freigeben. |

Im Reiter **Sandbox Coding** legst du Vorgaben für „Sandbox starten“ (Repository, Basis-Branch), das Image fest (nur `dockware/shopware:<Version>`, optional mit `-amd64`/`-arm64`, kein `latest` oder `6.7-latest`; Standard `dockware/shopware:6.7.15.1`; ältere Einstellungen mit dem nicht mehr gepflegten Vorgänger `dockware/play:<Version>` gelten weiter), dazu Umgebungsvariablen (geheime Werte verschlüsselt, nie wieder angezeigt, aus Texten an die KI entfernt; Code im Container – auch von der KI geschriebener – kann sie lesen, daher nur Zugangsdaten, die allein für die Sandbox gelten), eigene Einrichtungsbefehle, **Hinweise für die KI** (Freitext, höchstens 4000 Zeichen, im Prompt als Daten) und die gespeicherte Datenbank, die „Sandbox starten“ vorauswählt. „Umgebung prüfen“ testet Docker und lädt das Image (einige GB), solange der **Screenshot-Knopf in der Vorschau** eingeschaltet ist (Standard aus) auch das Browser-Image `mcr.microsoft.com/playwright:v1.64.0-noble` (gut 2 GB; fehlt es, lädt es der erste Screenshot). Beim Ausschalten werden laufende Container gestoppt, nicht gelöscht. `make sandbox-clean` entfernt alle Container mit dem Label `lotse.managed=1`.

**Aufgaben und ihr Container.** Eine Sandbox hängt an einem Chat (höchstens eine je Chat); jede (Repository + Basis-Branch) bekommt genau einen Container. Die Einrichtung läuft im Hintergrund in festen Schritten: Image prüfen, Repository klonen (nach `<Daten>/workspaces/<id>/repo`, Git-Verlauf getrennt in `<Daten>/git/<id>`), Plugin erkennen (liest zuerst `.lotse/sandbox.json`, siehe unten; Plugin- und Theme-Repositorys mit `composer.json` vom Typ `shopware-platform-plugin`; ein ganzes Shopware-Projekt – `composer.json` vom Typ `project` mit `shopware/core` – wird im Modus „Overlay“ eingespielt, siehe unten; ein leeres Repository mit höchstens README, LICENSE und .gitignore wird ein neues Plugin unter `custom/plugins/<Name>` mit dem im Dialog gewählten Namen, dann entfällt das Installieren und ohne Dump auch `theme:compile`), Container starten, auf Shopware warten, bei hochgeladenem Dump Shopware-Version prüfen und Datenbank importieren, Storefront-Domain setzen, Vorschau aufräumen (Symfony-Debug-Leiste per `config/packages/dev/zz-lotse-preview.yaml` und Shopwares Cookie-Hinweis per `core.basicInformation.useDefaultCookieConsent` aus – nur in der Sandbox, der Shop bleibt im Dev-Modus; ein Fehler überspringt nur diesen Schritt), Plugin übertragen und mit `plugin:install --activate` aktivieren (Themes zusätzlich `theme:change`), eigene Befehle „nach der Datenbank“, `theme:compile` + `cache:clear`, eigene Befehle „zum Schluss“. Screenshots nimmt die Einrichtung keine auf – nur der Knopf in der Vorschau, wenn er eingeschaltet ist. Jeder eigene Befehl ist ein eigener Schritt (als `www-data` mit `bash -lc` in `/var/www/html` – bei einem eigenen Setup laufen die Befehle der Sandbox und aus `.lotse/sandbox.json` im Zielordner –; die Umgebungsvariablen stehen bereit, Variablen der Sandbox gehen gleichnamigen der Umgebung vor); schlägt einer fehl, stoppt die Einrichtung, und sie lässt sich ab diesem Schritt wiederholen. Gemessen mit `dockware/shopware:6.7.15.1` auf einem gewöhnlichen Host: Shopware antwortet beim ersten Start nach etwa 75 s, nach einer Pause nach etwa 43 s; `theme:compile` dauert 7–14 s (mit dem älteren `dockware/play:6.7.2.2` antwortete Shopware nach etwa 20 s).

**Ganze Shopware-Projekte, vollständig installiert (Standard).** Ist das Repository ein ganzes Projekt (Aufbau wie `shopware/production`), überträgt Lotse das ganze Repository nach `/var/www/html` – ohne Geheimnisse (`.env*`, Schlüssel, `auth.json` …), `.git`, `node_modules/`, `vendor/`, `var/`, `files/`, `.lotse/`, `config/jwt` und die erzeugten Ordner unter `public/` (`bundles`, `theme`, `media`, `thumbnail`, `sitemap`); die Konfigurationsdateien, die Lotse prüft (`config/packages/**`, `config/services*.yaml`), kommen erst nach `composer install`. Dann wartet der Schritt **Projekt einspielen**, bis ein Mensch oben in der Sandbox **Internet: aus** klickt und bestätigt (dieselbe Freigabe wie für die KI, auditiert; der Task zeigt „Wartet auf Internet-Freigabe“, der Chat eine Statuszeile), führt `composer install --no-scripts --prefer-dist` aus der `composer.lock` des Projekts als `www-data` aus (höchstens 20 Minuten; private Pakete über eine geheime Umgebungsvariable `COMPOSER_AUTH` der Sandbox-Umgebung) und trennt den Container sofort danach wieder vom Internet-Netz – auch wenn composer scheitert (dann nennt der Fehler die wahrscheinliche Ursache: Zugangsdaten, Netz, PHP-Version, Lock-Datei). Danach wie unten: Laufzeit lesen (jetzt mit den Bundles des Projekts), Konfiguration planen und abgleichen, Startprüfung, `bin/console database:migrate --all`, Plugins (zusätzlich die Plugins unter `vendor/`, die `composer.json` direkt verlangt; scheitert eines davon, nur eine Warnung), Apps, Theme, `assets:install`. Der Schritt hat bei vollständig installierten Projekten 90 Minuten (Warten eingeschlossen). Spätere Änderungen werden ebenso übertragen (auch `composer.json`, `bin/`, `public/index.php`); „Aus dem Container übernehmen“ liest dann den ganzen Shop-Ordner (ohne `vendor/`, `var/`, `public/`). Ist Internet in der Umgebung ausgeschaltet („nie“) oder ohne Egress-Subnetz nicht möglich, fällt die Einrichtung mit einem Hinweis im Log auf „Overlay“ zurück; `"projectInstall": "overlay"` in `.lotse/sandbox.json` wählt es fest.

**Ganze Shopware-Projekte (Overlay).** Im Modus „Overlay“ bleibt das Shopware des Images installiert; Lotse überträgt darüber nur `custom/plugins/*`, `custom/static-plugins/*`, `custom/apps/*`, `config/packages/**`, `config/services*.yaml` und `src/` – unter demselben Pfad in `/var/www/html`. Nie übertragen werden `composer.json`/`composer.lock`, `config/bundles.php`, Routen, `.env*`, Schlüssel, `vendor/`, `var/` und `public/`. Der Schritt **Projekt einspielen** liest zuerst aus dem sauberen Image `APP_ENV`, die verfügbaren Konfigurations-Erweiterungen (`bin/console debug:config`) und die Namen der definierten Umgebungsvariablen (nie ihre Werte), lässt die YAML-Konfiguration des Projekts vom Symfony-Parser im Container lesen (in einem Arbeitsordner unter `/tmp`, nicht geladen) und schreibt `config/services_<APP_ENV>.yml` – nur im Container, nie ins Repository. Shopware lädt `config/packages/*`, `config/packages/<APP_ENV>/**`, `config/services.*` und zuletzt `config/services_<APP_ENV>.*`, jeweils sortiert; diese Datei ist damit die allerletzte und gewinnt auch gegen Erweiterungs-Konfiguration in `config/services*.yaml` (die Lotse deshalb mit prüft). Sie stellt um, was das Projekt tatsächlich konfiguriert: Redis-Cache, -Sessions, -Warenkorb und -Nummernkreise auf Dateien bzw. MySQL, Locks auf `flock`, Message-Queues auf `sync://` (`failed` auf Doctrine), den Mailer auf den Mailcatcher (`smtp://127.0.0.1:1025`; mit `transports` jeden einzelnen, `dsn` dann leer – Symfony lehnt beides zusammen ab), S3-/CDN-Dateisysteme auf lokal (öffentliche mit `%env(APP_URL)%` als URL), OpenSearch/Elasticsearch aus, Cluster-Setup und Reverse-Proxy aus, den Theme-Konfigurations-Lader auf die Datenbank, Remote-Log-Handler (z. B. gelf) auf `null`, und setzt jede `%env(NAME)%`, die der Container nicht kennt, auf leer. Dateien, die eine Erweiterung brauchen, die das Image nicht hat (z. B. `sentry:`, `frosh_tools:`), die kein gültiges YAML sind, PHP- und XML-Konfiguration unter `config/packages/` (lässt sich nicht prüfen) und eine Projektdatei namens `config/services_<APP_ENV>.yml` lädt die Sandbox nicht. Überschreibt eine Projektdatei eine Datei des Images (z. B. `config/packages/lock.yaml`), sichert der erste Abgleich die `config/` und `src/` des Images nach `var/lotse-image`; wird die Projektdatei nicht geladen oder im Repository gelöscht, kommt die Fassung des Images zurück. Ordner, die das Repository als Symlink enthält (z. B. `custom/plugins` → ein Ordner außerhalb), liest Lotse nie: Jede Pfadkomponente ab dem Arbeitsordner muss ein echter Ordner sein. Für einen ganzen Abgleich gilt eine gemeinsame Grenze (20 000 Dateien, 256 MB über alle Plugins, Konfiguration und `src/`), geprüft bevor eine Datei gelesen wird; `sandbox_bash` spiegelt ein Projekt nur, wenn sich seit dem letzten Abgleich etwas geändert hat (Pfade, Größen, Änderungszeiten). Danach: statische Plugins per Offline-`composer require` aus dem Pfad-Repository (wie in der Produktion; `composer.json` des Images bekommt dafür kurz nur die Pfad-Repositorys, danach die ursprünglichen zurück), weitere `psr-4`-Namespaces aus `src/` per `composer dump-autoload`, eine Startprüfung (`bin/console about`; nennt der Fehler eine Konfigurationsdatei, wird sie herausgenommen, höchstens fünf Runden – sonst bricht der Schritt mit Shopwares Meldung und der wahrscheinlichen Datei ab), `plugin:refresh` und `plugin:install --activate` für alle Plugins des Projekts in einem Aufruf (der Schritt hat bei Projekten 15 statt 5 Minuten), `app:install --activate --force` für Apps (Apps mit eigenem Server brauchen Internet), das Theme des Projekts per `theme:change` und zuletzt `cache:clear` plus `cache:pool:clear --all`. Mit Datenbank-Dump entscheidet dessen Plugin-Tabelle: Plugins, die der Dump kennt, behalten ihren Zustand, nur neue werden installiert, solche mit neuerer Version im Repository aktualisiert `plugin:update` (mit Migrationen; scheitert es, eine Warnung), das Theme bleibt wie im Dump; aktive Plugins ohne Code (Store- oder composer-Plugins) nennt der Log vorher, weil `plugin:refresh` sie aus der Datenbank der Sandbox entfernt. Nennt `composer.lock` statt einer Version einen Branch (z. B. `6.7.x-dev`), sagt der Log das und vergleicht nicht. Weicht die Shopware-Version aus `composer.lock` in Major.Minor vom Image ab, stoppt die Einrichtung bei **Shopware-Projekt erkennen** mit dem passenden Image (`dockware/shopware:<Version>`) und **Trotzdem fortfahren**. Pakete, die das Projekt verlangt und dem Image fehlen, nennt der Log; sie werden offline nicht installiert. Das holt erst die vollständige Installation (oben). Gemessen offline mit einem Projekt aus drei Plugins, einem statischen Plugin, einer App, einem Theme, `src/` und Produktions-Konfiguration (Redis, OpenSearch, S3/CDN, AMQP, SMTP, gelf, Sentry): etwa 45 s ab dem Moment, in dem Shopware antwortet.

**Eigenes Setup, ohne Projekt und `.lotse/sandbox.json`.** Beim **eigenen Setup** bleibt der Container ein gewöhnlicher Dockware-Container. Lotse legt das Repository (Eigentümer `www-data`) in den Zielordner – absolut, unter `/var/www`, `/opt` oder `/srv`, Vorgabe `/opt/<Repository>`; fehlende Elternordner legt root an –, führt keine Shopware-Schritte aus (Plugin installieren, Vorschau aufräumen und `theme:compile` entfallen, „Bereit“ meldet nur den HTTP-Status der Startseite) und entfernt beim nächsten vollständigen Abgleich nur Dateien, die es selbst dorthin geschrieben hat (Liste in `/var/tmp/lotse-custom-sync.txt` im Container). **Ohne Projekt** wird nichts geklont: Die Arbeitskopie ist ein lokales Git mit leerem Start-Commit (Autor „Lotse“). **Als GitHub-Projekt anlegen** legt mit dem gespeicherten Token ein leeres privates Repository an (wie „Neues Projekt anlegen“ mit der Berechtigung „Administration: Lesen & Schreiben“) und lädt den Start-Commit als `main` hoch; danach läuft das Veröffentlichen wie bei jeder Sandbox. **`.lotse/sandbox.json`** liest Lotse aus der Arbeitskopie (höchstens 64 KB, keine Symlinks). Die Befehle darin laufen erst, wenn ein Mensch sie für dieses Repository und genau diesen Inhalt der Datei (SHA-256) erlaubt hat; die Freigaben liegen in der Datenbank von Lotse (je Repository die letzten 20) und stehen mit Nutzer im Audit-Log. Werte von Umgebungsvariablen kommen nie aus der Datei; ein anderes Image nur als Tag des eingestellten (z. B. `"image": "6.7.14.0"` → `dockware/shopware:6.7.14.0`, die Einrichtung lädt es dann). Für den Hinweis im Dialog klont Lotse das Repository vorab (höchstens 50 Commits, ein Branch) nach `<Daten>/probe/`, liest nur, löscht den Klon sofort und merkt sich das Ergebnis eine Minute.

- In den Container kommen nur die Dateien des Repositorys als Archiv (Eigentümer `www-data`), nie `.git`, `.env*`, Schlüssel (`*.pem`, `*.key`, `id_rsa` …), `auth.json`, `node_modules` oder Symlinks nach außen. Es gibt keine Host-Pfade im Container.
- Dockware startet seine Dienste mit `sudo`, deshalb ist `no-new-privileges` nicht möglich; stattdessen entzieht Lotse zusätzlich zu den Docker-Standards nicht benötigte Capabilities (`NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `SYS_CHROOT`, `SETFCAP`).
- Die Storefront antwortet nur auf `Host: localhost` (Dockware-Standard); Lotse schickt diesen Host-Kopf selbst, die Domain im Shop bleibt `http://localhost`. Die Vorschau (`/sbx/<id>.<schlüssel>/`) schreibt diese Adresse auf ihr Präfix um. Mit `LOTSE_PASSWORD` gilt für Pfade unter `/sbx/<id>.<schlüssel>/` der Schlüssel als Anmeldung (Ajax-Aufrufe aus der Vorschau tragen die Basic-Anmeldung nicht, opaker Origin): ein falscher Schlüssel ergibt 404, ein richtiger erreicht nur den Container dieser Aufgabe. Der Schlüssel steht nur in der angemeldeten Oberfläche – gib Vorschau-Adressen nicht weiter.
- **Pause:** Nach der eingestellten Inaktivität (Standard 30 Minuten; ein offener Chat mit Sandbox und jede Runde der KI zählen als Aktivität) stoppt Lotse den Container, löscht ihn aber nicht: Code, Datenbank und Änderungen bleiben. **Fortsetzen** startet ihn wieder, wartet auf Shopware und überträgt den Arbeitsstand vollständig – ohne neue Einrichtung (gemessen etwa 45 s). Läuft schon `LOTSE_SANDBOX_MAX` Container, pausiert ein weiterer Start den am längsten unbenutzten; sind alle noch in der Einrichtung, antwortet Lotse mit „Es laufen bereits … Sandboxes“.
- **Datenbank-Dump:** Ein hochgeladener Dump (`.sql`/`.sql.gz`, nur bereinigt) landet in `<Daten>/dumps/<id>/data` (Rechte 0600, nicht im Backup von `make backup`). Ein Dump mit `USE` oder `CREATE DATABASE` (aus `mysqldump --databases`/`--all-databases`) wird schon beim Hochladen abgelehnt, weil er an der Shop-Datenbank vorbei importiert würde. Vor dem Import vergleicht Lotse die Shopware-Version aus den Core-Migrationen des Dumps mit `bin/console --version` des Images; weicht die Hauptversion (z. B. 6.6 gegen 6.7) ab, stoppt die Einrichtung, bis „Trotzdem fortfahren“ gewählt wird. Der Import streamt die Datei nach `/tmp/lotse-import` im Container und spielt sie mit einem festen Befehl ein (`gunzip -cf … | mysql … shopware`, danach `rm`); ein einmaliger Dump wird danach auf dem Host und im Container sofort gelöscht, auch bei einem Fehler (von einer gespeicherten Datenbank nur die Kopie im Container, siehe unten). Nicht importierte Dumps löscht Lotse nach 24 Stunden, beim Abschließen der Aufgabe und beim Aufräumen nach einem Neustart. Da der Dump die ganze Datenbank ersetzt, kommen danach Domain, Plugin-Installation, eigene Befehle „nach der Datenbank“ und `theme:compile`. Live geprüft mit einem `mysqldump` von `dockware/shopware:6.7.15.1` (Import etwa 20 s). **Gespeicherte Datenbanken** (Haken „Für weitere Sandboxes speichern“, Standard an) liegen in `<Daten>/dumps/library/<id>/data` und bleiben, bis sie jemand in der Liste löscht (auch nicht im Backup). Für den schnellen Start legt Lotse je gespeicherter Datenbank und Image ein Docker-Volume `lotse-db-<id>-<hash>` mit einer Kopie des MySQL-Datenverzeichnisses an und je Aufgabe mit gespeicherter Datenbank ein Volume `lotse-taskdb-<Aufgabe>` – beide im Docker-Datenverzeichnis, etwa so groß wie die importierte Datenbank (gemessen: 784 MB für einen Dump von 241 MB). Mit einem Snapshot war eine neue Sandbox in drei Durchläufen 80–93 s statt 108–126 s bis „bereit“ (Details: Architektur). `LOTSE_SANDBOX_DB_SNAPSHOTS=0` schaltet das ab.
- **Sandbox abschließen** löscht Container (samt seinem Datenbank-Volume), Arbeitsordner, Git-Verlauf, einen einmaligen Dump und Screenshots – eine gespeicherte Datenbank bleibt; die Aufgabe bleibt als Eintrag in der Liste. Ein Neustart von Lotse markiert laufende Schritte als „unterbrochen“, entfernt Lotse-Container ohne Aufgabe und übernimmt den Zustand der übrigen (laufend = bereit, gestoppt = pausiert).

## Daten, Sicherung, Updates

- **Daten** liegen im Docker-Volume `lotse-data` (`/data`): Datenbank (Chats, Audit-Log), Wissensbasis, Styleguide, Regeln, eigene Prüfungen, verschlüsselte Zugangsdaten **und `secret.key`**. Ohne `secret.key` sind gespeicherte Zugangsdaten unbrauchbar: Sicherung immer das ganze Volume.
  `make backup` legt ein Archiv unter `./backups` ab, `make restore FILE=backups/lotse-….tgz` spielt es zurück (stoppt Lotse dabei kurz).
  Die Datenbank läuft im WAL-Modus; ein bloßes Kopieren der Dateien im laufenden Betrieb kann einen halben Stand erwischen. Darum erstellt `make backup` bei laufendem Lotse zuerst per `VACUUM INTO` einen stimmigen Schnappschuss (`docker/db-snapshot.mjs`, im Container nach `/data/.backup/`, danach wieder entfernt) und sichert ihn als `aicb.db` zusammen mit allen übrigen Dateien (`secret.key`, Wissen, Claude-Sitzungen …). Ist Lotse gestoppt, wird die Datenbank direkt gesichert. Ältere Archive lassen sich weiterhin einspielen. Arbeitskopien von Sandbox Coding (`workspaces/`, `git/`) und Datenbank-Dumps (`dumps/`) sichert `make backup` bewusst nicht.
  Eigene Sicherung ohne `make`: `docker compose exec -T lotse node --input-type=module - < docker/db-snapshot.mjs`, dann `/data` ohne `aicb.db`, `aicb.db-wal` und `aicb.db-shm` sichern und `/data/.backup/aicb.db` als `aicb.db` dazulegen.
- **Kostenbremse:** `LOTSE_AI_BUDGET_USD` (oder Einstellungen → KI verbinden) begrenzt die Claude-Kosten je Kalendermonat (UTC). Lotse speichert die Kosten jeder Runde in der Datenbank (`ai_usage`, 400 Tage); `GET /api/usage` liefert Monat, Tag und die letzten 30 Tage. Die Kosten sind Schätzungen des Agent SDK; Bild-KI und der Verbindungstest zählen nicht mit. Jede Runde bekommt höchstens die Hälfte des noch freien Budgets als Grenze (laufende Runden reservieren ihren Anteil), so überschreiten auch parallele Chats das Budget nicht. Eine abgebrochene Runde ohne Kostenmeldung zählt mit der nächsten Runde desselben Chats.
- **Aufbewahrung der Protokolle:** Das Zugriffsprotokoll wird nach `LOTSE_LOG_RETENTION_DAYS` Tagen gelöscht (Standard 180), das Änderungsprotokoll nach `LOTSE_AUDIT_RETENTION_DAYS` Tagen (Standard 365, mindestens 30). `0` = nie löschen. Aufgeräumt wird beim Start und danach höchstens einmal am Tag. „Rückgängig“ ist davon nicht betroffen: Die Vorher-Werte stehen im Chat, nicht im Protokoll.
- **Wer hat freigegeben?** Mit `LOTSE_PASSWORD` trägt das Änderungsprotokoll den beim Login angegebenen Benutzernamen ein (Anwenden und Rückgängig). Für Teams: je Person einen eigenen Benutzernamen verwenden (das Passwort bleibt dasselbe).
- **Dateirechte:** Datenbank (inkl. `-wal`/`-shm`) und `secret.key` werden mit Rechten `600` angelegt, auch außerhalb von Docker.
- **Update:** `git pull && make up` (aus dem Quellcode) bzw. `make update` (offizielles Image `ghcr.io/coding9gmbh/lotse`).
- **Mehrere Personen** teilen sich eine Instanz und damit dieselben Chats, Regeln und denselben Styleguide. Für getrennte Shops je Shop eine eigene Instanz (eigenes Volume, eigener Hostname).

## Fehlerbilder

| Meldung | Ursache |
|---|---|
| `403 Host nicht erlaubt` | Der Name, unter dem du Lotse aufrufst, steht nicht in `ALLOWED_HOSTS`. Ohne Port eintragen, kommagetrennt. Meldet auch `localhost` diesen Fehler, kommt die Anfrage über einen Proxy mit öffentlicher Absender-Adresse: dann den echten Hostnamen aufrufen. |
| `403 Origin nicht erlaubt` | Der Proxy hat `Host` verändert (z. B. auf einen internen Namen). `Host` unverändert weiterreichen (`proxy_set_header Host $host`). |
| `403 Kennung der Oberfläche fehlt` | Ein eigener Client ruft die API ohne `x-lotse: 1` auf. Die Oberfläche sendet sie selbst. |
| `401 Login erforderlich` | `LOTSE_PASSWORD` ist gesetzt, der Browser hat keine oder falsche Zugangsdaten gesendet. |
| Chat „hängt“, Antwort kommt erst am Ende | Der Proxy puffert (`proxy_buffering off` bzw. `flush_interval -1` setzen). |
| Abbruch nach 60 s | Lese-Timeout des Proxys zu kurz. |
