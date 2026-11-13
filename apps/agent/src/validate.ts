import { z } from "zod";
import { APP_TEMPLATES, JOB_TYPES, RUNTIMES, RUNTIME_VERSIONS, type JobPayloads, type JobType } from "@hostpanel/shared";

/**
 * Second line of defence: the agent re-validates every payload even though the API
 * already did. Anything that ends up in a file path, a config file or a command
 * argument is restricted to a safe character set here.
 */
export const linuxUser = z.string().regex(/^hp_[a-z][a-z0-9_]{1,30}$/);
export const siteName = z.string().regex(/^[a-z][a-z0-9_-]{1,23}$/);
export const hostname = z.string().regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/);
/** Route hostnames may be wildcards ("*.example.com") — only with DNS-issued certificates. */
const routeHostname = z.string().regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/);
/** Path inside an account home, relative, no "..", no NUL or newlines. "" = the home folder itself. */
export const homePath = z
  .string()
  .max(1024)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !/[\0\n\r]/.test(p), "bad path");
const token = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
const backupFile = z.string().regex(/^\d{8}-\d{6}-[a-z0-9]+\.tar$/);
const enc = z.string().regex(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]*$/);
const remote = z
  .object({
    endpoint: z.string().url().regex(/^https?:\/\/[A-Za-z0-9.:-]+\/?$/),
    region: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/),
    prefix: z.string().regex(/^[A-Za-z0-9._\/-]*$/),
    accessKeyEnc: enc,
    secretKeyEnc: enc,
  })
  .nullable();
/** user@domain, lower-case; local part limited to characters safe in Postfix/Dovecot table files. */
const email = z.string().max(254).regex(/^[a-z0-9]([a-z0-9._+-]*[a-z0-9])?@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/);
const wgKey = z.string().regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/);
const dbRef = z.object({ engine: z.enum(["mariadb", "postgres"]), name: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/) });
const relPath = z.string().regex(/^[A-Za-z0-9._/-]*$/).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."));
const absPath = z.string().regex(/^\/[A-Za-z0-9._/-]+$/).refine((p) => !p.split("/").includes(".."));
const port = z.number().int().min(1024).max(65535);
const releaseName = z.string().regex(/^[0-9]{8}-[0-9]{6}-[0-9a-f]{0,12}$|^000-placeholder$/);
const dbIdent = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const redirectUrl = z.string().url().regex(/^https?:\/\/[^\s{}"'`\\]+$/);

const envVar = z.object({ key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), valueEnc: z.string() });

export const siteSpec = z
  .object({
    id: z.string(),
    name: siteName,
    linuxUser,
    runtime: z.enum(RUNTIMES),
    runtimeVersion: z.string(),
    rootDir: relPath,
    publicDir: relPath,
    buildCmd: z.string().max(1000),
    startCmd: z.string().max(1000),
    port: port.nullable(),
    instances: z.number().int().min(1).max(8),
    healthPath: z.string().regex(/^\/[A-Za-z0-9._~\/?=&%-]*$/),
    background: z.boolean(),
    env: z.array(envVar),
    processes: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9-]{0,15}$/).refine((n) => n !== "redis"),
          command: z.string().min(1).max(1000),
          path: z.string().regex(/^\/[A-Za-z0-9._\-\/]*\*?$/).nullable(),
        }),
      )
      .max(6),
    redis: z.boolean(),
  })
  .refine((s) => RUNTIME_VERSIONS[s.runtime].includes(s.runtimeVersion), "unsupported runtime version");

const route = z.object({
  hostname: routeHostname,
  kind: z.enum(["php", "proxy", "static", "redirect"]),
  siteName,
  linuxUser,
  phpVersion: z.enum(RUNTIME_VERSIONS.php as unknown as [string, ...string[]]).optional(),
  port: port.optional(),
  instances: z.number().int().min(1).max(8).optional(),
  root: absPath.optional(),
  redirectTo: redirectUrl.optional(),
  redirectCode: z.union([z.literal(301), z.literal(302)]).optional(),
  paths: z
    .array(z.object({ path: z.string().regex(/^\/[A-Za-z0-9._\-\/]*\*?$/), port, instances: z.number().int().min(1).max(8) }))
    .max(20)
    .optional(),
  tls: z.union([z.literal("dns"), z.object({ certEnc: enc, keyEnc: enc })]).optional(),
});

