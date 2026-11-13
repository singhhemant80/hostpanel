import type { FastifyInstance } from "fastify";
import { asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createAccountSchema, packageSchema } from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { accountFilter, audit, currentUser, requireAdmin, requireAuth } from "../auth.js";
import { createAccount, deleteAccount, setAccountSuspended } from "../services/accounts.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---- Packages ----
  app.get("/packages", { preHandler: requireAuth }, async () => {
    const pkgs = await db.query.packages.findMany({ orderBy: asc(schema.packages.name) });
    const usage = await db
      .select({ packageId: schema.accounts.packageId, n: count() })
      .from(schema.accounts)
      .groupBy(schema.accounts.packageId);
    const byPkg = new Map(usage.map((u) => [u.packageId, u.n]));
    return { packages: pkgs.map((p) => ({ ...p, accountCount: byPkg.get(p.id) ?? 0 })) };
  });

  app.post("/packages", { preHandler: requireAdmin }, async (req) => {
    const [pkg] = await db.insert(schema.packages).values(packageSchema.parse(req.body)).returning();
    await audit(req, "package.create", "package", pkg!.id);
    return { package: pkg };
  });

  app.patch("/packages/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const [pkg] = await db.update(schema.packages).set(packageSchema.partial().parse(req.body)).where(eq(schema.packages.id, id)).returning();
    if (!pkg) throw notFound("Package not found");
    await audit(req, "package.update", "package", id);
    return { package: pkg };
  });

  app.delete("/packages/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const [{ n }] = (await db.select({ n: count() }).from(schema.accounts).where(eq(schema.accounts.packageId, id))) as [{ n: number }];
    if (n) throw conflict("Package is in use by accounts");
    await db.delete(schema.packages).where(eq(schema.packages.id, id));
    await audit(req, "package.delete", "package", id);
    return { ok: true };
  });

  // ---- Accounts ----
  app.get("/accounts", { preHandler: requireAuth }, async (req) => {
    const accounts = await db.query.accounts.findMany({
      where: await accountFilter(schema.accounts.id, currentUser(req)),
      with: {
        user: { columns: { id: true, email: true, name: true } },
        package: true,
        sites: { columns: { id: true } },
        domains: { columns: { id: true } },
        databases: { columns: { id: true } },
      },
      orderBy: desc(schema.accounts.createdAt),
    });
    return {
      accounts: accounts.map(({ sites, domains, databases, ...a }) => ({
        ...a,
        counts: { sites: sites.length, domains: domains.length, databases: databases.length },
      })),
    };
  });

  app.post("/accounts", { preHandler: requireAdmin }, async (req) => {
    const input = createAccountSchema.parse(req.body);
    const result = await createAccount(input, currentUser(req).id);
    await audit(req, "account.create", "account", result.account.id, { username: input.username });
    return result;
  });

  app.post("/accounts/:id/suspend", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const { suspended } = z.object({ suspended: z.boolean() }).parse(req.body);
    const r = await setAccountSuspended(id, suspended, currentUser(req).id);
    await audit(req, suspended ? "account.suspend" : "account.unsuspend", "account", id);
    return r;
  });

  app.patch("/accounts/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const { packageId } = z.object({ packageId: z.string() }).parse(req.body);
    if (!(await db.query.packages.findFirst({ where: eq(schema.packages.id, packageId) }))) throw notFound("Package not found");
    const [account] = await db.update(schema.accounts).set({ packageId }).where(eq(schema.accounts.id, id)).returning();
    if (!account) throw notFound("Account not found");
    await audit(req, "account.change_package", "account", id, { packageId });
    return { account };
  });

  app.delete("/accounts/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const r = await deleteAccount(id, currentUser(req).id);
    await audit(req, "account.delete", "account", id);
    return r;
  });

  app.get("/users", { preHandler: requireAdmin }, async () => ({
    users: await db.query.users.findMany({
      columns: { id: true, email: true, name: true, role: true, status: true, totpEnabled: true, createdAt: true },
      orderBy: desc(schema.users.createdAt),
    }),
  }));

  app.get("/audit", { preHandler: requireAdmin }, async (req) => {
    const { take } = z.object({ take: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return {
      entries: await db.query.auditLog.findMany({
        limit: take,
        orderBy: desc(schema.auditLog.createdAt),
        with: { user: { columns: { email: true } } },
      }),
    };
  });
}
