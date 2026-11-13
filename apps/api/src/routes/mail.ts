import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { catchAllSchema, mailAliasSchema, mailboxSchema, mailDomainSchema, updateMailboxSchema } from "@hostpanel/shared";
import { config } from "../config.js";
import { db, schema } from "../db.js";
import { decrypt } from "../crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { accountFilter, audit, currentUser, requireAuth } from "../auth.js";
import { resolveAccount } from "../access.js";
import { enqueue, runFast } from "../queue.js";
import { DKIM_SELECTOR, mailDnsRecords, mailHost, mailboxCount, syncMail } from "../mail.js";
import { Cloudflare } from "../cloudflare.js";
import { getSetting } from "../settings.js";

async function ownedMailDomain(req: FastifyRequest, id: string) {
  const d = await db.query.mailDomains.findFirst({ where: eq(schema.mailDomains.id, id), with: { account: { with: { package: true } } } });
  if (!d) throw notFound("Mail domain not found");
  const ids = await accountFilterIds(req);
  if (ids && !ids.includes(d.accountId)) throw forbidden();
  return d;
}

async function accountFilterIds(req: FastifyRequest): Promise<string[] | null> {
  const { visibleAccountIds } = await import("../auth.js");
  return visibleAccountIds(currentUser(req));
}

/** A customer may only add mail for a domain their account already uses (site domain or DNS zone). */
async function assertDomainOwned(accountId: string, name: string, isAdmin: boolean): Promise<void> {
  if (isAdmin) return;
  const [domains, zones] = await Promise.all([
    db.query.domains.findMany({ where: eq(schema.domains.accountId, accountId), columns: { hostname: true } }),
    db.query.dnsZones.findMany({ where: eq(schema.dnsZones.accountId, accountId), columns: { name: true } }),
  ]);
  const owned = [...domains.map((d) => d.hostname.replace(/^\*\./, "")), ...zones.map((z) => z.name)];
  if (!owned.some((h) => h === name || h.endsWith(`.${name}`))) {
    throw badRequest(`Add ${name} (or a subdomain of it) to one of your sites or DNS zones first`);
  }
}

