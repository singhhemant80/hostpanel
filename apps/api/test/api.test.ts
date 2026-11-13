import { test } from "node:test";
import assert from "node:assert/strict";
const { Cloudflare, fqdn, dnsTemplate } = await import("../src/cloudflare.js");

test("DNS names: @, relative and full", () => {
  assert.equal(fqdn("@", "shop.in"), "shop.in");
  assert.equal(fqdn("www", "shop.in"), "www.shop.in");
  assert.equal(fqdn("mail.eu", "shop.in"), "mail.eu.shop.in");
  assert.equal(fqdn("API.shop.in.", "shop.in"), "api.shop.in");
  assert.equal(fqdn("_dmarc", "shop.in"), "_dmarc.shop.in");
});

test("mail templates", () => {
  const z = dnsTemplate("zoho", "shop.in", null);
  assert.equal(z.filter((r) => r.type === "MX").length, 3);
  assert.ok(z.some((r) => r.type === "TXT" && r.content.startsWith("v=spf1")));
  assert.throws(() => dnsTemplate("web", "shop.in", null), /SERVER_IPV4/);
  assert.deepEqual(dnsTemplate("web", "shop.in", "203.0.113.10")[0], { type: "A", name: "shop.in", content: "203.0.113.10", ttl: 1, proxied: false });
});

test("Cloudflare client sends the token and surfaces API errors", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/dns_records") && init.method === "POST") {
      return new Response(JSON.stringify({ success: false, errors: [{ message: "Record already exists." }] }), { status: 400 });
    }
    return new Response(JSON.stringify({ success: true, result: [{ id: "z1", name: "shop.in", status: "active", name_servers: ["a.ns.cloudflare.com"] }] }));
  }) as unknown as typeof fetch;
  const cf = new Cloudflare("tok_123", fake);
  const zone = await cf.findZone("shop.in");
  assert.equal(zone?.id, "z1");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer tok_123");
  await assert.rejects(cf.createRecord("z1", { type: "A", name: "shop.in", content: "1.2.3.4", ttl: 1 }), /Record already exists/);
});

test("mail DNS records: MX, SPF, DKIM, DMARC", async () => {
  Object.assign(process.env, {
    PANEL_HOSTNAME: "panel.acme.in",
    PANEL_URL: "https://panel.acme.in",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://x:y@127.0.0.1:1/none",
    REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:1",
    JWT_SECRET: process.env.JWT_SECRET ?? "t".repeat(64),
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY ?? "1".repeat(64),
  });
  const { mailDnsRecords, DKIM_SELECTOR } = await import("../src/mail.js");
  const recs = mailDnsRecords("shop.in", "v=DKIM1; k=rsa; p=ABC");
  assert.deepEqual(recs.map((r) => r.type), ["MX", "TXT", "TXT", "TXT"]);
  assert.equal(recs[0]!.priority, 10);
  assert.ok(recs.some((r) => r.name === `${DKIM_SELECTOR}._domainkey.shop.in` && r.content.startsWith("v=DKIM1")));
  assert.ok(recs.some((r) => r.name === "_dmarc.shop.in"));
  assert.equal(mailDnsRecords("shop.in", null).length, 3);
});

test("routes: a site's extra process with a path gets that path on the site's domains", async () => {
  const { routeFor, serviceUnitNames } = await import("../src/specs.js");
  const site = {
    id: "s1", name: "crapplet", runtime: "node", runtimeVersion: "22", rootDir: "", publicDir: "", port: 20010, instances: 1, background: false, status: "active",
    processes: [{ name: "api", command: "x", path: "/api/*" }, { name: "worker", command: "y", path: null }], redis: true,
    account: { linuxUser: "hp_acme" },
  } as never;
  const domain = { hostname: "acme.in", type: "primary", pathRules: [], certEnc: null, keyEnc: null } as never;
  const r = routeFor(domain, site);
  assert.equal(r.kind, "proxy");
  assert.equal(r.port, 20010);
  assert.deepEqual(r.paths, [{ path: "/api/*", port: 20011, instances: 1 }]);
  assert.deepEqual(serviceUnitNames("hp_acme", site), ["hp-hp_acme-crapplet-0.service", "hp-hp_acme-crapplet.api.service", "hp-hp_acme-crapplet.worker.service", "hp-hp_acme-crapplet.redis.service"]);
});
