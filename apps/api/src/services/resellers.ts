import type { FastifyRequest } from "fastify";
import { and, eq, ne } from "drizzle-orm";
import { db, schema } from "../db.js";
import { badRequest, forbidden, notFound } from "../errors.js";
import { currentUser } from "../auth.js";

/** Admins manage every account; resellers only the customer accounts they created. */
export async function assertManages(req: FastifyRequest, accountId: string): Promise<void> {
  const me = currentUser(req);
  if (me.role === "admin") return;
  const acc = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId), columns: { resellerId: true } });
  if (!acc) throw notFound("Account not found");
  if (acc.resellerId !== me.id) throw forbidden("You can only manage accounts you created");
}

/**
 * A reseller may create (or move an account to) a package only if the admin allowed that package,
 * the account count stays within maxAccounts and the packages' disk adds up to at most maxDiskMb.
 */
export async function assertResellerCanCreate(resellerId: string, packageId: string, replacingAccountId?: string): Promise<void> {
  const limits = await db.query.resellerLimits.findFirst({ where: eq(schema.resellerLimits.userId, resellerId) });
  if (!limits) throw forbidden("No reseller limits set for this user");
  if (!limits.packageIds.includes(packageId)) throw badRequest("That package is not available to you");
  const accounts = await db.query.accounts.findMany({
    where: replacingAccountId
      ? and(eq(schema.accounts.resellerId, resellerId), ne(schema.accounts.id, replacingAccountId))
      : eq(schema.accounts.resellerId, resellerId),
    with: { package: { columns: { diskMb: true } } },
  });
  if (!replacingAccountId && accounts.length >= limits.maxAccounts) throw badRequest(`Your reseller plan allows ${limits.maxAccounts} accounts`);
  const pkg = await db.query.packages.findFirst({ where: eq(schema.packages.id, packageId) });
  if (!pkg) throw notFound("Package not found");
  const disk = accounts.reduce((n, a) => n + a.package.diskMb, 0) + pkg.diskMb;
  if (disk > limits.maxDiskMb) throw badRequest(`That would use ${Math.round(disk / 1000)} GB of your ${Math.round(limits.maxDiskMb / 1000)} GB reseller disk`);
}

export async function resellerUsage(resellerId: string) {
  const accounts = await db.query.accounts.findMany({ where: eq(schema.accounts.resellerId, resellerId), with: { package: { columns: { diskMb: true } } } });
  return { accounts: accounts.length, diskMb: accounts.reduce((n, a) => n + a.package.diskMb, 0) };
}
