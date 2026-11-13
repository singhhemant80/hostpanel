import { createHmac } from "node:crypto";
import { readdir } from "node:fs/promises";
import { RUNTIME_VERSIONS, paths, processEnvName, processPort, redisPort, type SiteSpec } from "@hostpanel/shared";
import { decrypt, env } from "./env.js";
import { run } from "./exec.js";
import { ensureDir, exists, removePath, writeFileAtomic } from "./fsx.js";

/** PATH a site's build and start commands see, with the chosen runtime version first. */
export function runtimePath(site: SiteSpec): string {
  const base = "/usr/local/bin:/usr/bin:/bin";
  switch (site.runtime) {
    case "node":
      return `${env.runtimesDir}/node/${site.runtimeVersion}/bin:${base}`;
    case "python":
      return `${env.runtimesDir}/python/${site.runtimeVersion}/bin:${base}`;
    case "php":
      // composer + the matching php-cli via a per-version shim folder created by install.sh
      return `${env.runtimesDir}/php/${site.runtimeVersion}/bin:${base}`;
    default:
      return `${env.runtimesDir}/node/22/bin:${base}`; // static sites may still run `npm run build`
  }
}

/** The site's env vars plus what the panel provides: PORT_<PROCESS> for each extra process and REDIS_URL. */
export function decryptEnv(site: SiteSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of site.env) out[v.key] = decrypt(v.valueEnc);
  (site.processes ?? []).forEach((p, i) => {
    const port = processPort(site, i);
    if (port !== null) out[processEnvName(p.name)] = String(port);
  });
  const rp = site.redis ? redisPort(site) : null;
  if (rp !== null) out.REDIS_URL = `redis://:${redisPassword(site)}@127.0.0.1:${rp}`;
  return out;
}

/** Stable per-site Redis password, derived from the panel's key (never stored). */
export function redisPassword(site: SiteSpec): string {
  return createHmac("sha256", env.encryptionKey).update(`redis:${site.id}`).digest("hex").slice(0, 40);
}

/** Folder the app runs from: current release + optional sub-folder (monorepos). */
export function appDir(site: SiteSpec, releaseDir?: string): string {
  const base = releaseDir ?? paths.current(site.linuxUser, site.name);
  return site.rootDir ? `${base}/${site.rootDir}` : base;
}

// ---------- systemd (Node.js / Python) ----------

export const unitName = (site: SiteSpec, i: number) => `hp-${site.linuxUser}-${site.name}-${i}.service`;
export const unitFile = (site: SiteSpec, i: number) => `/etc/systemd/system/${unitName(site, i)}`;
// "." never appears in user or site names, so these can't collide with another site's units
export const processUnitName = (site: SiteSpec, name: string) => `hp-${site.linuxUser}-${site.name}.${name}.service`;
export const redisUnitName = (site: SiteSpec) => `hp-${site.linuxUser}-${site.name}.redis.service`;
const UNIT_DIR = "/etc/systemd/system";
export const envFile = (site: SiteSpec) => `/etc/hostpanel/env/${site.linuxUser}-${site.name}.env`;