export async function mailRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/mail/domains", async (req) => {
    const domains = await db.query.mailDomains.findMany({
      where: await accountFilter(schema.mailDomains.accountId, currentUser(req)),
      with: { account: { columns: { username: true } }, mailboxes: { columns: { id: true } }, aliases: { columns: { id: true } } },
      orderBy: asc(schema.mailDomains.name),
    });
    return {
      domains: domains.map(({ mailboxes, aliases, ...d }) => ({ ...d, mailboxCount: mailboxes.length, aliasCount: aliases.length })),
      mailHost: mailHost(),
    };
  });

  app.post("/mail/domains", async (req) => {
    const input = mailDomainSchema.parse(req.body);
    const account = await resolveAccount(req, input.accountId);
    if (account.package.maxMailboxes < 1) throw badRequest("Your plan does not include email");
    await assertDomainOwned(account.id, input.name, currentUser(req).role === "admin");
    if (await db.query.mailDomains.findFirst({ where: eq(schema.mailDomains.name, input.name) })) throw conflict("Mail for that domain is already set up on this server");
    const dkim = (await runFast("mail.dkim", { domain: input.name, selector: DKIM_SELECTOR }, 30_000, null)) as { value: string };
    const [domain] = await db.insert(schema.mailDomains).values({ accountId: account.id, name: input.name, dkimRecord: dkim.value }).returning();
    await syncMail(currentUser(req).id);
    await audit(req, "mail.domain_add", "mail_domain", domain!.id, { name: input.name });
    return { domain };
  });

  app.get("/mail/domains/:id", async (req) => {
    const d = await ownedMailDomain(req, (req.params as { id: string }).id);
    const [mailboxes, aliases] = await Promise.all([
      db.query.mailboxes.findMany({ where: eq(schema.mailboxes.domainId, d.id), columns: { passwordHash: false }, orderBy: asc(schema.mailboxes.address) }),
      db.query.mailAliases.findMany({ where: eq(schema.mailAliases.domainId, d.id), orderBy: asc(schema.mailAliases.source) }),
    ]);
    let usage: Record<string, { usedMb: number; limitMb: number | null }> = {};
    if (mailboxes.length) {
      usage = ((await runFast("mail.usage", { addresses: mailboxes.map((m) => m.address) }, 15_000, null).catch(() => ({}))) ?? {}) as typeof usage;
    }
    const zone = await db.query.dnsZones.findFirst({ where: and(eq(schema.dnsZones.name, d.name), eq(schema.dnsZones.accountId, d.accountId)) });
    const host = mailHost();
    return {
      domain: { id: d.id, name: d.name, catchAll: d.catchAll, accountId: d.accountId },
      mailboxes: mailboxes.map((m) => ({ ...m, usedMb: usage[m.address]?.usedMb ?? null })),
      aliases,
      dns: mailDnsRecords(d.name, d.dkimRecord),
      canApplyDns: Boolean(zone),
      limits: { maxMailboxes: d.account.package.maxMailboxes, used: await mailboxCount(d.accountId) },
      client: {
        webmail: `${config.panelUrl}/webmail/`,
        imap: { host, port: 993, security: "SSL/TLS" },
        pop3: { host, port: 995, security: "SSL/TLS" },
        smtp: { host, port: 587, security: "STARTTLS", altPort: 465 },
      },
    };
  });

  app.delete("/mail/domains/:id", async (req) => {
    const d = await ownedMailDomain(req, (req.params as { id: string }).id);
    const boxes = await db.query.mailboxes.findMany({ where: eq(schema.mailboxes.domainId, d.id), columns: { address: true } });
    await db.delete(schema.mailDomains).where(eq(schema.mailDomains.id, d.id));
    await syncMail(currentUser(req).id);
    for (const b of boxes) await enqueue("mail.purge", { address: b.address }, { serverId: null, createdBy: currentUser(req).id });
    await audit(req, "mail.domain_remove", "mail_domain", d.id, { name: d.name, mailboxes: boxes.length });
    return { ok: true };
  });

  app.put("/mail/domains/:id/catchall", async (req) => {
    const d = await ownedMailDomain(req, (req.params as { id: string }).id);
    const { catchAll } = catchAllSchema.parse(req.body);
    await db.update(schema.mailDomains).set({ catchAll }).where(eq(schema.mailDomains.id, d.id));
    await syncMail(currentUser(req).id);
    await audit(req, "mail.catchall", "mail_domain", d.id, { catchAll });
    return { ok: true };
  });

  /** Create the MX/SPF/DKIM/DMARC records in Cloudflare when the zone is managed here. */
  app.post("/mail/domains/:id/dns", async (req) => {
    const d = await ownedMailDomain(req, (req.params as { id: string }).id);
    const zone = await db.query.dnsZones.findFirst({ where: and(eq(schema.dnsZones.name, d.name), eq(schema.dnsZones.accountId, d.accountId)) });
    if (!zone) throw badRequest("Add this domain under DNS first, or create the records at your DNS provider by hand");
    const s = await getSetting("dns");
    if (!s.apiTokenEnc) throw badRequest("DNS management is not set up");
    const cf = new Cloudflare(decrypt(s.apiTokenEnc));
    const existing = await cf.listRecords(zone.providerZoneId);
    const created: string[] = [];
    const skipped: string[] = [];
    for (const r of mailDnsRecords(d.name, d.dkimRecord)) {
      const same = existing.find((e) => e.type === r.type && e.name === r.name && (r.type === "MX" || e.content.replace(/"/g, "").startsWith(r.content.split(";")[0]!)));
      if (same) {
        skipped.push(`${r.type} ${r.name}`);
        continue;
      }
      await cf.createRecord(zone.providerZoneId, { type: r.type, name: r.name, content: r.content, ttl: 1, ...(r.priority ? { priority: r.priority } : {}) });
      created.push(`${r.type} ${r.name}`);
    }
    await audit(req, "mail.dns_apply", "mail_domain", d.id, { created });
    return { created, skipped };
  });

  // ---- mailboxes ----
  app.post("/mail/mailboxes", async (req) => {
    const input = mailboxSchema.parse(req.body);
    const d = await ownedMailDomain(req, input.domainId);
    if ((await mailboxCount(d.accountId)) >= d.account.package.maxMailboxes) throw badRequest(`Your plan allows ${d.account.package.maxMailboxes} mailboxes`);
    const address = `${input.localPart}@${d.name}`;
    if (await db.query.mailAliases.findFirst({ where: eq(schema.mailAliases.source, address) })) throw conflict(`${address} is already a forwarder`);
    const [mb] = await db
      .insert(schema.mailboxes)
      .values({ domainId: d.id, address, passwordHash: await bcrypt.hash(input.password, 10), quotaMb: input.quotaMb })
      .returning({ id: schema.mailboxes.id, address: schema.mailboxes.address, quotaMb: schema.mailboxes.quotaMb, enabled: schema.mailboxes.enabled });
    await syncMail(currentUser(req).id);
    await audit(req, "mail.mailbox_add", "mailbox", mb!.id, { address });
    return { mailbox: mb };
  });

  const loadMailbox = async (req: FastifyRequest) => {
    const mb = await db.query.mailboxes.findFirst({ where: eq(schema.mailboxes.id, (req.params as { id: string }).id) });
    if (!mb) throw notFound("Mailbox not found");
    await ownedMailDomain(req, mb.domainId);
    return mb;
  };

  app.patch("/mail/mailboxes/:id", async (req) => {
    const mb = await loadMailbox(req);
    const input = updateMailboxSchema.parse(req.body);
    await db
      .update(schema.mailboxes)
      .set({
        ...(input.password ? { passwordHash: await bcrypt.hash(input.password, 10) } : {}),
        ...(input.quotaMb !== undefined ? { quotaMb: input.quotaMb } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      })
      .where(eq(schema.mailboxes.id, mb.id));
    await syncMail(currentUser(req).id);
    await audit(req, "mail.mailbox_update", "mailbox", mb.id, { password: Boolean(input.password), quotaMb: input.quotaMb, enabled: input.enabled });
    return { ok: true };
  });

  app.delete("/mail/mailboxes/:id", async (req) => {
    const mb = await loadMailbox(req);
    await db.delete(schema.mailboxes).where(eq(schema.mailboxes.id, mb.id));
    await syncMail(currentUser(req).id);
    await enqueue("mail.purge", { address: mb.address }, { serverId: null, createdBy: currentUser(req).id });
    await audit(req, "mail.mailbox_remove", "mailbox", mb.id, { address: mb.address });
    return { ok: true };
  });

  // ---- forwarders / aliases ----
  app.post("/mail/aliases", async (req) => {
    const input = mailAliasSchema.parse(req.body);
    const d = await ownedMailDomain(req, input.domainId);
    const source = `${input.localPart}@${d.name}`;
    if (await db.query.mailboxes.findFirst({ where: eq(schema.mailboxes.address, source) })) throw conflict(`${source} is a mailbox; delete it first or choose another name`);
    if (input.destinations.includes(source)) throw badRequest("A forwarder cannot point at itself");
    const [alias] = await db.insert(schema.mailAliases).values({ domainId: d.id, source, destinations: input.destinations }).returning();
    await syncMail(currentUser(req).id);
    await audit(req, "mail.alias_add", "mail_alias", alias!.id, { source, destinations: input.destinations });
    return { alias };
  });

  app.delete("/mail/aliases/:id", async (req) => {
    const a = await db.query.mailAliases.findFirst({ where: eq(schema.mailAliases.id, (req.params as { id: string }).id) });
    if (!a) throw notFound("Forwarder not found");
    await ownedMailDomain(req, a.domainId);
    await db.delete(schema.mailAliases).where(eq(schema.mailAliases.id, a.id));
    await syncMail(currentUser(req).id);
    await audit(req, "mail.alias_remove", "mail_alias", a.id, { source: a.source });
    return { ok: true };
  });
}
