# HostPanel

A self-hosted, cPanel-style control panel. It hosts any number of websites on one server, each on its own domains, in **PHP (7.4–8.4), Node.js (18–24), Python (3.10–3.13) or static HTML**, and deploys them straight from **GitHub** on every push.

Built to host the CRAPPLET panel and customer sites, and to be provisioned by CRAPPLET billing.

```
hostpanel/
├─ packages/shared/   Zod schemas, runtime list, typed agent jobs (used by all apps)
├─ apps/api/          Fastify + Drizzle (PostgreSQL) + BullMQ (Redis), runs as user `hostpanel`  → 127.0.0.1:4100
├─ apps/agent/        Root agent: the ONLY process that changes the server (users, Caddy, systemd, PHP-FPM, deploys)
├─ apps/web/          React + Vite + Tailwind panel UI, English + हिन्दी (served by the API)
├─ install.sh         One-command installer for Ubuntu 24.04 / Debian 12
└─ update.sh          Pull, rebuild, migrate, restart
```

## How it works

| Piece | Role |
|---|---|
| **Caddy** | Front door on ports 80/443. Routes every domain to its site and gets/renews Let's Encrypt certificates automatically. The agent regenerates `/etc/caddy/Caddyfile` from the database and hot-reloads it (no dropped connections). |
| **Panel API** | Logins (Argon2id + optional TOTP 2FA), accounts, packages, sites, domains, env vars, databases, GitHub webhooks. Never runs as root; it only *queues jobs*. |
| **Root agent** | Accepts a fixed list of typed jobs (`site.deploy`, `routes.sync`, `db.create`, …). Every payload is validated again, commands run without a shell, and customer build commands run as the customer's Linux user inside a systemd scope with their CPU/RAM limits and a 15-minute limit. |
| **Accounts** | Each hosting account is a Linux user `hp_<name>` with home `/home/hp_<name>`, a systemd slice (CPU %, RAM) and optional disk quota. Caddy gets read access through ACLs; customers can't read each other's files. |
| **Runtimes** | PHP: one PHP-FPM pool per site (own socket, `open_basedir`). Node/Python: systemd service(s) per site on internal ports 20000–29999, load-balanced by Caddy when instances > 1. Static: served by Caddy directly. |

Site layout on disk:

```
/home/hp_crapplet/sites/crapplet-web/
├─ releases/20261113-101500-a1b2c3d4e5f6/   one folder per deploy (last 5 kept)
├─ current -> releases/…                    switched atomically on deploy
├─ shared/                                  survives deploys: .env, storage/, uploads/ … are symlinked in
└─ logs/                                    access.log (Caddy), app.log (Node/Python), php-error.log
```

## Phase 3 features

| Feature | Where | How it works |
|---|---|---|
| **Email hosting** | Email | Mailboxes (`you@yourdomain.com`) with size limits, forwarders (to any address), catch-all. Postfix + Dovecot (IMAP/POP3, passwords bcrypt-hashed) + Rspamd (spam filter, DKIM signing). Mail is only sent after login over TLS, and only from addresses the mailbox owns. The page shows the MX/SPF/DKIM/DMARC records to create (one click when the domain is in DNS) and the settings for phone/desktop mail apps. Packages have a mailbox limit (0 = no email). |
| **Webmail** | `https://<panel>/webmail/` | Roundcube, served by Caddy under the panel hostname. |
| **One-click apps** | One-click apps | WordPress (with MariaDB and admin user), Laravel, Next.js, Django (admin user, static files). Each becomes a normal site with releases and rollback; the admin password is shown once. |
| **Resellers** | Admin → Resellers | Reseller logins create and manage their own customers' accounts, limited to a number of accounts, total disk, and the packages you allow. They never see other accounts. |
| **Extra processes & private Redis** | Site → Settings | One build, several programs: e.g. web + API + queue worker from one monorepo. Each process gets its own port (`$PORT`, and `PORT_<NAME>` for the others); give it a path like `/api/*` and Caddy sends that part of the site's domains to it. A private, password-protected Redis per site sets `REDIS_URL` (never share the panel's own Redis with a site). |
| **Multi-server** | Admin → Servers | Add servers to host accounts on. The panel shows a one-line join command for a fresh Ubuntu 24.04 server; it connects over WireGuard (UDP 51888), and its agent takes jobs from its own queue. Pick the server when creating an account. Mail, webmail and the web terminal stay on the main server. |

