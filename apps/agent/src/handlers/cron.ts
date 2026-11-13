import { readdir } from "node:fs/promises";
import { paths, type JobPayloads, type SiteSpec } from "@hostpanel/shared";
import { sys } from "../env.js";
import { run } from "../exec.js";
import { removePath, writeFileAtomic } from "../fsx.js";
import { appDir, envFile, runtimePath, systemdQuote, writeEnvFile } from "../runtime.js";

/**
 * Cron jobs are systemd timers: they run as the site's user, inside the account's
 * CPU/RAM slice, with the site's env vars, a 1-hour limit and output in logs/cron.log.
 */
const prefix = (site: SiteSpec) => `hp-${site.linuxUser}-${site.name}-cron-`;
const unit = (site: SiteSpec, id: string) => `${prefix(site)}${id}`;

export async function cronSync({ site, jobs }: JobPayloads["cron.sync"]): Promise<{ timers: number }> {
  await writeEnvFile(site);
  const wanted = new Set<string>();
  const log = `${paths.logs(site.linuxUser, site.name)}/cron.log`;

  for (const job of jobs) {
    const name = unit(site, job.id);
    wanted.add(name);
    const script = `echo "== $(date -Is) cron ${job.id}"; ${job.command}`;
    await writeFileAtomic(
      `/etc/systemd/system/${name}.service`,
      `[Unit]
Description=HostPanel cron ${job.id} for ${site.name} (${site.linuxUser})

[Service]
Type=oneshot
User=${site.linuxUser}
Group=${site.linuxUser}
Slice=hp-${site.linuxUser}.slice
WorkingDirectory=${appDir(site)}
Environment=PATH=${runtimePath(site)}
Environment=HOME=/home/${site.linuxUser}
EnvironmentFile=-${envFile(site)}
ExecStart=/bin/bash -c ${systemdQuote(script)}
RuntimeMaxSec=3600
NoNewPrivileges=yes
PrivateTmp=yes
StandardOutput=append:${log}
StandardError=append:${log}
`,
    );
    await writeFileAtomic(
      `/etc/systemd/system/${name}.timer`,
      `[Unit]
Description=HostPanel cron ${job.id} for ${site.name}

[Timer]
OnCalendar=${job.onCalendar}
Persistent=true
RandomizedDelaySec=0

[Install]
WantedBy=timers.target
`,
    );
  }

  // Remove timers of jobs that were deleted.
  const existing = (await readdir(sys("/etc/systemd/system")).catch(() => [] as string[]))
    .filter((f) => f.startsWith(prefix(site)) && f.endsWith(".timer"))
    .map((f) => f.slice(0, -".timer".length));
  for (const name of existing) {
    if (wanted.has(name)) continue;
    await run("systemctl", ["disable", "--now", `${name}.timer`], { allowFail: true });
    await removePath(`/etc/systemd/system/${name}.timer`);
    await removePath(`/etc/systemd/system/${name}.service`);
  }

  await run("systemctl", ["daemon-reload"]);
  for (const job of jobs) {
    const name = unit(site, job.id);
    await run("systemctl", job.enabled ? ["enable", "--now", `${name}.timer`] : ["disable", "--now", `${name}.timer`], { allowFail: !job.enabled });
  }
  return { timers: jobs.filter((j) => j.enabled).length };
}

export async function cronRun({ site, jobId }: JobPayloads["cron.run"]): Promise<{ started: boolean }> {
  // --no-block: return at once; output lands in logs/cron.log
  await run("systemctl", ["start", "--no-block", `${unit(site, jobId)}.service`]);
  return { started: true };
}

/** Called when a site is removed. */
export async function cronRemoveAll(site: SiteSpec): Promise<void> {
  await cronSync({ site, jobs: [] });
}
