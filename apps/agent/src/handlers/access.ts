import { realpath, stat, open as fopen } from "node:fs/promises";
import type { AccountUsage, JobPayloads } from "@hostpanel/shared";
import { decrypt, env, sys } from "../env.js";
import { run, runAs } from "../exec.js";

/**
 * SFTP / SSH. install.sh adds to sshd_config:
 *   Match Group hp-ssh   → ForceCommand none          (real shell)
 *   Match Group hp-users → ForceCommand internal-sftp  (SFTP only, starts in ~/sites)
 * Every hosting user is in hp-users; shell users are also in hp-ssh. Without a password
 * or key nobody can log in at all.
 */
export async function accessSync(p: JobPayloads["access.sync"]): Promise<void> {
  const u = p.linuxUser;
  const allowed = p.sftp || p.shell;
  await run("usermod", ["-aG", "hp-users", u]);
  if (p.shell) {
    await run("usermod", ["-aG", "hp-ssh", u]);
    await run("usermod", ["--shell", "/bin/bash", u]);
  } else {
    await run("gpasswd", ["-d", u, "hp-ssh"], { allowFail: true });
    await run("usermod", ["--shell", "/usr/sbin/nologin", u]);
  }

  if (!allowed) {
    await run("passwd", ["--lock", u], { allowFail: true });
  } else if (p.passwordEnc) {
    const pw = decrypt(p.passwordEnc);
    if (/[:\n\r]/.test(pw)) throw new Error("Password may not contain ':' or line breaks");
    await run("chpasswd", [], { input: `${u}:${pw}\n` });
    await run("passwd", ["--unlock", u], { allowFail: true });
  }

  // authorized_keys is written AS the user, so a symlinked ~/.ssh cannot redirect the write.
  const keys = allowed ? p.sshKeys : [];
  await runAs(u, "mkdir", ["-p", "-m", "700", sys(`/home/${u}/.ssh`)]);
  await runAs(u, "sh", ["-c", 'umask 077; cat > "$1"', "sh", sys(`/home/${u}/.ssh/authorized_keys`)], {
    input: keys.length ? keys.join("\n") + "\n" : "",
  });
}

/** Tail of one of a site's logs. Read as root, but only if the file really is that log (no symlink tricks). */
export async function logsRead(p: JobPayloads["logs.read"]): Promise<{ text: string; size: number }> {
  const names = { access: "access.log", app: "app.log", "php-error": "php-error.log", cron: "cron.log" } as const;
  const expected = sys(`/home/${p.linuxUser}/sites/${p.siteName}/logs/${names[p.log]}`);
  let real: string;
  try {
    real = await realpath(expected);
  } catch {
    return { text: "", size: 0 };
  }
  if (real !== expected) throw new Error("Log file is not a regular file in the logs folder");
  const st = await stat(real);
  if (!st.isFile()) throw new Error("Log file is not a regular file");
  const len = Math.min(st.size, p.bytes);
  const fh = await fopen(real, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    let text = buf.toString("utf8");
    if (len < st.size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    return { text, size: st.size };
  } finally {
    await fh.close();
  }
}

function num(v: string | undefined): number | null {
  if (!v || v === "[not set]" || v === "infinity" || !/^\d+$/.test(v)) return null;
  return Number(v);
}

async function show(unit: string, props: string[]): Promise<Record<string, string>> {
  const r = await run("systemctl", ["show", unit, ...props.map((x) => `--property=${x}`)], { allowFail: true, alwaysRun: !env.dryRun });
  return Object.fromEntries(
    r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

export async function statsAccount(p: JobPayloads["stats.account"]): Promise<AccountUsage> {
  const slice = await show(`hp-${p.linuxUser}.slice`, ["MemoryCurrent", "CPUUsageNSec", "TasksCurrent"]);
  const du = await run("du", ["-sb", sys(`/home/${p.linuxUser}`)], { allowFail: true, alwaysRun: true, timeoutSec: 20 });
  const units = [];
  for (const unit of p.units) {
    const s = await show(unit, ["ActiveState", "MemoryCurrent", "CPUUsageNSec", "ActiveEnterTimestamp"]);
    const cpu = num(s.CPUUsageNSec);
    units.push({
      unit,
      active: s.ActiveState ?? "unknown",
      memoryBytes: num(s.MemoryCurrent),
      cpuSeconds: cpu === null ? null : Math.round(cpu / 1e9),
      since: s.ActiveEnterTimestamp || null,
    });
  }
  const cpu = num(slice.CPUUsageNSec);
  return {
    diskBytes: du.code === 0 ? Number(du.stdout.split("\t")[0]) : null,
    memoryBytes: num(slice.MemoryCurrent),
    cpuSeconds: cpu === null ? null : Math.round(cpu / 1e9),
    tasks: num(slice.TasksCurrent),
    units,
  };
}
