#!/bin/sh
# Bereitet das Datenverzeichnis vor und startet Lotse.
set -eu
umask 077  # Datenbank, Schlüssel und Claude-Sitzungen nur für den App-Nutzer lesbar
mkdir -p "$AICB_DATA" "$CLAUDE_CONFIG_DIR" "$HOME"
if [ ! -w "$AICB_DATA" ]; then
  echo "Lotse: $AICB_DATA ist nicht beschreibbar (Volume-Rechte prüfen, App läuft als UID $(id -u))." >&2
  exit 1
fi
exec "$@"
