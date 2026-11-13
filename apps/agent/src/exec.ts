import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { env } from "./env.js";

export interface RunOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Text written to the child's stdin (used for SQL so passwords never appear in `ps`). */
  input?: string | Buffer;
  timeoutSec?: number;
  /** Stream combined stdout/stderr here (deploy logs). */
  log?: WriteStream;
  /** Run even in dry-run mode (safe, unprivileged commands such as git or a build in the sandbox). */
  alwaysRun?: boolean;
  /** Non-zero exit is not an error. */
  allowFail?: boolean;
  /** Stream this file into stdin (uploads). */
  inputFile?: string;
  /** Stream stdout into this file instead of capturing it (downloads, dumps). */
  outputFile?: string;
  /** Capture stdout as raw bytes (file reads). */
  binary?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Raw stdout when opts.binary was set. */
  bytes?: Buffer;
}

export class CommandError extends Error {
  constructor(
    public cmd: string,
    public result: RunResult,
  ) {
    super(`${cmd} exited with ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(-5).join(" | ").slice(0, 600)}`);
  }
}

/**
 * Runs a program WITHOUT a shell: arguments are passed as an array, so nothing a
 * customer typed can be interpreted as shell syntax. (User build/start commands are the
 * one exception and run inside `bash -c` as the customer's own Linux user, see runAsUser.)
 */
export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  const printable = [cmd, ...args].join(" ");
  if (env.dryRun && !opts.alwaysRun) {
    console.log(`[dry-run] ${printable}`);
    opts.log?.write(`[dry-run] ${printable}\n`);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8", ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const chunks: Buffer[] = [];
    const cap = (s: string, chunk: Buffer) => (s.length < 1_000_000 ? s + chunk.toString() : s);
    let outDone: Promise<void> = Promise.resolve();
    if (opts.outputFile) {
      const out = createWriteStream(opts.outputFile, { mode: 0o640 });
      child.stdout.pipe(out);
      outDone = new Promise((r) => out.on("close", () => r()));
    } else {
      child.stdout.on("data", (c: Buffer) => {
        if (opts.binary) chunks.push(c);
        else stdout = cap(stdout, c);
        opts.log?.write(c);
      });
    }
    child.stderr.on("data", (c: Buffer) => {
      stderr = cap(stderr, c);
      opts.log?.write(c);
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutSec) {
      timer = setTimeout(() => {
        opts.log?.write(`\n!! Timed out after ${opts.timeoutSec}s, stopping\n`);
        child.kill("SIGKILL");
      }, opts.timeoutSec * 1000);
    }
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      void outDone.then(() => {
        const result: RunResult = { code: code ?? -1, stdout, stderr, ...(opts.binary ? { bytes: Buffer.concat(chunks) } : {}) };
        if (result.code !== 0 && !opts.allowFail) reject(new CommandError(printable, result));
        else resolve(result);
      });
    });
    if (opts.inputFile) createReadStream(opts.inputFile).on("error", reject).pipe(child.stdin);
    else if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Runs a customer's shell command (build step) as their Linux user inside a transient
 * systemd service, so it gets the account's CPU/RAM limits and a hard time limit.
 * The command goes into a script file and the variables into an EnvironmentFile, so
 * systemd never re-interprets `$` or `%` in what the customer typed.
 */
export async function runAsUser(
  linuxUser: string,
  command: string,
  opts: { cwd: string; env: Record<string, string>; log: WriteStream; timeoutSec: number },
): Promise<RunResult> {
  if (env.dryRun) {
    // In the sandbox the build runs as the current user, still without a login shell.
    return run("bash", ["-c", command], { cwd: opts.cwd, env: opts.env, log: opts.log, timeoutSec: opts.timeoutSec, alwaysRun: true });
  }
  const id = `${Date.now()}-${process.pid}`;
  const scriptDir = `/home/${linuxUser}/.hostpanel`;
  const script = `${scriptDir}/build-${id}.sh`;
  const envPath = `/etc/hostpanel/build/${linuxUser}-${id}.env`;
  await mkdir(scriptDir, { recursive: true, mode: 0o700 });
  await mkdir("/etc/hostpanel/build", { recursive: true, mode: 0o700 });
  await writeFile(script, `set -e\n${command}\n`, { mode: 0o700 });
  await writeFile(
    envPath,
    Object.entries(opts.env)
      .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await run("chown", ["-R", `${linuxUser}:${linuxUser}`, scriptDir]);
  try {
    return await run(
      "systemd-run",
      [
        "--quiet",
        "--wait",
        "--pipe",
        "--collect",
        `--uid=${linuxUser}`,
        `--gid=${linuxUser}`,
        `--slice=hp-${linuxUser}.slice`,
        `--working-directory=${opts.cwd}`,
        `--property=EnvironmentFile=${envPath}`,
        `--property=RuntimeMaxSec=${opts.timeoutSec}`,
        "--property=NoNewPrivileges=yes",
        "--property=PrivateTmp=yes",
        "/bin/bash",
        script,
      ],
      { log: opts.log, timeoutSec: opts.timeoutSec + 30 },
    );
  } finally {
    await rm(script, { force: true });
    await rm(envPath, { force: true });
  }
}

/**
 * Runs a command AS the customer's Linux user (runuser), so the kernel enforces their
 * permissions: a symlink in their home pointing at /etc/shadow simply fails to open.
 * Used by the file manager. In dry-run it runs as the current user inside the sandbox.
 */
export function runAs(linuxUser: string, cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  if (env.dryRun) return run(cmd, args, { ...opts, alwaysRun: true });
  return run("runuser", ["-u", linuxUser, "--", cmd, ...args], { ...opts, cwd: opts.cwd ?? "/" });
}
