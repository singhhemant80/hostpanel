#!/usr/bin/env bash
# HostPanel installer for a fresh Ubuntu 24.04 (or Debian 12) server. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/hostpanel/main/install.sh | \
#     sudo bash -s -- --domain panel.example.com --email you@example.com
#
# Options:
#   --domain HOST     Hostname for the panel itself (DNS A record must point here). Required.
#   --email EMAIL     Admin login + Let's Encrypt contact. Required.
#   --repo URL        Git URL of HostPanel (default: the one in HOSTPANEL_REPO or the current checkout)
#   --branch NAME     Branch to install (default: main)
#   --dir PATH        Install folder (default: /opt/hostpanel)
#   --php "8.3 8.4"   PHP versions to install (default: "8.1 8.2 8.3 8.4")
#   --node "20 22"    Node.js versions (default: "20 22 24")
#   --python "3.12"   Python versions (default: "3.11 3.12 3.13")
#   --no-mariadb      Skip MariaDB (PostgreSQL is always installed; the panel uses it)
#   --no-mail         Skip the mail server (Postfix, Dovecot, Rspamd, Roundcube webmail)
#
# Add another server to an existing panel (run on the NEW server; the command is shown
# in the panel under Servers → Add server):
#   ... | sudo bash -s -- --join https://panel.example.com --token <one-time token>
#
# Re-running the script upgrades in place and keeps .env files, databases and sites.
set -euo pipefail

DOMAIN=""; EMAIL=""; BRANCH="main"; DIR="/opt/hostpanel"
REPO="${HOSTPANEL_REPO:-https://github.com/singhhemant80/hostpanel.git}"
PHP_VERSIONS="8.1 8.2 8.3 8.4"; NODE_VERSIONS="20 22 24"; PY_VERSIONS="3.11 3.12 3.13"; WITH_MARIADB=1; WITH_MAIL=1
JOIN=""; TOKEN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email) EMAIL="$2"; shift 2;;
    --repo) REPO="$2"; shift 2;;
    --branch) BRANCH="$2"; shift 2;;
    --dir) DIR="$2"; shift 2;;
    --php) PHP_VERSIONS="$2"; shift 2;;
    --node) NODE_VERSIONS="$2"; shift 2;;
    --python) PY_VERSIONS="$2"; shift 2;;
    --no-mariadb) WITH_MARIADB=0; shift;;
    --no-mail) WITH_MAIL=0; shift;;
    --join) JOIN="${2%/}"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    *) echo "Unknown option $1"; exit 1;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)."; exit 1; }
if [[ -n "$JOIN" ]]; then
  [[ -n "$TOKEN" ]] || { echo "Usage: install.sh --join https://panel.example.com --token <token>"; exit 1; }
  WITH_MAIL=0
else
  [[ -n "$DOMAIN" && -n "$EMAIL" ]] || { echo "Usage: install.sh --domain panel.example.com --email you@example.com"; exit 1; }
fi

log() { echo -e "\n\033[1;34m==> $*\033[0m"; }
RUNTIMES=/opt/hostpanel-runtimes
PYTHONS=/opt/hostpanel-runtimes/pythons
# Managed Pythons only: never pick up the system /usr/bin/python3
export UV_PYTHON_PREFERENCE=only-managed
export DEBIAN_FRONTEND=noninteractive

log "System packages"
apt-get update -q
apt-get install -yq curl git ca-certificates gnupg jq zip unzip ufw quota acl rclone openssh-server debian-keyring debian-archive-keyring apt-transport-https \
  postgresql software-properties-common python3 python3-venv build-essential wireguard-tools
apt-get install -yq redis-server   # the panel's queue on the main server; per-site private Redis everywhere
[[ -n "$JOIN" ]] && systemctl disable --now redis-server >/dev/null 2>&1 || true
if [[ $WITH_MAIL -eq 1 ]]; then
  echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
  echo "postfix postfix/mailname string $DOMAIN" | debconf-set-selections
  apt-get install -yq postfix dovecot-imapd dovecot-pop3d dovecot-lmtpd rspamd
