import { randomBytes } from "node:crypto";
import { relations } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Short sortable-enough random ids (base36 time + 10 random bytes). */
export function newId(): string {
  return Date.now().toString(36) + randomBytes(10).toString("hex");
}

const id = () => text("id").primaryKey().$defaultFn(newId);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum("role", ["admin", "reseller", "user"]);
export const statusEnum = pgEnum("status", ["pending", "active", "suspended", "failed", "deleting"]);
export type Role = (typeof roleEnum.enumValues)[number];
export type Status = (typeof statusEnum.enumValues)[number];

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull().default("user"),
  locale: text("locale").notNull().default("en"),
  totpSecret: text("totp_secret"), // encrypted
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  status: statusEnum("status").notNull().default("active"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
});

export const packages = pgTable("packages", {
  id: id(),
  name: text("name").notNull().unique(),
  diskMb: integer("disk_mb").notNull(),
  bandwidthGb: integer("bandwidth_gb").notNull(),
  maxSites: integer("max_sites").notNull(),
  maxDomains: integer("max_domains").notNull(),
  maxDatabases: integer("max_databases").notNull(),
  cpuPercent: integer("cpu_percent").notNull(),
  ramMb: integer("ram_mb").notNull(),
  maxMailboxes: integer("max_mailboxes").notNull().default(10),
  createdAt: createdAt(),
});

