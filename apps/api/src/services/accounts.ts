import { and, asc, eq } from "drizzle-orm";
import { syncMail } from "../mail.js";
import { linuxUserFor, type CreateAccountInput } from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { conflict, notFound } from "../errors.js";
import { hashPassword } from "../auth.js";
import { enqueue } from "../queue.js";
import { syncRoutes } from "../specs.js";

/** Creates (or reuses) the login user, the hosting account row and queues the Linux user creation. */
export async function createAccount(input: CreateAccountInput, createdBy?: string, resellerId: string | null = null) {
  const pkg = await db.query.packages.findFirst({ where: eq(schema.packages.id, input.packageId) });
  if (!pkg) throw notFound("Package not found");
  if (await db.query.accounts.findFirst({ where: eq(schema.accounts.username, input.username) })) throw conflict("Username is taken");

  const server = input.serverId
    ? await db.query.servers.findFirst({ where: and(eq(schema.servers.id, input.serverId), eq(schema.servers.status, "active")) })
    : ((await db.query.servers.findFirst({ where: eq(schema.servers.isMain, true) })) ??
      (await db.query.servers.findFirst({ where: eq(schema.servers.status, "active"), orderBy: asc(schema.servers.createdAt) })));
  if (!server) throw notFound(input.serverId ? "That server is not active" : "No active server. Run the seed script first.");

  const email = input.email.toLowerCase();
  let user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
  if (!user) {
    [user] = await db
      .insert(schema.users)
      .values({ email, name: input.name, passwordHash: await hashPassword(input.password), locale: input.locale, role: "user" })
      .returning();
  }

  const linuxUser = linuxUserFor(input.username);
  const [account] = await db
    .insert(schema.accounts)
    .values({ userId: user!.id, packageId: pkg.id, serverId: server.id, username: input.username, linuxUser, resellerId })
    .returning();
  const jobId = await enqueue(
    "account.create",
    { linuxUser, cpuPercent: pkg.cpuPercent, ramMb: pkg.ramMb, diskMb: pkg.diskMb },
    { targetType: "account", targetId: account!.id, createdBy },
  );
  return { account: account!, jobId };
}

export async function setAccountSuspended(accountId: string, suspended: boolean, createdBy?: string) {
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId), with: { sites: true } });
  if (!account) throw notFound("Account not found");
  await db.update(schema.accounts).set({ status: suspended ? "suspended" : "active" }).where(eq(schema.accounts.id, accountId));
  const jobId = await enqueue(
    "account.suspend",
    { linuxUser: account.linuxUser, suspended, siteNames: account.sites.map((s) => s.name) },
    { targetType: "account", targetId: accountId, createdBy },
  );
  // Suspended accounts drop out of the routing table and the mail configuration.
  await syncRoutes(createdBy);
  await syncMail(createdBy);
  return { jobId };
}

export async function deleteAccount(accountId: string, createdBy?: string) {
  const account = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId) });
  if (!account) throw notFound("Account not found");
  await db.update(schema.accounts).set({ status: "deleting" }).where(eq(schema.accounts.id, accountId));
  await syncRoutes(createdBy);
  await syncMail(createdBy);
  const jobId = await enqueue("account.delete", { linuxUser: account.linuxUser }, { targetType: "account", targetId: accountId, createdBy });
  return { jobId };
}
