import type { FastifyInstance } from "fastify";
import { Job } from "bullmq";
import { count, desc, inArray, sql } from "drizzle-orm";
import { DEFAULT_VERSION, RUNTIME_DEFAULTS, RUNTIME_VERSIONS, RUNTIMES } from "@hostpanel/shared";
import { config } from "../config.js";
import { db, schema } from "../db.js";
import { currentUser, requireAdmin, requireAuth, visibleAccountIds } from "../auth.js";
import { agentQueue, enqueue, queueEvents } from "../queue.js";
import { syncRoutes } from "../specs.js";
import { githubConfigured } from "../github.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    await db.execute(sql`select 1`);
    return { ok: true };
  });

  /** Static facts the UI needs (runtimes, server IPs, GitHub App install link). */
  app.get("/system/info", { preHandler: requireAuth }, async () => ({
    runtimes: RUNTIMES.map((r) => ({ id: r, versions: RUNTIME_VERSIONS[r], defaultVersion: DEFAULT_VERSION[r], defaults: RUNTIME_DEFAULTS[r] })),
    dnsTargets: { ipv4: config.serverIpv4, ipv6: config.serverIpv6 },
    github: {
      configured: githubConfigured(),
      installUrl: config.github.appSlug ? `https://github.com/apps/${config.github.appSlug}/installations/new` : null,
      webhookUrl: `${config.panelUrl}/api/v1/webhooks/github`,
    },
    panelUrl: config.panelUrl,
  }));

  app.get("/system/overview", { preHandler: requireAuth }, async (req) => {
    const ids = await visibleAccountIds(currentUser(req));
    const by = (col: Parameters<typeof inArray>[0]) => (ids === null ? undefined : inArray(col, ids.length ? ids : ["-none-"]));
    const n = async (table: typeof schema.sites | typeof schema.domains | typeof schema.databases) =>
      (await db.select({ n: count() }).from(table).where(by(table.accountId)))[0]!.n;

    const siteIds =
      ids === null ? null : (await db.select({ id: schema.sites.id }).from(schema.sites).where(by(schema.sites.accountId))).map((s) => s.id);
    const recentDeployments = await db.query.deployments.findMany({
      where: siteIds === null ? undefined : inArray(schema.deployments.siteId, siteIds.length ? siteIds : ["-none-"]),
      orderBy: desc(schema.deployments.createdAt),
      limit: 8,
      with: { site: { columns: { id: true, name: true } } },
    });
    return {
      counts: {
        sites: await n(schema.sites),
        domains: await n(schema.domains),
        databases: await n(schema.databases),
        accounts: ids === null ? (await db.select({ n: count() }).from(schema.accounts))[0]!.n : ids.length,
      },
      recentDeployments,
    };
  });

  app.get("/system/stats", { preHandler: requireAdmin }, async (req) => {
    const id = await enqueue("system.stats", {}, { targetType: "server", createdBy: currentUser(req).id });
    const job = await Job.fromId(agentQueue, id);
    if (!job) return { stats: null };
    try {
      return { stats: await job.waitUntilFinished(queueEvents(), 10_000) };
    } catch {
      return { stats: null, error: "The agent did not answer within 10 seconds. Is hostpanel-agent running?" };
    }
  });

  app.post("/system/routes/sync", { preHandler: requireAdmin }, async (req) => ({ jobId: await syncRoutes(currentUser(req).id) }));

  app.get("/system/jobs", { preHandler: requireAdmin }, async () => ({
    jobs: await db.query.jobs.findMany({ orderBy: desc(schema.jobs.createdAt), limit: 100 }),
    counts: await agentQueue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
  }));
}
