#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=PATH bash "$0" "$@"
fi

ROOT=$(cd "$(dirname "$0")/../../.."; pwd)
APP_NAME="slow-daemon-reload-$$"
UNIT="zm2-${APP_NAME}.service"
GENERATOR="/etc/systemd/system-generators/zm2-slow-daemon-reload-$$"
ZM2_HOME=$(mktemp -d)
export ZM2_HOME

cleanup() {
  rm -f "$GENERATOR"
  systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$UNIT" "/etc/zm2/env/${UNIT%.service}.env"
  systemctl daemon-reload
  rm -rf "$ZM2_HOME"
}
trap cleanup EXIT

mkdir -p "$(dirname "$GENERATOR")"
cat > "$GENERATOR" <<'GENERATOR'
#!/bin/sh
# Delay the first reload only; enable/cleanup reloads must not delay again.
rm -f "$0"
sleep 32
GENERATOR
chmod 0755 "$GENERATOR"

STARTED=$(date +%s)
"$ROOT/bin/zm2" start /bin/sleep --interpreter none --name "$APP_NAME" -- 300
[ "$(( $(date +%s) - STARTED ))" -ge 31 ]
systemctl is-active --quiet "$UNIT"
echo "PASS: CLI starts an active service when daemon-reload exceeds 30 seconds"