fi
[[ $WITH_MARIADB -eq 1 ]] && apt-get install -yq mariadb-server

log "Caddy (web server, automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -yq caddy
fi

# Wildcard certificates (*.example.com) need Caddy's Cloudflare DNS module. Optional: skipped if the
# Caddy build service is unreachable; only wildcard domains need it.
if ! caddy list-modules 2>/dev/null | grep -q "dns.providers.cloudflare"; then
  caddy add-package github.com/caddy-dns/cloudflare >/dev/null 2>&1 && echo "Caddy Cloudflare DNS module added" \
    || echo "warning: could not add the Caddy Cloudflare module; wildcard domains will not get certificates"
fi

log "PHP ${PHP_VERSIONS} (ondrej/php)"
if . /etc/os-release && [[ "$ID" == "ubuntu" ]]; then add-apt-repository -y ppa:ondrej/php; else
  curl -sSLo /usr/share/keyrings/deb.sury.org-php.gpg https://packages.sury.org/php/apt.gpg
  echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/php.list
fi
apt-get update -q
for v in $PHP_VERSIONS; do
  apt-get install -yq "php$v-fpm" "php$v-cli" "php$v-mysql" "php$v-pgsql" "php$v-curl" "php$v-gd" "php$v-mbstring" \
    "php$v-xml" "php$v-zip" "php$v-intl" "php$v-bcmath" "php$v-opcache" "php$v-redis" "php$v-sqlite3" || echo "warning: some php$v extensions missing"
  rm -f "/etc/php/$v/fpm/pool.d/www.conf"   # customers get their own pools
  mkdir -p "$RUNTIMES/php/$v/bin"
  ln -sf "/usr/bin/php$v" "$RUNTIMES/php/$v/bin/php"
  printf '#!/bin/sh\nexec /usr/bin/php%s /usr/local/bin/composer.phar "$@"\n' "$v" > "$RUNTIMES/php/$v/bin/composer"
  chmod 755 "$RUNTIMES/php/$v/bin/composer"
  systemctl enable --now "php$v-fpm" || true
done
[[ -f /usr/local/bin/composer.phar ]] || curl -fsSL https://getcomposer.org/download/latest-stable/composer.phar -o /usr/local/bin/composer.phar

log "Node.js ${NODE_VERSIONS}"
ARCH=$(uname -m); case "$ARCH" in x86_64) NARCH=x64;; aarch64) NARCH=arm64;; *) echo "Unsupported CPU $ARCH"; exit 1;; esac
for v in $NODE_VERSIONS 22; do
  [[ -x "$RUNTIMES/node/$v/bin/node" ]] && continue
  file=$(curl -fsSL "https://nodejs.org/dist/latest-v$v.x/SHASUMS256.txt" | awk "/linux-$NARCH.tar.xz/ {print \$2}")
  mkdir -p "$RUNTIMES/node/$v"
  curl -fsSL "https://nodejs.org/dist/latest-v$v.x/$file" | tar -xJ -C "$RUNTIMES/node/$v" --strip-components=1
done
NODE="$RUNTIMES/node/22/bin"

log "Python ${PY_VERSIONS} (uv)"
[[ -x /usr/local/bin/uv ]] || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
for v in $PY_VERSIONS; do
  UV_PYTHON_INSTALL_DIR=$PYTHONS /usr/local/bin/uv python install "$v"
  py=$(UV_PYTHON_INSTALL_DIR=$PYTHONS /usr/local/bin/uv python find "$v")
  mkdir -p "$RUNTIMES/python/$v"
  ln -sfn "$(dirname "$py")" "$RUNTIMES/python/$v/bin"
  [[ -e "$(dirname "$py")/python" ]] || ln -sf "$py" "$(dirname "$py")/python"
done
chown -R root:root "$RUNTIMES"; chmod -R a+rX,go-w "$RUNTIMES"

log "HostPanel code → $DIR"
id hostpanel >/dev/null 2>&1 || useradd --system --home-dir "$DIR" --shell /usr/sbin/nologin hostpanel
if [[ -d "$DIR" && ! -d "$DIR/.git" ]]; then
  # left over from an interrupted earlier install: keep it aside, start clean
  mv "$DIR" "$DIR.old-$(date +%s)"
