#!/usr/bin/env bash
# Pull the latest HostPanel, rebuild, migrate and restart. Run as root on the server.
set -euo pipefail
DIR="${1:-/opt/hostpanel}"
BRANCH="$(git -C "$DIR" rev-parse --abbrev-ref HEAD)"
export PATH="/opt/hostpanel/runtimes/node/22/bin:$PATH"
cd "$DIR"
sudo -u hostpanel git fetch -q origin "$BRANCH"
sudo -u hostpanel git reset -q --hard "origin/$BRANCH"
sudo -u hostpanel npm ci --no-audit --no-fund
sudo -u hostpanel npm run build
set -a; . apps/api/.env; set +a
(cd apps/api && sudo -E -u hostpanel node dist/migrate.js)
systemctl restart hostpanel-agent hostpanel-api
echo "HostPanel updated to $(git rev-parse --short HEAD)"
