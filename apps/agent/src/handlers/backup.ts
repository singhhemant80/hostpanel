import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Job } from "bullmq";
import { paths, type JobPayloads, type RemoteSpec } from "@hostpanel/shared";
import { decrypt, env, sys } from "../env.js";
import { run } from "../exec.js";
import { exists, readLink, swapSymlink } from "../fsx.js";
import { restartApp } from "./deploy.js";

/**
 * One backup = one .tar in /var/backups/hostpanel/<user>/ holding:
 *   manifest.json, sites/<name>.tar.gz (live release + shared/), databases/<name>.sql.gz | .dump
 * Optionally copied to S3-compatible storage with rclone (config passed via env, never on disk).
 */

const TMP = "/var/lib/hostpanel/backup-tmp";

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function rcloneEnv(r: RemoteSpec): Record<string, string> {
  return {
    RCLONE_CONFIG_HP_TYPE: "s3",
    RCLONE_CONFIG_HP_PROVIDER: "Other",
    RCLONE_CONFIG_HP_ENDPOINT: r.endpoint,
    RCLONE_CONFIG_HP_REGION: r.region,
    RCLONE_CONFIG_HP_ACCESS_KEY_ID: decrypt(r.accessKeyEnc),
    RCLONE_CONFIG_HP_SECRET_ACCESS_KEY: decrypt(r.secretKeyEnc),
    RCLONE_CONFIG_HP_NO_CHECK_BUCKET: "true",
  };
}

const remotePath = (r: RemoteSpec, linuxUser: string, file: string) =>
  `hp:${r.bucket}/${[r.prefix.replace(/^\/|\/$/g, ""), linuxUser, file].filter(Boolean).join("/")}`;

interface Manifest {
  version: 1;
  linuxUser: string;
  createdAt: string;
  sites: { name: string; release: string | null }[];
  databases: { engine: "mariadb" | "postgres"; name: string; file: string }[];
}