fi
[[ -d "$DIR/.git" ]] && chown -R root:root "$DIR"   # git refuses folders owned by another user
if [[ -d "$DIR/.git" ]]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q -f -B "$BRANCH" "origin/$BRANCH"
else git clone -q --branch "$BRANCH" "$REPO" "$DIR"; fi

log "Folders and groups"
mkdir -p /etc/hostpanel/env /etc/hostpanel/build /var/log/hostpanel/deploys /var/backups/hostpanel /var/lib/hostpanel/backup-tmp \
  /var/lib/hostpanel/uploads /var/lib/hostpanel/downloads /etc/caddy/certs
chmod 700 /etc/hostpanel/env /etc/hostpanel/build /var/lib/hostpanel/backup-tmp
chown root:hostpanel /var/log/hostpanel /var/log/hostpanel/deploys /var/backups/hostpanel
chmod 750 /var/log/hostpanel /var/log/hostpanel/deploys /var/backups/hostpanel
# staging folders shared by the API (writes uploads, deletes downloads) and the agent
chown hostpanel:hostpanel /var/lib/hostpanel/uploads /var/lib/hostpanel/downloads
chmod 770 /var/lib/hostpanel/uploads /var/lib/hostpanel/downloads
chown root:caddy /etc/caddy/certs; chmod 750 /etc/caddy/certs
getent group hp-users >/dev/null || groupadd --system hp-users
getent group hp-ssh >/dev/null || groupadd --system hp-ssh
for u in $(getent passwd | cut -d: -f1 | grep '^hp_' || true); do usermod -aG hp-users "$u"; done

log "SFTP / SSH for hosting accounts"
if ! grep -q "BEGIN HOSTPANEL" /etc/ssh/sshd_config; then
  cat >> /etc/ssh/sshd_config <<'SSHEOF'

# BEGIN HOSTPANEL (managed by install.sh)
# Hosting accounts get SFTP only (starting in ~/sites) unless they are in hp-ssh.
Match Group hp-ssh
    ForceCommand none
    AllowTcpForwarding no
    X11Forwarding no
Match Group hp-users
    ForceCommand internal-sftp -d /home/%u/sites
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication yes
Match all
# END HOSTPANEL
SSHEOF
  if sshd -t; then systemctl reload ssh 2>/dev/null || systemctl reload sshd; else echo "warning: sshd_config check failed, SSH not reloaded"; fi
fi

