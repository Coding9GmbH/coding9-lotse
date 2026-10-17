[Deutsch](../self-hosting.md) · **English**

# Self-hosting Lotse (server, login, HTTPS)

By default, Lotse only runs on your own machine (`127.0.0.1`). You can also run it on a server so a team can access it. In that case: **set a login, put HTTPS in front, allow the host names.** This document describes how, and what Lotse enforces along the way.

> Anyone who can reach Lotse can approve changes to the shop after logging in. Treat the password like admin access.

## What Lotse provides for server operation

| Feature | Behavior |
|---|---|
| **Login** | `LOTSE_PASSWORD` set → every page and every API call requires HTTP Basic Auth. Only the **password value** counts; the user name is arbitrary (e.g. `lotse`). The password is compared in constant time (UTF-8, non-ASCII characters work). |
| **Login throttle** | After 10 wrong passwords within 15 minutes Lotse answers that source address with `429` for 5 minutes (in memory, reset on restart). Behind a local reverse proxy the last entry in `X-Forwarded-For` counts; if the proxy runs on another machine (or as a Kubernetes ingress), add its address to `LOTSE_TRUSTED_PROXIES` (IPs or IPv4 CIDR, comma-separated) – otherwise all users share one counter. |
| **Host name allowlist** | Only `localhost`, `127.0.0.1` and `[::1]` (and only from there) plus the names from `ALLOWED_HOSTS` are served. Everything else responds with `403 Host nicht erlaubt` (“host not allowed”; protection against DNS rebinding). “From there” is checked against the real socket address, not only `X-Forwarded-For` (a client can set that itself). |
| **Protection against foreign sites** | Write calls require the interface marker (`x-lotse: 1`), and an `Origin` must match the `Host` (CSRF). |
| **Health check** | `GET /api/ping` is reachable without login (returns only `{"ok":true,"version":…}`), e.g. for a Docker health check or monitoring. |
| **Startup warning** | Outside Docker, Lotse warns at startup if it listens on an open address without `LOTSE_PASSWORD`. `ALLOWED_HOSTS` without `LOTSE_PASSWORD` is always reported, at startup and as a notice in the settings. |
| **Security headers** | UI and API: `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`, `nosniff`, `Referrer-Policy: same-origin`. The shop preview (`/shop`) sets its own sandbox CSP. |

What it does **not** have: individual user accounts or roles (one shared password), its own TLS (use the reverse proxy for that) and a permanent account lockout (the login throttle above is deliberately simple; further limits at the proxy, see below).

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

## Enable Sandbox Coding

Sandbox Coding starts a separate Shopware container (`dockware/shopware`) per code task, in which the AI works on a plugin or theme. For this, Lotse needs access to Docker. The feature is **off by default** and is switched on under **Settings → Sandbox**.

> **Docker access is root access to the host.** Anyone who can use Lotse can start containers. The socket proxy below is an additional layer; the real boundary is the container spec that only the Lotse server builds: a configured, versioned `dockware/shopware` image, no host paths, no privileges, no devices, resource limits, and only containers labelled `lotse.managed=1`. The AI never gets Docker access.

Lotse does **not** switch the sandbox on (and blocks it if it is already on) while it is reachable from the network without `LOTSE_PASSWORD` (open address or `ALLOWED_HOSTS`). `LOTSE_SANDBOX=0` switches it off hard, regardless of the switch.

**Option 1: Lotse in Docker (recommended).** `make sandbox-up` starts Lotse together with [`docker-compose.sandbox.yml`](../../docker-compose.sandbox.yml):

```sh
make sandbox-up
# same as: docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

- A socket proxy (`tecnativa/docker-socket-proxy`, pinned by digest) gets the Docker socket; Lotse talks to it via `DOCKER_HOST=tcp://docker-proxy:2375` on an internal network. Only containers (incl. start/stop), images, networks and exec are allowed; volumes, build, swarm, secrets, system and others are blocked.
- Task containers are attached to the internal network `lotse-sandbox` (`internal: true`, pinned subnet `10.213.0.0/24`): no internet, no live shop, no published ports. Lotse reaches them directly; the preview goes through Lotse. The other way round, Lotse refuses every request from that subnet (`LOTSE_SANDBOX_SUBNET`), even without `LOTSE_PASSWORD`. If the subnet clashes with your network, change it in the file in both places.
- The normal `docker-compose.yml` stays hardened as before (read-only, no capabilities, no socket).

