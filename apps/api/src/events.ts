import { and, eq } from "drizzle-orm";
import type { DeployResult } from "@hostpanel/shared";
import { db, schema } from "./db.js";
import { deploymentUrl } from "./deploy.js";
import { setCommitStatus } from "./github.js";
import { eventsFor } from "./queue.js";

type Log = { error: (o: unknown, m?: string) => void };

/**
 * Mirrors agent job progress/results into Postgres and applies side effects
 * (site/domain/account status, deployment status, GitHub commit status).
 * Runs in exactly one API process (see server.ts).
 */
const listening = new Set<string>();
let logRef: Log | null = null;

/** Listen to every server's queue (call again after a server joins). */
export async function startEventListener(log: Log): Promise<void> {
  logRef = log;
  const servers = await db.query.servers.findMany({ columns: { queueSuffix: true } });
  for (const s of new Set(["", ...servers.map((x) => x.queueSuffix)])) listenServer(s);
}

export function listenServer(suffix: string): void {
  if (listening.has(suffix) || !logRef) return;
  listening.add(suffix);
  const log = logRef;
  const ev = eventsFor(suffix);
  const safe = (p: Promise<unknown>, what: string) => void p.catch((e) => log.error(e, what));

  ev.on("active", ({ jobId }) => safe(onActive(jobId), "job active handler failed"));
  ev.on("progress", ({ jobId, data }) => {
    const d = (typeof data === "object" && data ? data : { pct: Number(data) }) as { pct?: number; message?: string };
    safe(
      db
        .update(schema.jobs)
        .set({ progress: Math.max(0, Math.min(100, Math.round(d.pct ?? 0))), message: d.message?.slice(0, 500) })
        .where(eq(schema.jobs.id, jobId)),
      "job progress handler failed",
    );
  });
  ev.on("completed", ({ jobId, returnvalue }) => safe(onDone(jobId, true, returnvalue, null), "job completion handler failed"));
  ev.on("failed", ({ jobId, failedReason }) => safe(onDone(jobId, false, null, failedReason), "job failure handler failed"));
}

async function onActive(jobId: string): Promise<void> {
  const [job] = await db.update(schema.jobs).set({ status: "active" }).where(eq(schema.jobs.id, jobId)).returning();
  if (job?.type === "backup.run" && job.targetId) {
    await db.update(schema.backups).set({ status: "running" }).where(eq(schema.backups.id, job.targetId));
  }
  if (job && (job.type === "site.deploy" || job.type === "site.rollback" || job.type === "app.install") && job.targetId) {
    await db.update(schema.deployments).set({ status: "building", startedAt: new Date() }).where(eq(schema.deployments.id, job.targetId));
  }
}

