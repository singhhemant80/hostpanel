import { z } from "zod";
import { RUNTIMES } from "./runtimes.js";
import { isValidCron } from "./cron.js";

/** RFC 1123 hostname, lower case, optional leading "*." for wildcards. */
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, "Not a valid domain name");

/** Linux-safe slug used for user names, site names and database names. */
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(24)
  .regex(/^[a-z][a-z0-9_-]*$/, "Use lower-case letters, digits, - or _ and start with a letter");

export const envKeySchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid variable name").max(128);

/** Relative path inside a repo or home folder: no "..", no absolute paths. */
export const relPathSchema = z
  .string()
  .trim()
  .max(255)
  .refine((p) => p === "" || (!p.startsWith("/") && !p.split("/").includes("..")), "Must be a relative path without ..");

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const packageSchema = z.object({
  name: z.string().min(1).max(64),
  diskMb: z.number().int().min(100),
  bandwidthGb: z.number().int().min(1),
  maxSites: z.number().int().min(1),
  maxDomains: z.number().int().min(1),
  maxDatabases: z.number().int().min(0),
  cpuPercent: z.number().int().min(10).max(6400),
  ramMb: z.number().int().min(128),
});

export const createAccountSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10),
  name: z.string().min(1).max(100),
  username: slugSchema,
  packageId: z.string().min(1),
  locale: z.enum(["en", "hi"]).default("en"),
});

export const createSiteSchema = z.object({
  accountId: z.string().min(1).optional(),
  name: slugSchema,
  runtime: z.enum(RUNTIMES),
  runtimeVersion: z.string().min(1).max(10),
  /** Required except for background workers. */
  primaryDomain: hostnameSchema.optional(),
  rootDir: relPathSchema.default(""),
  publicDir: relPathSchema.optional(),
  buildCmd: z.string().max(1000).optional(),
  startCmd: z.string().max(1000).optional(),
  healthPath: z.string().startsWith("/").max(255).default("/"),
  instances: z.number().int().min(1).max(8).default(1),
  background: z.boolean().default(false),
});

export const updateSiteSchema = createSiteSchema
  .omit({ accountId: true, name: true, primaryDomain: true })
  .partial();

export const DOMAIN_TYPES = ["primary", "addon", "subdomain", "alias", "redirect"] as const;

export const addDomainSchema = z.object({
  hostname: hostnameSchema,
  siteId: z.string().min(1),
  type: z.enum(DOMAIN_TYPES).default("alias"),
  redirectTo: z.string().url().optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).default(301),
});

/** "/api/*" style prefixes: letters, digits, - _ . / and a trailing * */
export const pathRulesSchema = z.object({
  rules: z
    .array(
      z.object({
        path: z.string().regex(/^\/[A-Za-z0-9._\-\/]*\*?$/, "Use a path like /api/* or /client*"),
        siteId: z.string().min(1),
      }),
    )
    .max(20),
});

export const envVarsSchema = z.object({
  vars: z.array(z.object({ key: envKeySchema, value: z.string().max(16_384) })).max(200),
});

export const connectGitSchema = z.object({
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Use owner/repo"),
  branch: z.string().min(1).max(255).default("main"),
  installationId: z.number().int().positive().optional(),
  autoDeploy: z.boolean().default(true),
});

export const createDatabaseSchema = z.object({
  accountId: z.string().min(1).optional(),
  engine: z.enum(["mariadb", "postgres"]),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, "Lower-case letters, digits and _ only"),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type PackageInput = z.infer<typeof packageSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type CreateSiteInput = z.infer<typeof createSiteSchema>;
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;
export type AddDomainInput = z.infer<typeof addDomainSchema>;
export type PathRulesInput = z.infer<typeof pathRulesSchema>;
export type ConnectGitInput = z.infer<typeof connectGitSchema>;
export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;

// ---------------- phase 2 ----------------

export const cronJobSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().min(1).max(80),
  schedule: z.string().max(100).refine(isValidCron, "Not a valid cron schedule (5 fields, e.g. */15 * * * *)"),
  command: z.string().min(1).max(2000),
  enabled: z.boolean().default(true),
});
export const updateCronJobSchema = cronJobSchema.omit({ siteId: true }).partial();

/** Paths in the file manager are relative to the account home and may not climb out of it. */
export const homePathSchema = z
  .string()
  .max(1024)
  .transform((p) => p.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""))
  .refine((p) => !p.split("/").includes("..") && !p.includes("\0"), "Invalid path");

export const accessSchema = z.object({
  sftp: z.boolean(),
  shell: z.boolean(),
  password: z.string().min(12).max(128).optional(),
  sshKeys: z
    .array(z.string().trim().regex(/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\n\r]{0,200})?$/, "Not an OpenSSH public key"))
    .max(20)
    .default([]),
});

export const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Hour of day (server time) for the nightly run. */
  hour: z.number().int().min(0).max(23),
  keepLocal: z.number().int().min(1).max(60),
  remote: z
    .object({
      endpoint: z.string().url(),
      region: z.string().max(40).default("auto"),
      bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/),
      prefix: z.string().regex(/^[A-Za-z0-9._\/-]*$/).max(200).default("hostpanel"),
      accessKey: z.string().min(1).max(200).optional(),
      secretKey: z.string().min(1).max(200).optional(),
    })
    .nullable(),
});

export const dnsSettingsSchema = z.object({
  provider: z.enum(["none", "cloudflare"]),
  /** Cloudflare API token with Zone:Read, DNS:Edit (and Zone:Edit to create zones). */
  apiToken: z.string().min(20).max(200).optional(),
  accountId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"] as const;
export const dnsRecordSchema = z.object({
  type: z.enum(DNS_RECORD_TYPES),
  /** "@" for the zone apex, or a relative or full name. */
  name: z.string().min(1).max(253),
  content: z.string().min(1).max(2048),
  ttl: z.number().int().min(1).max(86400).default(1),
  priority: z.number().int().min(0).max(65535).optional(),
  proxied: z.boolean().optional(),
});

export const certUploadSchema = z.object({
  certificate: z.string().includes("-----BEGIN CERTIFICATE-----").max(64_000),
  privateKey: z.string().regex(/-----BEGIN (RSA |EC )?PRIVATE KEY-----/, "Paste a PEM private key").max(16_000),
});

export type CronJobInput = z.infer<typeof cronJobSchema>;
export type AccessInput = z.infer<typeof accessSchema>;
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export type DnsSettings = z.infer<typeof dnsSettingsSchema>;
export type DnsRecordInput = z.infer<typeof dnsRecordSchema>;
