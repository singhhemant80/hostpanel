import { buildApp } from "./app.js";
import { config } from "./config.js";
import { startEventListener } from "./events.js";
import { pool } from "./db.js";
import { syncRoutes } from "./specs.js";
import { backupScheduler } from "./routes/backups.js";

const app = await buildApp();

// Only one API process should mirror job events into Postgres.
if (process.env.HOSTPANEL_EVENTS !== "off") await startEventListener(app.log);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: config.host, port: config.port });

// Make sure Caddy's config matches the database after an install, update or restore.
if (process.env.HOSTPANEL_EVENTS !== "off") {
  syncRoutes().catch((e) => app.log.error(e, "initial routes.sync failed"));
  // Nightly backups: checked every 5 minutes, runs once at the configured hour.
  setInterval(() => void backupScheduler(app.log).catch((e) => app.log.error(e, "backup scheduler failed")), 5 * 60_000);
}
