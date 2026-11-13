import { realpath } from "node:fs/promises";
import { paths, type JobPayloads, type SiteSpec } from "@hostpanel/shared";
import { env, sys } from "../env.js";
import { cronRemoveAll } from "./cron.js";
import { run } from "../exec.js";
import { ensureDir, exists, readLink, removePath, swapSymlink, writeFileAtomic } from "../fsx.js";
import {
  removePhpPool,
  removeServiceUnits,
  serviceUnits,
  writeEnvFile,
  writePhpPool,
  writeServiceUnits,
} from "../runtime.js";

export const PLACEHOLDER = "000-placeholder";

function placeholderHtml(site: SiteSpec): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${site.name} is ready</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9;color:#1f2937}main{text-align:center;max-width:32rem;padding:2rem}h1{font-size:1.5rem}</style></head>
<body><main><h1>${site.name} is set up on HostPanel</h1><p>Connect a GitHub repository and deploy, or upload files, to replace this page.</p></main></body></html>`;
}

/** Creates folders, a placeholder release and the runtime config. Safe to run again (used for updates). */
export async function siteProvision({ site }: JobPayloads["site.provision"]): Promise<void> {
  const u = site.linuxUser;
  const root = paths.site(u, site.name);
  await ensureDir(root, 0o750);
  await ensureDir(paths.releases(u, site.name), 0o750);
  await ensureDir(paths.shared(u, site.name), 0o750);
  await ensureDir(paths.logs(u, site.name), 0o750);

  const current = paths.current(u, site.name);
  if (!(await exists(current))) {
    const ph = `${paths.releases(u, site.name)}/${PLACEHOLDER}`;
    const docDir = [ph, site.rootDir, site.publicDir].filter(Boolean).join("/");
    await ensureDir(docDir, 0o750);
    await writeFileAtomic(`${docDir}/index.html`, placeholderHtml(site), 0o640);
    if (site.runtime === "node") {
      await writeFileAtomic(
        `${[ph, site.rootDir].filter(Boolean).join("/")}/server.js`,
        `require("http").createServer((q,s)=>{s.writeHead(200,{"content-type":"text/html"});s.end(require("fs").readFileSync(__dirname+"/index.html"))}).listen(process.env.PORT,"127.0.0.1");\n`,
        0o640,
      );
    }
    await swapSymlink(ph, current);
  }
  await run("chown", ["-R", "--no-dereference", `${u}:${u}`, root]);
  // Caddy reads site files and writes access logs (see accountCreate for why ACLs).
  await run("setfacl", ["-R", "-m", `u:${env.webUser}:rX,d:u:${env.webUser}:rX`, root]);
  await fixLogAcl(u, site.name);

  await removeServiceUnits(site).catch(() => undefined);
  await removePhpPool(site).catch(() => undefined);

  if (site.runtime === "php") {
    await writePhpPool(site);
  } else if (site.runtime === "node" || site.runtime === "python") {
    await writeEnvFile(site);
    const units = await writeServiceUnits(site);
    // Placeholder release for Node has a tiny server so the domain answers before the first deploy.
    if (site.runtime === "node" || (await currentIsDeployed(site))) await run("systemctl", ["restart", ...units], { allowFail: true });
  }
}

async function currentIsDeployed(site: SiteSpec): Promise<boolean> {
  const t = await readLink(paths.current(site.linuxUser, site.name));
  return Boolean(t && !t.endsWith(PLACEHOLDER));
}

export async function siteRemove({ site }: JobPayloads["site.remove"]): Promise<void> {
  await cronRemoveAll(site);
  await removeServiceUnits(site);
  await removePhpPool(site);
  await removePath(paths.site(site.linuxUser, site.name));
}

export async function siteControl({ site, action }: JobPayloads["site.control"]): Promise<void> {
  if (site.runtime === "node" || site.runtime === "python") {
    await writeEnvFile(site); // picks up changed environment variables on restart
    const verb = action === "stop" ? "stop" : action === "start" ? "start" : "restart";
    await run("systemctl", [verb, ...serviceUnits(site)]);
  } else if (site.runtime === "php") {
    await writePhpPool(site); // rewrites env[] and reloads the pool
    if (action === "stop") await removePhpPool(site);
  }
  // static sites have no process; Caddy serves the files directly
}

/**
 * Caddy appends to logs/access.log. A recursive chown/setfacl on the site (provision, restore) turns
 * the existing file into the customer's with read-only access for Caddy, and Caddy then refuses to
 * start. Give Caddy read+write on the folder and every file in it, now and for new files.
 */
export async function fixLogAcl(linuxUser: string, siteName: string): Promise<void> {
  const dir = paths.logs(linuxUser, siteName);
  // the customer owns this tree: never follow a symlink they may have put in place of the folder
  if ((await realpath(sys(dir)).catch(() => null)) !== sys(dir)) return;
  await run("setfacl", ["-R", "-P", "-m", `u:${env.webUser}:rwX,d:u:${env.webUser}:rwX`, dir]);
}
