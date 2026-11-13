/**
 * HostPanel root agent. Consumes typed jobs from Redis and is the ONLY component
 * that changes the server. It never accepts raw shell commands: every job type has
 * a fixed handler and a strict payload schema (validate.ts).
 */
import { Worker, type Job } from "bullmq";
import { heartbeatKey, queueNames } from "@hostpanel/shared";
import { env } from "./env.js";
import { parsePayload } from "./validate.js";
import { accountCreate, accountDelete, accountSuspend } from "./handlers/accounts.js";
import { siteControl, siteProvision, siteRemove } from "./handlers/sites.js";
import { siteDeploy, siteRollback } from "./handlers/deploy.js";
import { dbCreate, dbDelete, routesSync, systemStats } from "./handlers/misc.js";
import { cronRun, cronSync } from "./handlers/cron.js";
import { backupDelete, backupRestore, backupRun } from "./handlers/backup.js";
import { accessSync, logsRead, statsAccount } from "./handlers/access.js";
import * as files from "./handlers/files.js";
import { startTerminalServer } from "./terminal.js";
import { mailDkim, mailPurge, mailSync, mailUsage } from "./handlers/mail.js";
import { appInstall } from "./handlers/apps.js";
import { serverAddPeer, serverRemovePeer } from "./handlers/servers.js";
import { redis } from "./redis.js";

export async function handle(job: Job): Promise<unknown> {
  const type = job.name;
  const started = Date.now();
  console.log(`→ ${type} #${job.id}`);
  try {
    switch (type) {
      case "account.create":
        return await accountCreate(parsePayload<"account.create">(type, job.data));
      case "account.suspend":
        return await accountSuspend(parsePayload<"account.suspend">(type, job.data));
      case "account.delete":
        return await accountDelete(parsePayload<"account.delete">(type, job.data));
      case "site.provision":
        return await siteProvision(parsePayload<"site.provision">(type, job.data));
      case "site.remove":
        return await siteRemove(parsePayload<"site.remove">(type, job.data));
      case "site.control":
        return await siteControl(parsePayload<"site.control">(type, job.data));
      case "site.deploy":
        return await siteDeploy(parsePayload<"site.deploy">(type, job.data), job);
      case "site.rollback":
        return await siteRollback(parsePayload<"site.rollback">(type, job.data), job);
      case "routes.sync":
        return await routesSync(parsePayload<"routes.sync">(type, job.data));
      case "db.create":
        return await dbCreate(parsePayload<"db.create">(type, job.data));
      case "db.delete":
        return await dbDelete(parsePayload<"db.delete">(type, job.data));
      case "system.stats":
        return await systemStats();
      case "cron.sync":
        return await cronSync(parsePayload<"cron.sync">(type, job.data));
      case "cron.run":
        return await cronRun(parsePayload<"cron.run">(type, job.data));
      case "backup.run":
        return await backupRun(parsePayload<"backup.run">(type, job.data), job);
      case "backup.restore":
        return await backupRestore(parsePayload<"backup.restore">(type, job.data), job);
      case "backup.delete":
        return await backupDelete(parsePayload<"backup.delete">(type, job.data));
      case "access.sync":
        return await accessSync(parsePayload<"access.sync">(type, job.data));
      case "fs.list":
        return await files.fsList(parsePayload<"fs.list">(type, job.data));
      case "fs.read":
        return await files.fsRead(parsePayload<"fs.read">(type, job.data));
      case "fs.write":
        return await files.fsWrite(parsePayload<"fs.write">(type, job.data));
      case "fs.mkdir":
        return await files.fsMkdir(parsePayload<"fs.mkdir">(type, job.data));
      case "fs.rename":
        return await files.fsRename(parsePayload<"fs.rename">(type, job.data));
      case "fs.delete":
        return await files.fsDelete(parsePayload<"fs.delete">(type, job.data));
      case "fs.chmod":
        return await files.fsChmod(parsePayload<"fs.chmod">(type, job.data));
      case "fs.upload":
        return await files.fsUpload(parsePayload<"fs.upload">(type, job.data));
      case "fs.download":
        return await files.fsDownload(parsePayload<"fs.download">(type, job.data));
      case "fs.extract":
        return await files.fsExtract(parsePayload<"fs.extract">(type, job.data));
      case "fs.compress":
        return await files.fsCompress(parsePayload<"fs.compress">(type, job.data));
      case "logs.read":
        return await logsRead(parsePayload<"logs.read">(type, job.data));
      case "stats.account":
        return await statsAccount(parsePayload<"stats.account">(type, job.data));
      case "mail.sync":
        return await mailSync(parsePayload<"mail.sync">(type, job.data));
      case "mail.dkim":
        return await mailDkim(parsePayload<"mail.dkim">(type, job.data));
      case "mail.purge":
        return await mailPurge(parsePayload<"mail.purge">(type, job.data));
      case "mail.usage":
        return await mailUsage(parsePayload<"mail.usage">(type, job.data));
      case "app.install":
        return await appInstall(parsePayload<"app.install">(type, job.data), job);
      case "server.addPeer":
        return await serverAddPeer(parsePayload<"server.addPeer">(type, job.data));
      case "server.removePeer":
        return await serverRemovePeer(parsePayload<"server.removePeer">(type, job.data));
      default:
        throw new Error(`Unknown job type ${type}`);
    }
  } finally {
    console.log(`← ${type} #${job.id} ${Date.now() - started}ms`);
  }
}

function redisOptions() {
  const u = new URL(env.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  if (!env.dryRun && process.getuid?.() !== 0) {
    console.error("hostpanel-agent must run as root (or set AGENT_DRY_RUN=true for development)");
    process.exit(1);
  }
  const q = queueNames(env.queueSuffix);
  const worker = new Worker(q.jobs, handle, {
    connection: redisOptions(),
    concurrency: env.concurrency,
    lockDuration: 60_000,
  });
  // Interactive jobs (files, logs, usage) get their own worker so a 10-minute build never blocks them.
  const fast = new Worker(q.fast, handle, { connection: redisOptions(), concurrency: 8, lockDuration: 60_000 });
  for (const w of [worker, fast]) w.on("failed", (job, err) => console.error(`✗ ${job?.name} #${job?.id}: ${err.message}`));
  // The web terminal is only offered on the main server (the panel connects to it over a local socket).
  if (!env.queueSuffix) void startTerminalServer().catch((e) => console.error("terminal server failed:", e));
  // Heartbeat so the panel can show which servers are online.
  const beat = () => void redis().set(heartbeatKey(env.queueSuffix), new Date().toISOString(), "EX", 90).catch(() => undefined);
  beat();
  setInterval(beat, 30_000).unref();
  worker.on("ready", () => console.log(`HostPanel agent ready on queue ${q.jobs}${env.dryRun ? ` (DRY RUN, sandbox ${env.dryRoot})` : ""}`));
  const stop = async () => {
    await Promise.all([worker.close(), fast.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
