import type { FastifyInstance, FastifyRequest } from "fastify";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { dnsRecordSchema, dnsSettingsSchema, hostnameSchema } from "@hostpanel/shared";
import { config } from "../config.js";
import { db, schema } from "../db.js";
import { decrypt, encrypt } from "../crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { accountFilter, audit, currentUser, requireAdmin, requireAuth } from "../auth.js";
import { canSee, resolveAccount } from "../access.js";
import { Cloudflare, dnsTemplate, fqdn } from "../cloudflare.js";
import { getSetting, setSetting } from "../settings.js";

async function client(): Promise<Cloudflare> {
  const s = await getSetting("dns");
  if (s.provider !== "cloudflare" || !s.apiTokenEnc) throw badRequest("DNS management is not set up. An admin can add a Cloudflare API token in Settings.");
  return new Cloudflare(decrypt(s.apiTokenEnc));
}

async function ownedZone(req: FastifyRequest, id: string) {
  const zone = await db.query.dnsZones.findFirst({ where: eq(schema.dnsZones.id, id), with: { account: true } });
  if (!zone) throw notFound("Zone not found");
  const user = currentUser(req);
  if (!(await canSee(user, zone.account))) throw forbidden();
  return zone;
}

export async function dnsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/dns/zones", async (req) => {
    const s = await getSetting("dns");
    const zones = await db.query.dnsZones.findMany({
      where: await accountFilter(schema.dnsZones.accountId, currentUser(req)),
      with: { account: { columns: { username: true } } },
      orderBy: asc(schema.dnsZones.name),
    });
    return { configured: s.provider !== "none" && Boolean(s.apiTokenEnc), zones };
  });

  /** Add a domain's zone: use it if it already exists in the Cloudflare account, otherwise create it. */
  app.post("/dns/zones", async (req) => {
    const body = z.object({ name: hostnameSchema, accountId: z.string().optional() }).parse(req.body);
    const account = await resolveAccount(req, body.accountId);
    if (await db.query.dnsZones.findFirst({ where: eq(schema.dnsZones.name, body.name) })) throw conflict("That zone is already managed here");
    const cf = await client();
    const s = await getSetting("dns");
    let zone = await cf.findZone(body.name);
    if (!zone) {
      if (!s.accountId) throw badRequest("The zone is not in Cloudflare yet. Add it there first, or ask an admin to set the Cloudflare account ID so zones can be created from here.");
      zone = await cf.createZone(body.name, s.accountId);
    }
    const [row] = await db
      .insert(schema.dnsZones)
      .values({ accountId: account.id, name: zone.name, provider: "cloudflare", providerZoneId: zone.id, nameservers: zone.name_servers ?? [], status: zone.status })
      .returning();
    await audit(req, "dns.zone_add", "zone", row!.id, { name: zone.name });
    return { zone: row };
  });

  app.delete("/dns/zones/:id", async (req) => {
    const zone = await ownedZone(req, (req.params as { id: string }).id);
    // Only stop managing it here; the zone stays in Cloudflare so nothing goes offline.
    await db.delete(schema.dnsZones).where(eq(schema.dnsZones.id, zone.id));
    await audit(req, "dns.zone_remove", "zone", zone.id, { name: zone.name });
    return { ok: true };
  });

  app.get("/dns/zones/:id/records", async (req) => {
    const zone = await ownedZone(req, (req.params as { id: string }).id);
    const cf = await client();
    const [info, records] = await Promise.all([cf.getZone(zone.providerZoneId), cf.listRecords(zone.providerZoneId)]);
    if (info.status !== zone.status) await db.update(schema.dnsZones).set({ status: info.status, nameservers: info.name_servers }).where(eq(schema.dnsZones.id, zone.id));
    return {
      zone: { ...zone, status: info.status, nameservers: info.name_servers },
      records: records.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
      serverIp: config.serverIpv4,
    };
  });

  const toCf = (zoneName: string, input: z.infer<typeof dnsRecordSchema>) => ({
    type: input.type,
    name: fqdn(input.name, zoneName),
    content: input.content.trim(),
    ttl: input.ttl,
    ...(input.priority !== undefined && (input.type === "MX" || input.type === "SRV") ? { priority: input.priority } : {}),
    ...(["A", "AAAA", "CNAME"].includes(input.type) ? { proxied: input.proxied ?? false } : {}),
  });

  app.post("/dns/zones/:id/records", async (req) => {
    const zone = await ownedZone(req, (req.params as { id: string }).id);
    const input = dnsRecordSchema.parse(req.body);
    const rec = await (await client()).createRecord(zone.providerZoneId, toCf(zone.name, input));
    await audit(req, "dns.record_add", "zone", zone.id, { type: rec.type, name: rec.name });
    return { record: rec };
  });

  app.put("/dns/zones/:id/records/:recordId", async (req) => {
    const { id, recordId } = req.params as { id: string; recordId: string };
    const zone = await ownedZone(req, id);
    const input = dnsRecordSchema.parse(req.body);
    const rec = await (await client()).updateRecord(zone.providerZoneId, recordId, toCf(zone.name, input));
    await audit(req, "dns.record_update", "zone", zone.id, { type: rec.type, name: rec.name });
    return { record: rec };
  });

  app.delete("/dns/zones/:id/records/:recordId", async (req) => {
    const { id, recordId } = req.params as { id: string; recordId: string };
    const zone = await ownedZone(req, id);
    await (await client()).deleteRecord(zone.providerZoneId, recordId);
    await audit(req, "dns.record_delete", "zone", zone.id, { recordId });
    return { ok: true };
  });

  app.post("/dns/zones/:id/template", async (req) => {
    const zone = await ownedZone(req, (req.params as { id: string }).id);
    const { template } = z.object({ template: z.enum(["google-workspace", "zoho", "web"]) }).parse(req.body);
    const cf = await client();
    const created = [];
    for (const rec of dnsTemplate(template, zone.name, config.serverIpv4)) created.push(await cf.createRecord(zone.providerZoneId, rec));
    await audit(req, "dns.template", "zone", zone.id, { template });
    return { records: created };
  });

  // ---- settings (admin) ----
  app.get("/settings/dns", { preHandler: requireAdmin }, async () => {
    const s = await getSetting("dns");
    return { provider: s.provider, tokenSet: Boolean(s.apiTokenEnc), accountId: s.accountId };
  });

  app.put("/settings/dns", { preHandler: requireAdmin }, async (req) => {
    const input = dnsSettingsSchema.parse(req.body);
    const current = await getSetting("dns");
    const apiTokenEnc = input.apiToken ? encrypt(input.apiToken) : current.apiTokenEnc;
    if (input.provider === "cloudflare") {
      if (!apiTokenEnc) throw badRequest("Enter a Cloudflare API token");
      if (input.apiToken) await new Cloudflare(input.apiToken).verifyToken(); // fail fast on a bad token
    }
    await setSetting("dns", { provider: input.provider, apiTokenEnc: input.provider === "none" ? null : apiTokenEnc, accountId: input.accountId ?? current.accountId });
    await audit(req, "settings.dns", undefined, undefined, { provider: input.provider });
    return { ok: true };
  });
}
