#!/bin/sh
# Native Programme der KI-Laufzeiten für eine Zielarchitektur bereitstellen bzw. aufräumen.
#   add-native <amd64|arm64>                    legt die Pakete der Zielarchitektur nach node_modules (falls fehlend)
#   add-native <amd64|arm64> --prune <dir>      entfernt in <dir> alles, was die Zielarchitektur nicht braucht
set -eu
case "$1" in arm64) ARCH=arm64 ;; amd64|x64) ARCH=x64 ;; *) echo "unbekannte Architektur: $1" >&2; exit 1 ;; esac
OTHER=$([ "$ARCH" = x64 ] && echo arm64 || echo x64)

if [ "${2:-}" = "--prune" ]; then
  NM="$3"
  rm -rf "$NM/@anthropic-ai/claude-agent-sdk-linux-$OTHER" "$NM"/@anthropic-ai/claude-agent-sdk-linux-*-musl \
         "$NM/@openai/codex-linux-$OTHER" "$NM/sharp" "$NM/@img" \
         "$NM"/@openai/codex-linux-*/vendor/*/codex-resources/voice
  test -x "$(find "$NM/@anthropic-ai/claude-agent-sdk-linux-$ARCH" -name claude -type f | head -1)"
  test -x "$(find "$NM/@openai/codex-linux-$ARCH" -path '*/bin/codex' -type f | head -1)"
  exit 0
fi

# Pakete per npm pack holen (ohne Plattform-Prüfung) und an die Stelle legen, an der die SDKs sie suchen
fetch() { # <paket@version> <ziel>
  [ -f "$2/package.json" ] && return 0
  tmp=$(mktemp -d); (cd "$tmp" && npm pack --silent "$1" >/dev/null)
  mkdir -p "$2" && tar xzf "$tmp"/*.tgz --strip-components=1 -C "$2" && rm -rf "$tmp"
}
CLAUDE_V=$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version")
CODEX_V=$(node -p "require('./node_modules/@openai/codex/package.json').version")
fetch "@anthropic-ai/claude-agent-sdk-linux-$ARCH@$CLAUDE_V" "node_modules/@anthropic-ai/claude-agent-sdk-linux-$ARCH"
fetch "@openai/codex@$CODEX_V-linux-$ARCH" "node_modules/@openai/codex-linux-$ARCH"
