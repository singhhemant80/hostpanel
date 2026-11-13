import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { resellerSchema } from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { audit, currentUser, hashPassword, requireAdmin, requireAuth } from "../auth.js";
import { resellerUsage } from "../services/resellers.js";

export async function resellerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/resellers", { preHandler: requireAdmin }, async () => {
    const users = await db.query.users.findMany({
      where: eq(schema.users.role, "reseller"),
      columns: { id: true, email: true, name: true, status: true, createdAt: true },
      with: { resellerLimits: true },
      orderBy: desc(schema.users.createdAt),
    });
    return { resellers: await Promise.all(users.map(async (u) => ({ ...u, usage: await resellerUsage(u.id) }))) };
  });

  /** What a reseller sees about their own plan. */
  app.get("/reseller/me", { preHandler: requireAuth }, async (req) => {
    const me = currentUser(req);
    if (me.role !== "reseller") return { reseller: null };
    const limits = await db.query.resellerLimits.findFirst({ where: eq(schema.resellerLimits.userId, me.id) });
    return { reseller: { limits, usage: await resellerUsage(me.id) } };
  });

  app.post("/resellers", { preHandler: requireAdmin }, async (req) => {
    const input = resellerSchema.parse(req.body);
    const email = input.email.toLowerCase();
    if (await db.query.users.findFirst({ where: eq(schema.users.email, email) })) throw conflict("A user with that email exists");
    const [user] = await db.insert(schema.users).values({ email, name: input.name, passwordHash: await hashPassword(input.password), role: "reseller" }).returning();
    await db.insert(schema.resellerLimits).values({ userId: user!.id, maxAccounts: input.maxAccounts, maxDiskMb: input.maxDiskMb, packageIds: input.packageIds });
    await audit(req, "reseller.create", "user", user!.id, { email });
    return { reseller: { id: user!.id, email, name: input.name } };
  });

  app.patch("/resellers/:id", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const input = resellerSchema.pick({ maxAccounts: true, maxDiskMb: true, packageIds: true }).partial().parse(req.body);
    const row = await db.query.resellerLimits.findFirst({ where: eq(schema.resellerLimits.userId, id) });
    if (!row) throw notFound("Reseller not found");
    await db.update(schema.resellerLimits).set(input).where(eq(schema.resellerLimits.userId, id));
    await audit(req, "reseller.update", "user", id, input);
    return { ok: true };
  });

  app.post("/resellers/:id/status", { preHandler: requireAdmin }, async (req) => {
    const { id } = req.params as { id: string };
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    await db.update(schema.users).set({ status: active ? "active" : "suspended" }).where(eq(schema.users.id, id));
    if (!active) await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    await audit(req, active ? "reseller.unsuspend" : "reseller.suspend", "user", id);
    return { ok: true };
  });
}
