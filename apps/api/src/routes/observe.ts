import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AccountUsage } from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { requireAuth } from "../auth.js";
import { ownedAccount, ownedSite } from "../access.js";
import { runFast } from "../queue.js";
import { serviceUnitNames } from "../specs.js";

/** Logs and resource usage, read live from the server by the agent. */
export async function observeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/sites/:id/logs", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    const q = z
      .object({ log: z.enum(["access", "app", "php-error", "cron"]).default("access"), kb: z.coerce.number().int().min(4).max(2000).default(200) })
      .parse(req.query);
    return runFast("logs.read", { linuxUser: site.account.linuxUser, siteName: site.name, log: q.log, bytes: q.kb * 1024 });
  });

  app.get("/accounts/:id/usage", async (req) => {
    const account = await ownedAccount(req, (req.params as { id: string }).id);
    const sites = await db.query.sites.findMany({ where: eq(schema.sites.accountId, account.id) });
    const units = sites.flatMap((s) => serviceUnitNames(account.linuxUser, s));
    const usage = (await runFast("stats.account", { linuxUser: account.linuxUser, units }, 30_000)) as AccountUsage;
    return {
      usage,
      limits: { diskMb: account.package.diskMb, ramMb: account.package.ramMb, cpuPercent: account.package.cpuPercent },
      sites: sites.map((s) => ({ id: s.id, name: s.name, units: serviceUnitNames(account.linuxUser, s) })),
    };
  });
}
