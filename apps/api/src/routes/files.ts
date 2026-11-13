import type { FastifyInstance } from "fastify";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { homePathSchema, paths } from "@hostpanel/shared";
import { config } from "../config.js";
import { randomToken } from "../crypto.js";
import { badRequest, notFound } from "../errors.js";
import { audit, requireAuth } from "../auth.js";
import { ownedAccount } from "../access.js";
import { runFast } from "../queue.js";
import { serverOf } from "../specs.js";

const MAX_UPLOAD = 512 * 1024 * 1024;
/** Accounts on servers other than the main one: files travel inside jobs, so keep them small. */
const REMOTE_MAX = 25 * 1024 * 1024;
const local = (p: string) => config.devSandboxRoot + p;

/**
 * File manager. Paths are relative to the account's home (/home/hp_<name>).
 * The API never touches customer files itself: the agent does every operation as the
 * customer's Linux user. Uploads/downloads pass through /var/lib/hostpanel/{uploads,downloads}.
 */
export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Raw uploads: the browser PUTs the file body as-is (no multipart parsing needed).
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  const acc = (req: Parameters<typeof ownedAccount>[0]) => ownedAccount(req, (req.params as { id: string }).id);
  const p = (v: unknown) => homePathSchema.parse(v ?? "");

  app.get("/accounts/:id/files", async (req) => {
    const a = await acc(req);
    return runFast("fs.list", { linuxUser: a.linuxUser, path: p((req.query as { path?: string }).path) });
  });

  app.get("/accounts/:id/files/content", async (req) => {
    const a = await acc(req);
    return runFast("fs.read", { linuxUser: a.linuxUser, path: p((req.query as { path?: string }).path) });
  });

  app.put("/accounts/:id/files/content", { bodyLimit: 16 * 1024 * 1024 }, async (req) => {
    const a = await acc(req);
    const body = z.object({ path: z.string(), content: z.string().max(10 * 1024 * 1024) }).parse(req.body);
    const path = p(body.path);
    if (!path) throw badRequest("Choose a file name");
    const r = await runFast("fs.write", { linuxUser: a.linuxUser, path, contentB64: Buffer.from(body.content, "utf8").toString("base64") });
    await audit(req, "files.write", "account", a.id, { path });
    return r;
  });

  app.post("/accounts/:id/files/:op", async (req) => {
    const a = await acc(req);
    const { op } = req.params as { op: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const u = a.linuxUser;
    let r: unknown;
    switch (op) {
      case "mkdir":
        r = await runFast("fs.mkdir", { linuxUser: u, path: p(b.path) });
        break;
      case "rename":
        r = await runFast("fs.rename", { linuxUser: u, from: p(b.from), to: p(b.to) });
        break;
      case "delete":
        r = await runFast("fs.delete", { linuxUser: u, paths: z.array(z.string()).min(1).max(500).parse(b.paths).map(p) }, 120_000);
        break;
      case "chmod":
        r = await runFast("fs.chmod", { linuxUser: u, path: p(b.path), mode: z.string().regex(/^[0-7]{3,4}$/).parse(b.mode) });
        break;
      case "extract":
        r = await runFast("fs.extract", { linuxUser: u, path: p(b.path), into: p(b.into) }, 600_000);
        break;
      case "compress":
        r = await runFast("fs.compress", { linuxUser: u, paths: z.array(z.string()).min(1).parse(b.paths).map(p), to: p(b.to) }, 600_000);
        break;
      default:
        throw notFound("Unknown file operation");
    }
    await audit(req, `files.${op}`, "account", a.id, b);
    return r ?? { ok: true };
  });

  app.put("/accounts/:id/files/upload", { bodyLimit: MAX_UPLOAD }, async (req) => {
    const a = await acc(req);
    const path = p((req.query as { path?: string }).path);
    if (!path) throw badRequest("Missing ?path=");
    if (!(await serverOf(a.serverId)).isMain) {
      // other servers: no shared staging folder, so the file travels inside the job (max 25 MB)
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req.body as AsyncIterable<Buffer>) {
        size += c.length;
        if (size > REMOTE_MAX) throw badRequest("Files over 25 MB on this server: upload them with SFTP");
        chunks.push(c);
      }
      const r = await runFast("fs.write", { linuxUser: a.linuxUser, path, contentB64: Buffer.concat(chunks).toString("base64") }, 300_000);
      await audit(req, "files.upload", "account", a.id, { path });
      return r;
    }
    const staged = randomToken(24);
    await mkdir(local(paths.uploads), { recursive: true });
    const file = join(local(paths.uploads), staged);
    try {
      await pipeline(req.body as NodeJS.ReadableStream, createWriteStream(file, { mode: 0o640 }));
      const r = await runFast("fs.upload", { linuxUser: a.linuxUser, staged, path }, 600_000);
      await audit(req, "files.upload", "account", a.id, { path });
      return r;
    } finally {
      await rm(file, { force: true });
    }
  });

  /** Step 1: the agent copies the file to the downloads folder. Step 2: GET .../download/:token streams it once. */
  app.post("/accounts/:id/files/download", async (req) => {
    const a = await acc(req);
    const path = p(((req.body ?? {}) as { path?: string }).path);
    const token = randomToken(24);
    if (!(await serverOf(a.serverId)).isMain) {
      const r = (await runFast("fs.read", { linuxUser: a.linuxUser, path, maxBytes: REMOTE_MAX }, 300_000)) as { contentB64: string; size: number };
      await mkdir(local(paths.downloads), { recursive: true });
      await writeFile(join(local(paths.downloads), token), Buffer.from(r.contentB64, "base64"), { mode: 0o640 });
      return { token, name: path.split("/").pop(), size: r.size };
    }
    const r = (await runFast("fs.download", { linuxUser: a.linuxUser, path, token }, 600_000)) as { name: string; size: number };
    return { token, ...r };
  });

  app.get("/accounts/:id/files/download/:token", async (req, reply) => {
    await acc(req);
    const { token } = req.params as { token: string };
    const { name } = z.object({ name: z.string().max(255).default("download") }).parse(req.query);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound();
    const file = join(local(paths.downloads), token);
    const st = await stat(file).catch(() => null);
    if (!st) throw notFound("Download expired, try again");
    const stream = createReadStream(file);
    stream.on("close", () => void rm(file, { force: true }));
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", st.size)
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(stream);
  });
}