**Email deliverability:** many VPS providers block outgoing port 25 until you ask them to open it. Set the server's reverse DNS (PTR) to the panel hostname, and create the DNS records shown on the Email page.

## Phase 2 features

| Feature | Where | How it works |
|---|---|---|
| **File manager** | Files | Browse, edit (≤ 2 MB), upload (≤ 512 MB, any type), download, zip/unzip, rename, permissions. Every operation runs *as the customer's Linux user*, so a symlink to `/etc/shadow` simply cannot be opened, and paths are checked to stay inside the account's home. |
| **SFTP / SSH** | SFTP & usage | SFTP-only by default (lands in `~/sites`, no tunnels). Admins can grant a real shell. Password and/or SSH keys. Without either, nobody can log in. |
| **Web terminal** | Site → Terminal | Browser terminal (xterm.js) for accounts with shell access, running as the customer inside their CPU/RAM limits; 30-minute idle timeout. |
| **Cron jobs** | Site → Cron | Standard cron syntax, converted to systemd timers: run as the site user with the site's env vars, in the account's resource slice, max 1 hour, output in `logs/cron.log`. "Run now" button. |
| **Backups** | Backups, Server | Nightly (configurable hour) + manual. Each backup = live release + `shared/` of every site and a dump of every MariaDB/PostgreSQL database. Keep N copies on the server and optionally copy to **S3-compatible storage** (Backblaze B2, Cloudflare R2, AWS S3, Wasabi) via rclone. Download, or restore chosen sites/databases with one click. |
| **DNS zone editor** | DNS, Server | Cloudflare-backed: add zones, edit A/AAAA/CNAME/MX/TXT/SRV/CAA/NS records, orange-cloud proxy toggle, one-click templates (point to this server, Google Workspace, Zoho Mail). |
| **Logs** | Site → Logs | Live tail of access, app, PHP error and cron logs with filter. |
| **Usage** | SFTP & usage | Disk, memory, CPU and processes for the account vs. its package, and per-process memory. |
| **Custom SSL** | Domains → SSL badge | Upload your own certificate + key (checked: matches the key, covers the domain, not expired). Or go back to automatic Let's Encrypt. |
| **Wildcard domains** | Domains | `*.example.com` with a certificate issued through Cloudflare DNS (needs the Cloudflare token in Server settings). |

### Turn on off-server backups

Server → Backups → *Also copy to S3-compatible storage*. Example for Backblaze B2: endpoint `https://s3.us-west-004.backblazeb2.com`, region `us-west-004`, your bucket, an application key ID + key. For Cloudflare R2: endpoint `https://<account-id>.r2.cloudflarestorage.com`, region `auto`.

### Turn on DNS management and wildcards

Cloudflare → My Profile → API Tokens → Create token with **Zone → Zone: Read**, **Zone → DNS: Edit** (add **Zone: Edit** + your account ID if you want to create zones from the panel). Paste it under Server → DNS.

## GitHub deploys

1. Push to the connected branch → GitHub calls `https://<panel>/api/v1/webhooks/github` (signature checked, duplicates ignored).
2. The agent clones that exact commit into a new release folder (the token goes in an HTTP header, never in the URL or process list).
3. `shared/` folders and `.env` are linked in, then the **build command** runs as the site user.
4. `current` is switched to the new release and the app restarts (rolling restart for multi-instance sites; PHP-FPM reload clears OPcache).
5. **Health check**: Node/Python must answer `GET <health path>` with a status below 500 within 60 s; PHP/static must have their public folder. If it fails, the previous release is put back automatically and the deploy is marked *rolled back*.
6. The result is posted back to the commit on GitHub (✓ or ✗), and the full build log is in the panel.

