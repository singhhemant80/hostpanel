import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { AGENT_QUEUE, FAST_QUEUE, type JobPayloads, type JobType } from "@hostpanel/shared";
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

/** Plain client for rate limiting and webhook replay protection. */
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });

export const agentQueue = new Queue(AGENT_QUEUE, {
  connection: redisOptions(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { age: 7 * 86400, count: 5000 },
    removeOnFail: { age: 30 * 86400 },
  },
});

let events: QueueEvents | null = null;
export function queueEvents(): QueueEvents {
  if (!events) events = new QueueEvents(AGENT_QUEUE, { connection: redisOptions() });
  return events;
}

export interface EnqueueOpts {
  targetType?: string;
  targetId?: string;
  createdBy?: string;
  /** Jobs with the same key replace a still-waiting job of that key (used for routes.sync). */
  dedupeKey?: string;
  /** Strip secrets from the copy of the payload kept in Redis after completion. */
  sensitive?: boolean;
}

/** Queue a job for the root agent and record it in the jobs table. Returns the job id. */
export async function enqueue<T extends JobType>(type: T, data: JobPayloads[T], opts: EnqueueOpts = {}): Promise<string> {
  const job = await agentQueue.add(type, data, {
    // Unique ids: BullMQ's counter restarts if Redis is ever flushed, which would collide with old rows.
    jobId: newId(),
    ...(opts.dedupeKey ? { deduplication: { id: opts.dedupeKey } } : {}),
    ...(opts.sensitive ? { removeOnComplete: true, removeOnFail: { age: 3600 } } : {}),
  });
  const id = String(job.id);
  await db
    .insert(schema.jobs)
    .values({ id, type, targetType: opts.targetType, targetId: opts.targetId, createdBy: opts.createdBy })
    .onConflictDoNothing();
  return id;
}

/** Interactive queue: the API waits for the answer (file manager, logs, usage). */
export const fastQueue = new Queue(FAST_QUEUE, {
  connection: redisOptions(),
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: 30 }, removeOnFail: { age: 300 } },
});
let fastEvents: QueueEvents | null = null;

export async function runFast<T extends JobType>(type: T, data: JobPayloads[T], timeoutMs = 20_000): Promise<unknown> {
  fastEvents ??= new QueueEvents(FAST_QUEUE, { connection: redisOptions() });
  await fastEvents.waitUntilReady();
  const job = await fastQueue.add(type, data, { jobId: newId() });
  try {
    return await job.waitUntilFinished(fastEvents, timeoutMs);
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/timed out|Job wait/i.test(msg)) throw new HttpError(504, "The server agent did not answer in time. Is hostpanel-agent running?", "agent_timeout");
    // Agent errors are meant for the user (e.g. "Not found: foo.txt")
    throw new HttpError(400, msg.replace(/^Error: /, ""), "agent_error");
  }
}
