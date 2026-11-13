import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db, schema } from "./db.js";
import { enqueue } from "./queue.js";

/** All mail runs on the main server; MX records point at the panel's hostname. */
export function mailHost(): string {
  return config.panelHostname ?? "localhost";
}

export const DKIM_SELECTOR = "hostpanel";

/** Rewrite the server's whole mail configuration from the database (idempotent). */
export async function syncMail(createdBy?: string): Promise<string> {
  const domains = await db.query.mailDomains.findMany({ with: { account: { columns: { status: true } }, mailboxes: true, aliases: true } });
  const live = domains.filter((d) => d.account.status === "active");
  return enqueue(
    "mail.sync",
    {
      mailHost: mailHost(),
      domains: live.map((d) => ({ name: d.name, catchAll: d.catchAll })),
      mailboxes: live.flatMap((d) => d.mailboxes.map((m) => ({ address: m.address, passwordHash: m.passwordHash, quotaMb: m.quotaMb, enabled: m.enabled }))),
      aliases: live.flatMap((d) => d.aliases.map((a) => ({ source: a.source, destinations: a.destinations }))),
    },
    { dedupeKey: "mail.sync", targetType: "server", createdBy, serverId: null },
  );
}

export interface DnsRecordSuggestion {
  type: "MX" | "TXT";
  name: string;
  content: string;
  priority?: number;
  purpose: string;
}

/** Records a mail domain needs: MX (receive), SPF + DKIM + DMARC (deliverability). */
export function mailDnsRecords(domain: string, dkimRecord: string | null): DnsRecordSuggestion[] {
  const host = mailHost();
  return [
    { type: "MX", name: domain, content: host, priority: 10, purpose: "Receive mail on this server" },
    { type: "TXT", name: domain, content: `v=spf1 mx a:${host} ~all`, purpose: "SPF: this server may send for the domain" },
    ...(dkimRecord ? [{ type: "TXT" as const, name: `${DKIM_SELECTOR}._domainkey.${domain}`, content: dkimRecord, purpose: "DKIM: signature on outgoing mail" }] : []),
    { type: "TXT", name: `_dmarc.${domain}`, content: `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:postmaster@${domain}`, purpose: "DMARC: tell receivers what to do with failing mail" },
  ];
}

export async function mailboxCount(accountId: string): Promise<number> {
  const domains = await db.query.mailDomains.findMany({ where: eq(schema.mailDomains.accountId, accountId), with: { mailboxes: { columns: { id: true } } } });
  return domains.reduce((n, d) => n + d.mailboxes.length, 0);
}