Manual **Deploy now** and one-click **Roll back** to any earlier release are in the site's Deployments tab.

### Set up the GitHub App (once per server, ~5 minutes)

GitHub → Settings → Developer settings → **GitHub Apps** → New GitHub App:

- **Homepage URL:** `https://panel.example.com`
- **Webhook URL:** `https://panel.example.com/api/v1/webhooks/github`, **Webhook secret:** `openssl rand -hex 32`
- **Permissions:** Repository → *Contents: Read*, *Commit statuses: Read & write*, *Metadata: Read*
- **Subscribe to events:** *Push*
- Create it, then **Generate a private key** (downloads a `.pem`).

On the server:

```bash
sudo install -m 640 -o root -g hostpanel ~/your-app.private-key.pem /etc/hostpanel/github-app.pem
sudo nano /opt/hostpanel/apps/api/.env      # GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_WEBHOOK_SECRET
sudo systemctl restart hostpanel-api
```

Then press **Install the GitHub App** in the panel and pick the repositories (private repos work). Public repos deploy even without the App, but there's no auto-deploy on push.

## Install

Point a DNS A record for the panel (e.g. `panel.example.com`) at the server, push this repo to GitHub, then on a fresh **Ubuntu 24.04** server:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/hostpanel/main/install.sh | \
  sudo bash -s -- --domain panel.example.com --email you@example.com --repo https://github.com/<owner>/hostpanel.git
