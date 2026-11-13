import type { FastifyInstance } from "fastify";
import { open, stat } from "node:fs/promises";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  RUNTIME_DEFAULTS,
  RUNTIME_VERSIONS,
  connectGitSchema,
  createSiteSchema,
  detectRuntime,
  envVarsSchema,
  needsPort,
  paths,
  updateSiteSchema,
  type CreateSiteInput,
  type Runtime,
} from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { encrypt } from "../crypto.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { accountFilter, audit, currentUser, requireAuth } from "../auth.js";
import { ownedSite, resolveAccount } from "../access.js";
import { enqueue, redis } from "../queue.js";
import { allocatePort, loadSiteSpec, serverOf, syncRoutes } from "../specs.js";
import { startDeployment } from "../deploy.js";
import { syncSiteCron } from "./cron.js";
import { config } from "../config.js";
import { githubConfigured, installationForRepo, installationToken, listInstallationRepos, listRepoFiles } from "../github.js";

export async function siteRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/sites", async (req) => {
    const sites = await db.query.sites.findMany({
      where: await accountFilter(schema.sites.accountId, currentUser(req)),
      with: {
        account: { columns: { username: true } },
        domains: { columns: { hostname: true, type: true }, orderBy: asc(schema.domains.createdAt) },
        git: { columns: { repoFullName: true, branch: true } },
        deployments: { limit: 1, orderBy: desc(schema.deployments.createdAt), columns: { status: true, commitSha: true, createdAt: true } },
      },
      orderBy: desc(schema.sites.createdAt),
    });
    return { sites };
  });

  app.post("/sites", async (req) => {
    const input = createSiteSchema.parse(req.body);
    const user = currentUser(req);
    const account = await resolveAccount(req, input.accountId);
    const site = await createSiteRecord(account, input);
    const jobId = await enqueue("site.provision", { site: await loadSiteSpec(site.id) }, { targetType: "site", targetId: site.id, createdBy: user.id });
    await syncRoutes(user.id);
    await audit(req, "site.create", "site", site.id, { name: site.name, runtime: site.runtime });
    return { site, jobId };
  });

  app.get("/sites/:id", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    return {
      site: {
        ...site,
        domains: site.domains.map(({ certEnc: _c, keyEnc: _k, ...d }) => d),
        env: site.env.map((e) => ({ key: e.key })),
        paths: { home: paths.site(site.account.linuxUser, site.name), current: paths.current(site.account.linuxUser, site.name) },
      },
      dnsTargets: await serverOf(site.account.serverId).then((s) => ({ ipv4: s.ipv4, ipv6: s.ipv6 })),
      server: await serverOf(site.account.serverId).then((s) => ({ name: s.name, isMain: s.isMain })),
      webhookUrl: `${config.panelUrl}/api/v1/webhooks/github`,
    };
  });

  app.patch("/sites/:id", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    const input = updateSiteSchema.parse(req.body);
    const runtime = (input.runtime ?? site.runtime) as Runtime;
    const version =
      input.runtimeVersion ?? (input.runtime && input.runtime !== site.runtime ? RUNTIME_VERSIONS[runtime].at(-1)! : site.runtimeVersion);
    if (!RUNTIME_VERSIONS[runtime].includes(version)) throw badRequest(`Unsupported ${runtime} version ${version}`);

    const instances = needsPort(runtime) ? (input.instances ?? site.instances) : 1;
    let port = site.port;
    if (!needsPort(runtime)) port = null;
    else if (port === null || instances > site.instances) port = await allocatePort(instances, site.id);

    const [updated] = await db
      .update(schema.sites)
      .set({ ...input, runtime, runtimeVersion: version, instances, port, background: (input.background ?? site.background) && needsPort(runtime) })
      .where(eq(schema.sites.id, site.id))
      .returning();
    // Re-provision writes the new runtime config (php-fpm pool / systemd units). Build changes need a deploy.
    const jobId = await enqueue("site.provision", { site: await loadSiteSpec(site.id) }, { targetType: "site", targetId: site.id, createdBy: currentUser(req).id });
    await syncRoutes(currentUser(req).id);
    // cron jobs run in the app folder with the runtime's PATH, so rewrite their timers too
    if (await db.query.cronJobs.findFirst({ where: eq(schema.cronJobs.siteId, site.id) })) await syncSiteCron(site.id, currentUser(req).id);
    await audit(req, "site.update", "site", site.id, input);
    return { site: updated, jobId };
  });

  app.delete("/sites/:id", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    await db.update(schema.sites).set({ status: "deleting" }).where(eq(schema.sites.id, site.id));
    await syncRoutes(currentUser(req).id);
    const jobId = await enqueue("site.remove", { site: await loadSiteSpec(site.id) }, { targetType: "site", targetId: site.id, createdBy: currentUser(req).id });
    await audit(req, "site.delete", "site", site.id);
    return { jobId };
  });

  for (const action of ["start", "stop", "restart"] as const) {
    app.post(`/sites/:id/${action}`, async (req) => {
      const site = await ownedSite(req, (req.params as { id: string }).id);
      const jobId = await enqueue(
        "site.control",
        { site: await loadSiteSpec(site.id), action },
        { targetType: `site:${action}`, targetId: site.id, createdBy: currentUser(req).id },
      );
      await audit(req, `site.${action}`, "site", site.id);
      return { jobId };
    });
  }

  // ---- Environment variables (write-only: values are never sent back to the browser) ----
  app.get("/sites/:id/env", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    return { vars: site.env.map((e) => ({ key: e.key })) };
  });

  app.put("/sites/:id/env", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    const { vars } = envVarsSchema.parse(req.body);
    const keys = new Set(vars.map((v) => v.key));
    if (keys.size !== vars.length) throw badRequest("Duplicate variable names");
    if (vars.length) {
      await db
        .insert(schema.siteEnv)
        .values(vars.map((v) => ({ siteId: site.id, key: v.key, valueEnc: encrypt(v.value) })))
        .onConflictDoUpdate({
          target: [schema.siteEnv.siteId, schema.siteEnv.key],
          set: { valueEnc: sql`excluded.value_enc` },
        });
    }
    await audit(req, "site.env_update", "site", site.id, { keys: [...keys] });
    return { ok: true, note: "Redeploy or restart the site to apply" };
  });

  app.delete("/sites/:id/env/:key", async (req) => {
    const { id, key } = req.params as { id: string; key: string };
    const site = await ownedSite(req, id);
    await db.delete(schema.siteEnv).where(and(eq(schema.siteEnv.siteId, site.id), eq(schema.siteEnv.key, key)));
    await audit(req, "site.env_delete", "site", site.id, { key });
    return { ok: true };
  });

  // ---- GitHub ----
  app.get("/github/repos", async () => {
    if (!githubConfigured()) return { configured: false, repos: [], installUrl: null };
    return {
      configured: true,
      repos: await listInstallationRepos(),
      installUrl: config.github.appSlug ? `https://github.com/apps/${config.github.appSlug}/installations/new` : null,
    };
  });

  /** Suggest a runtime from a repo's files before creating/connecting a site. */
  app.get("/github/detect", async (req) => {
    const q = z
      .object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.string().default("main"), dir: z.string().default("") })
      .parse(req.query);
    const inst = githubConfigured() ? await installationForRepo(q.repo) : null;
    const token = inst ? await installationToken(inst) : null;
    const files = await listRepoFiles(q.repo, q.branch, q.dir, token);
    const runtime = detectRuntime(files);
    return { runtime, defaults: RUNTIME_DEFAULTS[runtime], files };
  });

  app.post("/sites/:id/git", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    const input = connectGitSchema.parse(req.body);
    const installationId = input.installationId ?? (githubConfigured() ? await installationForRepo(input.repoFullName) : null);
    const values = { repoFullName: input.repoFullName, branch: input.branch, installationId, autoDeploy: input.autoDeploy };
    const [git] = await db
      .insert(schema.gitSources)
      .values({ siteId: site.id, ...values })
      .onConflictDoUpdate({ target: schema.gitSources.siteId, set: values })
      .returning();
    await audit(req, "site.git_connect", "site", site.id, { repo: input.repoFullName, branch: input.branch });
    return { git };
  });

  app.delete("/sites/:id/git", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    await db.delete(schema.gitSources).where(eq(schema.gitSources.siteId, site.id));
    await audit(req, "site.git_disconnect", "site", site.id);
    return { ok: true };
  });

  // ---- Deployments ----
  app.post("/sites/:id/deploy", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    const dep = await startDeployment(site.id, { trigger: "manual", createdBy: currentUser(req).id });
    await audit(req, "site.deploy", "site", site.id, { deploymentId: dep.id });
    return { deployment: dep };
  });

  app.get("/sites/:id/deployments", async (req) => {
    const site = await ownedSite(req, (req.params as { id: string }).id);
    return {
      deployments: await db.query.deployments.findMany({
        where: eq(schema.deployments.siteId, site.id),
        orderBy: desc(schema.deployments.createdAt),
        limit: 30,
      }),
    };
  });

  app.get("/deployments/:id/log", async (req) => {
    const { id } = req.params as { id: string };
    const { offset } = z.object({ offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const dep = await db.query.deployments.findFirst({ where: eq(schema.deployments.id, id) });
    if (!dep) throw notFound("Deployment not found");
    await ownedSite(req, dep.siteId);
    const done = !["queued", "building"].includes(dep.status);
    const file = config.devSandboxRoot + paths.deployLog(dep.id);
    const st = await stat(file).catch(() => null);
    if (!st) {
      // built on another server: the agent mirrors the log to Redis
      const text = (await redis.getrange(`hp:deploylog:${dep.id}`, offset, offset + 256 * 1024 - 1)) ?? "";
      return { text, offset: offset + Buffer.byteLength(text), done: done && text.length === 0, status: dep.status };
    }
    const start = Math.min(offset, st.size);
    const len = Math.min(st.size - start, 256 * 1024);
    const fh = await open(file, "r");
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      return { text: buf.toString("utf8"), offset: start + len, done: done && start + len >= st.size, status: dep.status };
    } finally {
      await fh.close();
    }
  });

  app.post("/deployments/:id/rollback", async (req) => {
    const { id } = req.params as { id: string };
    const target = await db.query.deployments.findFirst({ where: eq(schema.deployments.id, id) });
    if (!target?.releaseName) throw notFound("That deployment has no release to roll back to");
    const site = await ownedSite(req, target.siteId);
    const [dep] = await db
      .insert(schema.deployments)
      .values({
        siteId: site.id,
        trigger: "rollback",
        commitSha: target.commitSha,
        commitMessage: `Rollback to ${target.commitSha?.slice(0, 7) ?? target.releaseName}`,
      })
      .returning();
    const jobId = await enqueue(
      "site.rollback",
      { site: await loadSiteSpec(site.id), deploymentId: dep!.id, releaseName: target.releaseName },
      { targetType: "deployment", targetId: dep!.id, createdBy: currentUser(req).id },
    );
    await db.update(schema.deployments).set({ jobId }).where(eq(schema.deployments.id, dep!.id));
    await audit(req, "site.rollback", "site", site.id, { to: target.releaseName });
    return { deployment: { ...dep!, jobId } };
  });

  // ---- Jobs ----
  app.get("/jobs/:id", async (req) => {
    const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, (req.params as { id: string }).id) });
    const user = currentUser(req);
    if (!job || (user.role !== "admin" && job.createdBy !== user.id)) throw notFound("Job not found");
    return { job };
  });
}

