#!/bin/sh
# Prepares the data directory and starts Lotse.
set -eu
umask 077  # database, keys and Claude sessions readable only by the app user
mkdir -p "$AICB_DATA" "$CLAUDE_CONFIG_DIR" "$HOME"
if [ ! -w "$AICB_DATA" ]; then
  echo "Lotse: $AICB_DATA ist nicht beschreibbar (Volume-Rechte prüfen, App läuft als UID $(id -u))." >&2
  exit 1
fi
exec "$@"
