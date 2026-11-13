import type { FastifyInstance } from "fastify";
import { createDatabaseSchema } from "@hostpanel/shared";
import { count, desc, eq } from "drizzle-orm";
import { db, schema } from "../db.js";
import { badRequest, conflict } from "../errors.js";
import { decrypt, encrypt, randomPassword } from "../crypto.js";
import { accountFilter, audit, currentUser, requireAuth } from "../auth.js";
import { ownedDatabase, resolveAccount } from "../access.js";
import { enqueue } from "../queue.js";

export async function databaseRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/databases", async (req) => {
    const databases = await db.query.databases.findMany({
      where: await accountFilter(schema.databases.accountId, currentUser(req)),
      columns: { id: true, engine: true, name: true, dbUser: true, status: true, createdAt: true },
      with: { account: { columns: { username: true } } },
      orderBy: desc(schema.databases.createdAt),
    });
    return { databases };
  });

  app.post("/databases", async (req) => {
    const input = createDatabaseSchema.parse(req.body);
    const account = await resolveAccount(req, input.accountId);
    const [c] = await db.select({ n: count() }).from(schema.databases).where(eq(schema.databases.accountId, account.id));
    if (c!.n >= account.package.maxDatabases) throw badRequest(`Your plan allows ${account.package.maxDatabases} databases`);

    // Prefix with the account name so names never clash between customers (like cPanel's user_db).
    const name = `${account.username.replace(/-/g, "_")}_${input.name}`.slice(0, 63);
    if (await db.query.databases.findFirst({ where: eq(schema.databases.name, name) })) throw conflict("A database with that name exists");
    const password = randomPassword();
    const passwordEnc = encrypt(password);
    const [row] = await db
      .insert(schema.databases)
      .values({ accountId: account.id, engine: input.engine, name, dbUser: name.slice(0, 32), passwordEnc })
      .returning();
    const jobId = await enqueue(
      "db.create",
      { engine: input.engine, name: row!.name, user: row!.dbUser, passwordEnc },
      { targetType: "database", targetId: row!.id, createdBy: currentUser(req).id, sensitive: true, serverId: account.serverId },
    );
    await audit(req, "database.create", "database", row!.id, { name, engine: input.engine });
    return { database: { id: row!.id, name: row!.name, dbUser: row!.dbUser, engine: row!.engine, status: row!.status }, password, jobId };
  });

  app.get("/databases/:id/credentials", async (req) => {
    const rec = await ownedDatabase(req, (req.params as { id: string }).id);
    const password = decrypt(rec.passwordEnc);
    const host = "127.0.0.1";
    const port = rec.engine === "mariadb" ? 3306 : 5432;
    const scheme = rec.engine === "mariadb" ? "mysql" : "postgresql";
    await audit(req, "database.reveal_credentials", "database", rec.id);
    return {
      host,
      port,
      database: rec.name,
      user: rec.dbUser,
      password,
      url: `${scheme}://${rec.dbUser}:${password}@${host}:${port}/${rec.name}`,
    };
  });

  app.delete("/databases/:id", async (req) => {
    const rec = await ownedDatabase(req, (req.params as { id: string }).id);
    await db.update(schema.databases).set({ status: "deleting" }).where(eq(schema.databases.id, rec.id));
    const jobId = await enqueue(
      "db.delete",
      { engine: rec.engine as "mariadb" | "postgres", name: rec.name, user: rec.dbUser },
      { targetType: "database", targetId: rec.id, createdBy: currentUser(req).id, serverId: rec.account.serverId },
    );
    await audit(req, "database.delete", "database", rec.id);
    return { jobId };
  });
}
