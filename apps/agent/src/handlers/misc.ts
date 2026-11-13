import { hostname, loadavg, totalmem, freemem, uptime, cpus } from "node:os";
import { statfs } from "node:fs/promises";
import type { JobPayloads, SystemStats } from "@hostpanel/shared";
import { decrypt } from "../env.js";
import { run } from "../exec.js";
import { applyCaddyfile, buildCaddyfile, writeCustomCerts } from "../caddy.js";

export async function routesSync(p: JobPayloads["routes.sync"]): Promise<{ routes: number }> {
  await writeCustomCerts(p.routes);
  await applyCaddyfile(buildCaddyfile(p.routes, p.panelHostname, p.acmeEmail, p.dnsTokenEnc ? decrypt(p.dnsTokenEnc) : null));
  return { routes: p.routes.length };
}

/** Names and users are validated identifiers; the password is alphanumeric and goes in via stdin. */
export async function dbCreate(p: JobPayloads["db.create"]): Promise<void> {
  const pw = decrypt(p.passwordEnc);
  if (!/^[A-Za-z0-9]{12,64}$/.test(pw)) throw new Error("Generated password has an unexpected format");
  if (p.engine === "mariadb") {
    await run("mariadb", ["--batch"], {
      input: `CREATE DATABASE IF NOT EXISTS \`${p.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${p.user}'@'localhost' IDENTIFIED BY '${pw}';
ALTER USER '${p.user}'@'localhost' IDENTIFIED BY '${pw}';
GRANT ALL PRIVILEGES ON \`${p.name}\`.* TO '${p.user}'@'localhost';
FLUSH PRIVILEGES;
`,
    });
  } else {
    await run("runuser", ["-u", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1", "-q"], {
      input: `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${p.user}') THEN CREATE ROLE "${p.user}" LOGIN PASSWORD '${pw}';
  ELSE ALTER ROLE "${p.user}" LOGIN PASSWORD '${pw}'; END IF;
END $$;
SELECT 'CREATE DATABASE "${p.name}" OWNER "${p.user}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${p.name}')\\gexec
REVOKE ALL ON DATABASE "${p.name}" FROM PUBLIC;
`,
    });
  }
}

export async function dbDelete(p: JobPayloads["db.delete"]): Promise<void> {
  if (p.engine === "mariadb") {
    await run("mariadb", ["--batch"], {
      input: `DROP DATABASE IF EXISTS \`${p.name}\`;\nDROP USER IF EXISTS '${p.user}'@'localhost';\n`,
    });
  } else {
    await run("runuser", ["-u", "postgres", "--", "psql", "-v", "ON_ERROR_STOP=1", "-q"], {
      input: `DROP DATABASE IF EXISTS "${p.name}" WITH (FORCE);\nDROP ROLE IF EXISTS "${p.user}";\n`,
    });
  }
}

export async function systemStats(): Promise<SystemStats> {
  const fs = await statfs("/");
  const [a, b, c] = loadavg();
  return {
    hostname: hostname(),
    uptimeSec: Math.round(uptime()),
    load: [a!, b!, c!],
    memTotalMb: Math.round(totalmem() / 1048576),
    memFreeMb: Math.round(freemem() / 1048576),
    diskTotalGb: Math.round((fs.blocks * fs.bsize) / 1e9),
    diskFreeGb: Math.round((fs.bavail * fs.bsize) / 1e9),
    cpus: cpus().length,
  };
}
