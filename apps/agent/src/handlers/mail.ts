import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { JobPayloads } from "@hostpanel/shared";
import { env, sys } from "../env.js";
import { run } from "../exec.js";
import { exists, removePath, writeFileAtomic } from "../fsx.js";

/**
 * Email: Postfix (SMTP) + Dovecot (IMAP/POP3, LMTP delivery, quota) + Rspamd (spam, DKIM signing).
 * The agent writes flat lookup files from the database; Postfix reads them as `texthash:` tables
 * (no postmap step) and Dovecot re-reads its passwd-file when it changes. install.sh wires the
 * daemons to these files once.
 */
export const MAIL_DIR = "/etc/hostpanel/mail";
export const VMAIL_DIR = "/var/mail/vhosts";
const DKIM_DIR = "/var/lib/rspamd/dkim";

export async function mailSync(p: JobPayloads["mail.sync"]): Promise<{ domains: number; mailboxes: number; aliases: number }> {
  const enabled = p.mailboxes.filter((m) => m.enabled);
  const domainsWithCatchAll = new Set(p.domains.filter((d) => d.catchAll).map((d) => d.name));

  const domains = p.domains.map((d) => `${d.name} OK`);
  const mailboxes = enabled.map((m) => {
    const [local, domain] = m.address.split("@");
    return `${m.address} ${domain}/${local}/`;
  });
  const aliases: string[] = [];
  for (const a of p.aliases) aliases.push(`${a.source} ${a.destinations.join(",")}`);
  // A catch-all ("@domain") would also swallow real mailboxes, so map each mailbox to itself first.
  for (const m of enabled) if (domainsWithCatchAll.has(m.address.split("@")[1]!)) aliases.push(`${m.address} ${m.address}`);
  for (const d of p.domains) if (d.catchAll) aliases.push(`@${d.name} ${d.catchAll}`);

  // Who may send as which address (submission port): a mailbox as itself, and as aliases that deliver to it.
  const senders = new Map<string, Set<string>>();
  for (const m of enabled) senders.set(m.address, new Set([m.address]));
  for (const a of p.aliases) {
    for (const dest of a.destinations) if (senders.has(dest)) (senders.get(a.source) ?? senders.set(a.source, new Set()).get(a.source)!).add(dest);
  }

  const passwd = enabled.map((m) => `${m.address}:{BLF-CRYPT}${m.passwordHash}::::::userdb_quota_rule=*:storage=${m.quotaMb}M`);

  await writeFileAtomic(`${MAIL_DIR}/domains`, lines(domains), 0o644);
  await writeFileAtomic(`${MAIL_DIR}/mailboxes`, lines(mailboxes), 0o644);
  await writeFileAtomic(`${MAIL_DIR}/aliases`, lines(aliases), 0o644);
  await writeFileAtomic(`${MAIL_DIR}/senders`, lines([...senders].map(([addr, owners]) => `${addr} ${[...owners].join(",")}`)), 0o644);
  // password hashes: readable by root and the dovecot group only
  await writeFileAtomic(`${MAIL_DIR}/passwd`, lines(passwd), 0o640);
  await run("chgrp", ["dovecot", `${MAIL_DIR}/passwd`], { allowFail: true });
  await writeFileAtomic(`${MAIL_DIR}/mailhost`, `${p.mailHost}\n`, 0o644);

  // texthash tables are loaded when Postfix processes start; reload makes new ones pick them up
  await run("postfix", ["reload"], { allowFail: true });
  return { domains: domains.length, mailboxes: mailboxes.length, aliases: aliases.length };
}

function lines(l: string[]): string {
  return l.length ? `${l.join("\n")}\n` : "";
}

/** DKIM: the private key stays on the server (read by Rspamd); the public part goes in DNS. */
export async function mailDkim(p: JobPayloads["mail.dkim"]): Promise<{ name: string; value: string }> {
  const keyFile = `${DKIM_DIR}/${p.domain}.${p.selector}.key`;
  if (!(await exists(keyFile))) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFileAtomic(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }) as string, 0o640);
    await run("chown", ["_rspamd:_rspamd", keyFile], { allowFail: true });
  }
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const pub = createPublicKey(createPrivateKey(await readFile(sys(keyFile), "utf8")));
  const der = pub.export({ type: "spki", format: "der" }).toString("base64");
  return { name: `${p.selector}._domainkey.${p.domain}`, value: `v=DKIM1; k=rsa; p=${der}` };
}

export async function mailPurge(p: JobPayloads["mail.purge"]): Promise<void> {
  const [local, domain] = p.address.split("@");
  await removePath(`${VMAIL_DIR}/${domain}/${local}`);
}

/** Storage used per mailbox (Dovecot quota). */
export async function mailUsage(p: JobPayloads["mail.usage"]): Promise<Record<string, { usedMb: number; limitMb: number | null }>> {
  const out: Record<string, { usedMb: number; limitMb: number | null }> = {};
  for (const addr of p.addresses) {
    const r = await run("doveadm", ["-f", "tab", "quota", "get", "-u", addr], { allowFail: true, alwaysRun: !env.dryRun });
    // columns: Quota name, Type, Value, Limit, % ; Value/Limit in KiB for STORAGE
    const row = r.stdout.split("\n").find((l) => l.split("\t")[1] === "STORAGE");
    if (!row) continue;
    const [, , value, limit] = row.split("\t");
    out[addr] = { usedMb: Math.round(Number(value) / 1024), limitMb: limit && limit !== "-" ? Math.round(Number(limit) / 1024) : null };
  }
  return out;
}
