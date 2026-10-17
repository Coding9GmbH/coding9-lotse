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

Sandbox Coding startet pro Code-Aufgabe einen eigenen Shopware-Container (`dockware/shopware`), in dem die KI an einem Plugin oder Theme arbeitet. Dafür braucht Lotse Zugriff auf Docker. Die Funktion ist **standardmäßig aus** und wird unter **Einstellungen → Sandbox** eingeschaltet.

> **Docker-Zugriff ist Root-Zugriff auf den Host.** Wer Lotse bedienen kann, kann Container starten. Der Socket-Proxy unten ist eine zusätzliche Schutzschicht; die eigentliche Grenze ist die Container-Spezifikation, die nur der Lotse-Server baut: ein fest eingestelltes, versioniertes `dockware/shopware`-Image, keine Host-Pfade, keine Privilegien, keine Geräte, Ressourcen-Limits und nur Container mit dem Label `lotse.managed=1`. Die KI bekommt nie Docker-Zugriff.

Lotse schaltet die Sandbox **nicht** ein (und sperrt sie, falls schon an), solange es ohne `LOTSE_PASSWORD` aus dem Netzwerk erreichbar ist (offene Adresse oder `ALLOWED_HOSTS`). `LOTSE_SANDBOX=0` schaltet sie hart ab, unabhängig vom Schalter.

**Variante 1: Lotse in Docker (empfohlen).** `make sandbox-up` startet Lotse zusammen mit [`docker-compose.sandbox.yml`](../docker-compose.sandbox.yml):

```sh
make sandbox-up
# entspricht: docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

- Ein Socket-Proxy (`tecnativa/docker-socket-proxy`, per Digest fest) bekommt den Docker-Socket; Lotse spricht ihn über `DOCKER_HOST=tcp://docker-proxy:2375` in einem internen Netz an. Erlaubt sind nur Container (inkl. Start/Stopp), Images, Netzwerke und Exec; Volumes, Build, Swarm, Secrets, System u. a. sind gesperrt.
- Die Aufgaben-Container hängen am internen Netz `lotse-sandbox` (`internal: true`, Subnetz fest `10.213.0.0/24`): kein Internet, kein Live-Shop, keine veröffentlichten Ports. Lotse erreicht sie direkt; die Vorschau läuft über Lotse. Umgekehrt lehnt Lotse jede Anfrage aus diesem Subnetz ab (`LOTSE_SANDBOX_SUBNET`), auch ohne `LOTSE_PASSWORD`. Kollidiert das Subnetz mit deinem Netz, ändere es in der Datei an beiden Stellen.
- Die normale `docker-compose.yml` bleibt unverändert gehärtet (schreibgeschützt, keine Capabilities, kein Socket).

**Variante 2: Lotse direkt auf dem Host.** Lotse nutzt `DOCKER_HOST` (Standard `unix:///var/run/docker.sock`); der Benutzer, unter dem Lotse läuft, braucht Zugriff auf den Socket. Jeder Aufgaben-Container veröffentlicht Port 80 nur auf `127.0.0.1` (auf einem Port, den Lotse wählt).

**Weitere Einstellungen**

| Variable | Bedeutung |
|---|---|
| `LOTSE_SANDBOX` | `0` = hart aus. Leer = der Schalter in den Einstellungen entscheidet. |
| `DOCKER_HOST` | `unix:///pfad/docker.sock` oder `tcp://host:port`. Andere Schemata (ssh, TLS) werden nicht unterstützt. |
| `LOTSE_SANDBOX_MAX` | Gleichzeitig laufende Container (Standard 2). Ein weiterer pausiert den am längsten unbenutzten. |
| `LOTSE_SANDBOX_IDLE_MINUTES` | Standard für die Pause nach Inaktivität (30 Minuten); der Wert in den Einstellungen hat Vorrang. Pausiert heißt gestoppt, nicht gelöscht. |
| `LOTSE_SANDBOX_NETWORK` | `network` (internes Netz) oder `local` (Ports auf 127.0.0.1). Leer = automatisch. |
| `LOTSE_DUMP_MAX_MB` | Größter Datenbank-Dump in MB (Standard 2048). |
| `LOTSE_SANDBOX_SUBNET` | IPv4-Subnetz (CIDR) von `lotse-sandbox`; Anfragen daraus lehnt Lotse ab. Setzt `docker-compose.sandbox.yml`. Fehlt es im Netzwerk-Betrieb, braucht die Sandbox `LOTSE_PASSWORD`. |

Im Reiter **Sandbox Coding** legst du das Image fest (nur `dockware/shopware:<Version>`, optional mit `-amd64`/`-arm64`, kein `latest` oder `6.7-latest`; Standard `dockware/shopware:6.7.15.1`; ältere Einstellungen mit dem nicht mehr gepflegten Vorgänger `dockware/play:<Version>` gelten weiter), dazu Umgebungsvariablen (geheime Werte verschlüsselt, nie wieder angezeigt, nie an die KI) und eigene Einrichtungsbefehle. „Umgebung prüfen“ testet Docker und lädt das Image (einige GB). Beim Ausschalten werden laufende Container gestoppt, nicht gelöscht. `make sandbox-clean` entfernt alle Container mit dem Label `lotse.managed=1`.