export async function backupRun(p: JobPayloads["backup.run"], job: Job): Promise<{ fileName: string; sizeBytes: number; remote: boolean }> {
  const tmp = sys(`${TMP}/${p.backupId}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, "sites"), { recursive: true, mode: 0o700 });
  await mkdir(join(tmp, "databases"), { recursive: true, mode: 0o700 });
  const manifest: Manifest = { version: 1, linuxUser: p.linuxUser, createdAt: new Date().toISOString(), sites: [], databases: [] };
  const total = p.contents.sites.length + p.contents.databases.length || 1;
  let done = 0;
  const step = (message: string) => job.updateProgress({ pct: Math.round((++done / total) * 90), message });

  try {
    for (const name of p.contents.sites) {
      const siteDir = paths.site(p.linuxUser, name);
      if (!(await exists(siteDir))) continue;
      const target = await readLink(paths.current(p.linuxUser, name));
      const release = target ? basename(target) : null;
      const parts = [release ? `releases/${release}` : null, (await exists(`${siteDir}/shared`)) ? "shared" : null].filter(Boolean) as string[];
      if (parts.length) {
        await run("tar", ["-czf", join(tmp, "sites", `${name}.tar.gz`), "-C", sys(siteDir), "--", ...parts], { alwaysRun: true, timeoutSec: 3600 });
      }
      manifest.sites.push({ name, release });
      await step(`Site ${name}`);
    }

    for (const db of p.contents.databases) {
      if (db.engine === "mariadb") {
        const file = `${db.name}.sql.gz`;
        await run("bash", ["-c", 'set -o pipefail; mariadb-dump --single-transaction --quick --routines --triggers "$1" | gzip -6', "bash", db.name], {
          outputFile: join(tmp, "databases", file),
          timeoutSec: 3600,
        });
        manifest.databases.push({ ...db, file });
      } else {
        const file = `${db.name}.dump`;
        await run("runuser", ["-u", "postgres", "--", "pg_dump", "-Fc", "--no-owner", db.name], { outputFile: join(tmp, "databases", file), timeoutSec: 3600 });
        manifest.databases.push({ ...db, file });
      }
      if (env.dryRun) await writeFile(join(tmp, "databases", manifest.databases.at(-1)!.file), "");
      await step(`Database ${db.name}`);
    }

    await writeFile(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    const dir = sys(paths.backups(p.linuxUser));
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const fileName = `${stamp()}-${p.backupId}.tar`;
    const file = join(dir, fileName);
    await run("tar", ["-cf", file, "-C", tmp, "."], { alwaysRun: true, timeoutSec: 3600 });
    await chmod(file, 0o640);
    await run("chgrp", [env.panelGroup, dir, file], { allowFail: true });
    const sizeBytes = (await stat(file)).size;

    if (p.remote) {
      await job.updateProgress({ pct: 92, message: "Uploading to remote storage" });
      await run("rclone", ["copyto", "--s3-no-check-bucket", file, remotePath(p.remote, p.linuxUser, fileName)], { env: rcloneEnv(p.remote), timeoutSec: 6 * 3600 });
    }

    // keep the newest N local copies
    const all = (await readdir(dir)).filter((f) => /^\d{8}-\d{6}-[a-z0-9]+\.tar$/.test(f)).sort().reverse();
    for (const old of all.slice(p.keepLocal)) await rm(join(dir, old), { force: true });

    return { fileName, sizeBytes, remote: Boolean(p.remote) };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function backupRestore(p: JobPayloads["backup.restore"], job: Job): Promise<{ sites: string[]; databases: string[] }> {
  const file = sys(join(paths.backups(p.linuxUser), p.fileName));
  if (!(await exists(join(paths.backups(p.linuxUser), p.fileName)))) {
    if (!p.remote) throw new Error("Backup file is no longer on this server");
    await job.updateProgress({ pct: 5, message: "Downloading from remote storage" });
    await mkdir(sys(paths.backups(p.linuxUser)), { recursive: true, mode: 0o750 });
    await run("rclone", ["copyto", remotePath(p.remote, p.linuxUser, p.fileName), file], { env: rcloneEnv(p.remote), timeoutSec: 6 * 3600 });
  }
  const tmp = sys(`${TMP}/restore-${p.backupId}-${Date.now()}`);
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const restoredSites: string[] = [];
  const restoredDbs: string[] = [];
  try {
    await run("tar", ["-xf", file, "-C", tmp], { alwaysRun: true, timeoutSec: 3600 });
    const manifest = JSON.parse(await readFile(join(tmp, "manifest.json"), "utf8")) as Manifest;
    if (manifest.linuxUser !== p.linuxUser) throw new Error("This backup belongs to a different account");

    for (const { name, spec } of p.sites) {
      const m = manifest.sites.find((s) => s.name === name);
      const archive = join(tmp, "sites", `${name}.tar.gz`);
      if (!m || !(await stat(archive).then(() => true, () => false))) throw new Error(`Site ${name} is not in this backup`);
      if (!spec) throw new Error(`Create the site '${name}' in the panel first, then restore its files`);
      await job.updateProgress({ pct: 20, message: `Restoring site ${name}` });
      const out = join(tmp, "x", name);
      await mkdir(out, { recursive: true });
      await run("tar", ["-xzf", archive, "-C", out], { alwaysRun: true, timeoutSec: 3600 });
      const siteDir = paths.site(p.linuxUser, name);
      await mkdir(sys(`${siteDir}/releases`), { recursive: true });
      if (m.release && (await stat(join(out, "releases", m.release)).then(() => true, () => false))) {
        const dest = `${siteDir}/releases/${m.release}`;
        await rm(sys(dest), { recursive: true, force: true });
        await rename(join(out, "releases", m.release), sys(dest));
        await swapSymlink(dest, paths.current(p.linuxUser, name));
      }
      if (await stat(join(out, "shared")).then(() => true, () => false)) {
        if (await exists(`${siteDir}/shared`)) await rename(sys(`${siteDir}/shared`), sys(`${siteDir}/shared.before-restore-${stamp()}`));
        await rename(join(out, "shared"), sys(`${siteDir}/shared`));
      }
      await run("chown", ["-R", "--no-dereference", `${p.linuxUser}:${p.linuxUser}`, siteDir]);
      await run("setfacl", ["-R", "-m", `u:${env.webUser}:rX`, siteDir]);
      const logStream = createWriteStream("/dev/null");
      await restartApp(spec, { stream: logStream, line: () => undefined });
      logStream.end();
      restoredSites.push(name);
    }

    for (const db of p.databases) {
      const m = manifest.databases.find((d) => d.name === db.name && d.engine === db.engine);
      if (!m) throw new Error(`Database ${db.name} is not in this backup`);
      await job.updateProgress({ pct: 70, message: `Restoring database ${db.name}` });
      const dump = join(tmp, "databases", m.file);
      if (db.engine === "mariadb") {
        await run("bash", ["-c", 'set -o pipefail; gunzip -c "$1" | mariadb "$2"', "bash", dump, db.name], { timeoutSec: 3600 });
      } else {
        await run("runuser", ["-u", "postgres", "--", "pg_restore", "--clean", "--if-exists", "--no-owner", `--role=${db.user}`, "-d", db.name], {
          inputFile: dump,
          timeoutSec: 3600,
        });
      }
      restoredDbs.push(db.name);
    }
    return { sites: restoredSites, databases: restoredDbs };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function backupDelete(p: JobPayloads["backup.delete"]): Promise<void> {
  await rm(sys(join(paths.backups(p.linuxUser), p.fileName)), { force: true });
  if (p.remote) {
    await run("rclone", ["deletefile", remotePath(p.remote, p.linuxUser, p.fileName)], { env: rcloneEnv(p.remote), allowFail: true, timeoutSec: 300 });
  }
}