**Option 2: Lotse directly on the host.** Lotse uses `DOCKER_HOST` (default `unix:///var/run/docker.sock`); the user Lotse runs as needs access to the socket. Each task container publishes port 80 on `127.0.0.1` only (on a port Lotse picks).

**More settings**

| Variable | Meaning |
|---|---|
| `LOTSE_SANDBOX` | `0` = hard off. Empty = the switch in the settings decides. |
| `DOCKER_HOST` | `unix:///path/docker.sock` or `tcp://host:port`. Other schemes (ssh, TLS) are not supported. |
| `LOTSE_SANDBOX_MAX` | Containers running at the same time (default 2). Another one pauses the least recently used. |
| `LOTSE_SANDBOX_IDLE_MINUTES` | Default idle pause (30 minutes); the value in the settings takes precedence. Paused means stopped, not deleted. |
| `LOTSE_SANDBOX_NETWORK` | `network` (internal network) or `local` (ports on 127.0.0.1). Empty = automatic. |
| `LOTSE_DUMP_MAX_MB` | Largest database dump in MB (default 2048). |
| `LOTSE_SANDBOX_SUBNET` | IPv4 subnet (CIDR) of `lotse-sandbox`; Lotse refuses requests from it. Set by `docker-compose.sandbox.yml`. Missing in network mode, the sandbox needs `LOTSE_PASSWORD`. |

In the **Sandbox Coding** tab you set the image (only `dockware/shopware:<version>`, optionally with `-amd64`/`-arm64`, no `latest` or `6.7-latest`; default `dockware/shopware:6.7.15.1`; older settings with the discontinued predecessor `dockware/play:<version>` keep working), plus environment variables (secret values encrypted, never shown again, removed from text sent to the AI; code in the container – including code the AI writes – can read them, so only credentials meant for the sandbox alone) and your own setup commands. “Check environment” tests Docker and pulls the image (several GB). Switching off stops running containers; they are not deleted. `make sandbox-clean` removes all containers labelled `lotse.managed=1`.

**Tasks and their container.** Each task (repository + base branch) gets exactly one container. The setup runs in the background in fixed steps: check the image, clone the repository (into `<data>/workspaces/<id>/repo`, git history separately in `<data>/git/<id>`), detect the plugin (only plugin and theme repositories with a `composer.json` of type `shopware-platform-plugin`; a full Shopware project is refused with a clear message), start the container, wait for Shopware, with an uploaded dump check the Shopware version and import the database, set the storefront domain, transfer the plugin and activate it with `plugin:install --activate` (themes also `theme:change`), own commands “after the database”, `theme:compile` + `cache:clear`, own commands “at the end”. Each own command is a step of its own (as `www-data` in `/var/www/html` with `bash -lc`, the environment variables are available); if one fails, the setup stops and can be retried from that step. Measured with `dockware/shopware:6.7.15.1` on an ordinary host: Shopware answers after about 75 s on the first start and after about 43 s after a pause; `theme:compile` takes 7–14 s (with the older `dockware/play:6.7.2.2` Shopware answered after about 20 s).

