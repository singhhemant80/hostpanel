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
