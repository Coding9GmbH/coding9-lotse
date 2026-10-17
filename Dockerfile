# syntax=docker/dockerfile:1.7
# Lotse: AI pilot for Shopware 6 (by CODING 9)
# One image, everything included: Next.js app, Claude agent runtime, SQLite database (in the /data volume).

ARG NODE_VERSION=22.22
# Source of the Node image; CI uses the Docker Hub mirror mirror.gcr.io/library/node (no rate limit for anonymous pulls)
ARG NODE_IMAGE=node

# ---- Dependencies + build: always run natively on the build machine (no slow emulation for arm64) ----
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE}:${NODE_VERSION}-bookworm-slim AS build
ARG TARGETARCH
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# Add the native AI binaries (Claude, Codex) for the TARGET architecture; npm ci only installed the build machine's
COPY docker/add-native.sh /usr/local/bin/add-native
RUN sh /usr/local/bin/add-native "$TARGETARCH"
COPY . .
RUN npm run build \
 && sh /usr/local/bin/add-native "$TARGETARCH" --prune .next/standalone/node_modules
# --prune removes from the standalone output: other architectures, musl variants, image optimization (sharp, ~47 MB)
# as well as Codex's speech output (~74 MB), which is disabled in Lotse

# ---- Runtime ----
FROM ${NODE_IMAGE}:${NODE_VERSION}-bookworm-slim
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Lotse" \
      org.opencontainers.image.description="KI-Lotse für Shopware 6: Inhalte, Layouts, Preise & SEO per Chat – die KI liest nur, geschrieben wird nur nach Freigabe." \
      org.opencontainers.image.vendor="CODING 9 GmbH" \
      org.opencontainers.image.url="https://coding9.de/produkte/lotse" \
      org.opencontainers.image.source="https://github.com/coding9gmbh/shopware-ai-manager" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# tini: clean signal handling (docker stop) and no zombie process from the Claude subprocess
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    AICB_DOCKER=1 \
    AICB_DATA=/data \
    CLAUDE_CONFIG_DIR=/data/claude \
    HOME=/data/home \
    HOSTNAME=0.0.0.0 \
    PORT=3333 \
    LOTSE_VERSION=${VERSION}

WORKDIR /app
# Only the standalone output (server + required node_modules), static assets and the prompts
COPY --from=build --chown=root:root /app/.next/standalone ./
COPY --from=build --chown=root:root /app/.next/static ./.next/static
COPY --from=build --chown=root:root /app/public ./public
COPY --from=build --chown=root:root /app/prompts ./prompts
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/lotse-entrypoint

# App code is owned by root and read-only; the app runs as an unprivileged user and writes only to /data
RUN chmod 0755 /usr/local/bin/lotse-entrypoint \
 && test -x "$(find node_modules/@anthropic-ai -path '*claude-agent-sdk-linux-*' -name claude -type f | head -1)" \
 && test -x "$(find node_modules/@openai -path '*/vendor/*/bin/codex' -type f | head -1)" \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3333

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/lotse-entrypoint"]
CMD ["node", "server.js"]
