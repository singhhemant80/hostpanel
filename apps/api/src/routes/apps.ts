import type { FastifyInstance } from "fastify";
import { count, eq } from "drizzle-orm";
import { appInstallSchema, type AppTemplate, type CreateSiteInput } from "@hostpanel/shared";
import { db, schema } from "../db.js";
import { encrypt, randomPassword } from "../crypto.js";
import { badRequest, conflict } from "../errors.js";
import { audit, currentUser, requireAuth } from "../auth.js";
import { resolveAccount } from "../access.js";
import { enqueue } from "../queue.js";
import { loadSiteSpec, syncRoutes } from "../specs.js";
import { createSiteRecord } from "./sites.js";

interface CatalogEntry {
  id: AppTemplate;
  name: string;
  description: string;
  site: Omit<CreateSiteInput, "name" | "primaryDomain" | "accountId">;
  database: "mariadb" | null;
  adminUser: boolean;
  minutes: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "wordpress",
    name: "WordPress",
    description: "Blog or website with the WordPress admin, a MariaDB database and an admin user ready to log in.",
    site: { runtime: "php", runtimeVersion: "8.3", rootDir: "", publicDir: "", buildCmd: "", healthPath: "/", instances: 1, background: false },
    database: "mariadb",
    adminUser: true,
    minutes: "1–2",
  },
  {
    id: "laravel",
    name: "Laravel",
    description: "New Laravel project (composer create-project) wired to a MariaDB database, migrations run.",
    site: {
      runtime: "php",
      runtimeVersion: "8.3",
      rootDir: "",
      publicDir: "public",
      buildCmd: "composer install --no-dev --optimize-autoloader && php artisan migrate --force && php artisan config:cache",
      healthPath: "/",
      instances: 1,
      background: false,
    },
    database: "mariadb",
    adminUser: false,
    minutes: "2–4",
  },
  {
    id: "nextjs",
    name: "Next.js",
    description: "New Next.js app (TypeScript, App Router) built and running on Node.js 22.",
    site: { runtime: "node", runtimeVersion: "22", rootDir: "", buildCmd: "npm ci && npm run build", startCmd: "npm start", healthPath: "/", instances: 1, background: false },
    database: null,
    adminUser: false,
    minutes: "2–4",
  },
  {
    id: "django",
    name: "Django",
    description: "New Django project on Python 3.12 with gunicorn, static files and a superuser for /admin.",
    site: {
      runtime: "python",
      runtimeVersion: "3.12",
      rootDir: "",
      buildCmd: "python -m venv .venv && .venv/bin/pip install -r requirements.txt",
      startCmd: ".venv/bin/gunicorn -b 127.0.0.1:$PORT mysite.wsgi",
      healthPath: "/admin/login/",
      instances: 1,
      background: false,
    },
    database: null,
    adminUser: true,
    minutes: "2–4",
  },
];

export async function appRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/apps/catalog", async () => ({
    apps: CATALOG.map(({ id, name, description, database, adminUser, minutes, site }) => ({ id, name, description, database, adminUser, minutes, runtime: `${site.runtime} ${site.runtimeVersion}` })),
  }));

  app.post("/apps/install", async (req) => {
    const input = appInstallSchema.parse(req.body);
    const entry = CATALOG.find((c) => c.id === input.template)!;
    const me = currentUser(req);
    const account = await resolveAccount(req, input.accountId);

    let dbRow: { id: string; name: string; dbUser: string } | null = null;
    let dbPasswordEnc: string | null = null;
    if (entry.database) {
      const [{ n }] = (await db.select({ n: count() }).from(schema.databases).where(eq(schema.databases.accountId, account.id))) as [{ n: number }];
      if (n >= account.package.maxDatabases) throw badRequest(`${entry.name} needs a database and your plan allows ${account.package.maxDatabases}`);
      const name = `${account.username}_${input.name}`.replace(/-/g, "_").slice(0, 63);
      if (await db.query.databases.findFirst({ where: eq(schema.databases.name, name) })) throw conflict(`A database called ${name} already exists`);
      dbPasswordEnc = encrypt(randomPassword());
      [dbRow] = await db.insert(schema.databases).values({ accountId: account.id, engine: entry.database, name, dbUser: name.slice(0, 32), passwordEnc: dbPasswordEnc }).returning();
    }

    const site = await createSiteRecord(account, { ...entry.site, name: input.name, primaryDomain: input.domain } as CreateSiteInput);
    if (input.template === "django") {
      await db.insert(schema.siteEnv).values({ siteId: site.id, key: "APP_DOMAINS", valueEnc: encrypt(input.domain) });
    }
    const adminPassword = entry.adminUser ? randomPassword(16) : null;
    const adminEmail = input.adminEmail ?? me.email;
    const [dep] = await db.insert(schema.deployments).values({ siteId: site.id, trigger: "app", commitMessage: `One-click install: ${entry.name}` }).returning();
    const jobId = await enqueue(
      "app.install",
      {
        site: await loadSiteSpec(site.id),
        template: entry.id,
        domain: input.domain,
        deploymentId: dep!.id,
        db: dbRow ? { engine: entry.database!, name: dbRow.name, user: dbRow.dbUser, passwordEnc: dbPasswordEnc! } : null,
        admin: adminPassword ? { user: "admin", email: adminEmail, passwordEnc: encrypt(adminPassword) } : null,
      },
      { targetType: "deployment", targetId: dep!.id, createdBy: me.id, sensitive: true },
    );
    await db.update(schema.deployments).set({ jobId }).where(eq(schema.deployments.id, dep!.id));
    await syncRoutes(me.id);
    await audit(req, "app.install", "site", site.id, { template: entry.id, domain: input.domain });
    return {
      site,
      deploymentId: dep!.id,
      // shown once: the panel does not store the app's admin password
      admin: adminPassword ? { user: "admin", password: adminPassword, email: adminEmail, url: entry.id === "wordpress" ? `https://${input.domain}/wp-admin/` : `https://${input.domain}/admin/` } : null,
      database: dbRow ? { name: dbRow.name, user: dbRow.dbUser } : null,
    };
  });
}