/** Validates plan limits and creates the site + primary domain rows (no jobs). Shared with one-click apps. */
export async function createSiteRecord(
  account: { id: string; package: { maxSites: number; maxDomains: number } },
  input: CreateSiteInput,
) {
  if (!RUNTIME_VERSIONS[input.runtime].includes(input.runtimeVersion)) {
    throw badRequest(`Unsupported ${input.runtime} version ${input.runtimeVersion}`);
  }
  const background = input.background && needsPort(input.runtime);
  if (input.background && !background) throw badRequest("Only Node.js and Python sites can run as background workers");
  if (!background && !input.primaryDomain) throw badRequest("A primary domain is required");
  const [[sc], [dc]] = await Promise.all([
    db.select({ n: count() }).from(schema.sites).where(eq(schema.sites.accountId, account.id)),
    db.select({ n: count() }).from(schema.domains).where(eq(schema.domains.accountId, account.id)),
  ]);
  if (sc!.n >= account.package.maxSites) throw badRequest(`Your plan allows ${account.package.maxSites} site(s)`);
  if (!background && dc!.n >= account.package.maxDomains) throw badRequest(`Your plan allows ${account.package.maxDomains} domains`);
  if (input.primaryDomain && !background && (await db.query.domains.findFirst({ where: eq(schema.domains.hostname, input.primaryDomain) }))) {
    throw conflict("That domain is already on this server");
  }
  if (await db.query.sites.findFirst({ where: and(eq(schema.sites.accountId, account.id), eq(schema.sites.name, input.name)) })) {
    throw conflict("You already have a site with that name");
  }

  const d = RUNTIME_DEFAULTS[input.runtime as Runtime];
  const port = needsPort(input.runtime) ? await allocatePort(input.instances) : null;
  const site = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(schema.sites)
      .values({
        accountId: account.id,
        name: input.name,
        runtime: input.runtime,
        runtimeVersion: input.runtimeVersion,
        rootDir: input.rootDir,
        publicDir: input.publicDir ?? d.publicDir,
        buildCmd: input.buildCmd ?? d.buildCmd,
        startCmd: input.startCmd ?? d.startCmd,
        healthPath: input.healthPath,
        instances: needsPort(input.runtime) ? input.instances : 1,
        port,
        background,
      })
      .returning();
    if (!background && input.primaryDomain) {
      await tx.insert(schema.domains).values({ accountId: account.id, siteId: s!.id, hostname: input.primaryDomain, type: "primary" });
    }
    return s!;
  });
  return site;
}