**Aufgaben und ihr Container.** Jede Aufgabe (Repository + Basis-Branch) bekommt genau einen Container. Die Einrichtung läuft im Hintergrund in festen Schritten: Image prüfen, Repository klonen (nach `<Daten>/workspaces/<id>/repo`, Git-Verlauf getrennt in `<Daten>/git/<id>`), Plugin erkennen (nur Plugin- und Theme-Repositorys mit `composer.json` vom Typ `shopware-platform-plugin`; ein vollständiges Shopware-Projekt wird mit klarer Meldung abgelehnt), Container starten, auf Shopware warten, bei hochgeladenem Dump Shopware-Version prüfen und Datenbank importieren, Storefront-Domain setzen, Plugin übertragen und mit `plugin:install --activate` aktivieren (Themes zusätzlich `theme:change`), eigene Befehle „nach der Datenbank“, `theme:compile` + `cache:clear`, eigene Befehle „zum Schluss“. Jeder eigene Befehl ist ein eigener Schritt (als `www-data` in `/var/www/html` mit `bash -lc`, die Umgebungsvariablen stehen bereit); schlägt einer fehl, stoppt die Einrichtung, und sie lässt sich ab diesem Schritt wiederholen. Gemessen mit `dockware/shopware:6.7.15.1` auf einem gewöhnlichen Host: Shopware antwortet beim ersten Start nach etwa 75 s, nach einer Pause nach etwa 43 s; `theme:compile` dauert 7–14 s (mit dem älteren `dockware/play:6.7.2.2` antwortete Shopware nach etwa 20 s).

- In den Container kommen nur die Dateien des Repositorys als Archiv (Eigentümer `www-data`), nie `.git`, `.env*`, Schlüssel (`*.pem`, `*.key`, `id_rsa` …), `auth.json`, `node_modules` oder Symlinks nach außen. Es gibt keine Host-Pfade im Container.
- Dockware startet seine Dienste mit `sudo`, deshalb ist `no-new-privileges` nicht möglich; stattdessen entzieht Lotse zusätzlich zu den Docker-Standards nicht benötigte Capabilities (`NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `SYS_CHROOT`, `SETFCAP`).
- Die Storefront antwortet nur auf `Host: localhost` (Dockware-Standard); Lotse schickt diesen Host-Kopf selbst, die Domain im Shop bleibt `http://localhost`. Die Vorschau (`/sbx/<id>.<schlüssel>/`) schreibt diese Adresse auf ihr Präfix um. Mit `LOTSE_PASSWORD` gilt für Pfade unter `/sbx/<id>.<schlüssel>/` der Schlüssel als Anmeldung (Ajax-Aufrufe aus der Vorschau tragen die Basic-Anmeldung nicht, opaker Origin): ein falscher Schlüssel ergibt 404, ein richtiger erreicht nur den Container dieser Aufgabe. Der Schlüssel steht nur in der angemeldeten Oberfläche – gib Vorschau-Adressen nicht weiter.
- **Pause:** Nach der eingestellten Inaktivität (Standard 30 Minuten; ein offener Aufgaben-Tab zählt als Aktivität) stoppt Lotse den Container, löscht ihn aber nicht: Code, Datenbank und Änderungen bleiben. **Fortsetzen** startet ihn wieder, wartet auf Shopware und überträgt den Arbeitsstand vollständig – ohne neue Einrichtung (gemessen etwa 45 s). Läuft schon `LOTSE_SANDBOX_MAX` Container, pausiert ein weiterer Start den am längsten unbenutzten; sind alle noch in der Einrichtung, antwortet Lotse mit „Es laufen bereits … Sandboxes“.
- **Datenbank-Dump:** Ein hochgeladener Dump (`.sql`/`.sql.gz`, nur bereinigt) landet in `<Daten>/dumps/<id>/data` (Rechte 0600, nicht im Backup von `make backup`). Vor dem Import vergleicht Lotse die Shopware-Version aus den Core-Migrationen des Dumps mit `bin/console --version` des Images; weicht die Hauptversion (z. B. 6.6 gegen 6.7) ab, stoppt die Einrichtung, bis „Trotzdem fortfahren“ gewählt wird. Der Import streamt die Datei nach `/tmp/lotse-import` im Container und spielt sie mit einem festen Befehl ein (`gunzip -cf … | mysql … shopware`, danach `rm`); auf dem Host und im Container wird sie sofort danach gelöscht, auch bei einem Fehler. Nicht importierte Dumps löscht Lotse nach 24 Stunden, beim Abschließen der Aufgabe und beim Aufräumen nach einem Neustart. Da der Dump die ganze Datenbank ersetzt, kommen danach Domain, Plugin-Installation, eigene Befehle „nach der Datenbank“ und `theme:compile`. Live geprüft mit einem `mysqldump` von `dockware/shopware:6.7.15.1` (Import etwa 20 s).
- **Aufgabe abschließen** löscht Container (samt Volumes), Arbeitsordner, Git-Verlauf, hochgeladenen Dump und Screenshots; die Aufgabe bleibt als Eintrag in der Liste. Ein Neustart von Lotse markiert laufende Schritte als „unterbrochen“, entfernt Lotse-Container ohne Aufgabe und übernimmt den Zustand der übrigen (laufend = bereit, gestoppt = pausiert).

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
