import { eq, inArray, isNotNull } from "drizzle-orm";
import { PORT_RANGE, paths, type RouteSpec, type Runtime, type SiteSpec } from "@hostpanel/shared";
import { config } from "./config.js";
import { db, schema } from "./db.js";
import type { Account, Domain, Site, SiteEnv } from "./schema.js";
import { enqueue } from "./queue.js";
import { notFound } from "./errors.js";
import { getSetting } from "./settings.js";

type SiteWithAccount = Site & { account: Account; env?: SiteEnv[] };

export function siteSpec(site: SiteWithAccount): SiteSpec {
  return {
    id: site.id,
    name: site.name,
    linuxUser: site.account.linuxUser,
    runtime: site.runtime as Runtime,
    runtimeVersion: site.runtimeVersion,
    rootDir: site.rootDir,
    publicDir: site.publicDir,
    buildCmd: site.buildCmd,
    startCmd: site.startCmd,
    port: site.port,
    instances: site.instances,
    healthPath: site.healthPath,
    background: site.background,
    env: (site.env ?? []).map((e) => ({ key: e.key, valueEnc: e.valueEnc })),
  };
}

export async function loadSiteSpec(siteId: string): Promise<SiteSpec> {
  const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, siteId), with: { account: true, env: true } });
  if (!site) throw notFound("Site not found");
  return siteSpec(site);
}

/** Document root Caddy serves for php/static sites: <current release>/<rootDir>/<publicDir>. */
export function docRoot(site: SiteWithAccount): string {
  const parts = [paths.current(site.account.linuxUser, site.name), site.rootDir, site.publicDir].filter(Boolean);
  return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "");
}

export function routeFor(domain: Domain, site: SiteWithAccount, portsBySite?: Map<string, { port: number | null; instances: number }>): RouteSpec {
  const paths = (domain.pathRules ?? [])
    .map((r) => ({ path: r.path, target: portsBySite?.get(r.siteId) }))
    .filter((r): r is { path: string; target: { port: number; instances: number } } => Boolean(r.target?.port))
    .map((r) => ({ path: r.path, port: r.target.port, instances: r.target.instances }));
  const tls: RouteSpec["tls"] =
    domain.certEnc && domain.keyEnc ? { certEnc: domain.certEnc, keyEnc: domain.keyEnc } : domain.hostname.startsWith("*.") ? "dns" : undefined;
  const base = {
    hostname: domain.hostname,
    siteName: site.name,
    linuxUser: site.account.linuxUser,
    ...(paths.length ? { paths } : {}),
    ...(tls ? { tls } : {}),
  };
  if (domain.type === "redirect" && domain.redirectTo) {
    return { ...base, kind: "redirect", redirectTo: domain.redirectTo, redirectCode: (domain.redirectCode ?? 301) as 301 | 302 };
  }
  switch (site.runtime as Runtime) {
    case "php":
      return { ...base, kind: "php", phpVersion: site.runtimeVersion, root: docRoot(site) };
    case "node":
    case "python":
      return { ...base, kind: "proxy", port: site.port ?? undefined, instances: site.instances };
    default:
      return { ...base, kind: "static", root: docRoot(site) };
  }
}

/** Full desired routing table. The agent rebuilds Caddy's config from it every time (idempotent). */
export async function buildRoutes(serverId?: string): Promise<RouteSpec[]> {
  const rows = await db.query.domains.findMany({
    where: inArray(schema.domains.status, ["pending", "active"]),
    with: { site: { with: { account: true } } },
    orderBy: schema.domains.hostname,
  });
  const ports = await db
    .select({ id: schema.sites.id, port: schema.sites.port, instances: schema.sites.instances })
    .from(schema.sites)
    .where(isNotNull(schema.sites.port));
  const portsBySite = new Map(ports.map((p) => [p.id, { port: p.port, instances: p.instances }]));
  return rows
    .filter((d) => !serverId || d.site.account.serverId === serverId)
    .filter((d) => d.site.account.status === "active" && (d.site.status === "pending" || d.site.status === "active") && !d.site.background)
    .map((d) => routeFor(d, d.site, portsBySite));
}

/** Rebuild every server's Caddy config (each server only gets the domains of its own accounts). */
export async function syncRoutes(createdBy?: string): Promise<string> {
  const dns = await getSetting("dns");
  const servers = await db.query.servers.findMany({ where: inArray(schema.servers.status, ["active", "pending"]) });
  let mainJob = "";
  for (const server of servers) {
    if (!server.isMain && !server.wgPublicKey) continue; // not joined yet
    const routes = await buildRoutes(server.id);
    const jobId = await enqueue(
      "routes.sync",
      {
        routes,
        panelHostname: server.isMain ? config.panelHostname : null,
        acmeEmail: config.acmeEmail,
        dnsTokenEnc: routes.some((r) => r.tls === "dns") && dns.provider === "cloudflare" ? dns.apiTokenEnc : null,
      },
      { dedupeKey: "routes.sync", targetType: "server", targetId: server.id, createdBy, serverId: server.id },
    );
    if (server.isMain) mainJob = jobId;
  }
  return mainJob;
}

/** Lowest free internal port block. Instance i of a Node/Python site listens on port + i. */
export async function allocatePort(instances: number, excludeSiteId?: string): Promise<number> {
  const used = await db
    .select({ id: schema.sites.id, port: schema.sites.port, instances: schema.sites.instances })
    .from(schema.sites)
    .where(isNotNull(schema.sites.port));
  const taken = new Set<number>();
  for (const s of used) {
    if (s.id === excludeSiteId) continue;
    for (let i = 0; i < s.instances; i++) taken.add(s.port! + i);
  }
  for (let p = PORT_RANGE.min; p + instances - 1 <= PORT_RANGE.max; p++) {
    let free = true;
    for (let i = 0; i < instances && free; i++) if (taken.has(p + i)) free = false;
    if (free) return p;
  }
  throw new Error("No free ports left in the site port range");
}


/** systemd units that run a site's processes (Node/Python only). */
export function serviceUnitNames(linuxUser: string, site: Pick<Site, "name" | "runtime" | "instances">): string[] {
  if (site.runtime !== "node" && site.runtime !== "python") return [];
  return Array.from({ length: site.instances }, (_, i) => `hp-${linuxUser}-${site.name}-${i}.service`);
}

/** The server an account lives on (for DNS targets and main-only features). */
export async function serverOf(serverId: string) {
  const s = await db.query.servers.findFirst({ where: eq(schema.servers.id, serverId) });
  return { isMain: s?.isMain ?? true, ipv4: s?.ipv4 ?? config.serverIpv4, ipv6: s?.ipv6 ?? config.serverIpv6, name: s?.name ?? "Main server" };
}
