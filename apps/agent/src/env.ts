import "dotenv/config";
import { createDecipheriv } from "node:crypto";
import { join } from "node:path";

const isProd = process.env.NODE_ENV === "production";

export const env = {
  /** Log every privileged action and write files under DRY_ROOT instead of touching the real system. */
  dryRun: process.env.AGENT_DRY_RUN === "true",
  dryRoot: process.env.AGENT_DRY_ROOT ?? "/tmp/hostpanel-dry",
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  encryptionKey: process.env.APP_ENCRYPTION_KEY || (isProd ? "" : "0".repeat(64)),
  concurrency: parseInt(process.env.AGENT_CONCURRENCY ?? "2", 10),
  caddyAdmin: process.env.CADDY_ADMIN ?? "http://127.0.0.1:2019",
  caddyfile: process.env.CADDYFILE ?? "/etc/caddy/Caddyfile",
  panelUpstream: process.env.PANEL_UPSTREAM ?? "127.0.0.1:4100",
  runtimesDir: process.env.RUNTIMES_DIR ?? "/opt/hostpanel-runtimes",
  buildTimeoutSec: parseInt(process.env.BUILD_TIMEOUT_SEC ?? "900", 10),
  /** Group the panel API runs as; deploy logs are readable by it. */
  panelGroup: process.env.PANEL_GROUP ?? "hostpanel",
  webUser: process.env.WEB_USER ?? "caddy",
};

if (!env.encryptionKey) throw new Error("APP_ENCRYPTION_KEY is required (same value as the API)");

/** Maps a real system path into the dry-run sandbox when AGENT_DRY_RUN=true. */
export function sys(path: string): string {
  return env.dryRun ? join(env.dryRoot, path) : path;
}

export function decrypt(enc: string): string {
  const raw = env.encryptionKey.trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  const [iv, tag, ct] = enc.split(".");
  if (!iv || !tag || ct === undefined) throw new Error("Malformed encrypted value");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
