import type { FastifyInstance } from "fastify";
import { asc, count, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { heartbeatKey, serverSchema } from "@hostpanel/shared";
import { config } from "../config.js";
import { db, schema } from "../db.js";
import { randomToken, sha256 } from "../crypto.js";
import { HttpError, badRequest, conflict, notFound } from "../errors.js";
import { audit, currentUser, requireAdmin } from "../auth.js";
import { enqueue, redis } from "../queue.js";
import { listenServer } from "../events.js";
import { syncRoutes } from "../specs.js";

const JOIN_TTL_H = 24;

/**
 * Multi-server. Extra servers run only the agent (plus Caddy, PHP, Node, Python, databases).
 * They join the main server's private WireGuard network and take jobs from their own queue in
 * the main server's Redis, which is reachable only through that tunnel.
 */
export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.get("/servers", { preHandler: requireAdmin }, async () => {
    const servers = await db.query.servers.findMany({ orderBy: asc(schema.servers.createdAt) });
    const counts = await db.select({ serverId: schema.accounts.serverId, n: count() }).from(schema.accounts).groupBy(schema.accounts.serverId);
    const byServer = new Map(counts.map((c) => [c.serverId, c.n]));
    return {
      servers: await Promise.all(
        servers.map(async (s) => ({
          id: s.id,
          name: s.name,
          hostname: s.hostname,
          ipv4: s.ipv4,
          status: s.status,
          isMain: s.isMain,
          wgAddress: s.wgAddress,
          joined: s.isMain || Boolean(s.wgPublicKey),
          lastSeen: await redis.get(heartbeatKey(s.queueSuffix)),
          accounts: byServer.get(s.id) ?? 0,
        })),
      ),
      multiServerReady: Boolean(config.wgPublicKey),
    };
  });

  app.post("/servers", { preHandler: requireAdmin }, async (req) => {
    if (!config.wgPublicKey) throw badRequest("Multi-server is not set up on this panel yet: re-run install.sh on the main server to create the private network.");
    const input = serverSchema.parse(req.body);
    if (await db.query.servers.findFirst({ where: eq(schema.servers.hostname, input.hostname) })) throw conflict("A server with that hostname exists");
    const token = randomToken(32);
    const [row] = await db
      .insert(schema.servers)
      .values({ name: input.name, hostname: input.hostname, status: "pending", isMain: false, joinTokenHash: sha256(token), joinExpiresAt: new Date(Date.now() + JOIN_TTL_H * 3600_000) })
      .returning();
    await db.update(schema.servers).set({ queueSuffix: `-${row!.id}` }).where(eq(schema.servers.id, row!.id));
    await audit(req, "server.create", "server", row!.id, { hostname: input.hostname });
    return { server: { id: row!.id, name: row!.name, hostname: row!.hostname, status: row!.status }, joinCommand: joinCommand(token), expiresInHours: JOIN_TTL_H };
  });

  app.post("/servers/:id/token", { preHandler: requireAdmin }, async (req) => {
    const s = await db.query.servers.findFirst({ where: eq(schema.servers.id, (req.params as { id: string }).id) });
    if (!s || s.isMain) throw notFound("Server not found");
    const token = randomToken(32);
    await db.update(schema.servers).set({ joinTokenHash: sha256(token), joinExpiresAt: new Date(Date.now() + JOIN_TTL_H * 3600_000) }).where(eq(schema.servers.id, s.id));
    await audit(req, "server.token", "server", s.id);
    return { joinCommand: joinCommand(token), expiresInHours: JOIN_TTL_H };
  });

  app.delete("/servers/:id", { preHandler: requireAdmin }, async (req) => {
    const s = await db.query.servers.findFirst({ where: eq(schema.servers.id, (req.params as { id: string }).id) });
    if (!s || s.isMain) throw notFound("Server not found");
    const [{ n }] = (await db.select({ n: count() }).from(schema.accounts).where(eq(schema.accounts.serverId, s.id))) as [{ n: number }];
    if (n) throw conflict(`Move or delete the ${n} account(s) on this server first`);
    if (s.wgPublicKey) await enqueue("server.removePeer", { publicKey: s.wgPublicKey }, { serverId: null, createdBy: currentUser(req).id });
    await db.delete(schema.servers).where(eq(schema.servers.id, s.id));
    await audit(req, "server.delete", "server", s.id, { hostname: s.hostname });
    return { ok: true };
  });

  /**
   * Called by `install.sh --join` on the new server (authenticated by the one-time token).
   * Returns everything its agent needs: tunnel settings, its queue name, the Redis URL inside
   * the tunnel and the encryption key used for env vars and database passwords.
   */
  app.post("/servers/join", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const body = z
      .object({
        token: z.string().min(20).max(100),
        publicKey: z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/),
        ipv4: z.string().ip({ version: "v4" }).optional(),
      })
      .parse(req.body);
    const s = await db.query.servers.findFirst({ where: eq(schema.servers.joinTokenHash, sha256(body.token)) });
    if (!s || !s.joinExpiresAt || s.joinExpiresAt < new Date()) throw new HttpError(401, "Invalid or expired join token. Create a new one in the panel.", "bad_token");
    const used = await db.query.servers.findMany({ where: isNotNull(schema.servers.wgAddress), columns: { wgAddress: true, id: true } });
    const taken = new Set(used.filter((u) => u.id !== s.id).map((u) => u.wgAddress));
    let n = 2;
    while (taken.has(`10.88.0.${n}`) && n < 254) n++;
    if (n >= 254) throw conflict("No free addresses left in the private network");
    const wgAddress = s.wgAddress ?? `10.88.0.${n}`;
    await enqueue("server.addPeer", { publicKey: body.publicKey, address: wgAddress }, { serverId: null, targetType: "server", targetId: s.id });
    await db
      .update(schema.servers)
      .set({ wgPublicKey: body.publicKey, wgAddress, ipv4: body.ipv4 ?? s.ipv4, status: "active", joinTokenHash: null, joinExpiresAt: null })
      .where(eq(schema.servers.id, s.id));
    listenServer(s.queueSuffix);
    await db.insert(schema.auditLog).values({ action: "server.joined", targetType: "server", targetId: s.id, ip: req.ip, meta: { wgAddress } });
    setTimeout(() => void syncRoutes().catch(() => undefined), 15_000); // once its agent is up
    const redisUrl = new URL(config.redisUrl);
    redisUrl.hostname = "10.88.0.1";
    return {
      serverId: s.id,
      queueSuffix: s.queueSuffix,
      wireguard: { address: `${wgAddress}/24`, mainPublicKey: config.wgPublicKey, mainEndpoint: `${config.serverIpv4}:${config.wgPort}`, mainAddress: "10.88.0.1" },
      redisUrl: redisUrl.toString(),
      encryptionKey: config.encryptionKey,
      panelUrl: config.panelUrl,
    };
  });
}

function joinCommand(token: string): string {
  return `curl -fsSL https://raw.githubusercontent.com/singhhemant80/hostpanel/main/install.sh | sudo bash -s -- --join ${config.panelUrl} --token ${token}`;
}
