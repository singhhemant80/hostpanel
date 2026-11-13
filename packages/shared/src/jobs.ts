import type { Runtime } from "./runtimes.js";

/**
 * The ONLY operations the root agent will perform. The API queues these on the
 * "agent" BullMQ queue; the agent validates every payload before acting.
 */
export const JOB_TYPES = [
  "account.create",
  "account.suspend",
  "account.delete",
  "site.provision",
  "site.remove",
  "site.control",
  "site.deploy",
  "site.rollback",
  "routes.sync",
  "db.create",
  "db.delete",
  "system.stats",
  // phase 2
  "cron.sync",
  "cron.run",
  "backup.run",
  "backup.restore",
  "backup.delete",
  "access.sync",
  // fast queue (answered within seconds, the API waits for the result)
  "fs.list",
  "fs.read",
  "fs.write",
  "fs.mkdir",
  "fs.rename",
  "fs.delete",
  "fs.chmod",
  "fs.upload",
  "fs.download",
  "fs.extract",
  "fs.compress",
  "logs.read",
  "stats.account",
  // phase 3
  "mail.sync",
  "mail.dkim",
  "mail.purge",
  "mail.usage",
  "app.install",
  "server.addPeer",
  "server.removePeer",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const AGENT_QUEUE = "hostpanel-agent";
/** Short interactive jobs (file manager, logs, usage) so they never wait behind a long build. */
export const FAST_QUEUE = "hostpanel-agent-fast";
export const FAST_JOB_PREFIXES = ["fs.", "logs.", "stats.", "cron.run", "mail.usage", "mail.dkim"];
/** Queue names for a server: the main server keeps the plain names, others get "-<serverId>". */
export function queueNames(serverSuffix: string): { jobs: string; fast: string } {
  return { jobs: `${AGENT_QUEUE}${serverSuffix}`, fast: `${FAST_QUEUE}${serverSuffix}` };
}
export const heartbeatKey = (serverSuffix: string) => `hp:heartbeat${serverSuffix || "-main"}`;

export function isFastJob(type: string): boolean {
  return FAST_JOB_PREFIXES.some((p) => type.startsWith(p));
}

export interface EncryptedEnvVar {
  key: string;
  /** AES-256-GCM, "iv.tag.ciphertext" base64 parts; the agent decrypts with APP_ENCRYPTION_KEY. */
  valueEnc: string;
}

export interface SiteSpec {
  id: string;
  name: string;
  linuxUser: string;
  runtime: Runtime;
  runtimeVersion: string;
  rootDir: string;
  publicDir: string;
  buildCmd: string;
  startCmd: string;
  port: number | null;
  instances: number;
  healthPath: string;
  /** Background worker: runs under systemd like a web app but gets no domain or HTTP health check. */
  background: boolean;
  env: EncryptedEnvVar[];
}

export type RouteKind = "php" | "proxy" | "static" | "redirect";

/** Path-based routing on one domain, e.g. /api/* → the API site's port. Checked before the default. */
export interface PathRoute {
  path: string;
  port: number;
  instances: number;
}

export interface RouteSpec {
  hostname: string;
  kind: RouteKind;
  siteName: string;
  linuxUser: string;
  phpVersion?: string;
  port?: number;
  instances?: number;
  /** Absolute document root for php/static routes. */
  root?: string;
  redirectTo?: string;
  redirectCode?: 301 | 302;
  paths?: PathRoute[];
  /** Custom certificate (encrypted PEM), or "dns" to issue via the DNS provider (wildcards). */
  tls?: { certEnc: string; keyEnc: string } | "dns";
}

export interface CronSpec {
  id: string;
  /** systemd OnCalendar expression (converted from cron syntax by the API). */
  onCalendar: string;
  command: string;
  enabled: boolean;
}

/** S3-compatible remote (AWS S3, Backblaze B2, Cloudflare R2, Wasabi, MinIO) for off-server backups. */
export interface RemoteSpec {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyEnc: string;
  secretKeyEnc: string;
}

export interface BackupContents {
  sites: string[];
  databases: { engine: "mariadb" | "postgres"; name: string }[];
}

export interface FileEntry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mtime: number;
  mode: string;
}

