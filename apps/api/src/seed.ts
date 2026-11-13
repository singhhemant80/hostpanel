/**
 * Creates the first admin, the server row and three starter packages. Safe to re-run.
 * ADMIN_EMAIL / ADMIN_PASSWORD come from the environment (install.sh generates the password).
 */
import "dotenv/config";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { hash } from "@node-rs/argon2";
import { db, pool, schema } from "./db.js";

const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "change-me-now-please";

const starter = [
  { name: "Starter", diskMb: 5_000, bandwidthGb: 100, maxSites: 1, maxDomains: 3, maxDatabases: 1, cpuPercent: 50, ramMb: 512, maxMailboxes: 5 },
  { name: "Business", diskMb: 25_000, bandwidthGb: 500, maxSites: 10, maxDomains: 25, maxDatabases: 10, cpuPercent: 100, ramMb: 2048, maxMailboxes: 50 },
  { name: "Unlimited", diskMb: 200_000, bandwidthGb: 5_000, maxSites: 100, maxDomains: 500, maxDatabases: 100, cpuPercent: 400, ramMb: 8192, maxMailboxes: 1000 },
];

await db.insert(schema.packages).values(starter).onConflictDoNothing({ target: schema.packages.name });

const ipv4 = process.env.SERVER_IPV4 || null;
const ipv6 = process.env.SERVER_IPV6 || null;
// The server the panel runs on is the "main" server (plain queue names, mail, web terminal).
const main = await db.query.servers.findFirst({ where: eq(schema.servers.isMain, true) });
if (main) await db.update(schema.servers).set({ ipv4: ipv4 ?? main.ipv4, ipv6: ipv6 ?? main.ipv6 }).where(eq(schema.servers.id, main.id));
else
  await db
    .insert(schema.servers)
    .values({ name: "Main server", hostname: hostname(), ipv4, ipv6, isMain: true, queueSuffix: "" })
    .onConflictDoUpdate({ target: schema.servers.hostname, set: { ipv4, ipv6, isMain: true, queueSuffix: "" } });

const existing = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
if (!existing) {
  await db.insert(schema.users).values({ email, name: "Administrator", passwordHash: await hash(password), role: "admin" });
  console.log(`Admin created: ${email}`);
} else {
  console.log(`Admin ${email} already exists (password unchanged)`);
}
await pool.end();
