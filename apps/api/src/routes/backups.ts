import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { backupSettingsSchema, paths } from "@hostpanel/shared";
import { config } from "../config.js";
import { db, schema } from "../db.js";
import { encrypt } from "../crypto.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { accountFilter, audit, currentUser, requireAdmin, requireAuth } from "../auth.js";
import { ownedAccount } from "../access.js";
import { enqueue } from "../queue.js";
import { getSetting, remoteSpec, setSetting } from "../settings.js";
import { siteSpec } from "../specs.js";

/** Queue a full backup of one account (all sites + databases). */
export async function startBackup(accountId: string, trigger: "scheduled" | "manual", createdBy?: string) {
  const account = await db.query.accounts.findFirst({
    where: eq(schema.accounts.id, accountId),
    with: { sites: { columns: { name: true } }, databases: { columns: { engine: true, name: true, status: true } } },
  });
  if (!account) throw notFound("Account not found");
  const running = await db.query.backups.findFirst({
    where: and(eq(schema.backups.accountId, accountId), inArray(schema.backups.status, ["queued", "running", "restoring"])),
  });
  if (running) throw conflict("A backup or restore for this account is already running");
  const settings = await getSetting("backups");
  const contents = {
    sites: account.sites.map((s) => s.name),
    databases: account.databases.filter((d) => d.status === "active").map((d) => ({ engine: d.engine as "mariadb" | "postgres", name: d.name })),
  };
  const remote = remoteSpec(settings);
  const [backup] = await db.insert(schema.backups).values({ accountId, trigger, contents, remote: Boolean(remote) }).returning();
  await enqueue(
    "backup.run",
    { backupId: backup!.id, linuxUser: account.linuxUser, contents, remote, keepLocal: settings.keepLocal },
    { targetType: "backup", targetId: backup!.id, createdBy, sensitive: true },
  );
  return backup!;
}

