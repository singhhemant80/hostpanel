import type { FastifyInstance } from "fastify";
import { and, eq, ilike } from "drizzle-orm";
import { db, schema } from "../db.js";
import { HttpError } from "../errors.js";
import { verifyWebhook } from "../github.js";
import { redis } from "../queue.js";
import { startDeployment } from "../deploy.js";

interface PushEvent {
  ref: string;
  after: string;
  deleted?: boolean;
  repository: { full_name: string };
  installation?: { id: number };
  head_commit?: { message: string; author?: { name?: string; username?: string } } | null;
  pusher?: { name?: string };
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/github", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const raw = req.rawBody ?? "";
    if (!verifyWebhook(raw, req.headers["x-hub-signature-256"] as string | undefined)) {
      throw new HttpError(401, "Bad signature", "bad_signature");
    }
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    if (delivery) {
      const fresh = await redis.set(`gh:delivery:${delivery}`, "1", "EX", 86400, "NX");
      if (!fresh) return reply.code(200).send({ ok: true, duplicate: true });
    }

    const event = String(req.headers["x-github-event"] ?? "");
    if (event === "ping") return { ok: true, pong: true };
    if (event !== "push") return { ok: true, ignored: event };

    const push = req.body as PushEvent;
    if (push.deleted || !push.ref?.startsWith("refs/heads/")) return { ok: true, ignored: "not a branch push" };
    const branch = push.ref.slice("refs/heads/".length);

    const repo = push.repository.full_name.replace(/[%_\\]/g, "\\$&");
    const sources = await db.query.gitSources.findMany({
      where: and(ilike(schema.gitSources.repoFullName, repo), eq(schema.gitSources.branch, branch), eq(schema.gitSources.autoDeploy, true)),
      with: { site: { with: { account: true } } },
    });

    const started: string[] = [];
    for (const src of sources) {
      if (src.site.account.status !== "active" || src.site.status === "deleting") continue;
      if (push.installation?.id && src.installationId !== push.installation.id) {
        await db.update(schema.gitSources).set({ installationId: push.installation.id }).where(eq(schema.gitSources.id, src.id));
      }
      try {
        const dep = await startDeployment(src.siteId, {
          trigger: "push",
          commitSha: push.after,
          commitMessage: push.head_commit?.message?.split("\n")[0]?.slice(0, 200) ?? null,
          author: push.head_commit?.author?.username ?? push.head_commit?.author?.name ?? push.pusher?.name ?? null,
        });
        started.push(dep.id);
      } catch (e) {
        req.log.error({ err: e, site: src.siteId }, "auto-deploy failed to start");
      }
    }
    return { ok: true, deployments: started };
  });
}
