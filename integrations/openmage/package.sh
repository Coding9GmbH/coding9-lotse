#!/bin/sh
# Builds dist/lotse-connector-<version>.zip with the Magento directory structure (unpack in the shop root).
set -e
cd "$(dirname "$0")"
VERSION=$(sed -n 's/.*<version>\([^<]*\)<\/version>.*/\1/p' app/code/community/Lotse/Connector/etc/config.xml | head -1)
[ -n "$VERSION" ] || { echo "Version nicht gefunden"; exit 1; }
OUT=dist/lotse-connector-$VERSION.zip
mkdir -p dist
rm -f "$OUT"
# Check PHP syntax if php is available
if command -v php >/dev/null 2>&1; then
    find app shell -name '*.php' | while read -r f; do php -l "$f" >/dev/null || exit 1; done
fi
zip -q -r "$OUT" app shell modman README.md openapi.yaml -x '*.DS_Store'
echo "$OUT"
unzip -l "$OUT" | tail -1
