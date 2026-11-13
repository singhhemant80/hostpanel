#!/usr/bin/env bash
# Pull the latest HostPanel, rebuild, migrate and restart. Run as root on the server.
set -euo pipefail
DIR="${1:-/opt/hostpanel}"
BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
export PATH="/opt/hostpanel-runtimes/node/22/bin:$PATH"
cd "$DIR"
# the code is root-owned (the root agent runs from it), so update as root
git fetch -q origin "$BRANCH"
git reset -q --hard "origin/$BRANCH"
npm ci --include=dev --no-audit --no-fund
npm run build
chmod -R a+rX,go-w "$DIR"; chown root:hostpanel apps/api/.env; chmod 640 apps/api/.env
(cd apps/api && node dist/migrate.js)
systemctl restart hostpanel-agent hostpanel-api
echo "HostPanel updated to $(git rev-parse --short HEAD)"
