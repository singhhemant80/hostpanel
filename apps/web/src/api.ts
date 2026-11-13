export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  refreshing ??= fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin", headers: { "X-HostPanel": "1" } })
    .then((r) => r.ok)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

/** JSON fetch with cookie auth, CSRF header and one silent token refresh on 401. */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: opts.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "X-HostPanel": "1",
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !retried && !path.startsWith("/auth/login")) {
    if (await refresh()) return api<T>(path, opts, true);
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const put = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });

// ---- Types returned by the API (kept loose on purpose) ----
export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "reseller" | "user";
  locale: string;
  totpEnabled: boolean;
}
export interface Domain {
  id: string;
  hostname: string;
  type: string;
  status: string;
  sslStatus: string;
  certExpiresAt?: string | null;
  dnsOk: boolean;
  redirectTo: string | null;
  pathRules?: { path: string; siteId: string }[];
  site?: { id: string; name: string; runtime: string };
  account?: { username: string };
}
export interface Deployment {
  id: string;
  siteId: string;
  trigger: string;
  commitSha: string | null;
  commitMessage: string | null;
  author: string | null;
  status: string;
  releaseName: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  site?: { id: string; name: string };
}
export interface Site {
  id: string;
  accountId: string;
  name: string;
  runtime: "php" | "node" | "python" | "static";
  runtimeVersion: string;
  rootDir: string;
  publicDir: string;
  buildCmd: string;
  startCmd: string;
  port: number | null;
  instances: number;
  healthPath: string;
  background: boolean;
  status: string;
  running: boolean;
  currentRelease: string | null;
  createdAt: string;
  account: { username: string; linuxUser?: string };
  domains: Domain[];
  git: { repoFullName: string; branch: string; autoDeploy?: boolean; installationId?: number | null } | null;
  deployments?: Pick<Deployment, "status" | "commitSha" | "createdAt">[];
  env?: { key: string }[];
  paths?: { home: string; current: string };
}
export interface Package {
  id: string;
  name: string;
  diskMb: number;
  bandwidthGb: number;
  maxSites: number;
  maxDomains: number;
  maxDatabases: number;
  cpuPercent: number;
  ramMb: number;
  accountCount?: number;
}
export interface Account {
  id: string;
  username: string;
  linuxUser: string;
  status: string;
  createdAt: string;
  user: { id: string; email: string; name: string };
  package: Package;
  counts: { sites: number; domains: number; databases: number };
}
export interface RuntimeInfo {
  id: "php" | "node" | "python" | "static";
  versions: string[];
  defaultVersion: string;
  defaults: { buildCmd: string; startCmd: string; publicDir: string };
}
export interface SystemInfo {
  runtimes: RuntimeInfo[];
  dnsTargets: { ipv4: string | null; ipv6: string | null };
  github: { configured: boolean; installUrl: string | null; webhookUrl: string };
  panelUrl: string;
}
