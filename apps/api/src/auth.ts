import type { FastifyReply, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { hash, verify } from "@node-rs/argon2";
import { eq, inArray, or, type SQL, type AnyColumn } from "drizzle-orm";
import { config } from "./config.js";
import { db, schema } from "./db.js";
import type { Role } from "./schema.js";
import { randomToken, sha256 } from "./crypto.js";
import { HttpError, forbidden } from "./errors.js";

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const ACCESS_COOKIE = "hp_at";
export const REFRESH_COOKIE = "hp_rt";

export function hashPassword(pw: string): Promise<string> {
  // Argon2id with library defaults (m=19 MiB, t=2, p=1), the OWASP baseline
  return hash(pw);
}

export function verifyPassword(hashed: string, pw: string): Promise<boolean> {
  return verify(hashed, pw).catch(() => false);
}

function cookieOpts(req: FastifyRequest, maxAgeSec: number, path = "/") {
  const secure = config.isProd || req.protocol === "https";
  return { httpOnly: true, sameSite: "strict" as const, secure, path, maxAge: maxAgeSec };
}

export async function issueSession(req: FastifyRequest, reply: FastifyReply, user: AuthUser): Promise<void> {
  const refresh = randomToken(32);
  await db.insert(schema.sessions).values({
    userId: user.id,
    tokenHash: sha256(refresh),
    ip: req.ip,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 255),
    expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 86400_000),
  });
  setAccessCookie(req, reply, user);
  reply.setCookie(REFRESH_COOKIE, refresh, cookieOpts(req, config.refreshTokenTtlDays * 86400, "/api/v1/auth"));
}

export function setAccessCookie(req: FastifyRequest, reply: FastifyReply, user: AuthUser): void {
  const token = jwt.sign({ sub: user.id, role: user.role, email: user.email }, config.jwtSecret, {
    expiresIn: config.accessTokenTtlSec,
    algorithm: "HS256",
  });
  reply.setCookie(ACCESS_COOKIE, token, cookieOpts(req, config.accessTokenTtlSec));
}

export async function refreshSession(req: FastifyRequest, reply: FastifyReply): Promise<AuthUser> {
  const raw = req.cookies[REFRESH_COOKIE];
  if (!raw) throw new HttpError(401, "Not signed in", "unauthenticated");
  const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.tokenHash, sha256(raw)), with: { user: true } });
  if (!session || session.expiresAt < new Date() || session.user.status !== "active") {
    throw new HttpError(401, "Session expired", "unauthenticated");
  }
  await db.update(schema.sessions).set({ lastUsedAt: new Date() }).where(eq(schema.sessions.id, session.id));
  const user = { id: session.user.id, role: session.user.role, email: session.user.email };
  setAccessCookie(req, reply, user);
  return user;
}

export async function endSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.cookies[REFRESH_COOKIE];
  if (raw) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(raw)));
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: "/api/v1/auth" });
}

/** preHandler: requires a valid access cookie. Mutating requests must also carry the X-HostPanel header (CSRF guard). */
export async function requireAuth(req: FastifyRequest): Promise<void> {
  const token = req.cookies[ACCESS_COOKIE];
  if (!token) throw new HttpError(401, "Not signed in", "unauthenticated");
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    req.user = { id: String(p.sub), role: p.role as Role, email: String(p.email) };
  } catch {
    throw new HttpError(401, "Session expired", "unauthenticated");
  }
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-hostpanel"] !== "1") {
    throw forbidden("Missing X-HostPanel header");
  }
}

export async function requireAdmin(req: FastifyRequest): Promise<void> {
  await requireAuth(req);
  if (req.user?.role !== "admin") throw forbidden("Admins only");
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, "Not signed in", "unauthenticated");
  return req.user;
}

/** Account ids the user may see, or null for "all" (admins). */
export async function visibleAccountIds(user: AuthUser): Promise<string[] | null> {
  if (user.role === "admin") return null;
  // resellers see their own accounts and every customer account they created
  const where = user.role === "reseller" ? or(eq(schema.accounts.userId, user.id), eq(schema.accounts.resellerId, user.id)) : eq(schema.accounts.userId, user.id);
  const rows = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(where);
  return rows.map((r) => r.id);
}

/** preHandler: admins and resellers (resellers are further limited to their own customers). */
export async function requireAdminOrReseller(req: FastifyRequest): Promise<void> {
  await requireAuth(req);
  if (req.user?.role !== "admin" && req.user?.role !== "reseller") throw forbidden("Admins and resellers only");
}

/** WHERE fragment limiting `column` (an account id column) to the user's accounts; undefined for admins. */
export async function accountFilter(column: AnyColumn, user: AuthUser): Promise<SQL | undefined> {
  const ids = await visibleAccountIds(user);
  if (ids === null) return undefined;
  return inArray(column, ids.length ? ids : ["-none-"]);
}

export async function audit(
  req: FastifyRequest,
  action: string,
  targetType?: string,
  targetId?: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await db.insert(schema.auditLog).values({ userId: req.user?.id ?? null, action, targetType, targetId, ip: req.ip, meta });
}