# ======================================================================================
# --join: this server only runs the agent and takes jobs from the main panel
# ======================================================================================
if [[ -n "$JOIN" ]]; then
  log "Joining the panel at $JOIN"
  install -d -m 700 /etc/wireguard
  [[ -f /etc/wireguard/wg-hp.key ]] || (umask 077; wg genkey > /etc/wireguard/wg-hp.key)
  PUB=$(wg pubkey < /etc/wireguard/wg-hp.key)
  IP4=$(curl -4fsS https://api.ipify.org || true)
  BODY=$(jq -n --arg t "$TOKEN" --arg k "$PUB" --arg ip "$IP4" '{token:$t, publicKey:$k} + (if $ip != "" then {ipv4:$ip} else {} end)')
  RESP=$(curl -fsS -X POST "$JOIN/api/v1/servers/join" -H "Content-Type: application/json" -d "$BODY") \
    || { echo "The panel refused to join this server. Create a new join command in the panel (tokens work once, for 24 hours)."; exit 1; }
  cat > /etc/wireguard/wg-hp.conf <<EOF
[Interface]
Address = $(jq -r .wireguard.address <<<"$RESP")
PrivateKey = $(cat /etc/wireguard/wg-hp.key)

[Peer]
PublicKey = $(jq -r .wireguard.mainPublicKey <<<"$RESP")
Endpoint = $(jq -r .wireguard.mainEndpoint <<<"$RESP")
AllowedIPs = 10.88.0.1/32
PersistentKeepalive = 25
EOF
  chmod 600 /etc/wireguard/wg-hp.conf
  systemctl enable wg-quick@wg-hp >/dev/null 2>&1; systemctl restart wg-quick@wg-hp
  echo -n "Waiting for the private network"
  for i in $(seq 1 30); do ping -c1 -W1 10.88.0.1 >/dev/null 2>&1 && break; echo -n "."; sleep 2; done; echo
  ping -c1 -W2 10.88.0.1 >/dev/null 2>&1 || echo "warning: cannot reach the main server over WireGuard yet (UDP $(jq -r .wireguard.mainEndpoint <<<"$RESP") must be open)"

  cat > /etc/hostpanel/agent.env <<EOF
NODE_ENV=production
REDIS_URL=$(jq -r .redisUrl <<<"$RESP")
APP_ENCRYPTION_KEY=$(jq -r .encryptionKey <<<"$RESP")
QUEUE_SUFFIX=$(jq -r .queueSuffix <<<"$RESP")
RUNTIMES_DIR=$RUNTIMES
EOF
  chmod 600 /etc/hostpanel/agent.env

  log "Build (agent only)"
  cd "$DIR"
  export PATH="$NODE:$PATH"
  npm ci --include=dev --no-audit --no-fund
  npm run build -w packages/shared && npm run build -w apps/agent
  chown -R root:root "$DIR"; chmod -R a+rX,go-w "$DIR"

  cat > /etc/systemd/system/hostpanel-agent.service <<EOF
[Unit]
Description=HostPanel root agent
After=network-online.target wg-quick@wg-hp.service caddy.service
Wants=wg-quick@wg-hp.service
[Service]
User=root
RuntimeDirectory=hostpanel
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
WorkingDirectory=$DIR/apps/agent
EnvironmentFile=/etc/hostpanel/agent.env
ExecStart=$NODE/node dist/main.js
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now caddy
  systemctl enable hostpanel-agent >/dev/null 2>&1; systemctl restart hostpanel-agent
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw --force enable >/dev/null
  log "Done. This server now appears as online under Servers in the panel ($JOIN)."
  exit 0
fi

log "Databases and secrets"
ENV="$DIR/apps/api/.env"
if [[ ! -f "$ENV" ]]; then
  PGPASS=$(openssl rand -hex 16); REDISPASS=$(openssl rand -hex 16)
  sudo -u postgres psql -qc "CREATE ROLE hostpanel LOGIN PASSWORD '$PGPASS'" 2>/dev/null || sudo -u postgres psql -qc "ALTER ROLE hostpanel PASSWORD '$PGPASS'"
  sudo -u postgres psql -qc "CREATE DATABASE hostpanel OWNER hostpanel" 2>/dev/null || true
  sed -i "s/^#\?\s*requirepass .*/requirepass $REDISPASS/" /etc/redis/redis.conf
  grep -q "^requirepass" /etc/redis/redis.conf || echo "requirepass $REDISPASS" >> /etc/redis/redis.conf
  systemctl restart redis-server
  IP4=$(curl -4fsS https://api.ipify.org || true); IP6=$(curl -6fsS --max-time 5 https://api64.ipify.org || true)
  cat > "$ENV" <<EOF
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4100
PANEL_URL=https://$DOMAIN
PANEL_HOSTNAME=$DOMAIN
ACME_EMAIL=$EMAIL
DATABASE_URL=postgresql://hostpanel:$PGPASS@127.0.0.1:5432/hostpanel
REDIS_URL=redis://:$REDISPASS@127.0.0.1:6379
JWT_SECRET=$(openssl rand -hex 32)
APP_ENCRYPTION_KEY=$(openssl rand -hex 32)
SERVER_IPV4=$IP4
SERVER_IPV6=$IP6
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_WEBHOOK_SECRET=
GITHUB_APP_PRIVATE_KEY_PATH=/etc/hostpanel/github-app.pem
WEB_DIST=../web/dist
PROVISIONING_API_KEY=$(openssl rand -hex 24)
EOF
fi
chown root:hostpanel "$ENV"; chmod 640 "$ENV"
# The agent needs Redis + the encryption key (to decrypt env vars), nothing else.
set -a; . "$ENV"; set +a
cat > /etc/hostpanel/agent.env <<EOF
NODE_ENV=production
REDIS_URL=$REDIS_URL
APP_ENCRYPTION_KEY=$APP_ENCRYPTION_KEY
PANEL_UPSTREAM=127.0.0.1:$API_PORT
RUNTIMES_DIR=$RUNTIMES
QUEUE_SUFFIX=
EOF
chmod 600 /etc/hostpanel/agent.env

log "Build"
cd "$DIR"
export PATH="$NODE:$PATH"
npm ci --include=dev --no-audit --no-fund
npm run build
(cd apps/api && node dist/migrate.js)
FIRST_RUN=0
if ! sudo -u postgres psql -tAqd hostpanel -c "select 1 from users limit 1" | grep -q 1; then
  FIRST_RUN=1; ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  (cd apps/api && ADMIN_EMAIL="$EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" node dist/seed.js)
else
  (cd apps/api && node dist/seed.js)
fi
chown -R root:root "$DIR"; chmod -R a+rX,go-w "$DIR"; chown root:hostpanel "$ENV"; chmod 640 "$ENV"

log "Private network for extra servers (WireGuard)"
install -d -m 700 /etc/wireguard
[[ -f /etc/wireguard/wg-hp.key ]] || (umask 077; wg genkey > /etc/wireguard/wg-hp.key)
WG_PUB=$(wg pubkey < /etc/wireguard/wg-hp.key)
if [[ ! -f /etc/wireguard/wg-hp.conf ]]; then
  cat > /etc/wireguard/wg-hp.conf <<EOF
[Interface]
Address = 10.88.0.1/24
ListenPort = 51888
PrivateKey = $(cat /etc/wireguard/wg-hp.key)
EOF
  chmod 600 /etc/wireguard/wg-hp.conf
fi
systemctl enable wg-quick@wg-hp >/dev/null 2>&1; systemctl restart wg-quick@wg-hp || echo "warning: WireGuard did not start (multi-server will not work until it does)"
grep -q '^WG_PUBLIC_KEY=' "$ENV" || printf 'WG_PUBLIC_KEY=%s\nWG_PORT=51888\n' "$WG_PUB" >> "$ENV"
# Redis: also listen inside the private network (the "-" makes that address optional at boot)
sed -i -E 's/^bind .*/bind 127.0.0.1 -::1 -10.88.0.1/' /etc/redis/redis.conf
mkdir -p /etc/systemd/system/redis-server.service.d
printf '[Unit]\nAfter=wg-quick@wg-hp.service\nWants=wg-quick@wg-hp.service\n' > /etc/systemd/system/redis-server.service.d/hostpanel.conf
systemctl daemon-reload; systemctl restart redis-server

if [[ $WITH_MAIL -eq 1 ]]; then
  log "Email (Postfix, Dovecot, Rspamd)"
  bash "$DIR/deploy/mail-setup.sh" "$DOMAIN" "$(sed -E 's#^redis://:([^@]*)@.*#\1#' <<<"$REDIS_URL")"

  log "Webmail (Roundcube) at https://$DOMAIN/webmail/"
  WM_PHP=""; for v in $PHP_VERSIONS; do WM_PHP=$v; done; [[ " $PHP_VERSIONS " == *" 8.3 "* ]] && WM_PHP=8.3
  if [[ ! -f /var/www/webmail/index.php ]]; then
    RC_URL=$(curl -fsSL https://api.github.com/repos/roundcube/roundcubemail/releases/latest | jq -r '.assets[] | select(.name | test("-complete\\.tar\\.gz$")) | .browser_download_url' | head -1)
    mkdir -p /var/www/webmail && curl -fsSL "$RC_URL" | tar -xz -C /var/www/webmail --strip-components=1
  fi
  install -d -o www-data -g www-data -m 700 /var/lib/roundcube
  if [[ ! -f /var/www/webmail/config/config.inc.php ]]; then
    cat > /var/www/webmail/config/config.inc.php <<EOF
<?php
// Generated by HostPanel install.sh
\$config = [];
\$config['db_dsnw'] = 'sqlite:////var/lib/roundcube/roundcube.db?mode=0640';
\$config['imap_host'] = 'ssl://localhost:993';
\$config['smtp_host'] = 'tls://localhost:587';
\$config['smtp_user'] = '%u';
\$config['smtp_pass'] = '%p';
\$config['imap_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]];
\$config['smtp_conn_options'] = ['ssl' => ['verify_peer' => false, 'verify_peer_name' => false]];
\$config['des_key'] = '$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-24)';
\$config['product_name'] = 'Webmail';
\$config['plugins'] = ['archive', 'zipdownload'];
\$config['skin'] = 'elastic';
\$config['use_https'] = true;
\$config['log_driver'] = 'syslog';
\$config['enable_installer'] = false;
EOF
  fi
  [[ -f /var/lib/roundcube/roundcube.db ]] || (cd /var/www/webmail && sudo -u www-data php$WM_PHP bin/initdb.sh --dir=/var/www/webmail/SQL >/dev/null)
  rm -rf /var/www/webmail/installer
  chown -R root:root /var/www/webmail; chown -R www-data:www-data /var/www/webmail/temp /var/www/webmail/logs
  chown root:www-data /var/www/webmail/config/config.inc.php; chmod 640 /var/www/webmail/config/config.inc.php
  cat > /etc/php/$WM_PHP/fpm/pool.d/hostpanel-webmail.conf <<EOF
[hostpanel-webmail]
user = www-data
group = www-data
listen = /run/php/hostpanel-webmail.sock
listen.owner = caddy
listen.group = caddy
listen.mode = 0660
pm = ondemand
pm.max_children = 10
php_admin_value[open_basedir] = /var/www/webmail/:/var/lib/roundcube/:/tmp/
php_value[upload_max_filesize] = 25M
php_value[post_max_size] = 26M
EOF
  systemctl reload-or-restart php$WM_PHP-fpm
  ufw allow 25/tcp >/dev/null; ufw allow 465/tcp >/dev/null; ufw allow 587/tcp >/dev/null; ufw allow 993/tcp >/dev/null; ufw allow 995/tcp >/dev/null
fi

log "Services"
cat > /etc/systemd/system/hostpanel-api.service <<EOF
[Unit]
Description=HostPanel API
After=network.target postgresql.service redis-server.service
[Service]
User=hostpanel
Group=hostpanel
WorkingDirectory=$DIR/apps/api
EnvironmentFile=$ENV
ExecStart=$NODE/node dist/server.js
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/hostpanel/uploads /var/lib/hostpanel/downloads
ProtectHome=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/hostpanel-agent.service <<EOF
[Unit]
Description=HostPanel root agent
After=network.target redis-server.service caddy.service
[Service]
User=root
RuntimeDirectory=hostpanel
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
WorkingDirectory=$DIR/apps/agent
EnvironmentFile=/etc/hostpanel/agent.env
ExecStart=$NODE/node dist/main.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now caddy
systemctl enable hostpanel-agent hostpanel-api
systemctl restart hostpanel-agent hostpanel-api

log "Firewall"
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw allow 51888/udp >/dev/null                                   # WireGuard for extra servers
ufw allow in on wg-hp to any port 6379 proto tcp >/dev/null      # Redis, only inside the private network
ufw --force enable >/dev/null

# Quotas on /home are optional: they need `usrquota` in /etc/fstab and a remount (not done automatically).

if [[ $FIRST_RUN -eq 1 ]]; then
  printf "HostPanel admin\nURL: https://%s\nEmail: %s\nPassword: %s\nProvisioning API key: %s\n" "$DOMAIN" "$EMAIL" "$ADMIN_PASSWORD" "$PROVISIONING_API_KEY" > /root/hostpanel-admin.txt
  chmod 600 /root/hostpanel-admin.txt
  log "Done. Open https://$DOMAIN — login details are in /root/hostpanel-admin.txt"
else
  log "Upgrade complete. https://$DOMAIN"
fi
