import { Redis } from "ioredis";
import { env } from "./env.js";

let client: Redis | null = null;
/** Shared Redis client (deploy-log mirror, heartbeat). BullMQ workers keep their own connections. */
export function redis(): Redis {
  client ??= new Redis(env.redisUrl, { maxRetriesPerRequest: 3, lazyConnect: false });
  client.on("error", () => undefined); // reported per command; never crash the agent
  return client;
}