/** Called every few minutes; runs the nightly backup once per day at the configured hour. */
export async function backupScheduler(log: { info: (m: string) => void; error: (e: unknown, m: string) => void }): Promise<void> {
  const s = await getSetting("backups");
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (!s.enabled || now.getHours() !== s.hour || s.lastScheduledDate === today) return;
  await setSetting("backups", { ...s, lastScheduledDate: today });
  const accounts = await db.query.accounts.findMany({ where: eq(schema.accounts.status, "active"), columns: { id: true } });
  for (const a of accounts) {
    await startBackup(a.id, "scheduled").catch((e) => log.error(e, `scheduled backup for ${a.id} not started`));
  }
  log.info(`Nightly backups queued for ${accounts.length} account(s)`);
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/backups", async (req) => {
    const backups = await db.query.backups.findMany({
      where: await accountFilter(schema.backups.accountId, currentUser(req)),
      with: { account: { columns: { username: true } } },
      orderBy: desc(schema.backups.createdAt),
      limit: 200,
    });
    return { backups };
  });

  app.post("/accounts/:id/backups", async (req) => {
    const account = await ownedAccount(req, (req.params as { id: string }).id);
    const backup = await startBackup(account.id, "manual", currentUser(req).id);
    await audit(req, "backup.create", "account", account.id);
    return { backup };
  });

  const load = async (req: Parameters<typeof ownedAccount>[0]) => {
    const backup = await db.query.backups.findFirst({ where: eq(schema.backups.id, (req.params as { id: string }).id) });
    if (!backup) throw notFound("Backup not found");
    const account = await ownedAccount(req, backup.accountId);
    return { backup, account };
  };

  app.get("/backups/:id/download", async (req, reply) => {
    const { backup, account } = await load(req);
    if (!backup.fileName) throw badRequest("Backup is not finished");
    const file = `${config.devSandboxRoot}${paths.backups(account.linuxUser)}/${backup.fileName}`;
    const st = await stat(file).catch(() => null);
    if (!st) throw notFound(backup.remote ? "Not on this server any more; it is in remote storage. Restore it, or download it from your bucket." : "Backup file no longer exists");
    await audit(req, "backup.download", "backup", backup.id);
    return reply
      .header("Content-Type", "application/x-tar")
      .header("Content-Length", st.size)
      .header("Content-Disposition", `attachment; filename="${account.username}-${backup.fileName}"`)
      .send(createReadStream(file));
  });

  app.post("/backups/:id/restore", async (req) => {
    const { backup, account } = await load(req);
    if (backup.status !== "done" || !backup.fileName) throw badRequest("Only finished backups can be restored");
    const body = z.object({ sites: z.array(z.string()).default([]), databases: z.array(z.string()).default([]) }).parse(req.body);
    if (!body.sites.length && !body.databases.length) throw badRequest("Choose at least one site or database");
    const contents = backup.contents ?? { sites: [], databases: [] };

    const sites = [];
    for (const name of body.sites) {
      if (!contents.sites.includes(name)) throw badRequest(`Site ${name} is not in this backup`);
      const site = await db.query.sites.findFirst({
        where: and(eq(schema.sites.accountId, account.id), eq(schema.sites.name, name)),
        with: { account: true, env: true },
      });
      sites.push({ name, spec: site ? siteSpec(site) : null });
    }
    const databases = [];
    for (const name of body.databases) {
      const d = contents.databases.find((x) => x.name === name);
      if (!d) throw badRequest(`Database ${name} is not in this backup`);
      const row = await db.query.databases.findFirst({ where: eq(schema.databases.name, name) });
      if (!row || row.accountId !== account.id) throw badRequest(`Create the database ${name} again before restoring it`);
      databases.push({ engine: d.engine, name, user: row.dbUser });
    }
    const settings = await getSetting("backups");
    await db.update(schema.backups).set({ status: "restoring", error: null }).where(eq(schema.backups.id, backup.id));
    const jobId = await enqueue(
      "backup.restore",
      { backupId: backup.id, linuxUser: account.linuxUser, fileName: backup.fileName, remote: backup.remote ? remoteSpec(settings) : null, sites, databases },
      { targetType: "backup", targetId: backup.id, createdBy: currentUser(req).id, sensitive: true },
    );
    await audit(req, "backup.restore", "backup", backup.id, body);
    return { jobId };
  });

  app.delete("/backups/:id", async (req) => {
    const { backup, account } = await load(req);
    if (["queued", "running", "restoring"].includes(backup.status)) throw conflict("Wait until the backup or restore has finished");
    if (!backup.fileName) {
      await db.delete(schema.backups).where(eq(schema.backups.id, backup.id));
      return { ok: true };
    }
    await db.update(schema.backups).set({ status: "deleting" }).where(eq(schema.backups.id, backup.id));
    const settings = await getSetting("backups");
    const jobId = await enqueue(
      "backup.delete",
      { linuxUser: account.linuxUser, fileName: backup.fileName, remote: backup.remote ? remoteSpec(settings) : null },
      { targetType: "backup", targetId: backup.id, createdBy: currentUser(req).id, sensitive: true },
    );
    await audit(req, "backup.delete", "backup", backup.id);
    return { jobId };
  });

  // ---- settings (admin) ----
  app.get("/settings/backups", { preHandler: requireAdmin }, async () => {
    const s = await getSetting("backups");
    return {
      enabled: s.enabled,
      hour: s.hour,
      keepLocal: s.keepLocal,
      remote: s.remote ? { endpoint: s.remote.endpoint, region: s.remote.region, bucket: s.remote.bucket, prefix: s.remote.prefix, keysSet: Boolean(s.remote.accessKeyEnc && s.remote.secretKeyEnc) } : null,
    };
  });

  app.put("/settings/backups", { preHandler: requireAdmin }, async (req) => {
    const input = backupSettingsSchema.parse(req.body);
    const current = await getSetting("backups");
    let remote = null;
    if (input.remote) {
      const accessKeyEnc = input.remote.accessKey ? encrypt(input.remote.accessKey) : (current.remote?.accessKeyEnc ?? null);
      const secretKeyEnc = input.remote.secretKey ? encrypt(input.remote.secretKey) : (current.remote?.secretKeyEnc ?? null);
      if (!accessKeyEnc || !secretKeyEnc) throw badRequest("Enter the access key and secret key for the remote storage");
      remote = {
        endpoint: input.remote.endpoint.replace(/\/$/, ""),
        region: input.remote.region,
        bucket: input.remote.bucket,
        prefix: input.remote.prefix,
        accessKeyEnc,
        secretKeyEnc,
      };
    }
    await setSetting("backups", { enabled: input.enabled, hour: input.hour, keepLocal: input.keepLocal, remote, lastScheduledDate: current.lastScheduledDate });
    await audit(req, "settings.backups");
    return { ok: true };
  });
}
