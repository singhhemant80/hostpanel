import { RUNTIME_VERSIONS, paths, type SiteSpec } from "@hostpanel/shared";
import { decrypt, env } from "./env.js";
import { run } from "./exec.js";
import { exists, removePath, writeFileAtomic } from "./fsx.js";

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

export function decryptEnv(site: SiteSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of site.env) out[v.key] = decrypt(v.valueEnc);
  return out;
}

/** Folder the app runs from: current release + optional sub-folder (monorepos). */
export function appDir(site: SiteSpec, releaseDir?: string): string {
  const base = releaseDir ?? paths.current(site.linuxUser, site.name);
  return site.rootDir ? `${base}/${site.rootDir}` : base;
}

// ---------- systemd (Node.js / Python) ----------

export const unitName = (site: SiteSpec, i: number) => `hp-${site.linuxUser}-${site.name}-${i}.service`;
export const unitFile = (site: SiteSpec, i: number) => `/etc/systemd/system/${unitName(site, i)}`;
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

export async function writeServiceUnits(site: SiteSpec): Promise<string[]> {
  if (site.port === null) throw new Error("Node/Python sites need a port");
  const units: string[] = [];
  const start = site.startCmd.trim() || (site.runtime === "node" ? "npm start" : "python app.py");
  for (let i = 0; i < site.instances; i++) {
    const port = site.port + i;
    const unit = `[Unit]
Description=HostPanel site ${site.name} (${site.linuxUser}) instance ${i}
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
${site.background ? "" : `Environment=PORT=${port}`}
ExecStart=/bin/bash -c ${systemdQuote(start)}
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=tmpfs
BindPaths=/home/${site.linuxUser}
StandardOutput=append:/home/${site.linuxUser}/sites/${site.name}/logs/app.log
StandardError=append:/home/${site.linuxUser}/sites/${site.name}/logs/app.log

[Install]
WantedBy=multi-user.target
`;
    await writeFileAtomic(unitFile(site, i), unit, 0o644);
    units.push(unitName(site, i));
  }
  // remove units for instances that no longer exist (instance count lowered)
  for (let i = site.instances; i < 8; i++) {
    if (await exists(unitFile(site, i))) {
      await run("systemctl", ["disable", "--now", unitName(site, i)], { allowFail: true });
      await removePath(unitFile(site, i));
    }
  }
  await run("systemctl", ["daemon-reload"]);
  await run("systemctl", ["enable", ...units]);
  return units;
}

export async function removeServiceUnits(site: SiteSpec): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if (await exists(unitFile(site, i))) {
      await run("systemctl", ["disable", "--now", unitName(site, i)], { allowFail: true });
      await removePath(unitFile(site, i));
    }
  }
  await removePath(envFile(site));
  await run("systemctl", ["daemon-reload"]);
}

export function serviceUnits(site: SiteSpec): string[] {
  return Array.from({ length: site.instances }, (_, i) => unitName(site, i));
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