- Only the repository's files reach the container, as an archive owned by `www-data`; never `.git`, `.env*`, keys (`*.pem`, `*.key`, `id_rsa` …), `auth.json`, `node_modules` or symlinks pointing outside. There are no host paths in the container.
- Dockware starts its services with `sudo`, so `no-new-privileges` is not possible; instead Lotse drops capabilities the services do not need on top of Docker's defaults (`NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `SYS_CHROOT`, `SETFCAP`).
- The storefront only answers `Host: localhost` (Dockware's default); Lotse sends that host header itself, the shop's domain stays `http://localhost`. The preview (`/sbx/<id>.<key>/`) rewrites that address to its prefix. With `LOTSE_PASSWORD`, paths below `/sbx/<id>.<key>/` take the key as the sign-in (ajax calls from the preview do not carry Basic credentials, opaque origin): a wrong key gets a 404, a right one only reaches that task's container. The key only appears in the signed-in UI – do not pass preview addresses on.
- **Pause:** after the configured inactivity (default 30 minutes; an open task tab counts as activity) Lotse stops the container but does not delete it: code, database and changes stay. **Resume** starts it again, waits for Shopware and transfers the working copy in full – without a new setup (measured about 45 s). If `LOTSE_SANDBOX_MAX` containers already run, starting another one pauses the least recently used; if all of them are still being set up, Lotse answers “Es laufen bereits … Sandboxes”.
- **Database dump:** an uploaded dump (`.sql`/`.sql.gz`, sanitized only) is stored in `<data>/dumps/<id>/data` (mode 0600, not in the `make backup` archive). A dump with `USE` or `CREATE DATABASE` (from `mysqldump --databases`/`--all-databases`) is refused on upload, since it would be imported beside the shop database. Before the import Lotse compares the Shopware version from the dump's core migrations with the image's `bin/console --version`; if the minor version differs (e.g. 6.6 vs. 6.7) the setup stops until “Continue anyway” is chosen. The import streams the file to `/tmp/lotse-import` in the container and loads it with a fixed command (`gunzip -cf … | mysql … shopware`, then `rm`); it is deleted on the host and in the container right afterwards, also on failure. Dumps not imported are deleted after 24 hours, when the task is finished and by the cleanup after a restart. Since the dump replaces the whole database, domain, plugin installation, own commands “after the database” and `theme:compile` follow it. Checked live with a `mysqldump` of `dockware/shopware:6.7.15.1` (import about 20 s).
- **Finish task** deletes the container (with its volumes), working folder, git history, uploaded dump and screenshots; the task stays in the list as a record. A Lotse restart marks running steps as “interrupted”, removes Lotse containers without a task and takes over the state of the others (running = ready, stopped = paused).

## Data, backups, updates

- **Data** lives in the Docker volume `lotse-data` (`/data`): database (chats, audit log), knowledge base, style guide, rules, custom checks, encrypted credentials **and `secret.key`**. Without `secret.key`, stored credentials are useless: always back up the whole volume.
  `make backup` writes an archive to `./backups`, `make restore FILE=backups/lotse-….tgz` restores it (briefly stopping Lotse).
  The database runs in WAL mode; simply copying its files while Lotse runs can capture a half-written state. So while Lotse is running, `make backup` first creates a consistent snapshot with `VACUUM INTO` (`docker/db-snapshot.mjs`, inside the container at `/data/.backup/`, removed afterwards) and archives it as `aicb.db` together with all other files (`secret.key`, knowledge, Claude sessions …). If Lotse is stopped, the database is backed up directly. Older archives can still be restored. Sandbox Coding working copies (`workspaces/`, `git/`) and database dumps (`dumps/`) are deliberately left out of `make backup`.
  Your own backup without `make`: `docker compose exec -T lotse node --input-type=module - < docker/db-snapshot.mjs`, then back up `/data` without `aicb.db`, `aicb.db-wal` and `aicb.db-shm` and add `/data/.backup/aicb.db` as `aicb.db`.
- **Cost brake:** `LOTSE_AI_BUDGET_USD` (or Settings → Connect AI) limits Claude costs per calendar month (UTC). Lotse stores the cost of every run in the database (`ai_usage`, 400 days); `GET /api/usage` returns month, day and the last 30 days. Costs are Agent SDK estimates; image AI and the connection test are not included. Each run gets at most half of the budget still free as its limit (running runs reserve their share), so parallel chats cannot exceed the budget either. An aborted run without a cost report is counted with the next run of the same chat.
- **Log retention:** the access log is pruned after `LOTSE_LOG_RETENTION_DAYS` days (default 180), the change log after `LOTSE_AUDIT_RETENTION_DAYS` days (default 365, at least 30). `0` = never prune. Pruning runs at startup and then at most once a day. "Undo" is not affected: the previous values are stored in the chat, not in the log.
- **Who approved?** With `LOTSE_PASSWORD`, the change log records the user name entered at login (apply and undo). For teams: give each person their own user name (the password stays the same).
- **File permissions:** the database (incl. `-wal`/`-shm`) and `secret.key` are created with mode `600`, also outside Docker.
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
