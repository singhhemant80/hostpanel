import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import WebSocket, { WebSocketServer } from "ws";
import { accessSchema, paths } from "@hostpanel/shared";
import { config } from "../config.js";
import { db, schema } from "../db.js";
import { encrypt } from "../crypto.js";
import { audit, currentUser, requireAuth, ACCESS_COOKIE } from "../auth.js";
import { ownedAccount } from "../access.js";
import { enqueue } from "../queue.js";

export async function accessRoutes(app: FastifyInstance): Promise<void> {
  app.get("/accounts/:id/access", { preHandler: requireAuth }, async (req) => {
    const account = await ownedAccount(req, (req.params as { id: string }).id);
    const row = await db.query.accountAccess.findFirst({ where: eq(schema.accountAccess.accountId, account.id) });
    return {
      sftp: row?.sftp ?? false,
      shell: row?.shell ?? false,
      passwordSet: row?.passwordSet ?? false,
      sshKeys: row?.sshKeys ?? [],
      host: config.panelHostname ?? config.serverIpv4,
      username: account.linuxUser,
      port: 22,
    };
  });

  app.put("/accounts/:id/access", { preHandler: requireAuth }, async (req) => {
    const account = await ownedAccount(req, (req.params as { id: string }).id);
    const input = accessSchema.parse(req.body);
    const current = await db.query.accountAccess.findFirst({ where: eq(schema.accountAccess.accountId, account.id) });
    // Shell access is a privilege: only admins can turn it on.
    const shell = currentUser(req).role === "admin" ? input.shell : (current?.shell ?? false) && input.shell;
    const passwordSet = Boolean(input.password) || (current?.passwordSet ?? false);
    const values = { sftp: input.sftp || shell, shell, passwordSet, sshKeys: input.sshKeys };
    await db.insert(schema.accountAccess).values({ accountId: account.id, ...values }).onConflictDoUpdate({ target: schema.accountAccess.accountId, set: values });
    const jobId = await enqueue(
      "access.sync",
      { linuxUser: account.linuxUser, sftp: values.sftp, shell, passwordEnc: input.password ? encrypt(input.password) : null, sshKeys: input.sshKeys },
      { targetType: "account", targetId: account.id, createdBy: currentUser(req).id, sensitive: true },
    );
    await audit(req, "access.update", "account", account.id, { sftp: values.sftp, shell, keys: input.sshKeys.length, passwordChanged: Boolean(input.password) });
    return { ok: true, jobId };
  });
}

// ---------------- web terminal (WebSocket) ----------------

function signTerminalToken(claims: { u: string; cwd: string; cols: number; rows: number; exp: number }): string {
  const key = createHmac("sha256", config.encryptionKey).update("hostpanel-terminal-v1").digest();
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

const reject = (socket: Duplex, code: number, msg: string) => socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);

/**
 * GET /api/v1/terminal?site=<id>&cols=&rows= (WebSocket). Checks the session cookie, the
 * Origin, site ownership and that the account has shell access, then pipes to the agent.
 */
export function attachTerminal(app: FastifyInstance): void {
  const wss = new WebSocketServer({ noServer: true });
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/api/v1/terminal") return reject(socket, 404, "Not Found");
    void (async () => {
      const origin = req.headers.origin ?? "";
      const allowed = new URL(config.panelUrl).origin;
      if (config.isProd && origin !== allowed) return reject(socket, 403, "Forbidden");

      const token = cookie(req, ACCESS_COOKIE);
      let userId: string;
      let role: string;
      try {
        const p = jwt.verify(token ?? "", config.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
        userId = String(p.sub);
        role = String(p.role);
      } catch {
        return reject(socket, 401, "Unauthorized");
      }
      const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, url.searchParams.get("site") ?? ""), with: { account: { with: { access: true } } } });
      if (!site || (role !== "admin" && site.account.userId !== userId)) return reject(socket, 404, "Not Found");
      if (role !== "admin" && !site.account.access?.shell) return reject(socket, 403, "Forbidden");
      if (site.account.status !== "active") return reject(socket, 403, "Forbidden");

      const t = signTerminalToken({
        u: site.account.linuxUser,
        cwd: paths.current(site.account.linuxUser, site.name).replace(/\/current$/, ""),
        cols: Number(url.searchParams.get("cols") ?? 120),
        rows: Number(url.searchParams.get("rows") ?? 30),
        exp: Math.floor(Date.now() / 1000) + 30,
      });
      const upstream = new WebSocket(`ws+unix://${config.devSandboxRoot}${paths.terminalSocket}:/?t=${encodeURIComponent(t)}`);
      upstream.on("error", () => reject(socket, 502, "Bad Gateway"));
      upstream.on("open", () => {
        wss.handleUpgrade(req, socket, head, (client) => {
          void db.insert(schema.auditLog).values({ userId, action: "terminal.open", targetType: "site", targetId: site.id, ip: req.socket.remoteAddress ?? null });
          client.on("message", (d) => upstream.readyState === upstream.OPEN && upstream.send(d));
          upstream.on("message", (d) => client.readyState === client.OPEN && client.send(d));
          client.on("close", () => upstream.close());
          upstream.on("close", () => client.close());
        });
      });
    })().catch(() => reject(socket, 500, "Internal Server Error"));
  });
}
