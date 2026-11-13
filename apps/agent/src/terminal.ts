import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";
import { paths } from "@hostpanel/shared";
import { env, sys } from "./env.js";
import { run } from "./exec.js";

/**
 * Web terminal. The API (unprivileged) authenticates the browser, then proxies its
 * WebSocket to this Unix socket with a short-lived token signed with a key derived
 * from APP_ENCRYPTION_KEY. The shell runs as the customer inside their resource slice.
 * A PTY comes from util-linux `script`, so no native Node modules are needed.
 */

export interface TerminalClaims {
  u: string; // linux user
  cwd: string; // absolute folder inside the user's home
  cols: number;
  rows: number;
  exp: number; // unix seconds
}

function key(): Buffer {
  return createHmac("sha256", env.encryptionKey).update("hostpanel-terminal-v1").digest();
}

export function signTerminalToken(c: TerminalClaims): string {
  const body = Buffer.from(JSON.stringify(c)).toString("base64url");
  return `${body}.${createHmac("sha256", key()).update(body).digest("base64url")}`;
}

export function verifyTerminalToken(token: string): TerminalClaims | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", key()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const c = JSON.parse(Buffer.from(body, "base64url").toString()) as TerminalClaims;
  if (c.exp < Date.now() / 1000) return null;
  if (!/^hp_[a-z][a-z0-9_]{1,30}$/.test(c.u)) return null;
  if (!/^\/home\/hp_[a-z0-9_]+(\/[A-Za-z0-9._-]+)*$/.test(c.cwd) || !c.cwd.startsWith(`/home/${c.u}`)) return null;
  c.cols = Math.max(20, Math.min(400, Math.floor(c.cols || 120)));
  c.rows = Math.max(5, Math.min(200, Math.floor(c.rows || 30)));
  return c;
}

export async function startTerminalServer(): Promise<void> {
  const sock = sys(paths.terminalSocket);
  await mkdir(dirname(sock), { recursive: true, mode: 0o750 });
  await rm(sock, { force: true });
  const server = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const token = new URL(req.url ?? "/", "http://x").searchParams.get("t") ?? "";
    const claims = verifyTerminalToken(token);
    if (!claims) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const inner = env.dryRun
        ? `cd '${sys(claims.cwd)}' 2>/dev/null; exec bash --norc -i`
        : `exec systemd-run --scope --quiet --slice=hp-${claims.u}.slice runuser -u ${claims.u} -- /bin/bash -c 'cd "$0" 2>/dev/null; exec /bin/bash -l' '${claims.cwd}'`;
      const child = spawn("script", ["-qfec", `stty cols ${claims.cols} rows ${claims.rows}; ${inner}`, "/dev/null"], {
        env: {
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: env.dryRun ? sys(`/home/${claims.u}`) : `/home/${claims.u}`,
          USER: claims.u,
          SHELL: "/bin/bash",
        },
        detached: true,
      });
      const kill = () => {
        try {
          process.kill(-child.pid!, "SIGHUP");
        } catch {
          /* already gone */
        }
      };
      let idle = setTimeout(() => ws.close(4000, "idle"), 30 * 60_000);
      child.stdout.on("data", (d: Buffer) => ws.readyState === ws.OPEN && ws.send(d));
      child.stderr.on("data", (d: Buffer) => ws.readyState === ws.OPEN && ws.send(d));
      child.on("exit", () => ws.readyState === ws.OPEN && ws.close(1000, "exited"));
      ws.on("message", (data) => {
        clearTimeout(idle);
        idle = setTimeout(() => ws.close(4000, "idle"), 30 * 60_000);
        child.stdin.write(data as Buffer);
      });
      ws.on("close", () => {
        clearTimeout(idle);
        kill();
      });
      console.log(`terminal opened for ${claims.u} in ${claims.cwd}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(sock, resolve));
  await chmod(sock, 0o660);
  // the API (group hostpanel) must be able to enter /run/hostpanel and open the socket
  await run("chgrp", [env.panelGroup, dirname(sock), sock], { allowFail: true });
  console.log(`terminal socket ${sock}`);
}
