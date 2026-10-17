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

## Daten, Sicherung, Updates

- **Daten** liegen im Docker-Volume `lotse-data` (`/data`): Datenbank (Chats, Audit-Log), Wissensbasis, Styleguide, Regeln, eigene Prüfungen, verschlüsselte Zugangsdaten **und `secret.key`**. Ohne `secret.key` sind gespeicherte Zugangsdaten unbrauchbar: Sicherung immer das ganze Volume.
  `make backup` legt ein Archiv unter `./backups` ab, `make restore FILE=backups/lotse-….tgz` spielt es zurück (stoppt Lotse dabei kurz).
  Die Datenbank läuft im WAL-Modus; ein bloßes Kopieren der Dateien im laufenden Betrieb kann einen halben Stand erwischen. Darum erstellt `make backup` bei laufendem Lotse zuerst per `VACUUM INTO` einen stimmigen Schnappschuss (`docker/db-snapshot.mjs`, im Container nach `/data/.backup/`, danach wieder entfernt) und sichert ihn als `aicb.db` zusammen mit allen übrigen Dateien (`secret.key`, Wissen, Claude-Sitzungen …). Ist Lotse gestoppt, wird die Datenbank direkt gesichert. Ältere Archive lassen sich weiterhin einspielen.
  Eigene Sicherung ohne `make`: `docker compose exec -T lotse node --input-type=module - < docker/db-snapshot.mjs`, dann `/data` ohne `aicb.db`, `aicb.db-wal` und `aicb.db-shm` sichern und `/data/.backup/aicb.db` als `aicb.db` dazulegen.
- **Kostenbremse:** `LOTSE_AI_BUDGET_USD` (oder Einstellungen → KI verbinden) begrenzt die Claude-Kosten je Kalendermonat (UTC). Lotse speichert die Kosten jeder Runde in der Datenbank (`ai_usage`, 400 Tage); `GET /api/usage` liefert Monat, Tag und die letzten 30 Tage. Die Kosten sind Schätzungen des Agent SDK; Bild-KI zählt nicht mit.
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