export async function onDone(jobId: string, ok: boolean, returnvalue: unknown, error: string | null): Promise<void> {
  const [job] = await db
    .update(schema.jobs)
    .set({ status: ok ? "completed" : "failed", ...(ok ? { progress: 100 } : {}), error: error?.slice(0, 4000), finishedAt: new Date() })
    .where(eq(schema.jobs.id, jobId))
    .returning();
  const id = job?.targetId;
  if (!job || !id) return;
  const st = ok ? ("active" as const) : ("failed" as const);

  switch (job.type) {
    case "account.create":
      await db.update(schema.accounts).set({ status: st }).where(eq(schema.accounts.id, id));
      break;
    case "site.provision":
      await db.update(schema.sites).set({ status: st, running: ok }).where(eq(schema.sites.id, id));
      break;
    case "site.control":
      // routes enqueue site.control with targetType "site:start" | "site:stop" | "site:restart"
      if (ok) await db.update(schema.sites).set({ running: job.targetType !== "site:stop" }).where(eq(schema.sites.id, id));
      break;
    case "site.remove":
      if (ok) await db.delete(schema.sites).where(eq(schema.sites.id, id));
      break;
    case "account.delete":
      if (ok) await db.delete(schema.accounts).where(eq(schema.accounts.id, id));
      break;
    case "db.create":
      await db.update(schema.databases).set({ status: st }).where(eq(schema.databases.id, id));
      break;
    case "db.delete":
      if (ok) await db.delete(schema.databases).where(eq(schema.databases.id, id));
      break;
    case "routes.sync":
      if (ok) await db.update(schema.domains).set({ status: "active" }).where(eq(schema.domains.status, "pending"));
      break;
    case "site.deploy":
    case "site.rollback":
      await onDeployDone(id, ok, returnvalue as DeployResult | null, error);
      break;
    case "app.install": {
      await onDeployDone(id, ok, returnvalue as DeployResult | null, error);
      // the app's database (if any) was created by the same job
      const dep = await db.query.deployments.findFirst({ where: eq(schema.deployments.id, id), with: { site: { with: { account: true } } } });
      if (dep) {
        const dbName = `${dep.site.account.username}_${dep.site.name}`.replace(/-/g, "_").slice(0, 63);
        await db.update(schema.databases).set({ status: ok ? "active" : "failed" }).where(eq(schema.databases.name, dbName));
        await db.update(schema.sites).set({ status: ok ? "active" : "failed" }).where(eq(schema.sites.id, dep.siteId));
      }
      break;
    }
    case "backup.run": {
      const r = returnvalue as { fileName: string; sizeBytes: number; remote: boolean } | null;
      await db
        .update(schema.backups)
        .set(ok && r ? { status: "done", fileName: r.fileName, sizeBytes: r.sizeBytes, remote: r.remote, finishedAt: new Date() } : { status: "failed", error: error?.slice(0, 2000), finishedAt: new Date() })
        .where(eq(schema.backups.id, id));
      break;
    }
    case "backup.restore":
      await db
        .update(schema.backups)
        .set({ status: "done", error: ok ? null : `Restore failed: ${error?.slice(0, 1900)}` })
        .where(eq(schema.backups.id, id));
      break;
    case "backup.delete":
      if (ok) await db.delete(schema.backups).where(eq(schema.backups.id, id));
      else await db.update(schema.backups).set({ status: "done", error: `Delete failed: ${error?.slice(0, 1900)}` }).where(eq(schema.backups.id, id));
      break;
  }
}

async function onDeployDone(deploymentId: string, ok: boolean, result: DeployResult | null, error: string | null): Promise<void> {
  const dep = await db.query.deployments.findFirst({
    where: eq(schema.deployments.id, deploymentId),
    with: { site: { with: { git: true } } },
  });
  if (!dep) return;
  const live = ok && result !== null && !result.rolledBack;

  if (live) {
    await db.transaction(async (tx) => {
      await tx
        .update(schema.deployments)
        .set({ status: "superseded" })
        .where(and(eq(schema.deployments.siteId, dep.siteId), eq(schema.deployments.status, "live")));
      await tx
        .update(schema.deployments)
        .set({
          status: "live",
          releaseName: result.releaseName,
          commitSha: dep.commitSha || result.commitSha,
          commitMessage: dep.commitMessage ?? result.commitMessage,
          finishedAt: new Date(),
        })
        .where(eq(schema.deployments.id, dep.id));
      await tx
        .update(schema.sites)
        .set({ currentRelease: result.releaseName, status: "active", running: true })
        .where(eq(schema.sites.id, dep.siteId));
    });
  } else {
    await db
      .update(schema.deployments)
      .set({
        status: result?.rolledBack ? "rolled_back" : "failed",
        releaseName: result?.releaseName ?? dep.releaseName,
        commitSha: dep.commitSha || result?.commitSha || null,
        commitMessage: dep.commitMessage ?? result?.commitMessage ?? null,
        error: error?.slice(0, 4000) ?? (result?.rolledBack ? "Health check failed; the previous release is still live" : null),
        finishedAt: new Date(),
      })
      .where(eq(schema.deployments.id, dep.id));
  }

  const git = dep.site.git;
  const sha = dep.commitSha || result?.commitSha;
  if (git?.installationId && sha && dep.trigger !== "rollback") {
    await setCommitStatus(
      git.installationId,
      git.repoFullName,
      sha,
      live ? "success" : "failure",
      live ? "Live on HostPanel" : "Deploy failed on HostPanel",
      deploymentUrl(dep.siteId),
    ).catch(() => undefined);
  }
}
