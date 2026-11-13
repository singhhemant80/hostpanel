import { HttpError } from "./errors.js";

/** Minimal Cloudflare API v4 client for zones and DNS records. */
const API = "https://api.cloudflare.com/client/v4";

export interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  proxiable?: boolean;
}

export class Cloudflare {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(API + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
    if (!res.ok || !data.success) {
      const msg = data.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new HttpError(res.status === 403 || res.status === 401 ? 400 : 502, `Cloudflare: ${msg}`, "dns_provider");
    }
    return data.result as T;
  }

  verifyToken() {
    return this.call<{ status: string }>("GET", "/user/tokens/verify");
  }

  async findZone(name: string): Promise<{ id: string; name: string; status: string; name_servers: string[] } | null> {
    const r = await this.call<{ id: string; name: string; status: string; name_servers: string[] }[]>("GET", `/zones?name=${encodeURIComponent(name)}`);
    return r[0] ?? null;
  }

  createZone(name: string, accountId: string) {
    return this.call<{ id: string; name: string; status: string; name_servers: string[] }>("POST", "/zones", { name, account: { id: accountId }, type: "full" });
  }

  getZone(id: string) {
    return this.call<{ id: string; name: string; status: string; name_servers: string[] }>("GET", `/zones/${id}`);
  }

  listRecords(zoneId: string) {
    return this.call<CfRecord[]>("GET", `/zones/${zoneId}/dns_records?per_page=500`);
  }

  createRecord(zoneId: string, rec: Omit<CfRecord, "id" | "proxiable">) {
    return this.call<CfRecord>("POST", `/zones/${zoneId}/dns_records`, rec);
  }

  updateRecord(zoneId: string, id: string, rec: Omit<CfRecord, "id" | "proxiable">) {
    return this.call<CfRecord>("PUT", `/zones/${zoneId}/dns_records/${id}`, rec);
  }

  deleteRecord(zoneId: string, id: string) {
    return this.call<{ id: string }>("DELETE", `/zones/${zoneId}/dns_records/${id}`);
  }
}

/** "@" → apex; names ending in the zone are kept; anything else is relative ("www" → www.example.com). */
export function fqdn(name: string, zone: string): string {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (n === "@" || n === "" || n === zone) return zone;
  if (n.endsWith(`.${zone}`)) return n;
  return `${n}.${zone}`;
}

/** One-click record sets for common mail providers. */
export function dnsTemplate(template: string, zone: string, serverIp: string | null): Omit<CfRecord, "id" | "proxiable">[] {
  switch (template) {
    case "google-workspace":
      return [
        { type: "MX", name: zone, content: "smtp.google.com", priority: 1, ttl: 1 },
        { type: "TXT", name: zone, content: "v=spf1 include:_spf.google.com ~all", ttl: 1 },
        { type: "TXT", name: `_dmarc.${zone}`, content: `v=DMARC1; p=none; rua=mailto:dmarc@${zone}`, ttl: 1 },
      ];
    case "zoho":
      return [
        { type: "MX", name: zone, content: "mx.zoho.in", priority: 10, ttl: 1 },
        { type: "MX", name: zone, content: "mx2.zoho.in", priority: 20, ttl: 1 },
        { type: "MX", name: zone, content: "mx3.zoho.in", priority: 50, ttl: 1 },
        { type: "TXT", name: zone, content: "v=spf1 include:zohomail.in ~all", ttl: 1 },
        { type: "TXT", name: `_dmarc.${zone}`, content: `v=DMARC1; p=none; rua=mailto:dmarc@${zone}`, ttl: 1 },
      ];
    case "web":
      if (!serverIp) throw new HttpError(400, "SERVER_IPV4 is not set on this server", "no_ip");
      return [
        { type: "A", name: zone, content: serverIp, ttl: 1, proxied: false },
        { type: "CNAME", name: `www.${zone}`, content: zone, ttl: 1, proxied: false },
      ];
    default:
      throw new HttpError(400, "Unknown template", "bad_template");
  }
}
