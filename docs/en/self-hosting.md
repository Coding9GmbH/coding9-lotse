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

Sandbox Coding starts a separate Shopware container (`dockware/shopware`) per code task, in which the AI works on a plugin or theme, a new plugin, a whole Shopware project, an own setup or no project at all (the cases from the user’s point of view: [user guide](user-guide.md#start-sandbox-every-case)). For this, Lotse needs access to Docker. The feature is **off by default** and is switched on under **Settings → Sandbox**.

> **Docker access is root access to the host.** Anyone who can use Lotse can start containers. The socket proxy below is an additional layer; the real boundary is the container spec that only the Lotse server builds: a configured, versioned `dockware/shopware` image, no host paths, no privileges, no devices, resource limits, and only containers labelled `lotse.managed=1`. The AI never gets Docker access.

Lotse does **not** switch the sandbox on (and blocks it if it is already on) while it is reachable from the network without `LOTSE_PASSWORD` (open address or `ALLOWED_HOSTS`). `LOTSE_SANDBOX=0` switches it off hard, regardless of the switch.

**Option 1: Lotse in Docker (recommended).** `make sandbox-up` starts Lotse together with [`docker-compose.sandbox.yml`](../../docker-compose.sandbox.yml):

```sh
make sandbox-up
# same as: docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

- A socket proxy (`tecnativa/docker-socket-proxy`, pinned by digest) gets the Docker socket; Lotse talks to it via `DOCKER_HOST=tcp://docker-proxy:2375` on an internal network. Only containers (incl. start/stop), images, networks, exec and volumes (for stored databases; Lotse only creates its own, labelled ones) are allowed; build, swarm, secrets, system and others are blocked.
- Task containers are attached to the internal network `lotse-sandbox` (`internal: true`, pinned subnet `10.213.0.0/24`, gateway `isolated`): no internet, no published ports, and the host has no address on that network – services on the host (such as a live shop or its database on the same server) are out of reach of the containers. This needs Docker Engine 28 or newer; the setup refuses older versions. Lotse reaches them directly; the preview goes through Lotse. The other way round, Lotse refuses every request from that subnet (`LOTSE_SANDBOX_SUBNET`), even without `LOTSE_PASSWORD`. If the subnet clashes with your network, change it in the file in both places.
- **Internet only after approval:** when a human allows internet for a task (card in the chat or the “Internet: off/on” switch), Lotse additionally attaches its container to the network `lotse-sandbox-egress` – a plain bridge network with internet that Lotse creates on demand (label `lotse.managed=1`, pinned subnet `10.214.0.0/24` via `LOTSE_SANDBOX_EGRESS_SUBNET`, `enable_icc=false`: task containers cannot reach each other there). Lotse itself is not attached to that network and refuses requests from its subnet as well. Blocking, pausing and finishing detach the container again; after resuming it is offline. **With internet the container reaches any public address – including your live shop’s public address – and, via that network’s gateway, host services** not listening on `127.0.0.1` only. So only allow it when needed; switch it off entirely with “Internet in the container: never” in the environment.
- **Codex needs user namespaces:** Codex writes files inside its own sandbox (bubblewrap), and Docker's default seccomp profile blocks calls it needs. The overlay therefore mounts [`docker/seccomp-codex.json`](../../docker/seccomp-codex.json): Docker's default profile plus `unshare`, `clone`, `setns`, `mount`, `pivot_root` and `sethostname` without `CAP_SYS_ADMIN`. Capabilities stay dropped; the calls only act inside a new user namespace. Without this profile Codex reports "Failed to write file". Claude is not affected.
- The normal `docker-compose.yml` stays hardened as before (read-only, no capabilities, no socket).

**Option 2: Lotse directly on a Linux host.** Lotse uses `DOCKER_HOST` (default `unix:///var/run/docker.sock`); the user Lotse runs as needs access to the socket. Here too the task containers sit only on the internal network `lotse-sandbox` (no internet, no published ports); Lotse reaches the storefront via the container’s IP on that network (on Linux the host has a route into Docker bridges). **Caution:** the other way round, the container reaches the host via that network’s gateway address – every service not listening on `127.0.0.1` only, e.g. nginx and MySQL of a live shop on the same server. The setup probes common ports (SSH, HTTP/S, MySQL, PostgreSQL, Redis, Elasticsearch, Memcached, MongoDB, Lotse) and writes a warning to the log if one answers. Remedy: a firewall rule that drops new connections from the subnet and lets replies through, e.g. `iptables -I INPUT -s <subnet> -m conntrack ! --ctstate ESTABLISHED,RELATED -j DROP` (subnet from `docker network inspect lotse-sandbox`, pinnable with `LOTSE_SANDBOX_SUBNET`; persist the rule) – or use option 1. Where that is not possible (Docker Desktop on macOS/Windows) the setup stops at “Start container” with a clear message – use option 1 then; Lotse deliberately never falls back to a network with internet access. Lotse should only listen on `127.0.0.1` (default), otherwise it would be reachable from the container via the gateway address; without `LOTSE_PASSWORD` the sandbox stays blocked on open addresses anyway. Containers created with a published port (older Lotse version) are not started any more: retry the setup from “Start container”. Internet after approval uses the network `lotse-sandbox-egress` here too; the firewall rule should then cover its subnet as well (`docker network inspect lotse-sandbox-egress`, pinnable with `LOTSE_SANDBOX_EGRESS_SUBNET`).

**More settings**

| Variable | Meaning |
|---|---|
| `LOTSE_SANDBOX` | `0` = hard off. Empty = the switch in the settings decides. |
| `DOCKER_HOST` | `unix:///path/docker.sock` or `tcp://host:port`. Other schemes (ssh, TLS) are not supported. |
| `LOTSE_SANDBOX_MAX` | Containers running at the same time (default 2). Another one pauses the least recently used. |
| `LOTSE_SANDBOX_IDLE_MINUTES` | Default idle pause (30 minutes); the value in the settings takes precedence. Paused means stopped, not deleted. |
| `LOTSE_SANDBOX_NETWORK` | `network` (Lotse itself on the network `lotse-sandbox`) or `local` (Lotse on the host reaches the container IP). The containers are only on the internal network either way. Empty = automatic. |
| `LOTSE_DUMP_MAX_MB` | Largest database dump in MB (default 2048). |
| `LOTSE_SANDBOX_DB_SNAPSHOTS` | `0` = no snapshots of stored databases (every sandbox imports the dump). Default: on. |
| `LOTSE_SANDBOX_SUBNET` | IPv4 subnet (CIDR) of `lotse-sandbox`; Lotse refuses requests from it. Default `10.213.0.0/24` (as in `docker-compose.sandbox.yml`). If the value is invalid, the sandbox needs `LOTSE_PASSWORD` in network mode. |
| `LOTSE_SANDBOX_EGRESS_SUBNET` | IPv4 subnet (CIDR) of `lotse-sandbox-egress` (internet after approval); Lotse refuses requests from it too. Set by `docker-compose.sandbox.yml` (`10.214.0.0/24`). Missing in network mode, internet can only be allowed with `LOTSE_PASSWORD`. |

In the **Sandbox Coding** tab you set defaults for “Start sandbox” (repository, base branch), the image (only `dockware/shopware:<version>`, optionally with `-amd64`/`-arm64`, no `latest` or `6.7-latest`; default `dockware/shopware:6.7.15.1`; older settings with the discontinued predecessor `dockware/play:<version>` keep working), plus environment variables (secret values encrypted, never shown again, removed from text sent to the AI; code in the container – including code the AI writes – can read them, so only credentials meant for the sandbox alone), your own setup commands, **Notes for the AI** (free text, at most 4000 characters, data in the prompt) and the stored database “Start sandbox” preselects. “Check environment” tests Docker and pulls the image (several GB) and, while the **Screenshot button in the preview** is switched on (default off), the browser image `mcr.microsoft.com/playwright:v1.64.0-noble` (about 2 GB; without it the first screenshot pulls it). Switching off stops running containers; they are not deleted. `make sandbox-clean` removes all containers labelled `lotse.managed=1`.

**Tasks and their container.** A sandbox is attached to a chat (at most one per chat); each task (repository + base branch) gets exactly one container. The setup runs in the background in fixed steps: check the image, clone the repository (into `<data>/workspaces/<id>/repo`, git history separately in `<data>/git/<id>`), detect the plugin (first reads `.lotse/sandbox.json`, see below; plugin and theme repositories with a `composer.json` of type `shopware-platform-plugin`; a whole Shopware project – `composer.json` of type `project` requiring `shopware/core` – is brought in in “Overlay” mode, see below; an empty repository with at most README, LICENSE and .gitignore becomes a new plugin under `custom/plugins/<Name>` with the name chosen in the dialog; installing is skipped, and without a dump `theme:compile` too), start the container, wait for Shopware, with an uploaded dump check the Shopware version and import the database, set the storefront domain, tidy the preview (Symfony’s debug toolbar off via `config/packages/dev/zz-lotse-preview.yaml` and Shopware’s cookie notice via `core.basicInformation.useDefaultCookieConsent` – in the sandbox only, the shop stays in dev mode; a failure only skips this step), transfer the plugin and activate it with `plugin:install --activate` (themes also `theme:change`), own commands “after the database”, `theme:compile` + `cache:clear`, own commands “at the end”. The setup takes no screenshots – only the button in the preview does, when switched on. Each own command is a step of its own (as `www-data` with `bash -lc` in `/var/www/html` – with an own setup the sandbox’s commands and those from `.lotse/sandbox.json` run in the target folder –; the environment variables are available, the sandbox’s own variables take precedence over the environment’s of the same name); if one fails, the setup stops and can be retried from that step. Measured with `dockware/shopware:6.7.15.1` on an ordinary host: Shopware answers after about 75 s on the first start and after about 43 s after a pause; `theme:compile` takes 7–14 s (with the older `dockware/play:6.7.2.2` Shopware answered after about 20 s).

**Whole Shopware projects, installed completely (default).** If the repository is a whole project (laid out like `shopware/production`), Lotse transfers the whole repository to `/var/www/html` – without secrets (`.env*`, keys, `auth.json` …), `.git`, `node_modules/`, `vendor/`, `var/`, `files/`, `.lotse/`, `config/jwt` and the generated folders below `public/` (`bundles`, `theme`, `media`, `thumbnail`, `sitemap`); the configuration files Lotse checks (`config/packages/**`, `config/services*.yaml`) follow only after `composer install`. Then the step **Bring in the project** waits until a human clicks **Internet: off** at the top of the sandbox and confirms (the same approval as for the AI, audited; the task shows “Waiting for internet”, the chat a status line), runs `composer install --no-scripts --prefer-dist` from the project’s `composer.lock` as `www-data` (at most 20 minutes; private packages via a secret environment variable `COMPOSER_AUTH` of the sandbox environment) and detaches the container from the internet network right after – also when composer fails (the error then names the likely cause: credentials, network, PHP version, lock file). After that as below: read the runtime (now with the project’s bundles), plan and sync the configuration, boot check, `bin/console database:migrate --all`, plugins, apps, theme, `assets:install`. For projects installed completely the step has 90 minutes (waiting included). Later changes are transferred the same way (also `composer.json`, `bin/`, `public/index.php`); “Take over from the container” then reads the whole shop folder (without `vendor/`, `var/`, `public/`). If internet is switched off in the environment (“never”) or impossible without an egress subnet, the setup falls back to “Overlay” with a note in the log; `"projectInstall": "overlay"` in `.lotse/sandbox.json` picks it for good.

**Whole Shopware projects (Overlay).** In “Overlay” mode the image’s Shopware stays installed; Lotse transfers only `custom/plugins/*`, `custom/static-plugins/*`, `custom/apps/*`, `config/packages/**`, `config/services*.yaml` and `src/` over it – at the same path in `/var/www/html`. Never transferred: `composer.json`/`composer.lock`, `config/bundles.php`, routes, `.env*`, keys, `vendor/`, `var/` and `public/`. The step **Bring in the project** first reads `APP_ENV`, the available configuration extensions (`bin/console debug:config`) and the names of the defined environment variables (never their values) from the clean image, has the container’s Symfony parser read the project’s YAML configuration (in a working folder below `/tmp`, not loaded) and writes `config/services_<APP_ENV>.yml` – in the container only, never into the repository. Shopware loads `config/packages/*`, `config/packages/<APP_ENV>/**`, `config/services.*` and last `config/services_<APP_ENV>.*`, each sorted; so this file is the very last one and also wins over extension config in `config/services*.yaml` (which Lotse therefore checks too). It switches what the project actually configures: Redis cache, sessions, cart and number ranges to files or MySQL, locks to `flock`, message queues to `sync://` (`failed` to Doctrine), the mailer to the mail catcher (`smtp://127.0.0.1:1025`; with `transports` each one, `dsn` then empty – Symfony refuses both together), S3/CDN filesystems to local (public ones with `%env(APP_URL)%` as URL), OpenSearch/Elasticsearch off, cluster setup and reverse proxy off, the theme config loader back to the database, remote log handlers (e.g. gelf) to `null`, and sets every `%env(NAME)%` the container does not define to empty. Files that need an extension the image lacks (e.g. `sentry:`, `frosh_tools:`), that are not valid YAML, PHP and XML configuration below `config/packages/` (cannot be checked) and a project file named `config/services_<APP_ENV>.yml` are not loaded in the sandbox. If a project file overwrites one of the image’s files (e.g. `config/packages/lock.yaml`), the first sync keeps the image’s `config/` and `src/` in `var/lotse-image`; when the project file is not loaded or deleted in the repository, the image’s version comes back. Folders the repository contains as symlinks (e.g. `custom/plugins` → a folder outside) are never read by Lotse: every path component from the working folder down must be a real folder. A whole sync has one shared limit (20,000 files, 256 MB across all plugins, configuration and `src/`), checked before a file is read; `sandbox_bash` mirrors a project only when something changed since the last sync (paths, sizes, modification times). Then: static plugins via an offline `composer require` from the path repository (as in production; for that the image’s `composer.json` briefly gets only the path repositories, the original ones are restored afterwards), further `psr-4` namespaces of `src/` via `composer dump-autoload`, a boot check (`bin/console about`; if the error names a configuration file, that file is taken out, at most five rounds – otherwise the step stops with Shopware’s message and the likely file), `plugin:refresh` and `plugin:install --activate` for all plugins of the project in one call (for projects the step has 15 instead of 5 minutes), `app:install --activate --force` for apps (apps with a server of their own need internet), the project’s theme via `theme:change` and finally `cache:clear` plus `cache:pool:clear --all`. With a database dump its plugin table decides: plugins the dump knows keep their state, only new ones are installed, the theme stays as in the dump; active plugins without code (store or composer plugins) are named in the log first, because `plugin:refresh` removes them from the sandbox’s database. If `composer.lock` names a branch instead of a version (e.g. `6.7.x-dev`), the log says so and nothing is compared. If the Shopware version in `composer.lock` differs from the image in major.minor, the setup stops at **Detect Shopware project** with the matching image (`dockware/shopware:<version>`) and **Continue anyway**. Packages the project requires that the image lacks are named in the log; they are not installed offline. Only the complete installation (above) fetches them. Measured offline with a project of three plugins, a static plugin, an app, a theme, `src/` and production configuration (Redis, OpenSearch, S3/CDN, AMQP, SMTP, gelf, Sentry): about 45 s from the moment Shopware answers.

**Own setup, without a project and `.lotse/sandbox.json`.** With an **own setup** the container stays an ordinary Dockware container. Lotse puts the repository (owned by `www-data`) into the target folder – absolute, below `/var/www`, `/opt` or `/srv`, default `/opt/<repository>`; missing parent folders are created by root –, runs no Shopware steps (installing the plugin, tidying the preview and `theme:compile` are skipped, “Ready” only reports the HTTP status of the start page) and, on the next full sync, only removes files it wrote there itself (list in `/var/tmp/lotse-custom-sync.txt` in the container). **Without a project** nothing is cloned: the working copy is a local git with an empty start commit (author “Lotse”). **Create as GitHub project** creates an empty private repository with the stored token (like “Create a new project”, with the permission “Administration: Read and write”) and uploads the start commit as `main`; from then on publishing works like for any sandbox. Lotse reads **`.lotse/sandbox.json`** from the working copy (at most 64 KB, no symlinks). Its commands only run once a human has allowed them for this repository and exactly this content of the file (SHA-256); the approvals are kept in Lotse’s database (the last 20 per repository) and are in the audit log with the user. Values of environment variables never come from the file; another image only as a tag of the configured one (e.g. `"image": "6.7.14.0"` → `dockware/shopware:6.7.14.0`, which the setup then pulls). For the hint in the dialog, Lotse clones the repository beforehand (at most 50 commits, one branch) into `<data>/probe/`, only reads it, deletes the clone at once and keeps the result for a minute.

- Only the repository's files reach the container, as an archive owned by `www-data`; never `.git`, `.env*`, keys (`*.pem`, `*.key`, `id_rsa` …), `auth.json`, `node_modules` or symlinks pointing outside. There are no host paths in the container.
- Dockware starts its services with `sudo`, so `no-new-privileges` is not possible; instead Lotse drops capabilities the services do not need on top of Docker's defaults (`NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `SYS_CHROOT`, `SETFCAP`).
- The storefront only answers `Host: localhost` (Dockware's default); Lotse sends that host header itself, the shop's domain stays `http://localhost`. The preview (`/sbx/<id>.<key>/`) rewrites that address to its prefix. With `LOTSE_PASSWORD`, paths below `/sbx/<id>.<key>/` take the key as the sign-in (ajax calls from the preview do not carry Basic credentials, opaque origin): a wrong key gets a 404, a right one only reaches that task's container. The key only appears in the signed-in UI – do not pass preview addresses on.
- **Pause:** after the configured inactivity (default 30 minutes; an open chat with a sandbox and every AI turn count as activity) Lotse stops the container but does not delete it: code, database and changes stay. **Resume** starts it again, waits for Shopware and transfers the working copy in full – without a new setup (measured about 45 s). If `LOTSE_SANDBOX_MAX` containers already run, starting another one pauses the least recently used; if all of them are still being set up, Lotse answers “Es laufen bereits … Sandboxes”.
- **Database dump:** an uploaded dump (`.sql`/`.sql.gz`, sanitized only) is stored in `<data>/dumps/<id>/data` (mode 0600, not in the `make backup` archive). A dump with `USE` or `CREATE DATABASE` (from `mysqldump --databases`/`--all-databases`) is refused on upload, since it would be imported beside the shop database. Before the import Lotse compares the Shopware version from the dump's core migrations with the image's `bin/console --version`; if the minor version differs (e.g. 6.6 vs. 6.7) the setup stops until “Continue anyway” is chosen. The import streams the file to `/tmp/lotse-import` in the container and loads it with a fixed command (`gunzip -cf … | mysql … shopware`, then `rm`); a one-off dump is deleted on the host and in the container right afterwards, also on failure (of a stored database only the copy in the container, see below). Dumps not imported are deleted after 24 hours, when the task is finished and by the cleanup after a restart. Since the dump replaces the whole database, domain, plugin installation, own commands “after the database” and `theme:compile` follow it. Checked live with a `mysqldump` of `dockware/shopware:6.7.15.1` (import about 20 s). **Stored databases** (tick “Store for further sandboxes”, on by default) live in `<data>/dumps/library/<id>/data` and stay until someone deletes them in the list (not in backups either). For the faster start Lotse creates one Docker volume `lotse-db-<id>-<hash>` per stored database and image with a copy of the MySQL data directory, and one volume `lotse-taskdb-<task>` per task with a stored database – both in Docker's data directory, about as large as the imported database (measured: 784 MB for a 241 MB dump). With a snapshot a new sandbox was ready in 80–93 s instead of 108–126 s over three runs each (details: architecture). `LOTSE_SANDBOX_DB_SNAPSHOTS=0` switches it off.
- **Finish sandbox** deletes the container (with its database volume), working folder, git history, a one-off dump and screenshots – a stored database stays; the task stays in the list as a record. A Lotse restart marks running steps as “interrupted”, removes Lotse containers without a task and takes over the state of the others (running = ready, stopped = paused).

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
