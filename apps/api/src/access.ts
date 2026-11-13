import type { FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "./db.js";
import { badRequest, forbidden, notFound } from "./errors.js";
import { currentUser } from "./auth.js";

/** The account a new resource goes into: explicit (checked) or the user's only active account. */
export async function resolveAccount(req: FastifyRequest, accountId?: string) {
  const user = currentUser(req);
  const mine = user.role === "admin" ? undefined : eq(schema.accounts.userId, user.id);
  if (accountId) {
    const acc = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, accountId), mine), with: { package: true } });
    if (!acc) throw notFound("Account not found");
    if (acc.status !== "active") throw badRequest("Account is not active");
    return acc;
  }
  const list = await db.query.accounts.findMany({ where: and(eq(schema.accounts.status, "active"), mine), with: { package: true } });
  if (list.length === 0) throw badRequest("You have no active hosting account");
  if (list.length > 1) throw badRequest("Choose an account (accountId)");
  return list[0]!;
}

export async function ownedSite(req: FastifyRequest, siteId: string) {
  const site = await db.query.sites.findFirst({
    where: eq(schema.sites.id, siteId),
    with: { account: { with: { package: true } }, git: true, env: true, domains: { orderBy: asc(schema.domains.createdAt) } },
  });
  if (!site) throw notFound("Site not found");
  const user = currentUser(req);
  if (user.role !== "admin" && site.account.userId !== user.id) throw forbidden();
  return site;
}

export async function ownedDomain(req: FastifyRequest, domainId: string) {
  const domain = await db.query.domains.findFirst({ where: eq(schema.domains.id, domainId), with: { account: { with: { package: true } }, site: true } });
  if (!domain) throw notFound("Domain not found");
  const user = currentUser(req);
  if (user.role !== "admin" && domain.account.userId !== user.id) throw forbidden();
  return domain;
}

export async function ownedDatabase(req: FastifyRequest, id: string) {
  const row = await db.query.databases.findFirst({ where: eq(schema.databases.id, id), with: { account: true } });
  if (!row) throw notFound("Database not found");
  const user = currentUser(req);
  if (user.role !== "admin" && row.account.userId !== user.id) throw forbidden();
  return row;
}

export async function ownedAccount(req: FastifyRequest, accountId: string) {
  const acc = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, accountId), with: { package: true } });
  if (!acc) throw notFound("Account not found");
  const user = currentUser(req);
  if (user.role !== "admin" && acc.userId !== user.id) throw forbidden();
  return acc;
}