const schemas: { [K in JobType]: z.ZodType<JobPayloads[K]> } = {
  "account.create": z.object({ linuxUser, cpuPercent: z.number().int().min(10).max(6400), ramMb: z.number().int().min(64), diskMb: z.number().int().min(10) }),
  "account.suspend": z.object({ linuxUser, suspended: z.boolean(), siteNames: z.array(siteName) }),
  "account.delete": z.object({ linuxUser }),
  "site.provision": z.object({ site: siteSpec }),
  "site.remove": z.object({ site: siteSpec }),
  "site.control": z.object({ site: siteSpec, action: z.enum(["start", "stop", "restart"]) }),
  "site.deploy": z.object({
    site: siteSpec,
    deploymentId: z.string().regex(/^[a-z0-9]+$/),
    repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).nullable(),
    branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/).refine((b) => !b.startsWith("-") && !b.includes("..")),
    commitSha: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
    gitToken: z.string().regex(/^[A-Za-z0-9_.-]+$/).nullable(),
    keepReleases: z.number().int().min(2).max(50),
  }),
  "site.rollback": z.object({ site: siteSpec, deploymentId: z.string().regex(/^[a-z0-9]+$/), releaseName }),
  "routes.sync": z.object({
    routes: z.array(route).refine((rs) => rs.every((r) => !r.hostname.startsWith("*.") || r.tls === "dns"), "wildcards need DNS certificates"),
    panelHostname: hostname.nullable(),
    acmeEmail: z.string().email().nullable(),
    dnsTokenEnc: enc.nullable(),
  }),
  "db.create": z.object({ engine: z.enum(["mariadb", "postgres"]), name: dbIdent, user: dbIdent, passwordEnc: z.string() }),
  "db.delete": z.object({ engine: z.enum(["mariadb", "postgres"]), name: dbIdent, user: dbIdent }),
  "system.stats": z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  "cron.sync": z.object({
    site: siteSpec,
    jobs: z.array(z.object({ id: z.string().regex(/^[a-z0-9]+$/), onCalendar: z.string().regex(/^[A-Za-z0-9*,:. -]+$/).max(200), command: z.string().min(1).max(2000), enabled: z.boolean() })).max(100),
  }),
  "cron.run": z.object({ site: siteSpec, jobId: z.string().regex(/^[a-z0-9]+$/) }),
  "backup.run": z.object({
    backupId: z.string().regex(/^[a-z0-9]+$/),
    linuxUser,
    contents: z.object({ sites: z.array(siteName), databases: z.array(dbRef) }),
    remote,
    keepLocal: z.number().int().min(1).max(60),
  }),
  "backup.restore": z.object({
    backupId: z.string().regex(/^[a-z0-9]+$/),
    linuxUser,
    fileName: backupFile,
    remote,
    sites: z.array(z.object({ name: siteName, spec: siteSpec.nullable() })),
    databases: z.array(dbRef.extend({ user: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/) })),
  }),
  "backup.delete": z.object({ linuxUser, fileName: backupFile, remote }),
  "access.sync": z.object({
    linuxUser,
    sftp: z.boolean(),
    shell: z.boolean(),
    passwordEnc: enc.nullable(),
    sshKeys: z.array(z.string().regex(/^[A-Za-z0-9@.-]+ [A-Za-z0-9+/=]+( [^\n\r]{0,200})?$/)).max(20),
  }),
  "fs.list": z.object({ linuxUser, path: homePath }),
  "fs.read": z.object({ linuxUser, path: homePath, maxBytes: z.number().int().min(1).max(25 * 1024 * 1024).optional() }),
  "fs.write": z.object({ linuxUser, path: homePath.refine((p) => p !== ""), contentB64: z.string().max(14_000_000) }),
  "fs.mkdir": z.object({ linuxUser, path: homePath.refine((p) => p !== "") }),
  "fs.rename": z.object({ linuxUser, from: homePath.refine((p) => p !== ""), to: homePath.refine((p) => p !== "") }),
  "fs.delete": z.object({ linuxUser, paths: z.array(homePath.refine((p) => p !== "", "cannot delete the home folder")).min(1).max(500) }),
  "fs.chmod": z.object({ linuxUser, path: homePath.refine((p) => p !== ""), mode: z.string().regex(/^[0-7]{3,4}$/) }),
  "fs.upload": z.object({ linuxUser, staged: token, path: homePath.refine((p) => p !== "") }),
  "fs.download": z.object({ linuxUser, path: homePath.refine((p) => p !== ""), token }),
  "fs.extract": z.object({ linuxUser, path: homePath.refine((p) => /\.(zip|tar|tar\.gz|tgz|tar\.xz)$/i.test(p)), into: homePath }),
  "fs.compress": z.object({ linuxUser, paths: z.array(homePath.refine((p) => p !== "")).min(1).max(500), to: homePath.refine((p) => p.endsWith(".zip")) }),
  "logs.read": z.object({ linuxUser, siteName, log: z.enum(["access", "app", "php-error", "cron"]), bytes: z.number().int().min(1024).max(2_000_000) }),
  "mail.sync": z.object({
    mailHost: hostname,
    domains: z.array(z.object({ name: hostname, catchAll: z.string().regex(/^[a-z0-9._%+@,-]+$/).max(2000).nullable() })).max(5000),
    mailboxes: z
      .array(z.object({ address: email, passwordHash: z.string().regex(/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/), quotaMb: z.number().int().min(1).max(1_000_000), enabled: z.boolean() }))
      .max(100_000),
    aliases: z.array(z.object({ source: email, destinations: z.array(email).min(1).max(50) })).max(100_000),
  }),
  "mail.dkim": z.object({ domain: hostname, selector: z.string().regex(/^[a-z0-9-]{1,63}$/) }),
  "mail.purge": z.object({ address: email }),
  "mail.usage": z.object({ addresses: z.array(email).max(1000) }),
  "app.install": z.object({
    site: siteSpec,
    template: z.enum(APP_TEMPLATES),
    domain: hostname,
    deploymentId: z.string().regex(/^[a-z0-9]+$/),
    db: z.object({ engine: z.enum(["mariadb", "postgres"]), name: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), user: z.string().regex(/^[a-z][a-z0-9_]{1,62}$/), passwordEnc: enc }).nullable(),
    admin: z.object({ user: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/), email: z.string().email(), passwordEnc: enc }).nullable(),
  }),
  "server.addPeer": z.object({ publicKey: wgKey, address: z.string().regex(/^10\.88\.\d{1,3}\.\d{1,3}$/) }),
  "server.removePeer": z.object({ publicKey: wgKey }),
  "stats.account": z.object({ linuxUser, units: z.array(z.string().regex(/^hp-[a-z0-9_-]+(\.[a-z0-9-]+)?\.(service|slice)$/)).max(50) }),
};

export function parsePayload<T extends JobType>(type: string, data: unknown): JobPayloads[T] {
  if (!(JOB_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown job type ${type}`);
  return schemas[type as T].parse(data);
}

export { releaseName as releaseNameSchema };