export interface JobPayloads {
  "account.create": { linuxUser: string; cpuPercent: number; ramMb: number; diskMb: number };
  "account.suspend": { linuxUser: string; suspended: boolean; siteNames: string[] };
  "account.delete": { linuxUser: string };
  "site.provision": { site: SiteSpec };
  "site.remove": { site: SiteSpec };
  "site.control": { site: SiteSpec; action: "start" | "stop" | "restart" };
  "site.deploy": {
    site: SiteSpec;
    deploymentId: string;
    repoFullName: string | null;
    branch: string;
    commitSha: string | null;
    /** Short-lived GitHub App installation token (1 hour), null for public repos. */
    gitToken: string | null;
    keepReleases: number;
  };
  "site.rollback": { site: SiteSpec; deploymentId: string; releaseName: string };
  "routes.sync": {
    routes: RouteSpec[];
    panelHostname: string | null;
    acmeEmail: string | null;
    /** Encrypted Cloudflare token, needed only for wildcard (DNS-01) certificates. */
    dnsTokenEnc: string | null;
  };
  "db.create": { engine: "mariadb" | "postgres"; name: string; user: string; passwordEnc: string };
  "db.delete": { engine: "mariadb" | "postgres"; name: string; user: string };
  "system.stats": Record<string, never>;
  "cron.sync": { site: SiteSpec; jobs: CronSpec[] };
  "cron.run": { site: SiteSpec; jobId: string };
  "backup.run": {
    backupId: string;
    linuxUser: string;
    contents: BackupContents;
    remote: RemoteSpec | null;
    keepLocal: number;
  };
  "backup.restore": {
    backupId: string;
    linuxUser: string;
    fileName: string;
    remote: RemoteSpec | null;
    sites: { name: string; spec: SiteSpec | null }[];
    databases: { engine: "mariadb" | "postgres"; name: string; user: string }[];
  };
  "backup.delete": { linuxUser: string; fileName: string; remote: RemoteSpec | null };
  "access.sync": {
    linuxUser: string;
    sftp: boolean;
    shell: boolean;
    /** New password (encrypted) or null to keep the current one. */
    passwordEnc: string | null;
    sshKeys: string[];
  };
  "fs.list": { linuxUser: string; path: string };
  /** maxBytes: up to 25 MB for downloads from servers other than the main one (default 2 MB for the editor). */
  "fs.read": { linuxUser: string; path: string; maxBytes?: number };
  "fs.write": { linuxUser: string; path: string; contentB64: string };
  "fs.mkdir": { linuxUser: string; path: string };
  "fs.rename": { linuxUser: string; from: string; to: string };
  "fs.delete": { linuxUser: string; paths: string[] };
  "fs.chmod": { linuxUser: string; path: string; mode: string };
  /** Moves a file the API staged in the uploads folder into the customer's home. */
  "fs.upload": { linuxUser: string; staged: string; path: string };
  /** Copies a customer file to the downloads folder so the API can stream it. */
  "fs.download": { linuxUser: string; path: string; token: string };
  "fs.extract": { linuxUser: string; path: string; into: string };
  "fs.compress": { linuxUser: string; paths: string[]; to: string };
  "logs.read": { linuxUser: string; siteName: string; log: "access" | "app" | "php-error" | "cron"; bytes: number };
  "stats.account": { linuxUser: string; units: string[] };
  /** Full desired mail state of the server (idempotent, like routes.sync). */
  "mail.sync": { domains: MailDomainSpec[]; mailboxes: MailboxSpec[]; aliases: MailAliasSpec[]; mailHost: string };
  /** Create (if missing) the DKIM key for a domain and return its public DNS record. */
  "mail.dkim": { domain: string; selector: string };
  /** Delete a mailbox's stored mail (after it was removed from mail.sync). */
  "mail.purge": { address: string };
  "mail.usage": { addresses: string[] };
  "app.install": {
    site: SiteSpec;
    template: AppTemplate;
    domain: string;
    deploymentId: string;
    db: { engine: "mariadb" | "postgres"; name: string; user: string; passwordEnc: string } | null;
    admin: { user: string; email: string; passwordEnc: string } | null;
  };
  /** Main server: allow a new server into the private WireGuard network. */
  "server.addPeer": { publicKey: string; address: string };
  "server.removePeer": { publicKey: string };
}

// ---------------- email ----------------
export interface MailDomainSpec {
  name: string;
  /** Address (or comma list) that receives mail for unknown local parts, or null. */
  catchAll: string | null;
}
export interface MailboxSpec {
  address: string;
  /** bcrypt hash ({BLF-CRYPT} for Dovecot); the plain password never leaves the API. */
  passwordHash: string;
  quotaMb: number;
  enabled: boolean;
}
export interface MailAliasSpec {
  source: string;
  destinations: string[];
}

// ---------------- one-click apps ----------------
export const APP_TEMPLATES = ["wordpress", "laravel", "nextjs", "django"] as const;
export type AppTemplate = (typeof APP_TEMPLATES)[number];

export interface AccountUsage {
  diskBytes: number | null;
  memoryBytes: number | null;
  cpuSeconds: number | null;
  tasks: number | null;
  units: { unit: string; active: string; memoryBytes: number | null; cpuSeconds: number | null; since: string | null }[];
}

export interface DeployResult {
  releaseName: string;
  commitSha: string;
  commitMessage: string;
  rolledBack: boolean;
}

export interface SystemStats {
  hostname: string;
  uptimeSec: number;
  load: [number, number, number];
  memTotalMb: number;
  memFreeMb: number;
  diskTotalGb: number;
  diskFreeGb: number;
  cpus: number;
}

/** Folder layout on the server, shared by API (for display) and agent (for work). */
export const paths = {
  home: (linuxUser: string) => `/home/${linuxUser}`,
  site: (linuxUser: string, site: string) => `/home/${linuxUser}/sites/${site}`,
  releases: (linuxUser: string, site: string) => `/home/${linuxUser}/sites/${site}/releases`,
  current: (linuxUser: string, site: string) => `/home/${linuxUser}/sites/${site}/current`,
  shared: (linuxUser: string, site: string) => `/home/${linuxUser}/sites/${site}/shared`,
  logs: (linuxUser: string, site: string) => `/home/${linuxUser}/sites/${site}/logs`,
  deployLog: (deploymentId: string) => `/var/log/hostpanel/deploys/${deploymentId}.log`,
  backups: (linuxUser: string) => `/var/backups/hostpanel/${linuxUser}`,
  /** Staging folders shared by API (user hostpanel) and agent for uploads/downloads. */
  uploads: "/var/lib/hostpanel/uploads",
  downloads: "/var/lib/hostpanel/downloads",
  terminalSocket: "/run/hostpanel/terminal.sock",
};

export function linuxUserFor(username: string): string {
  return `hp_${username.replace(/-/g, "_")}`;
}
