import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { safeEqual } from "./crypto.js";
import { HttpError } from "./errors.js";

const API = "https://api.github.com";

export function githubConfigured(): boolean {
  return Boolean(config.github.appId && config.github.privateKey);
}

function appJwt(): string {
  if (!config.github.appId || !config.github.privateKey) {
    throw new HttpError(400, "GitHub App is not configured on this server (GITHUB_APP_ID / private key)", "github_not_configured");
  }
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iat: now - 60, exp: now + 9 * 60, iss: config.github.appId }, config.github.privateKey, { algorithm: "RS256" });
}

async function gh<T>(path: string, init: RequestInit & { token: string; bearer?: boolean }): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HostPanel",
      Authorization: `${init.bearer === false ? "token" : "Bearer"} ${init.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(502, `GitHub API ${res.status}: ${text.slice(0, 300)}`, "github_error");
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Short-lived (1 hour) token scoped to one installation. Never stored in the database. */
export async function installationToken(installationId: number): Promise<string> {
  const r = await gh<{ token: string }>(`/app/installations/${installationId}/access_tokens`, { method: "POST", token: appJwt() });
  return r.token;
}

/** Find the installation that can see a repo (when the user did not pick one). */
export async function installationForRepo(repoFullName: string): Promise<number | null> {
  try {
    const r = await gh<{ id: number }>(`/repos/${repoFullName}/installation`, { method: "GET", token: appJwt() });
    return r.id;
  } catch {
    return null;
  }
}

export interface RepoSummary {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  installationId: number;
}

export async function listInstallationRepos(): Promise<RepoSummary[]> {
  const installs = await gh<Array<{ id: number }>>(`/app/installations`, { method: "GET", token: appJwt() });
  const out: RepoSummary[] = [];
  for (const inst of installs) {
    const token = await installationToken(inst.id);
    const r = await gh<{ repositories: Array<{ full_name: string; default_branch: string; private: boolean }> }>(
      `/installation/repositories?per_page=100`,
      { method: "GET", token },
    );
    for (const repo of r.repositories) {
      out.push({ fullName: repo.full_name, defaultBranch: repo.default_branch, private: repo.private, installationId: inst.id });
    }
  }
  return out;
}

/** File names at the repo root (or a sub-folder), used for runtime detection. */
export async function listRepoFiles(repoFullName: string, branch: string, dir: string, token: string | null): Promise<string[]> {
  const path = dir ? `/${dir.replace(/^\/|\/$/g, "")}` : "";
  const items = await gh<Array<{ name: string }>>(`/repos/${repoFullName}/contents${path}?ref=${encodeURIComponent(branch)}`, {
    method: "GET",
    token: token ?? "",
  });
  return Array.isArray(items) ? items.map((i) => i.name) : [];
}

export async function setCommitStatus(
  installationId: number,
  repoFullName: string,
  sha: string,
  state: "pending" | "success" | "failure" | "error",
  description: string,
  targetUrl?: string,
): Promise<void> {
  const token = await installationToken(installationId);
  await gh(`/repos/${repoFullName}/statuses/${sha}`, {
    method: "POST",
    token,
    body: JSON.stringify({ state, description: description.slice(0, 140), context: "hostpanel/deploy", target_url: targetUrl }),
  });
}

/** Validates X-Hub-Signature-256 against the raw request body. */
export function verifyWebhook(rawBody: string, signature: string | undefined): boolean {
  if (!config.github.webhookSecret || !signature) return false;
  const expected = "sha256=" + createHmac("sha256", config.github.webhookSecret).update(rawBody).digest("hex");
  return safeEqual(expected, signature);
}
