import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { slugSchema } from "@hostpanel/shared";
import { config } from "../config.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.js";
import { randomPassword, safeEqual } from "../crypto.js";
import { HttpError, notFound } from "../errors.js";
import { createAccount, deleteAccount, setAccountSuspended } from "../services/accounts.js";

/**
 * Machine API for CRAPPLET billing (or WHMCS): create, suspend, unsuspend and terminate
 * hosting accounts when orders are paid, overdue or cancelled.
 * Auth: `Authorization: Bearer <PROVISIONING_API_KEY>`.
 */
async function requireApiKey(req: FastifyRequest): Promise<void> {
  const key = config.provisioningApiKey;
  const given = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!key || !given || !safeEqual(key, given)) throw new HttpError(401, "Invalid API key", "bad_api_key");
}

export async function provisioningRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post("/provisioning/accounts", async (req) => {
    const body = z
      .object({
        email: z.string().email(),
        name: z.string().min(1),
        username: slugSchema,
        package: z.string().min(1).describe("Package name, e.g. 'Starter'"),
        password: z.string().min(10).optional(),
        locale: z.enum(["en", "hi"]).default("en"),
        externalId: z.string().optional(),
      })
      .parse(req.body);
    const pkg = await db.query.packages.findFirst({ where: eq(schema.packages.name, body.package) });
    if (!pkg) throw notFound(`Package '${body.package}' not found`);
    const password = body.password ?? randomPassword(16);
    const { account, jobId } = await createAccount(
      { email: body.email, name: body.name, username: body.username, packageId: pkg.id, password, locale: body.locale },
      undefined,
    );
    await db.insert(schema.auditLog).values({
      action: "provisioning.account_create",
      targetType: "account",
      targetId: account.id,
      ip: req.ip,
      meta: { externalId: body.externalId },
    });
    return {
      accountId: account.id,
      username: account.username,
      jobId,
      loginUrl: config.panelUrl,
      // Only returned when we generated it; the billing system should e-mail it to the customer once.
      password: body.password ? undefined : password,
    };
  });

  const byUsername = async (username: string) => {
    const acc = await db.query.accounts.findFirst({ where: eq(schema.accounts.username, username) });
    if (!acc) throw notFound("Account not found");
    return acc;
  };

  app.post("/provisioning/accounts/:username/suspend", async (req) => {
    const acc = await byUsername((req.params as { username: string }).username);
    return setAccountSuspended(acc.id, true);
  });

  app.post("/provisioning/accounts/:username/unsuspend", async (req) => {
    const acc = await byUsername((req.params as { username: string }).username);
    return setAccountSuspended(acc.id, false);
  });

  app.post("/provisioning/accounts/:username/package", async (req) => {
    const acc = await byUsername((req.params as { username: string }).username);
    const { package: name } = z.object({ package: z.string() }).parse(req.body);
    const pkg = await db.query.packages.findFirst({ where: eq(schema.packages.name, name) });
    if (!pkg) throw notFound(`Package '${name}' not found`);
    await db.update(schema.accounts).set({ packageId: pkg.id }).where(eq(schema.accounts.id, acc.id));
    return { ok: true };
  });

  app.delete("/provisioning/accounts/:username", async (req) => {
    const acc = await byUsername((req.params as { username: string }).username);
    return deleteAccount(acc.id);
  });

  app.get("/provisioning/accounts/:username", async (req) => {
    const acc = await db.query.accounts.findFirst({
      where: eq(schema.accounts.username, (req.params as { username: string }).username),
      with: { package: true, sites: { columns: { id: true, name: true, status: true } }, domains: { columns: { hostname: true } } },
    });
    if (!acc) throw notFound("Account not found");
    return { account: acc };
  });
}