```

It installs Caddy (+ Cloudflare DNS module for wildcards), PostgreSQL, Redis, MariaDB, PHP 8.1–8.4 (ondrej), Node 20/22/24, Python 3.11–3.13 (uv), Composer, rclone; sets up SFTP/SSH rules for hosting accounts; creates the database, secrets and services (`hostpanel-api`, `hostpanel-agent`); sets up mail (Postfix, Dovecot, Rspamd, Roundcube; skip with `--no-mail`) and the WireGuard network for extra servers; opens ports 22/80/443, mail ports 25/465/587/993/995 and 51888/udp; and writes the admin login to `/root/hostpanel-admin.txt`. Choose versions with `--php "8.3 8.4" --node "22" --python "3.12"`. Re-run the same command (or `sudo bash /opt/hostpanel/update.sh`) to upgrade.

**Back up `apps/api/.env`.** `APP_ENCRYPTION_KEY` encrypts environment variables, database passwords and 2FA secrets.

Recommended server: 2 vCPU, 4 GB RAM, 40 GB SSD to start (Node builds are the heaviest part).

## Hosting CRAPPLET on HostPanel

CRAPPLET (`singhhemant80/crapplet-panel`) is a monorepo with four parts that Nginx currently splits by path on one domain. On HostPanel they become four sites in one account, deployed from the same repo:

| Site | Runtime | App folder | Build command | Start command | Notes |
|---|---|---|---|---|---|
| `crapplet-site` | Static | *(root)* | — | — | Public folder `public-site`. Primary domain `crapplet.co.in`, alias `www.crapplet.co.in` |
| `crapplet-api` | Node 22 | `apps/api` | `cd ../.. && npm ci && npm run build -w apps/api && cd apps/api && npx prisma migrate deploy` | `API_PORT=$PORT node dist/server.js` | Instances: 2. Health path `/api/health` (or any route that returns < 500) |
| `crapplet-worker` | Node 22, **background worker** | `apps/api` | `cd ../.. && npm ci && npm run build -w apps/api` | `node dist/worker.js` | No domain |
| `crapplet-web` | Node 22 | `apps/web` | `cd ../.. && npm ci && npm run build -w apps/web` | `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p $PORT` | |

Then on `crapplet.co.in` (site `crapplet-site` → Domains tab → **Path rules**):

| Path | Goes to |
|---|---|
| `/api/*` | `crapplet-api` |
| `/client*`, `/order*`, `/admin*`, `/_next/*` | `crapplet-web` |

Everything else is served from `public-site/`. Steps:

1. **Accounts → New account** `crapplet` on the *Unlimited* package (or your own).
2. **Databases → New database** (PostgreSQL) `app` → copy its `DATABASE_URL`.
3. Create the four sites above with repo `singhhemant80/crapplet-panel`, branch `main`.
4. On `crapplet-api`, `crapplet-worker` and `crapplet-web` → **Environment**: paste CRAPPLET's `apps/api/.env` (with the new `DATABASE_URL`, `REDIS_URL` of the server, `APP_URL=https://crapplet.co.in`). Keep the same `APP_ENCRYPTION_KEY` if you migrate an existing database.
5. Add the path rules, point DNS for `crapplet.co.in` and `www` at the server, press **Check DNS**.
6. Push to `main`: all three Node sites rebuild; the static site redeploys too.

Not carried over automatically: the legacy WHMCS `cart.php`/`clientarea` redirects from `deploy/nginx-crapplet.conf` (add them as redirect rules in a later phase) and CRAPPLET's PM2/backup scripts (HostPanel's systemd units and phase-2 backups replace them).

## CRAPPLET billing → HostPanel (provisioning API)

When a customer pays for shared hosting in CRAPPLET, call HostPanel to create the account (key is `PROVISIONING_API_KEY` in `apps/api/.env`):

```bash
curl -X POST https://panel.example.com/api/v1/provisioning/accounts \
  -H "Authorization: Bearer $PROVISIONING_API_KEY" -H "Content-Type: application/json" \
  -d '{"email":"rahul@example.com","name":"Rahul","username":"rahul","package":"Business","locale":"hi","externalId":"svc_123"}'
# → { accountId, username, loginUrl, password }   (password only when you didn't send one)
```

Also: `POST /provisioning/accounts/:username/suspend` · `/unsuspend` · `/package {"package":"Unlimited"}` · `DELETE /provisioning/accounts/:username` · `GET /provisioning/accounts/:username`.

## Development

Needs Node 22, PostgreSQL and Redis locally.

```bash
npm install
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL, REDIS_URL, leave keys empty in dev
npm run build -w packages/shared
cd apps/api && npx tsx src/migrate.ts && ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=change-me-now npx tsx src/seed.ts
npm run dev -w apps/api                      # API on :4100
npm run dev -w apps/agent                    # agent in DRY RUN: writes under /tmp/hostpanel-dry, logs root commands instead of running them
npm run dev -w apps/web                      # UI on :5173 (proxies /api)
```

Schema changes: edit `apps/api/src/schema.ts`, then `npm run db:generate -w apps/api` and commit the new file in `apps/api/migrations/`.

## Roadmap

Done (phase 1): accounts & packages, sites in 4 runtimes with version choice, domains/aliases/redirects/path rules, automatic SSL, GitHub App deploys with build logs, health checks and rollback, background workers, env vars, MariaDB/PostgreSQL databases, 2FA, English/Hindi UI, provisioning API.

Done (phase 2): file manager, SFTP/SSH access, web terminal, cron jobs, nightly + manual backups with restore and S3-compatible off-site copies, Cloudflare DNS editor with templates, live logs, resource usage, custom SSL upload, wildcard domains.

Done (phase 3): email hosting with webmail, DKIM and DNS records; one-click WordPress/Laravel/Next.js/Django; resellers; multi-server over WireGuard.

Next: self-hosted DNS (PowerDNS), moving accounts between servers, mail on extra servers.
