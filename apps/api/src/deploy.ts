import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db, schema } from "./db.js";
import { badRequest, notFound } from "./errors.js";
import { installationForRepo, installationToken, setCommitStatus } from "./github.js";
import { enqueue } from "./queue.js";
import { loadSiteSpec } from "./specs.js";

export interface DeployTrigger {
  trigger: "push" | "manual" | "rollback" | "upload";
  commitSha?: string | null;
  commitMessage?: string | null;
  author?: string | null;
  createdBy?: string;
}

/** Create a deployment row and queue the build on the agent. */
export async function startDeployment(siteId: string, t: DeployTrigger) {
  const site = await db.query.sites.findFirst({ where: eq(schema.sites.id, siteId), with: { git: true, account: true } });
  if (!site) throw notFound("Site not found");
  if (!site.git) throw badRequest("Connect a GitHub repository to this site first");
  if (site.account.status !== "active") throw badRequest("Account is not active");

  let installationId = site.git.installationId;
  if (!installationId && config.github.appId) {
    installationId = await installationForRepo(site.git.repoFullName);
    if (installationId) await db.update(schema.gitSources).set({ installationId }).where(eq(schema.gitSources.id, site.git.id));
  }
  // Public repos work without the GitHub App; private ones need an installation token.
  const gitToken = installationId ? await installationToken(installationId) : null;

  const [deployment] = await db
    .insert(schema.deployments)
    .values({ siteId, trigger: t.trigger, commitSha: t.commitSha ?? null, commitMessage: t.commitMessage ?? null, author: t.author ?? null })
    .returning();

  const jobId = await enqueue(
    "site.deploy",
    {
      site: await loadSiteSpec(siteId),
      deploymentId: deployment!.id,
      repoFullName: site.git.repoFullName,
      branch: site.git.branch,
      commitSha: t.commitSha ?? null,
      gitToken,
      keepReleases: config.keepReleases,
    },
    { targetType: "deployment", targetId: deployment!.id, createdBy: t.createdBy, sensitive: true },
  );
  await db.update(schema.deployments).set({ jobId }).where(eq(schema.deployments.id, deployment!.id));

  if (installationId && t.commitSha) {
    setCommitStatus(installationId, site.git.repoFullName, t.commitSha, "pending", "Deploying on HostPanel", deploymentUrl(siteId)).catch(
      () => undefined,
    );
  }
  return { ...deployment!, jobId };
}

export function deploymentUrl(siteId: string): string {
  return `${config.panelUrl}/sites/${siteId}?tab=deployments`;
}
