import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { isUniqueViolation } from "./db.js";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { redis } from "./queue.js";
import { authRoutes } from "./routes/auth.js";
import { adminRoutes } from "./routes/admin.js";
import { siteRoutes } from "./routes/sites.js";
import { domainRoutes } from "./routes/domains.js";
import { databaseRoutes } from "./routes/databases.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { provisioningRoutes } from "./routes/provisioning.js";
import { systemRoutes } from "./routes/system.js";
import { cronRoutes } from "./routes/cron.js";
import { fileRoutes } from "./routes/files.js";
import { backupRoutes } from "./routes/backups.js";
import { accessRoutes, attachTerminal } from "./routes/access.js";
import { dnsRoutes } from "./routes/dns.js";
import { observeRoutes } from "./routes/observe.js";
import { mailRoutes } from "./routes/mail.js";
import { appRoutes } from "./routes/apps.js";
import { resellerRoutes } from "./routes/resellers.js";
import { serverRoutes } from "./routes/servers.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string;
  }
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: config.isProd ? "info" : "debug" },
    trustProxy: "127.0.0.1",
    bodyLimit: 2 * 1024 * 1024,
  });

  // Keep the raw JSON body: GitHub webhook signatures are computed over the exact bytes.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      (e as HttpError).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://avatars.githubusercontent.com"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute", redis });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "validation", message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), issues: err.issues });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code ?? "error", message: err.message });
    if (isUniqueViolation(err)) return reply.code(409).send({ error: "conflict", message: "That already exists" });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: "error", message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "internal", message: "Something went wrong. Check the API log." });
  });

  await app.register(
    async (api) => {
      await api.register(systemRoutes);
      await api.register(authRoutes);
      await api.register(adminRoutes);
      await api.register(siteRoutes);
      await api.register(domainRoutes);
      await api.register(databaseRoutes);
      await api.register(webhookRoutes);
      await api.register(provisioningRoutes);
      await api.register(cronRoutes);
      await api.register(fileRoutes);
      await api.register(backupRoutes);
      await api.register(accessRoutes);
      await api.register(dnsRoutes);
      await api.register(observeRoutes);
      await api.register(mailRoutes);
      await api.register(appRoutes);
      await api.register(resellerRoutes);
      await api.register(serverRoutes);
    },
    { prefix: "/api/v1" },
  );
  attachTerminal(app);

  // Serve the built React panel from the same origin (cookies stay SameSite=Strict).
  const dist = config.webDist ? resolve(config.webDist) : null;
  if (dist && existsSync(dist)) {
    // wildcard: true serves files from disk on each request, so a rebuild needs no restart.
    await app.register(fastifyStatic, { root: dist, wildcard: true, index: false });
    app.get("/", (_req, reply) => reply.sendFile("index.html"));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found", message: "Unknown API route" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
