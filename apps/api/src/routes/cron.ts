import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { cronJobSchema, cronToOnCalendar, updateCronJobSchema, CRON_PRESETS } from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { notFound } from "../errors.js";
import { audit, currentUser, requireAuth } from "../auth.js";
import { ownedSite } from "../access.js";
import { enqueue, runFast } from "../queue.js";
import { loadSiteSpec } from "../specs.js";

const MAX_JOBS_PER_SITE = 50;

/** Rewrite all timers of a site from the database (idempotent). */
async function syncSiteCron(siteId: string, createdBy?: string): Promise<string> {
  const jobs = await db.query.cronJobs.findMany({ where: eq(schema.cronJobs.siteId, siteId) });
  return enqueue(
    "cron.sync",
    { site: await loadSiteSpec(siteId), jobs: jobs.map((j) => ({ id: j.id, onCalendar: cronToOnCalendar(j.schedule), command: j.command, enabled: j.enabled })) },
    { targetType: "site", targetId: siteId, createdBy, dedupeKey: `cron.sync:${siteId}` },
  );
}

export async function cronRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/cron/presets", async () => ({ presets: CRON_PRESETS }));

  app.get("/sites/:id/cron", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    const jobs = await db.query.cronJobs.findMany({ where: eq(schema.cronJobs.siteId, site.id), orderBy: asc(schema.cronJobs.createdAt) });
    return { jobs: jobs.map((j) => ({ ...j, onCalendar: cronToOnCalendar(j.schedule) })) };
  });

  app.post("/cron", async (req) => {
    const input = cronJobSchema.parse(req.body);
    const site = await ownedSite(req, input.siteId);
    const count = (await db.query.cronJobs.findMany({ where: eq(schema.cronJobs.siteId, site.id), columns: { id: true } })).length;
    if (count >= MAX_JOBS_PER_SITE) throw new Error(`A site can have at most ${MAX_JOBS_PER_SITE} cron jobs`);
    const [job] = await db.insert(schema.cronJobs).values({ ...input, schedule: input.schedule.trim() }).returning();
    const jobId = await syncSiteCron(site.id, currentUser(req).id);
    await audit(req, "cron.create", "cron", job!.id, { site: site.name, schedule: job!.schedule });
    return { job, jobId };
  });

  const load = async (req: Parameters<typeof ownedSite>[0], id: string) => {
    const job = await db.query.cronJobs.findFirst({ where: eq(schema.cronJobs.id, id) });
    if (!job) throw notFound("Cron job not found");
    await ownedSite(req, job.siteId);
    return job;
  };

  app.patch("/cron/:id", async (req) => {
    const job = await load(req, (req.params as { id: string }).id);
    const input = updateCronJobSchema.parse(req.body);
    const [updated] = await db.update(schema.cronJobs).set(input).where(eq(schema.cronJobs.id, job.id)).returning();
    const jobId = await syncSiteCron(job.siteId, currentUser(req).id);
    await audit(req, "cron.update", "cron", job.id, input);
    return { job: updated, jobId };
  });

  app.delete("/cron/:id", async (req) => {
    const job = await load(req, (req.params as { id: string }).id);
    await db.delete(schema.cronJobs).where(eq(schema.cronJobs.id, job.id));
    const jobId = await syncSiteCron(job.siteId, currentUser(req).id);
    await audit(req, "cron.delete", "cron", job.id);
    return { jobId };
  });

  app.post("/cron/:id/run", async (req) => {
    const job = await load(req, (req.params as { id: string }).id);
    await runFast("cron.run", { site: await loadSiteSpec(job.siteId), jobId: job.id });
    await audit(req, "cron.run", "cron", job.id);
    return { ok: true, note: "Started. Output goes to the site's cron log." };
  });
}

export { syncSiteCron };
