import { createWriteStream, type WriteStream } from "node:fs";
import { Writable } from "node:stream";
import { redis } from "../redis.js";
import { mkdir, readdir, rename, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Job } from "bullmq";
import { paths, type DeployResult, type JobPayloads, type SiteSpec } from "@hostpanel/shared";
import { env, sys } from "../env.js";
import { run, runAsUser } from "../exec.js";
import { exists, readLink, swapSymlink, writeFileAtomic } from "../fsx.js";
import { appDir, decryptEnv, reloadPhp, runtimePath, serviceUnits, writeEnvFile, writePhpPool } from "../runtime.js";
import { PLACEHOLDER } from "./sites.js";

/** Folders that survive deploys: if shared/<path> exists it is symlinked into every release. */
const SHARED_PATHS = ["storage", "uploads", "public/uploads", "wp-content/uploads", "media", "data"];

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Deploy log: written to /var/log/hostpanel/deploys/<id>.log AND mirrored to Redis, so the panel
 *  can show it even when the build ran on another server. Kept in Redis for 14 days. */
class TeeStream extends Writable {
  constructor(
    private file: WriteStream,
    private key: string,
  ) {
    super();
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.file.write(chunk);
    redis()
      .multi()
      .append(this.key, typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      .expire(this.key, 14 * 86400)
      .exec()
      .then(() => cb(), () => cb()); // a Redis hiccup must never fail a deploy
  }
  override _final(cb: (e?: Error | null) => void): void {
    this.file.end(() => cb());
  }
}

export class DeployLog {
  constructor(public stream: Writable) {}
  line(msg: string): void {
    this.stream.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
  }
  close(): Promise<void> {
    return new Promise((r) => this.stream.end(r));
  }
}

export async function openLog(deploymentId: string): Promise<DeployLog> {
  const file = sys(paths.deployLog(deploymentId));
  await mkdir(dirname(file), { recursive: true, mode: 0o750 });
  const fileStream = createWriteStream(file, { flags: "a", mode: 0o640 });
  await run("chgrp", [env.panelGroup, file], { allowFail: true });
  return new DeployLog(new TeeStream(fileStream, `hp:deploylog:${deploymentId}`));
}

export async function siteDeploy(p: JobPayloads["site.deploy"], job: Job): Promise<DeployResult> {
  const { site } = p;
  const log = await openLog(p.deploymentId);
  const progress = (pct: number, message: string) => {
    log.line(message);
    return job.updateProgress({ pct, message });
  };
  try {
    if (!p.repoFullName) throw new Error("No repository connected");
    const releases = paths.releases(site.linuxUser, site.name);
    const tmpDir = `${releases}/.incoming-${p.deploymentId}`;
    await rm(sys(tmpDir), { recursive: true, force: true });
    await mkdir(sys(releases), { recursive: true });

    // 1. Fetch the code. The token goes in an HTTP header via env vars, never in the URL or argv.
    await progress(5, `Cloning ${p.repoFullName}@${p.branch}`);
    const gitEnv: Record<string, string> = { GIT_TERMINAL_PROMPT: "0", HOME: "/root" };
    if (p.gitToken) {
      const basic = Buffer.from(`x-access-token:${p.gitToken}`).toString("base64");
      Object.assign(gitEnv, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` });
    }
    const url = `https://github.com/${p.repoFullName}.git`;
    await run("git", ["clone", "--depth", "50", "--single-branch", "--branch", p.branch, "--", url, sys(tmpDir)], {
      env: gitEnv,
      log: log.stream,
      timeoutSec: 300,
      alwaysRun: true,
    });
    if (p.commitSha) {
      const co = await run("git", ["-C", sys(tmpDir), "checkout", "--quiet", "--detach", p.commitSha], { allowFail: true, alwaysRun: true, log: log.stream });
      if (co.code !== 0) {
        await run("git", ["-C", sys(tmpDir), "fetch", "--depth", "1", "origin", p.commitSha], { env: gitEnv, alwaysRun: true, log: log.stream, timeoutSec: 120 });
        await run("git", ["-C", sys(tmpDir), "checkout", "--quiet", "--detach", p.commitSha], { alwaysRun: true, log: log.stream });
      }
    }
    const sha = (await run("git", ["-C", sys(tmpDir), "rev-parse", "HEAD"], { alwaysRun: true })).stdout.trim();
    const message = (await run("git", ["-C", sys(tmpDir), "log", "-1", "--pretty=%s"], { alwaysRun: true })).stdout.trim();
    await rm(sys(`${tmpDir}/.git`), { recursive: true, force: true });
    const releaseName = `${stamp()}-${sha.slice(0, 12)}`;
    const releaseDir = `${releases}/${releaseName}`;
    await rename(sys(tmpDir), sys(releaseDir));
    await progress(20, `Checked out ${sha.slice(0, 7)}: ${message}`);

    // 2. Persistent folders and the .env file.
    const app = appDir(site, releaseDir);
    if (!(await exists(app))) throw new Error(`Folder '${site.rootDir}' does not exist in the repository`);
    const shared = paths.shared(site.linuxUser, site.name);
    for (const rel of SHARED_PATHS) {
      if (await exists(`${shared}/${rel}`)) {
        await rm(sys(`${app}/${rel}`), { recursive: true, force: true });
        await mkdir(dirname(sys(`${app}/${rel}`)), { recursive: true });
        await symlink(sys(`${shared}/${rel}`), sys(`${app}/${rel}`));
        log.line(`Linked shared/${rel}`);
      }
    }
    if (await exists(`${shared}/.env`)) {
      await rm(sys(`${app}/.env`), { force: true });
      await symlink(sys(`${shared}/.env`), sys(`${app}/.env`));
      log.line("Linked shared/.env");
    } else if (site.env.length) {
      const vars = decryptEnv(site);
      const body = Object.entries(vars)
        .map(([k, v]) => `${k}=${/[\s#"'$`\\]/.test(v) ? JSON.stringify(v) : v}`)
        .join("\n");
      await writeFileAtomic(`${app}/.env`, body + "\n", 0o600);
      log.line(`Wrote .env with ${site.env.length} variable(s)`);
    }
    await run("chown", ["-R", "--no-dereference", `${site.linuxUser}:${site.linuxUser}`, releaseDir]);
    await run("setfacl", ["-R", "-m", `u:${env.webUser}:rX`, releaseDir]);

    // 3. Build as the customer's user, inside their resource limits.
    if (site.buildCmd.trim()) {
      await progress(30, `Building: ${site.buildCmd}`);
      await runAsUser(site.linuxUser, site.buildCmd, {
        cwd: sys(app),
        env: { ...decryptEnv(site), PATH: runtimePath(site), HOME: `/home/${site.linuxUser}`, CI: "true" },
        log: log.stream,
        timeoutSec: env.buildTimeoutSec,
      });
      await progress(75, "Build finished");
    } else {
      await progress(75, "No build command, skipping build");
    }

    // 4. Switch traffic to the new release.
    const previous = await readLink(paths.current(site.linuxUser, site.name));
    await swapSymlink(releaseDir, paths.current(site.linuxUser, site.name));
    await progress(85, `Switched to release ${releaseName}`);
    await restartApp(site, log);

    // 5. Health check; put the previous release back if the new one does not answer.
    const healthy = await healthCheck(site, log);
    if (!healthy && previous && !previous.endsWith(PLACEHOLDER)) {
      log.line("Health check failed. Restoring the previous release.");
      await swapSymlink(previous, paths.current(site.linuxUser, site.name));
      await restartApp(site, log);
      await prune(site, p.keepReleases, log);
      return { releaseName, commitSha: sha, commitMessage: message, rolledBack: true };
    }
    if (!healthy) throw new Error("Health check failed and there is no earlier release to restore");

    await prune(site, p.keepReleases, log);
    await progress(100, `Live: ${sha.slice(0, 7)}`);
    return { releaseName, commitSha: sha, commitMessage: message, rolledBack: false };
  } catch (e) {
    log.line(`FAILED: ${(e as Error).message}`);
    throw e;
  } finally {
    await log.close();
  }
}

export async function siteRollback(p: JobPayloads["site.rollback"], job: Job): Promise<DeployResult> {
  const { site } = p;
  const log = await openLog(p.deploymentId);
  try {
    const target = `${paths.releases(site.linuxUser, site.name)}/${p.releaseName}`;
    if (!(await exists(target))) throw new Error(`Release ${p.releaseName} no longer exists on disk`);
    const previous = await readLink(paths.current(site.linuxUser, site.name));
    await swapSymlink(target, paths.current(site.linuxUser, site.name));
    log.line(`Switched to release ${p.releaseName}`);
    await job.updateProgress({ pct: 60, message: "Restarting" });
    await restartApp(site, log);
    if (!(await healthCheck(site, log))) {
      if (previous) {
        await swapSymlink(previous, paths.current(site.linuxUser, site.name));
        await restartApp(site, log);
      }
      throw new Error("The old release did not pass the health check; nothing changed");
    }
    const sha = p.releaseName.split("-")[2] ?? "";
    return { releaseName: p.releaseName, commitSha: sha, commitMessage: "Rollback", rolledBack: false };
  } finally {
    await log.close();
  }
}

export async function restartApp(site: SiteSpec, log: { stream: Writable; line: (m: string) => void }): Promise<void> {
  if (site.runtime === "node" || site.runtime === "python") {
    await writeEnvFile(site);
    // Rolling restart: one instance at a time so multi-instance sites never drop traffic.
    for (const unit of serviceUnits(site)) {
      try {
        await run("systemctl", ["restart", unit], { log: log.stream });
      } catch (e) {
        // Put the real reason in the deploy log: systemd's own message only says "see journalctl".
        log.line(`--- why ${unit} did not start ---`);
        const st = await run("systemctl", ["status", "--no-pager", "-l", "-n", "0", unit], { allowFail: true });
        const jr = await run("journalctl", ["-u", unit, "-n", "25", "--no-pager", "-o", "cat"], { allowFail: true });
        const app = await run("tail", ["-n", "40", `/home/${site.linuxUser}/sites/${site.name}/logs/app.log`], { allowFail: true });
        for (const part of [st.stdout, jr.stdout, app.stdout ? `app.log:\n${app.stdout}` : ""]) if (part?.trim()) log.stream.write(part.trimEnd() + "\n");
        throw e;
      }
      if (site.instances > 1) await new Promise((r) => setTimeout(r, 2000));
    }
    log.line(`Restarted ${site.instances} instance(s)`);
  } else if (site.runtime === "php") {
    await writePhpPool(site);
    await reloadPhp(site.runtimeVersion); // also clears OPcache for the new code
    log.line(`Reloaded PHP ${site.runtimeVersion}`);
  }
}

export async function healthCheck(site: SiteSpec, log: DeployLog): Promise<boolean> {
  if (site.runtime === "php" || site.runtime === "static") {
    const doc = [appDir(site), site.publicDir].filter(Boolean).join("/");
    const ok = await exists(doc);
    log.line(ok ? `Document root ${doc} is present` : `Document root ${doc} is missing (check the public folder setting)`);
    return ok;
  }
  if (env.dryRun) {
    log.line("[dry-run] skipping health check");
    return true;
  }
  if (site.background) {
    // Workers have no HTTP endpoint: healthy if every unit is still running after 10 seconds.
    await new Promise((r) => setTimeout(r, 10_000));
    const res = await run("systemctl", ["is-active", ...serviceUnits(site)], { allowFail: true });
    log.line(`Worker units: ${res.stdout.trim().replace(/\n/g, ", ")}`);
    return res.code === 0;
  }
  const url = `http://127.0.0.1:${site.port}${site.healthPath}`;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
      if (res.status < 500) {
        log.line(`Health check ${url} → ${res.status}`);
        return true;
      }
      log.line(`Health check ${url} → ${res.status}, retrying`);
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  log.line(`Health check ${url} did not succeed within 60 seconds`);
  return false;
}

/** Keep the newest N releases plus whatever `current` points at. */
async function prune(site: SiteSpec, keep: number, log: DeployLog): Promise<void> {
  const dir = paths.releases(site.linuxUser, site.name);
  const current = await readLink(paths.current(site.linuxUser, site.name));
  const names = (await readdir(sys(dir))).filter((n) => /^\d{8}-\d{6}-/.test(n)).sort().reverse();
  for (const name of names.slice(keep)) {
    if (current?.endsWith(`/${name}`)) continue;
    await rm(sys(`${dir}/${name}`), { recursive: true, force: true });
    log.line(`Removed old release ${name}`);
  }
}
