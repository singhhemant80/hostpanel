import type { FastifyInstance } from "fastify";
import { promises as dns } from "node:dns";
import { X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { addDomainSchema, certUploadSchema, pathRulesSchema } from "@hostpanel/shared";
import { encrypt } from "../crypto.js";
import { getSetting } from "../settings.js";
import { and, asc, count, eq } from "drizzle-orm";
import { db, schema } from "../db.js";
import { badRequest, conflict } from "../errors.js";
import { accountFilter, audit, currentUser, requireAuth } from "../auth.js";
import { ownedDomain, ownedSite } from "../access.js";
import { serverOf, syncRoutes } from "../specs.js";
import { config } from "../config.js";

export async function domainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/domains", async (req) => {
    const domains = await db.query.domains.findMany({
      where: await accountFilter(schema.domains.accountId, currentUser(req)),
      columns: { certEnc: false, keyEnc: false },
      with: { site: { columns: { id: true, name: true, runtime: true } }, account: { columns: { username: true } } },
      orderBy: asc(schema.domains.hostname),
    });
    return { domains, dnsTargets: { ipv4: config.serverIpv4, ipv6: config.serverIpv6 } };
  });

  app.post("/domains", async (req) => {
    const input = addDomainSchema.parse(req.body);
    const site = await ownedSite(req, input.siteId);
    if (site.background) throw badRequest("Background workers have no domains; add a path rule on a web site's domain instead");
    if (input.type === "primary") throw badRequest("A site has exactly one primary domain; add this as an alias or addon");
    if (input.type === "redirect" && !input.redirectTo) throw badRequest("Redirect domains need a target URL");
    if (input.hostname.startsWith("*.")) {
      const dns = await getSetting("dns");
      if (dns.provider !== "cloudflare" || !dns.apiTokenEnc) {
        throw badRequest("Wildcard domains need a DNS provider for their certificate. An admin can add a Cloudflare token in Settings.");
      }
      if (input.type === "redirect") throw badRequest("A wildcard cannot be a redirect");
    }
    if (await db.query.domains.findFirst({ where: eq(schema.domains.hostname, input.hostname) })) throw conflict("That domain is already on this server");
    const [dc] = await db.select({ n: count() }).from(schema.domains).where(eq(schema.domains.accountId, site.accountId));
    if (dc!.n >= site.account.package.maxDomains) throw badRequest(`Your plan allows ${site.account.package.maxDomains} domains`);

    const [domain] = await db
      .insert(schema.domains)
      .values({
        accountId: site.accountId,
        siteId: site.id,
        hostname: input.hostname,
        type: input.type,
        redirectTo: input.type === "redirect" ? input.redirectTo : null,
        redirectCode: input.type === "redirect" ? input.redirectCode : null,
        sslStatus: input.hostname.startsWith("*.") ? "dns" : "pending",
      })
      .returning();
    const jobId = await syncRoutes(currentUser(req).id);
    await audit(req, "domain.add", "domain", domain!.id, { hostname: domain!.hostname, site: site.name });
    return { domain, jobId };
  });

  app.delete("/domains/:id", async (req) => {
    const domain = await ownedDomain(req, (req.params as { id: string }).id);
    if (domain.type === "primary") throw badRequest("Delete the site to remove its primary domain, or make another domain primary first");
    await db.delete(schema.domains).where(eq(schema.domains.id, domain.id));
    const jobId = await syncRoutes(currentUser(req).id);
    await audit(req, "domain.remove", "domain", domain.id, { hostname: domain.hostname });
    return { jobId };
  });

  /** Make an alias the site's primary domain (the old primary becomes an alias). */
  app.post("/domains/:id/primary", async (req) => {
    const domain = await ownedDomain(req, (req.params as { id: string }).id);
    if (domain.type === "redirect") throw badRequest("A redirect cannot be primary");
    await db.transaction(async (tx) => {
      await tx
        .update(schema.domains)
        .set({ type: "alias" })
        .where(and(eq(schema.domains.siteId, domain.siteId), eq(schema.domains.type, "primary")));
      await tx.update(schema.domains).set({ type: "primary" }).where(eq(schema.domains.id, domain.id));
    });
    await audit(req, "domain.make_primary", "domain", domain.id);
    return { ok: true };
  });

  /**
   * Path rules send part of a domain to another site of the same account, e.g. on crapplet.co.in:
   * /api/* → crapplet-api, /client* → crapplet-web, everything else → the static site.
   */
  app.put("/domains/:id/paths", async (req) => {
    const domain = await ownedDomain(req, (req.params as { id: string }).id);
    const { rules } = pathRulesSchema.parse(req.body);
    for (const r of rules) {
      const target = await db.query.sites.findFirst({ where: eq(schema.sites.id, r.siteId) });
      if (!target || target.accountId !== domain.accountId) throw badRequest(`Site for ${r.path} not found in this account`);
      if (target.port === null || target.background) throw badRequest(`${target.name} is not a Node.js/Python web app, so it cannot take a path rule`);
    }
    await db.update(schema.domains).set({ pathRules: rules }).where(eq(schema.domains.id, domain.id));
    const jobId = await syncRoutes(currentUser(req).id);
    await audit(req, "domain.paths", "domain", domain.id, { rules });
    return { ok: true, jobId };
  });

  /** Upload your own certificate (e.g. an EV/OV certificate). Caddy then stops managing this domain's cert. */
  app.put("/domains/:id/certificate", async (req) => {
    const domain = await ownedDomain(req, (req.params as { id: string }).id);
    const input = certUploadSchema.parse(req.body);
    let cert: X509Certificate;
    try {
      // a full chain may hold several PEM blocks; the first is the leaf
      cert = new X509Certificate(input.certificate.slice(0, input.certificate.indexOf("-----END CERTIFICATE-----") + 25));
    } catch {
      throw badRequest("Could not read the certificate (PEM)");
    }
    let key: KeyObject;
    try {
      key = createPrivateKey(input.privateKey);
    } catch {
      throw badRequest("Could not read the private key (PEM, not password-protected)");
    }
    if (!cert.checkPrivateKey(key)) throw badRequest("The private key does not belong to this certificate");
    const host = domain.hostname;
    if (!cert.checkHost(host.replace(/^\*\./, "wildcard-check.")) && !cert.checkHost(host)) throw badRequest(`The certificate does not cover ${host}`);
    const expires = new Date(cert.validTo);
    if (expires < new Date()) throw badRequest(`The certificate expired on ${expires.toDateString()}`);
    await db
      .update(schema.domains)
      .set({ certEnc: encrypt(input.certificate.trim() + "\n"), keyEnc: encrypt(input.privateKey.trim() + "\n"), certExpiresAt: expires, sslStatus: "custom" })
      .where(eq(schema.domains.id, domain.id));
    const jobId = await syncRoutes(currentUser(req).id);
    await audit(req, "domain.cert_upload", "domain", domain.id, { issuer: cert.issuer.split("\n").find((l) => l.startsWith("O=")), expires });
    return { ok: true, expires, issuer: cert.issuer, jobId };
  });

  app.delete("/domains/:id/certificate", async (req) => {
    const domain = await ownedDomain(req, (req.params as { id: string }).id);
    await db
      .update(schema.domains)
      .set({ certEnc: null, keyEnc: null, certExpiresAt: null, sslStatus: domain.hostname.startsWith("*.") ? "dns" : domain.dnsOk ? "active" : "pending" })
      .where(eq(schema.domains.id, domain.id));
    const jobId = await syncRoutes(currentUser(req).id);
    await audit(req, "domain.cert_remove", "domain", domain.id);
    return { ok: true, jobId };
  });

  /** Checks the domain's A/AAAA records point at this server. Caddy issues SSL once they do. */
  app.post("/domains/:id/check", async (req) => {
    const domain = await ownedDomain(req, (req.params as { id: string }).id);
    if (domain.hostname.startsWith("*.")) {
      return { dnsOk: true, found: { a: [], aaaa: [] }, expected: { ipv4: config.serverIpv4 }, hint: "Wildcards: add an A record for * (any name) pointing to this server. The certificate is issued through the DNS provider." };
    }
    const target = await serverOf(domain.account.serverId);
    const [a, aaaa] = await Promise.all([
      dns.resolve4(domain.hostname).catch(() => [] as string[]),
      dns.resolve6(domain.hostname).catch(() => [] as string[]),
    ]);
    const v4ok = target.ipv4 ? a.includes(target.ipv4) : a.length > 0;
    const v6ok = !target.ipv6 || aaaa.length === 0 || aaaa.includes(target.ipv6);
    const dnsOk = v4ok && v6ok;
    await db
      .update(schema.domains)
      .set({ dnsOk, sslStatus: dnsOk ? (domain.sslStatus === "custom" ? "custom" : "active") : "pending" })
      .where(eq(schema.domains.id, domain.id));
    return {
      dnsOk,
      found: { a, aaaa },
      expected: { ipv4: target.ipv4, ipv6: target.ipv6 },
      hint: dnsOk
        ? "DNS is correct. Caddy issues the certificate on the first HTTPS request (usually within a minute)."
        : `Create an A record for ${domain.hostname} pointing to ${target.ipv4 ?? "this server's IP"}${
            v6ok ? "" : ` and fix or remove the AAAA record (expected ${target.ipv6})`
          }.`,
    };
  });
}
