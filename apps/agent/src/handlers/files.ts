import { lstat, mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { paths, type FileEntry, type JobPayloads } from "@hostpanel/shared";
import { env, sys } from "../env.js";
import { run, runAs } from "../exec.js";

/**
 * File manager. Every operation runs AS the customer's Linux user (runAs → runuser),
 * so the kernel enforces permissions. On top of that, paths are checked to stay
 * inside the account's home after resolving symlinks.
 */

const MAX_READ = 2 * 1024 * 1024;

function home(linuxUser: string): string {
  return `/home/${linuxUser}`;
}

/**
 * Absolute (sandbox-mapped) path for a home-relative path, refusing anything that resolves outside home.
 * linkItself: for delete/rename the last component may be a symlink pointing anywhere (we act on the
 * link, not its target), so only its parent folder is checked.
 */
async function resolveIn(linuxUser: string, rel: string, mustExist = true, linkItself = false): Promise<string> {
  const root = sys(home(linuxUser));
  const abs = rel ? join(root, rel) : root;
  if (linkItself && rel) {
    await resolveIn(linuxUser, dirname(rel) === "." ? "" : dirname(rel), true);
    if (mustExist) await lstat(abs).catch(() => {
      throw new Error(`Not found: ${rel}`);
    });
    return abs;
  }
  // resolve the deepest existing ancestor so new files can be created too
  let probe = abs;
  for (;;) {
    try {
      const real = await realpath(probe);
      const realRoot = await realpath(root);
      if (real !== realRoot && !real.startsWith(realRoot + "/")) throw new Error("Path is outside your home folder");
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (mustExist && probe === abs) throw new Error(`Not found: ${rel || "/"}`);
      const parent = dirname(probe);
      if (parent === probe) throw new Error("Path is outside your home folder");
      probe = parent;
    }
  }
  return abs;
}

export async function fsList({ linuxUser, path }: JobPayloads["fs.list"]): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  const dir = await resolveIn(linuxUser, path);
  const r = await runAs(linuxUser, "find", [dir, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\\t%s\\t%T@\\t%m\\t%f\\0"]);
  const typeOf: Record<string, FileEntry["type"]> = { f: "file", d: "dir", l: "link" };
  const entries = r.stdout
    .split("\0")
    .filter(Boolean)
    .slice(0, 5000)
    .map((line) => {
      const [t, size, mtime, mode, ...name] = line.split("\t");
      return { name: name.join("\t"), type: typeOf[t!] ?? "other", size: Number(size), mtime: Math.round(Number(mtime)), mode: mode! } satisfies FileEntry;
    })
    .sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
  return { path, entries, truncated: r.stdout.split("\0").length > 5001 };
}

export async function fsRead({ linuxUser, path, maxBytes }: JobPayloads["fs.read"]): Promise<{ contentB64: string; size: number; binary: boolean }> {
  const file = await resolveIn(linuxUser, path);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error("That is a folder");
  const limit = maxBytes ?? MAX_READ;
  if (st.size > limit) throw new Error(`File is ${(st.size / 1048576).toFixed(1)} MB; the limit here is ${Math.round(limit / 1048576)} MB.`);
  const r = await runAs(linuxUser, "cat", ["--", file], { binary: true });
  const bytes = r.bytes ?? Buffer.alloc(0);
  const binary = bytes.subarray(0, 8000).includes(0);
  return { contentB64: bytes.toString("base64"), size: bytes.length, binary };
}

export async function fsWrite({ linuxUser, path, contentB64 }: JobPayloads["fs.write"]): Promise<{ size: number }> {
  const file = await resolveIn(linuxUser, path, false);
  const data = Buffer.from(contentB64, "base64");
  await runAs(linuxUser, "sh", ["-c", 'cat > "$1"', "sh", file], { input: data });
  return { size: data.length };
}

export async function fsMkdir({ linuxUser, path }: JobPayloads["fs.mkdir"]): Promise<void> {
  await runAs(linuxUser, "mkdir", ["-p", "--", await resolveIn(linuxUser, path, false)]);
}

export async function fsRename({ linuxUser, from, to }: JobPayloads["fs.rename"]): Promise<void> {
  const src = await resolveIn(linuxUser, from, true, true);
  const dst = await resolveIn(linuxUser, to, false);
  if (await stat(dst).then(() => true, () => false)) throw new Error(`${to} already exists`);
  await runAs(linuxUser, "mv", ["-T", "--", src, dst]);
}

export async function fsDelete({ linuxUser, paths: list }: JobPayloads["fs.delete"]): Promise<{ deleted: number }> {
  const targets = await Promise.all(list.map((p) => resolveIn(linuxUser, p, true, true)));
  await runAs(linuxUser, "rm", ["-rf", "--", ...targets]);
  return { deleted: targets.length };
}

export async function fsChmod({ linuxUser, path, mode }: JobPayloads["fs.chmod"]): Promise<void> {
  await runAs(linuxUser, "chmod", [mode, "--", await resolveIn(linuxUser, path)]);
}

/** The API staged the upload (owned by hostpanel); stream it into place as the customer. */
export async function fsUpload({ linuxUser, staged, path }: JobPayloads["fs.upload"]): Promise<{ size: number }> {
  const src = sys(join(paths.uploads, staged));
  const dst = await resolveIn(linuxUser, path, false);
  try {
    const size = (await stat(src)).size;
    await runAs(linuxUser, "mkdir", ["-p", "--", dirname(dst)]);
    await runAs(linuxUser, "sh", ["-c", 'cat > "$1"', "sh", dst], { inputFile: src });
    return { size };
  } finally {
    await rm(src, { force: true });
  }
}

/** Copy a customer file (read as the customer) to the downloads folder for the API to stream once. */
export async function fsDownload({ linuxUser, path, token }: JobPayloads["fs.download"]): Promise<{ name: string; size: number }> {
  const src = await resolveIn(linuxUser, path);
  if ((await stat(src)).isDirectory()) throw new Error("Compress the folder to a .zip first, then download the .zip");
  const dir = sys(paths.downloads);
  await mkdir(dir, { recursive: true });
  const out = join(dir, token);
  await runAs(linuxUser, "cat", ["--", src], { outputFile: out });
  await run("chgrp", [env.panelGroup, out], { allowFail: true });
  return { name: basename(src), size: (await stat(out)).size };
}

export async function fsExtract({ linuxUser, path, into }: JobPayloads["fs.extract"]): Promise<void> {
  const archive = await resolveIn(linuxUser, path);
  const dest = await resolveIn(linuxUser, into, false);
  await runAs(linuxUser, "mkdir", ["-p", "--", dest]);
  if (/\.zip$/i.test(archive)) await runAs(linuxUser, "unzip", ["-o", "-q", archive, "-d", dest], { timeoutSec: 600 });
  else await runAs(linuxUser, "tar", ["-xf", archive, "-C", dest, "--no-same-owner"], { timeoutSec: 600 });
}

export async function fsCompress({ linuxUser, paths: list, to }: JobPayloads["fs.compress"]): Promise<void> {
  const root = sys(home(linuxUser));
  for (const p of list) await resolveIn(linuxUser, p);
  const zip = await resolveIn(linuxUser, to, false);
  // run from the home folder so the archive stores home-relative names
  await runAs(linuxUser, "zip", ["-r", "-q", "-y", zip, "--", ...list], { cwd: root, timeoutSec: 600 });
}
