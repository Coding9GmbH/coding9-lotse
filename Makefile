# Lotse: AI pilot for Shopware 6 · `make help` lists all commands
SHELL        := /bin/sh
IMAGE        ?= ghcr.io/coding9gmbh/lotse
VERSION      ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
PORT         ?= 3333
COMPOSE      := LOTSE_IMAGE=$(IMAGE):local LOTSE_VERSION=$(VERSION) LOTSE_PORT=$(PORT) docker compose
BACKUP_DIR   ?= backups

.DEFAULT_GOAL := help
.PHONY: help env build up demo down stop restart logs ps shell open backup restore update clean dev check

help: ## Diese Hilfe
	@awk 'BEGIN{FS=":.*##"; printf "\n  \033[1mLotse\033[0m – make <befehl>\n\n"} /^[a-z-]+:.*##/{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST); printf '\n'

env: ## .env aus .env.example anlegen (falls nicht vorhanden)
	@[ -f .env ] && echo ".env existiert bereits" || (cp .env.example .env && chmod 600 .env && echo ".env angelegt – Zugangsdaten eintragen oder später in der Oberfläche setzen")

build: ## Docker-Image lokal bauen (…/lotse:local)
	docker build --build-arg VERSION=$(VERSION) --build-arg REVISION=$$(git rev-parse --short HEAD 2>/dev/null || echo unknown) -t $(IMAGE):local .

up: build ## Lotse bauen & starten → http://localhost:3333
	$(COMPOSE) up -d lotse
	@printf "\n  Lotse läuft: http://localhost:$(PORT)\n\n"

demo: build ## Lotse + Demo-Shop (dockware) starten → Shop auf http://localhost:8888
	$(COMPOSE) --profile demo up -d
	@printf "\n  Lotse:      http://localhost:$(PORT)\n"
	@echo "  Demo-Shop:  http://localhost:8888  (Admin: /admin · admin / shopware)"
	@printf "  In Lotse → Einstellungen: Shop-URL http://shopware, öffentliche URL http://localhost:8888\n\n"

down: ## Alles stoppen (Daten bleiben im Volume erhalten)
	$(COMPOSE) --profile demo down

restart: ## Lotse neu starten
	$(COMPOSE) restart lotse

logs: ## Logs verfolgen
	$(COMPOSE) logs -f --tail=200 lotse

ps: ## Status & Healthcheck
	$(COMPOSE) --profile demo ps

shell: ## Shell im Container
	$(COMPOSE) exec lotse sh

open: ## Oberfläche im Browser öffnen
	@(command -v open >/dev/null && open http://localhost:$(PORT)) || xdg-open http://localhost:$(PORT) 2>/dev/null || echo http://localhost:$(PORT)

# Backup: SQLite runs in WAL mode, so simply copying the files can capture a half-written state. If Lotse is running,
# docker/db-snapshot.mjs writes a consistent snapshot via VACUUM INTO to /data/.backup/aicb.db; the archive contains
# it as aicb.db (instead of the live file with -wal/-shm) plus all other files (secret.key, knowledge base, Claude sessions …).
# If Lotse is stopped, the database is idle and is backed up directly. Archives have the same format as before.
backup: ## Datenvolume sichern (DB-Schnappschuss, Schlüssel, Verlauf) nach ./backups
	@mkdir -p $(BACKUP_DIR)
	@if [ -n "$$($(COMPOSE) ps -q --status running lotse 2>/dev/null)" ]; then $(COMPOSE) exec -T lotse node --input-type=module - < docker/db-snapshot.mjs; \
	  else echo "Lotse läuft nicht – Datenbank ist in Ruhe und wird direkt gesichert"; fi
	docker run --rm -e TS=$$(date +%Y%m%d-%H%M%S) -v lotse_lotse-data:/data -v "$$PWD/$(BACKUP_DIR)":/backup busybox sh -c 'set -e; s=/tmp/lotse; mkdir -p $$s; cp -a /data/. $$s/; \
	  if [ -f $$s/.backup/aicb.db ]; then rm -f $$s/aicb.db $$s/aicb.db-wal $$s/aicb.db-shm; mv $$s/.backup/aicb.db $$s/aicb.db; fi; \
	  rm -rf $$s/.backup /data/.backup; tar czf /backup/lotse-$$TS.tgz -C $$s .'
	@ls -1t $(BACKUP_DIR) | head -1

restore: ## Sicherung einspielen: make restore FILE=backups/lotse-….tgz
	@[ -n "$(FILE)" ] || (echo "FILE=… angeben" && exit 1)
	$(COMPOSE) stop lotse
	docker run --rm -v lotse_lotse-data:/data -v "$$PWD/$(dir $(FILE))":/backup busybox sh -c 'set -e; rm -rf /data/* /data/.[!.]* /data/..?*; \
	  tar xzf /backup/$(notdir $(FILE)) -C /data; rm -rf /data/.backup; chown -R 1000:1000 /data'
	$(COMPOSE) start lotse

update: ## Neuestes offizielles Image holen und neu starten
	LOTSE_IMAGE=$(IMAGE):latest docker compose pull lotse
	LOTSE_IMAGE=$(IMAGE):latest docker compose up -d lotse

clean: ## Container, Image UND Daten löschen (fragt nach)
	@printf "Alle Lotse-Daten (Verlauf, Zugangsdaten, Audit-Log) löschen? [y/N] " && read a && [ "$$a" = y ]
	$(COMPOSE) --profile demo down -v --rmi local

dev: ## Entwicklungsserver ohne Docker (Node ≥ 22.13) → http://localhost:3333
	npm install && npm run dev

check: ## Typecheck, Lint und Tests
	npm run check

