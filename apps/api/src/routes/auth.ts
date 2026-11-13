import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticator } from "otplib";
import { loginSchema } from "@hostpanel/shared";
import { eq } from "drizzle-orm";
import { db, schema } from "../db.js";
import { decrypt, encrypt } from "../crypto.js";
import { HttpError, badRequest } from "../errors.js";
import {
  audit,
  currentUser,
  endSession,
  hashPassword,
  issueSession,
  refreshSession,
  requireAuth,
  verifyPassword,
} from "../auth.js";

// A real hash so unknown e-mails take as long as wrong passwords.
const DUMMY_HASH = await hashPassword("timing-equaliser-not-a-password");

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const user = await db.query.users.findFirst({ where: eq(schema.users.email, body.email.toLowerCase()) });
    const ok = await verifyPassword(user?.passwordHash ?? DUMMY_HASH, body.password);
    if (!user || !ok || user.status !== "active") {
      await db.insert(schema.auditLog).values({ action: "auth.login_failed", ip: req.ip, meta: { email: body.email } });
      throw new HttpError(401, "Wrong email or password", "bad_credentials");
    }
    if (user.totpEnabled) {
      if (!body.totp) throw new HttpError(401, "Enter the 6-digit code from your authenticator app", "totp_required");
      if (!user.totpSecret || !authenticator.check(body.totp, decrypt(user.totpSecret))) {
        throw new HttpError(401, "Wrong authenticator code", "bad_totp");
      }
    }
    const authUser = { id: user.id, role: user.role, email: user.email };
    await issueSession(req, reply, authUser);
    req.user = authUser;
    await audit(req, "auth.login");
    return { user: publicUser(user) };
  });

  app.post("/auth/refresh", async (req, reply) => {
    const u = await refreshSession(req, reply);
    const user = await getUser(u.id);
    return { user: publicUser(user) };
  });

  app.post("/auth/logout", async (req, reply) => {
    await endSession(req, reply);
    return { ok: true };
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (req) => {
    const user = await getUser(currentUser(req).id);
    return { user: publicUser(user) };
  });

  app.patch("/auth/me", { preHandler: requireAuth }, async (req) => {
    const body = z.object({ name: z.string().min(1).max(100).optional(), locale: z.enum(["en", "hi"]).optional() }).parse(req.body);
    const [user] = await db.update(schema.users).set(body).where(eq(schema.users.id, currentUser(req).id)).returning();
    return { user: publicUser(user!) };
  });

  app.post("/auth/password", { preHandler: requireAuth }, async (req) => {
    const body = z.object({ current: z.string(), next: z.string().min(10) }).parse(req.body);
    const user = await getUser(currentUser(req).id);
    if (!(await verifyPassword(user.passwordHash, body.current))) throw badRequest("Current password is wrong");
    await db.update(schema.users).set({ passwordHash: await hashPassword(body.next) }).where(eq(schema.users.id, user.id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
    await audit(req, "auth.password_changed");
    return { ok: true };
  });

  app.post("/auth/2fa/setup", { preHandler: requireAuth }, async (req) => {
    const user = await getUser(currentUser(req).id);
    if (user.totpEnabled) throw badRequest("Two-factor authentication is already on");
    const secret = authenticator.generateSecret();
    await db.update(schema.users).set({ totpSecret: encrypt(secret) }).where(eq(schema.users.id, user.id));
    return { secret, otpauthUrl: authenticator.keyuri(user.email, "HostPanel", secret) };
  });

  app.post("/auth/2fa/enable", { preHandler: requireAuth }, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const user = await getUser(currentUser(req).id);
    if (!user.totpSecret || !authenticator.check(code, decrypt(user.totpSecret))) throw badRequest("Wrong code, try again");
    await db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, user.id));
    await audit(req, "auth.2fa_enabled");
    return { ok: true };
  });

  app.post("/auth/2fa/disable", { preHandler: requireAuth }, async (req) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const user = await getUser(currentUser(req).id);
    if (!user.totpSecret || !authenticator.check(code, decrypt(user.totpSecret))) throw badRequest("Wrong code");
    await db.update(schema.users).set({ totpEnabled: false, totpSecret: null }).where(eq(schema.users.id, user.id));
    await audit(req, "auth.2fa_disabled");
    return { ok: true };
  });
}

export function publicUser(u: { id: string; email: string; name: string; role: string; locale: string; totpEnabled: boolean }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, locale: u.locale, totpEnabled: u.totpEnabled };
}

async function getUser(id: string) {
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, id) });
  if (!user) throw new HttpError(401, "Not signed in", "unauthenticated");
  return user;
}