function systemdEscapeEnv(v: string): string {
  // EnvironmentFile values: one per line, double-quoted, backslash and quote escaped, no newlines.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Quote a shell command for ExecStart: systemd must not expand $VARS or %specifiers itself; bash does. */
export function systemdQuote(cmd: string): string {
  return JSON.stringify(cmd).replace(/\$/g, "$$$$").replace(/%/g, "%%");
}

export async function writeEnvFile(site: SiteSpec): Promise<void> {
  const vars = { ...decryptEnv(site) };
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${systemdEscapeEnv(v)}`);
  await writeFileAtomic(envFile(site), lines.join("\n") + "\n", 0o600);
}

function unitText(site: SiteSpec, o: { description: string; port: number | null; command: string; logName: string; restartSec?: number }): string {
  return `[Unit]
Description=${o.description}
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=${site.linuxUser}
Group=${site.linuxUser}
Slice=hp-${site.linuxUser}.slice
WorkingDirectory=${appDir(site)}
Environment=PATH=${runtimePath(site)}
Environment=NODE_ENV=production
Environment=PYTHONUNBUFFERED=1
Environment=HOST=127.0.0.1
EnvironmentFile=-${envFile(site)}
${o.port !== null ? `Environment=PORT=${o.port}` : ""}
ExecStart=/bin/bash -c ${systemdQuote(o.command)}
Restart=always
RestartSec=${o.restartSec ?? 3}
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=tmpfs
BindPaths=/home/${site.linuxUser}
StandardOutput=append:/home/${site.linuxUser}/sites/${site.name}/logs/${o.logName}
StandardError=append:/home/${site.linuxUser}/sites/${site.name}/logs/${o.logName}

[Install]
WantedBy=multi-user.target
`;
}

/** Units of this site currently on disk (main instances, extra processes, redis). */
async function existingUnits(site: SiteSpec): Promise<string[]> {
  const prefix = `hp-${site.linuxUser}-${site.name}`;
  const names = await readdir(UNIT_DIR).catch(() => [] as string[]);
  // "-<n>" (instances) or ".<process>" / ".redis" right after the prefix; site "web" never matches site "web-2"
  return names.filter((n) => n.startsWith(prefix) && /^(-\d+|\.[a-z0-9-]+)\.service$/.test(n.slice(prefix.length)));
}

export async function writeServiceUnits(site: SiteSpec): Promise<string[]> {
  if (site.port === null) throw new Error("Node/Python sites need a port");
  const units: string[] = [];
  const start = site.startCmd.trim() || (site.runtime === "node" ? "npm start" : "python app.py");
  for (let i = 0; i < site.instances; i++) {
    const text = unitText(site, {
      description: `HostPanel site ${site.name} (${site.linuxUser}) instance ${i}`,
      port: site.background ? null : site.port + i,
      command: start,
      logName: "app.log",
    });
    await writeFileAtomic(unitFile(site, i), text, 0o644);
    units.push(unitName(site, i));
  }
  for (const [i, p] of (site.processes ?? []).entries()) {
    const text = unitText(site, {
      description: `HostPanel site ${site.name} (${site.linuxUser}) process ${p.name}`,
      port: processPort(site, i),
      command: p.command,
      logName: `${p.name}.log`,
    });
    await writeFileAtomic(`${UNIT_DIR}/${processUnitName(site, p.name)}`, text, 0o644);
    units.push(processUnitName(site, p.name));
  }
  const all = [...units];
  if (site.redis) {
    await writeRedisUnit(site);
    all.push(redisUnitName(site));
  }
  // remove units that no longer exist (fewer instances, a process removed, redis turned off)
  for (const old of await existingUnits(site)) {
    if (all.includes(old)) continue;
    await run("systemctl", ["disable", "--now", old], { allowFail: true });
    await removePath(`${UNIT_DIR}/${old}`);
  }
  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", ...all]);
  if (site.redis) await run("systemctl", ["start", redisUnitName(site)], { allowFail: true });
  return units;
}

/** Private Redis: own port, password, data in shared/redis (kept across deploys), BullMQ-safe settings. */
async function writeRedisUnit(site: SiteSpec): Promise<void> {
  const dir = `${paths.shared(site.linuxUser, site.name)}/redis`;
  await ensureDir(dir, 0o700);
  const conf = [
    `port ${redisPort(site)}`,
    "bind 127.0.0.1",
    "protected-mode yes",
    `requirepass ${redisPassword(site)}`,
    `dir ${dir}`,
    "appendonly yes",
    "save 300 1",
    "maxmemory 256mb",
    "maxmemory-policy noeviction",
    "daemonize no",
    "",
  ].join("\n");
  await writeFileAtomic(`${dir}/redis.conf`, conf, 0o600);
  await run("chown", ["-R", `${site.linuxUser}:${site.linuxUser}`, dir]);
  const text = unitText(site, {
    description: `HostPanel site ${site.name} (${site.linuxUser}) private Redis`,
    port: null,
    command: `exec /usr/bin/redis-server ${dir}/redis.conf`,
    logName: "redis.log",
  }).replace(/^Environment=PATH=.*\n/m, "");
  await writeFileAtomic(`${UNIT_DIR}/${redisUnitName(site)}`, text, 0o644);
}

export async function removeServiceUnits(site: SiteSpec): Promise<void> {
  for (const u of await existingUnits(site)) {
    await run("systemctl", ["disable", "--now", u], { allowFail: true });
    await removePath(`${UNIT_DIR}/${u}`);
  }
  await removePath(envFile(site));
  await run("systemctl", ["daemon-reload"]);
}

/** Units restarted on deploy and by start/stop/restart (Redis is left running across deploys). */
export function serviceUnits(site: SiteSpec): string[] {
  return [...Array.from({ length: site.instances }, (_, i) => unitName(site, i)), ...(site.processes ?? []).map((p) => processUnitName(site, p.name))];
}

// ---------- PHP-FPM ----------

export const phpSocket = (linuxUser: string, site: string) => `/run/php/hp-${linuxUser}-${site}.sock`;
const poolFile = (version: string, site: SiteSpec) => `/etc/php/${version}/fpm/pool.d/hp-${site.linuxUser}-${site.name}.conf`;

export async function writePhpPool(site: SiteSpec): Promise<void> {
  const home = `/home/${site.linuxUser}`;
  const envLines = Object.entries(decryptEnv(site))
    .filter(([, v]) => !/[\n"]/.test(v))
    .map(([k, v]) => `env[${k}] = "${v}"`);
  const pool = `[hp-${site.linuxUser}-${site.name}]
user = ${site.linuxUser}
group = ${site.linuxUser}
listen = ${phpSocket(site.linuxUser, site.name)}
listen.owner = ${env.webUser}
listen.group = ${env.webUser}
listen.mode = 0660
pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 30s
pm.max_requests = 500
chdir = /
php_admin_value[open_basedir] = ${home}/:/tmp/:/usr/share/php/
php_admin_value[upload_tmp_dir] = /tmp
php_admin_value[error_log] = ${home}/sites/${site.name}/logs/php-error.log
php_admin_flag[log_errors] = on
php_admin_value[disable_functions] = exec,passthru,shell_exec,system,proc_open,popen,pcntl_exec
php_value[memory_limit] = 256M
php_value[upload_max_filesize] = 64M
php_value[post_max_size] = 64M
${envLines.join("\n")}
`;
  // A site lives in exactly one PHP version's pool folder.
  for (const v of RUNTIME_VERSIONS.php) {
    if (v !== site.runtimeVersion && (await exists(poolFile(v, site)))) {
      await removePath(poolFile(v, site));
      await reloadPhp(v);
    }
  }
  await writeFileAtomic(poolFile(site.runtimeVersion, site), pool, 0o644);
  await reloadPhp(site.runtimeVersion);
}

export async function removePhpPool(site: SiteSpec): Promise<void> {
  for (const v of RUNTIME_VERSIONS.php) {
    if (await exists(poolFile(v, site))) {
      await removePath(poolFile(v, site));
      await reloadPhp(v);
    }
  }
}

export async function reloadPhp(version: string): Promise<void> {
  await run("systemctl", ["reload-or-restart", `php${version}-fpm`]);
}
