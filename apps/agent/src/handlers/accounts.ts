import type { JobPayloads } from "@hostpanel/shared";
import { env } from "../env.js";
import { run } from "../exec.js";
import { ensureDir, removePath, writeFileAtomic } from "../fsx.js";

const sliceFile = (u: string) => `/etc/systemd/system/hp-${u}.slice`;

export async function accountCreate(p: JobPayloads["account.create"]): Promise<void> {
  const home = `/home/${p.linuxUser}`;
  const exists = await run("id", ["-u", p.linuxUser], { allowFail: true });
  if (exists.code !== 0 || env.dryRun) {
    // No login shell: customers get SFTP (phase 2), builds run through systemd-run.
    await run("useradd", ["--create-home", "--home-dir", home, "--shell", "/usr/sbin/nologin", "--user-group", "--groups", "hp-users", p.linuxUser], {
      allowFail: env.dryRun,
    });
  }
  await ensureDir(home, 0o750);
  await ensureDir(`${home}/sites`, 0o750);
  await run("chown", [`${p.linuxUser}:${p.linuxUser}`, home, `${home}/sites`]);
  // Caddy may traverse the home folder and read site files; other customers may not.
  // ACLs apply immediately (group membership would need a Caddy restart).
  await run("setfacl", ["-m", `u:${env.webUser}:x`, home]);
  await run("setfacl", ["-R", "-m", `u:${env.webUser}:rX,d:u:${env.webUser}:rX`, `${home}/sites`]);

  // Resource limits for everything the account runs (sites, builds) via a systemd slice.
  await writeFileAtomic(
    sliceFile(p.linuxUser),
    `[Unit]
Description=HostPanel account ${p.linuxUser}

[Slice]
CPUQuota=${p.cpuPercent}%
MemoryMax=${p.ramMb}M
MemorySwapMax=0
TasksMax=512
`,
  );
  await run("systemctl", ["daemon-reload"]);

  // Disk quota when the filesystem has quotas enabled (install.sh turns them on for /home if it can).
  const blocks = String(p.diskMb * 1024);
  await run("setquota", ["-u", p.linuxUser, blocks, blocks, "0", "0", "/home"], { allowFail: true });
}

export async function accountSuspend(p: JobPayloads["account.suspend"]): Promise<void> {
  // Stop every running unit of the account; Caddy routes are removed by the API's routes.sync.
  if (p.suspended) {
    await run("systemctl", ["stop", `hp-${p.linuxUser}-*.timer`], { allowFail: true });
    await run("systemctl", ["stop", `hp-${p.linuxUser}.slice`], { allowFail: true });
    await run("usermod", ["--lock", p.linuxUser], { allowFail: true });
  } else {
    await run("usermod", ["--unlock", p.linuxUser], { allowFail: true });
    await run("bash", ["-c", `systemctl start $(systemctl list-unit-files 'hp-${p.linuxUser}-*.service' 'hp-${p.linuxUser}-*.timer' --state=enabled --no-legend | awk '{print $1}') 2>/dev/null || true`], {
      allowFail: true,
    });
  }
}

export async function accountDelete(p: JobPayloads["account.delete"]): Promise<void> {
  await run("systemctl", ["stop", `hp-${p.linuxUser}.slice`], { allowFail: true });
  // Remove unit files and PHP pools belonging to this account.
  await run(
    "bash",
    [
      "-c",
      `set -e
for f in /etc/systemd/system/hp-${p.linuxUser}-*.timer /etc/systemd/system/hp-${p.linuxUser}-*.service; do [ -e "$f" ] && systemctl disable "$(basename "$f")" || true; rm -f "$f"; done
rm -f /etc/hostpanel/env/${p.linuxUser}-*.env
for f in /etc/php/*/fpm/pool.d/hp-${p.linuxUser}-*.conf; do [ -e "$f" ] && rm -f "$f" && systemctl reload-or-restart "php$(echo "$f" | cut -d/ -f4)-fpm" || true; done`,
    ],
    { allowFail: true },
  );
  await removePath(sliceFile(p.linuxUser));
  await run("systemctl", ["daemon-reload"]);
  await run("userdel", ["--remove", p.linuxUser], { allowFail: true });
  await removePath(`/home/${p.linuxUser}`);
  await removePath(`/var/backups/hostpanel/${p.linuxUser}`);
}
