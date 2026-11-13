import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";

const isProd = process.env.NODE_ENV === "production";

function req(name: string, devFallback?: string): string {
  const v = process.env[name] || (isProd ? undefined : devFallback);
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function readKey(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export const config = {
  isProd,
  host: process.env.API_HOST ?? "127.0.0.1",
  port: parseInt(process.env.API_PORT ?? "4100", 10),
  panelUrl: (process.env.PANEL_URL ?? "http://localhost:5173").replace(/\/$/, ""),
  panelHostname: process.env.PANEL_HOSTNAME || null,
  acmeEmail: process.env.ACME_EMAIL || null,
  databaseUrl: req("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  jwtSecret: req("JWT_SECRET", "dev-only-jwt-secret-dev-only-jwt-secret-0000"),
  encryptionKey: req("APP_ENCRYPTION_KEY", "0".repeat(64)),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlDays: 30,
  serverIpv4: process.env.SERVER_IPV4 || null,
  serverIpv6: process.env.SERVER_IPV6 || null,
  github: {
    appId: process.env.GITHUB_APP_ID || null,
    appSlug: process.env.GITHUB_APP_SLUG || null,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || null,
    privateKey: readKey(process.env.GITHUB_APP_PRIVATE_KEY_PATH),
  },
  webDist: process.env.WEB_DIST || null,
  provisioningApiKey: process.env.PROVISIONING_API_KEY || null,
  keepReleases: 5,
  /** Development only: where a dry-run agent writes files (so the log viewer can read deploy logs). */
  devSandboxRoot: isProd ? "" : (process.env.AGENT_DRY_ROOT ?? ""),
};
