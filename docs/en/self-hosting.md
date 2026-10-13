[Deutsch](../self-hosting.md) · **English**

# Self-hosting Lotse (server, login, HTTPS)

By default, Lotse only runs on your own machine (`127.0.0.1`). You can also run it on a server so a team can access it. In that case: **set a login, put HTTPS in front, allow the host names.** This document describes how, and what Lotse enforces along the way.

> Anyone who can reach Lotse can approve changes to the shop after logging in. Treat the password like admin access.

## What Lotse provides for server operation

| Feature | Behavior |
|---|---|
| **Login** | `LOTSE_PASSWORD` set → every page and every API call requires HTTP Basic Auth. Only the **password value** counts; the user name is arbitrary (e.g. `lotse`). The password is compared in constant time. |
| **Host name allowlist** | Only `localhost`, `127.0.0.1` and `[::1]` (and only from there) plus the names from `ALLOWED_HOSTS` are served. Everything else responds with `403 Host nicht erlaubt` (“host not allowed”; protection against DNS rebinding). |
| **Protection against foreign sites** | Write calls require the interface marker (`x-lotse: 1`), and an `Origin` must match the `Host` (CSRF). |
| **Health check** | `GET /api/ping` is reachable without login (returns only `{"ok":true,"version":…}`), e.g. for a Docker health check or monitoring. |
| **Startup warning** | Outside Docker, Lotse warns at startup if it listens on an open address without `LOTSE_PASSWORD`. |

What it does **not** have: individual user accounts or roles (one shared password), its own TLS (use the reverse proxy for that) and a lockout after failed attempts (rate-limit at the proxy, see below).

## Configuration

In the `.env` next to `docker-compose.yml`:

```env
# Login (required on a server). Long and random: openssl rand -base64 32
LOTSE_PASSWORD=…
# Names under which Lotse is reachable (comma-separated, without scheme and port)
ALLOWED_HOSTS=lotse.example.com
# AI access. On servers, the API key is the simple route
ANTHROPIC_API_KEY=…
```

Shop access and other values as on your own machine (see [`.env.example`](../../.env.example) or the settings in the interface). `LOTSE_BIND` stays `127.0.0.1`: it states that the container port is only published on loopback and ensures that Lotse does not print a false warning.

## Option A: reverse proxy on the same server (recommended)

Lotse stays on `127.0.0.1:3333` (as set by `docker-compose.yml`); a proxy on the host accepts HTTPS and forwards.

```sh
git clone https://github.com/Coding9GmbH/coding9-lotse.git lotse && cd lotse
cp .env.example .env     # enter LOTSE_PASSWORD, ALLOWED_HOSTS, AI and shop access
make up                  # builds the image and starts on 127.0.0.1:3333
```

**Caddy** (automatic HTTPS certificate):

```caddyfile
lotse.example.com {
  reverse_proxy 127.0.0.1:3333 {
    flush_interval -1          # chat replies are streamed, do not buffer
    transport http { read_timeout 10m }
  }
}
```

**nginx** (certificate e.g. via certbot):

```nginx
server {
  listen 443 ssl http2;
  server_name lotse.example.com;
  # ssl_certificate … / ssl_certificate_key …

  client_max_body_size 30m;            # image/file attachments (Lotse allows up to 25 MB)
  location / {
    proxy_pass http://127.0.0.1:3333;
    proxy_set_header Host $host;        # REQUIRED: without the original name the origin check fails
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;                # NDJSON stream of the chat
    proxy_read_timeout 600s;            # long AI turns
  }
}
```

Important for every proxy: **pass `Host` through unchanged**, **do not buffer responses**, **generous read timeout** (AI turns and shop writes take time).

## Option B: proxy in the same Docker network

If your proxy (Traefik, Caddy, nginx) runs as a container itself, Lotse does not need a published port. Add to a `docker-compose.override.yml`:

```yaml
services:
  lotse:
    ports: !reset []             # publish nothing (Compose ≥ 2.24)
    networks: [default, proxy]
networks:
  proxy:
    external: true               # your proxy's network
```

The proxy then points to `http://lotse:3333`. The same notes as above apply (`Host`, no buffering, timeouts). Container health check: `/api/ping`.

## Hardening at the proxy

- **HTTPS only.** Basic Auth sends the password with every request; over HTTP it could be read. Redirect HTTP to HTTPS.
- **Limit failed attempts**, e.g. with `limit_req` (nginx), the rate-limit module of Caddy/Traefik or fail2ban on the proxy log (response 401).
- **Restrict access** where possible: VPN, Tailscale/WireGuard or an IP allowlist at the proxy. The smaller the circle, the less depends on the password.
- **Use a dedicated integration with a restricted role** for shop access, not the admin login (see [SECURITY.en.md](../../SECURITY.en.md)).

## Data, backups, updates

- **Data** lives in the Docker volume `lotse-data` (`/data`): database (chats, audit log), knowledge base, style guide, rules, custom checks, encrypted credentials **and `secret.key`**. Without `secret.key`, stored credentials are useless: always back up the whole volume.
  `make backup` writes an archive to `./backups`, `make restore FILE=backups/lotse-….tgz` restores it (briefly stopping Lotse).
- **Update:** `git pull && make up` (from source) or `make update` (official image `ghcr.io/coding9gmbh/lotse`).
- **Several people** share one instance and therefore the same chats, rules and style guide. For separate shops, run one instance per shop (own volume, own host name).

## Troubleshooting

| Message | Cause |
|---|---|
| `403 Host nicht erlaubt` (host not allowed) | The name under which you access Lotse is not in `ALLOWED_HOSTS`. Enter it without port, comma-separated. If `localhost` also reports this error, the request comes through a proxy with a public source address: then use the real host name. |
| `403 Origin nicht erlaubt` (origin not allowed) | The proxy changed `Host` (e.g. to an internal name). Pass `Host` through unchanged (`proxy_set_header Host $host`). |
| `403 Kennung der Oberfläche fehlt` (interface marker missing) | A custom client calls the API without `x-lotse: 1`. The interface sends it itself. |
| `401 Login erforderlich` (login required) | `LOTSE_PASSWORD` is set and the browser sent no or wrong credentials. |
| Chat “hangs”, reply only arrives at the end | The proxy is buffering (set `proxy_buffering off` or `flush_interval -1`). |
| Aborts after 60 s | The proxy's read timeout is too short. |
