import { chmod, chown, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { env, sys } from "./env.js";
import { run } from "./exec.js";

/** All file helpers take REAL system paths and map them into the sandbox in dry-run mode. */

export async function ensureDir(path: string, mode = 0o750): Promise<void> {
  await mkdir(sys(path), { recursive: true, mode });
  await chmod(sys(path), mode);
}

/** Writes atomically (temp file + rename) so a crash never leaves half a config file. */
export async function writeFileAtomic(path: string, content: string, mode = 0o644): Promise<void> {
  const real = sys(path);
  await mkdir(dirname(real), { recursive: true });
  const tmp = `${real}.tmp-${process.pid}`;
  await writeFile(tmp, content, { mode });
  await chmod(tmp, mode);
  await rename(tmp, real);
}

export async function removePath(path: string): Promise<void> {
  await rm(sys(path), { recursive: true, force: true });
}

export async function exists(path: string): Promise<boolean> {
  return lstat(sys(path)).then(
    () => true,
    () => false,
  );
}

/** Atomically point `link` at `target` (ln -sfn, but without a window where the link is missing). */
export async function swapSymlink(target: string, link: string): Promise<void> {
  const tmp = `${sys(link)}.tmp-${process.pid}`;
  await rm(tmp, { force: true });
  await symlink(env.dryRun ? sys(target) : target, tmp);
  await rename(tmp, sys(link));
}

export async function readLink(link: string): Promise<string | null> {
  try {
    const t = await readlink(sys(link));
    return env.dryRun && t.startsWith(env.dryRoot) ? t.slice(env.dryRoot.length) : t;
  } catch {
    return null;
  }
}

/** chown -R user:group (skipped in dry-run). */
export async function chownR(path: string, user: string, group = user): Promise<void> {
  await run("chown", ["-R", "--no-dereference", `${user}:${group}`, path]);
}

export async function chownOne(path: string, uid: number, gid: number): Promise<void> {
  if (env.dryRun) return;
  await chown(path, uid, gid);
}
