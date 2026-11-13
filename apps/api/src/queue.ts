import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import { queueNames, type JobPayloads, type JobType } from "@hostpanel/shared";
import { HttpError } from "./errors.js";
import { config } from "./config.js";
import { db, schema } from "./db.js";
import { newId } from "./schema.js";

/** BullMQ connection options parsed from REDIS_URL (BullMQ manages its own ioredis clients). */
export function redisOptions() {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Plain client for rate limiting, webhook replay protection, heartbeats and mirrored deploy logs. */
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

// ---------------- per-server queues ----------------
// Every server's agent works on its own pair of queues. The main server keeps the plain names
// ("hostpanel-agent", "hostpanel-agent-fast"); joined servers use "<name>-<serverId>".

interface ServerQueues {
  jobs: Queue;
  fast: Queue;
  events: QueueEvents | null;
  fastEvents: QueueEvents | null;
}
const queues = new Map<string, ServerQueues>();

export function queuesFor(suffix: string): ServerQueues {
  let q = queues.get(suffix);
  if (!q) {
    const names = queueNames(suffix);
    q = {
      jobs: new Queue(names.jobs, {
        connection: redisOptions(),
        defaultJobOptions: { attempts: 1, removeOnComplete: { age: 7 * 86400, count: 5000 }, removeOnFail: { age: 30 * 86400 } },
      }),
      fast: new Queue(names.fast, {
        connection: redisOptions(),
        defaultJobOptions: { attempts: 1, removeOnComplete: { age: 30 }, removeOnFail: { age: 300 } },
      }),
      events: null,
      fastEvents: null,
    };
    queues.set(suffix, q);
  }
  return q;
}

export function eventsFor(suffix: string): QueueEvents {
  const q = queuesFor(suffix);
  q.events ??= new QueueEvents(queueNames(suffix).jobs, { connection: redisOptions() });
  return q.events;
}

/** The main server's queue (kept for code that is main-server only). */
export const agentQueue = queuesFor("").jobs;
export const queueEvents = () => eventsFor("");

const suffixCache = new Map<string, string>();
/** Queue suffix for a server id; null/undefined → main server. */
export async function serverSuffix(serverId?: string | null): Promise<string> {
  if (!serverId) return "";
  const cached = suffixCache.get(serverId);
  if (cached !== undefined) return cached;
  const s = await db.query.servers.findFirst({ where: eq(schema.servers.id, serverId), columns: { queueSuffix: true } });
  if (!s) throw new HttpError(404, "Server not found", "not_found");
  suffixCache.set(serverId, s.queueSuffix);
  return s.queueSuffix;
}

const accountServer = new Map<string, string>();
/**
 * Most jobs concern one hosting account and carry its Linux user (directly or inside `site`).
 * That identifies the account, and so the server the job must run on.
 */
async function inferServer(data: unknown): Promise<string | null> {
  const d = data as { linuxUser?: string; site?: { linuxUser?: string } };
  const linuxUser = d?.linuxUser ?? d?.site?.linuxUser;
  if (!linuxUser) return null;
  const cached = accountServer.get(linuxUser);
  if (cached) return cached;
  const acc = await db.query.accounts.findFirst({ where: eq(schema.accounts.linuxUser, linuxUser), columns: { serverId: true } });
  if (!acc) return null;
  accountServer.set(linuxUser, acc.serverId);
  return acc.serverId;
}

export interface EnqueueOpts {
  targetType?: string;
  targetId?: string;
  createdBy?: string;
  /**
   * Debounce full-state syncs (routes.sync, mail.sync): a burst of changes runs once with the
   * latest payload, and a change made while one is running queues exactly one follow-up.
   */
  dedupeKey?: string;
  /** Strip secrets from the copy of the payload kept in Redis after completion. */
  sensitive?: boolean;
  /** Which server's agent runs the job (default: the account's server, else the main server). */
  serverId?: string | null;
}

/** Queue a job for a server's root agent and record it in the jobs table. Returns the job id. */
export async function enqueue<T extends JobType>(type: T, data: JobPayloads[T], opts: EnqueueOpts = {}): Promise<string> {
  const suffix = await serverSuffix(opts.serverId !== undefined ? opts.serverId : await inferServer(data));
  const job = await queuesFor(suffix).jobs.add(type, data, {
    // Unique ids: BullMQ's counter restarts if Redis is ever flushed, which would collide with old rows.
    jobId: newId(),
    ...(opts.dedupeKey
      ? { delay: 300, deduplication: { id: `${opts.dedupeKey}${suffix}`, ttl: 300, extend: true, replace: true, keepLastIfActive: true } }
      : {}),
    ...(opts.sensitive ? { removeOnComplete: true, removeOnFail: { age: 3600 } } : {}),
  });
  const id = String(job.id);
  await db
    .insert(schema.jobs)
    .values({ id, type, targetType: opts.targetType, targetId: opts.targetId, createdBy: opts.createdBy })
    .onConflictDoNothing();
  return id;
}

/** Interactive jobs: the API waits for the answer (file manager, logs, usage). */
export async function runFast<T extends JobType>(type: T, data: JobPayloads[T], timeoutMs = 20_000, serverId?: string | null): Promise<unknown> {
  const suffix = await serverSuffix(serverId !== undefined ? serverId : await inferServer(data));
  const q = queuesFor(suffix);
  q.fastEvents ??= new QueueEvents(queueNames(suffix).fast, { connection: redisOptions() });
  await q.fastEvents.waitUntilReady();
  const job = await q.fast.add(type, data, { jobId: newId() });
  try {
    return await job.waitUntilFinished(q.fastEvents, timeoutMs);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/timed out|Job wait/i.test(msg)) throw new HttpError(504, "The server agent did not answer in time. Is hostpanel-agent running on that server?", "agent_timeout");
    // Agent errors are meant for the user (e.g. "Not found: foo.txt")
    throw new HttpError(400, msg.replace(/^Error: /, ""), "agent_error");
  }
}