export const servers = pgTable("servers", {
  id: id(),
  name: text("name").notNull().default("Main server"),
  hostname: text("hostname").notNull().unique(),
  ipv4: text("ipv4"),
  ipv6: text("ipv6"),
  status: statusEnum("status").notNull().default("active"),
  /** The server the panel runs on: it keeps the plain queue names and runs mail + the web terminal. */
  isMain: boolean("is_main").notNull().default(false),
  /** "" for the main server, "-<id>" for joined servers (BullMQ queue names). */
  queueSuffix: text("queue_suffix").notNull().default(""),
  wgPublicKey: text("wg_public_key"),
  wgAddress: text("wg_address"),
  joinTokenHash: text("join_token_hash"),
  joinExpiresAt: timestamp("join_expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const accounts = pgTable("accounts", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  packageId: text("package_id").notNull().references(() => packages.id),
  serverId: text("server_id").notNull().references(() => servers.id),
  username: text("username").notNull().unique(),
  /** Reseller who owns this customer account (null = created by an admin). */
  resellerId: text("reseller_id").references(() => users.id, { onDelete: "set null" }),
  linuxUser: text("linux_user").notNull().unique(),
  status: statusEnum("status").notNull().default("pending"),
  createdAt: createdAt(),
});

export const sites = pgTable(
  "sites",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    runtime: text("runtime").notNull(), // php | node | python | static
    runtimeVersion: text("runtime_version").notNull(),
    rootDir: text("root_dir").notNull().default(""),
    publicDir: text("public_dir").notNull().default(""),
    buildCmd: text("build_cmd").notNull().default(""),
    startCmd: text("start_cmd").notNull().default(""),
    port: integer("port").unique(),
    instances: integer("instances").notNull().default(1),
    healthPath: text("health_path").notNull().default("/"),
    background: boolean("background").notNull().default(false),
    status: statusEnum("status").notNull().default("pending"),
    running: boolean("running").notNull().default(false),
    currentRelease: text("current_release"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("sites_account_name").on(t.accountId, t.name)],
);

export const domains = pgTable("domains", {
  id: id(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull().unique(),
  type: text("type").notNull(), // primary | addon | subdomain | alias | redirect
  redirectTo: text("redirect_to"),
  redirectCode: integer("redirect_code"),
  /** [{ path: "/api/*", siteId }] — sent to another site of the same account before the default site. */
  pathRules: jsonb("path_rules").$type<{ path: string; siteId: string }[]>().notNull().default([]),
  sslStatus: text("ssl_status").notNull().default("pending"), // pending | active | custom | dns
  /** Uploaded certificate and key (encrypted PEM). */
  certEnc: text("cert_enc"),
  keyEnc: text("key_enc"),
  certExpiresAt: timestamp("cert_expires_at", { withTimezone: true }),
  dnsOk: boolean("dns_ok").notNull().default(false),
  status: statusEnum("status").notNull().default("pending"),
  createdAt: createdAt(),
});

export const siteEnv = pgTable(
  "site_env",
  {
    id: id(),
    siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
  },
  (t) => [uniqueIndex("site_env_site_key").on(t.siteId, t.key)],
);

export const gitSources = pgTable(
  "git_sources",
  {
    id: id(),
    siteId: text("site_id").notNull().unique().references(() => sites.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("github"),
    repoFullName: text("repo_full_name").notNull(),
    branch: text("branch").notNull().default("main"),
    installationId: integer("installation_id"),
    autoDeploy: boolean("auto_deploy").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("git_sources_repo_branch").on(t.repoFullName, t.branch)],
);

export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(), // push | manual | rollback | upload
    commitSha: text("commit_sha"),
    commitMessage: text("commit_message"),
    author: text("author"),
    status: text("status").notNull().default("queued"), // queued | building | live | failed | rolled_back | superseded
    releaseName: text("release_name"),
    error: text("error"),
    jobId: text("job_id"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("deployments_site_created").on(t.siteId, t.createdAt)],
);

export const databases = pgTable("databases", {
  id: id(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  engine: text("engine").notNull(), // mariadb | postgres
  name: text("name").notNull().unique(),
  dbUser: text("db_user").notNull(),
  passwordEnc: text("password_enc").notNull(),
  status: statusEnum("status").notNull().default("pending"),
  createdAt: createdAt(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(), // BullMQ job id
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    message: text("message"),
    error: text("error"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_target").on(t.targetType, t.targetId)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    meta: jsonb("meta"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_created").on(t.createdAt)],
);

export const cronJobs = pgTable("cron_jobs", {
  id: id(),
  siteId: text("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  schedule: text("schedule").notNull(), // cron syntax as typed
  command: text("command").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const backups = pgTable(
  "backups",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(), // scheduled | manual
    status: text("status").notNull().default("queued"), // queued | running | done | failed | restoring | deleting
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    remote: boolean("remote").notNull().default(false),
    contents: jsonb("contents").$type<{ sites: string[]; databases: { engine: "mariadb" | "postgres"; name: string }[] }>(),
    error: text("error"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("backups_account_created").on(t.accountId, t.createdAt)],
);

/** Server-wide settings. Secret values are stored encrypted (key ends in "Enc"). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const dnsZones = pgTable("dns_zones", {
  id: id(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  provider: text("provider").notNull(), // cloudflare
  providerZoneId: text("provider_zone_id").notNull(),
  nameservers: jsonb("nameservers").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("pending"),
  createdAt: createdAt(),
});

/** SFTP / SSH access for an account's Linux user. */
export const accountAccess = pgTable("account_access", {
  accountId: text("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  sftp: boolean("sftp").notNull().default(false),
  shell: boolean("shell").notNull().default(false),
  passwordSet: boolean("password_set").notNull().default(false),
  sshKeys: jsonb("ssh_keys").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

/** Limits for users with role "reseller". */
export const resellerLimits = pgTable("reseller_limits", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  maxAccounts: integer("max_accounts").notNull(),
  maxDiskMb: integer("max_disk_mb").notNull(),
  packageIds: jsonb("package_ids").$type<string[]>().notNull().default([]),
});

export const mailDomains = pgTable("mail_domains", {
  id: id(),
  accountId: text("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  name: text("name").notNull().unique(),
  catchAll: text("catch_all"),
  dkimRecord: text("dkim_record"),
  createdAt: createdAt(),
});

export const mailboxes = pgTable("mailboxes", {
  id: id(),
  domainId: text("domain_id").notNull().references(() => mailDomains.id, { onDelete: "cascade" }),
  address: text("address").notNull().unique(),
  passwordHash: text("password_hash").notNull(), // bcrypt
  quotaMb: integer("quota_mb").notNull().default(1024),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export const mailAliases = pgTable("mail_aliases", {
  id: id(),
  domainId: text("domain_id").notNull().references(() => mailDomains.id, { onDelete: "cascade" }),
  source: text("source").notNull().unique(),
  destinations: jsonb("destinations").$type<string[]>().notNull(),
  createdAt: createdAt(),
});

// ---- relations (for db.query.*.findMany({ with: ... })) ----
export const usersRelations = relations(users, ({ many, one }) => ({
  accounts: many(accounts, { relationName: "owner" }),
  resoldAccounts: many(accounts, { relationName: "reseller" }),
  sessions: many(sessions),
  resellerLimits: one(resellerLimits, { fields: [users.id], references: [resellerLimits.userId] }),
}));
export const sessionsRelations = relations(sessions, ({ one }) => ({ user: one(users, { fields: [sessions.userId], references: [users.id] }) }));
export const packagesRelations = relations(packages, ({ many }) => ({ accounts: many(accounts) }));
export const accountsRelations = relations(accounts, ({ one, many }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id], relationName: "owner" }),
  package: one(packages, { fields: [accounts.packageId], references: [packages.id] }),
  server: one(servers, { fields: [accounts.serverId], references: [servers.id] }),
  sites: many(sites),
  domains: many(domains),
  databases: many(databases),
  backups: many(backups),
  dnsZones: many(dnsZones),
  access: one(accountAccess, { fields: [accounts.id], references: [accountAccess.accountId] }),
  mailDomains: many(mailDomains),
  reseller: one(users, { fields: [accounts.resellerId], references: [users.id], relationName: "reseller" }),
}));
export const mailDomainsRelations = relations(mailDomains, ({ one, many }) => ({
  account: one(accounts, { fields: [mailDomains.accountId], references: [accounts.id] }),
  mailboxes: many(mailboxes),
  aliases: many(mailAliases),
}));
export const mailboxesRelations = relations(mailboxes, ({ one }) => ({ domain: one(mailDomains, { fields: [mailboxes.domainId], references: [mailDomains.id] }) }));
export const mailAliasesRelations = relations(mailAliases, ({ one }) => ({ domain: one(mailDomains, { fields: [mailAliases.domainId], references: [mailDomains.id] }) }));
export const resellerLimitsRelations = relations(resellerLimits, ({ one }) => ({ user: one(users, { fields: [resellerLimits.userId], references: [users.id] }) }));
export const serversRelations = relations(servers, ({ many }) => ({ accounts: many(accounts) }));
export const sitesRelations = relations(sites, ({ one, many }) => ({
  account: one(accounts, { fields: [sites.accountId], references: [accounts.id] }),
  domains: many(domains),
  env: many(siteEnv),
  git: one(gitSources, { fields: [sites.id], references: [gitSources.siteId] }),
  deployments: many(deployments),
  cronJobs: many(cronJobs),
}));
export const cronJobsRelations = relations(cronJobs, ({ one }) => ({ site: one(sites, { fields: [cronJobs.siteId], references: [sites.id] }) }));
export const backupsRelations = relations(backups, ({ one }) => ({ account: one(accounts, { fields: [backups.accountId], references: [accounts.id] }) }));
export const dnsZonesRelations = relations(dnsZones, ({ one }) => ({ account: one(accounts, { fields: [dnsZones.accountId], references: [accounts.id] }) }));
export const accountAccessRelations = relations(accountAccess, ({ one }) => ({ account: one(accounts, { fields: [accountAccess.accountId], references: [accounts.id] }) }));
export const domainsRelations = relations(domains, ({ one }) => ({
  account: one(accounts, { fields: [domains.accountId], references: [accounts.id] }),
  site: one(sites, { fields: [domains.siteId], references: [sites.id] }),
}));
export const siteEnvRelations = relations(siteEnv, ({ one }) => ({ site: one(sites, { fields: [siteEnv.siteId], references: [sites.id] }) }));
export const gitSourcesRelations = relations(gitSources, ({ one }) => ({ site: one(sites, { fields: [gitSources.siteId], references: [sites.id] }) }));
export const deploymentsRelations = relations(deployments, ({ one }) => ({ site: one(sites, { fields: [deployments.siteId], references: [sites.id] }) }));
export const databasesRelations = relations(databases, ({ one }) => ({ account: one(accounts, { fields: [databases.accountId], references: [accounts.id] }) }));
export const auditLogRelations = relations(auditLog, ({ one }) => ({ user: one(users, { fields: [auditLog.userId], references: [users.id] }) }));

export type User = typeof users.$inferSelect;
export type Account = typeof accounts.$inferSelect;
export type Package = typeof packages.$inferSelect;
export type Site = typeof sites.$inferSelect;
export type Domain = typeof domains.$inferSelect;
export type SiteEnv = typeof siteEnv.$inferSelect;
export type GitSource = typeof gitSources.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type Database = typeof databases.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type CronJob = typeof cronJobs.$inferSelect;
export type Backup = typeof backups.$inferSelect;
export type DnsZone = typeof dnsZones.$inferSelect;
export type Server = typeof servers.$inferSelect;
export type MailDomain = typeof mailDomains.$inferSelect;
