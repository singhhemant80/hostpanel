import { eq } from "drizzle-orm";
import type { RemoteSpec } from "@hostpanel/shared";
import { db, schema } from "./db.js";

/** Stored shapes. Secrets are kept encrypted (fields ending in Enc). */
export interface BackupSettingsStored {
  enabled: boolean;
  hour: number;
  keepLocal: number;
  remote: (Omit<RemoteSpec, "accessKeyEnc" | "secretKeyEnc"> & { accessKeyEnc: string | null; secretKeyEnc: string | null }) | null;
  lastScheduledDate?: string;
}
export interface DnsSettingsStored {
  provider: "none" | "cloudflare";
  apiTokenEnc: string | null;
  accountId: string | null;
}

const DEFAULTS = {
  backups: { enabled: true, hour: 2, keepLocal: 7, remote: null } as BackupSettingsStored,
  dns: { provider: "none", apiTokenEnc: null, accountId: null } as DnsSettingsStored,
};
type Key = keyof typeof DEFAULTS;

export async function getSetting<K extends Key>(key: K): Promise<(typeof DEFAULTS)[K]> {
  const row = await db.query.settings.findFirst({ where: eq(schema.settings.key, key) });
  return { ...DEFAULTS[key], ...((row?.value as object) ?? {}) } as (typeof DEFAULTS)[K];
}

export async function setSetting<K extends Key>(key: K, value: (typeof DEFAULTS)[K]): Promise<void> {
  await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

/** Remote spec for the agent, or null when no complete remote is configured. */
export function remoteSpec(s: BackupSettingsStored): RemoteSpec | null {
  const r = s.remote;
  if (!r || !r.accessKeyEnc || !r.secretKeyEnc) return null;
  return { endpoint: r.endpoint, region: r.region, bucket: r.bucket, prefix: r.prefix, accessKeyEnc: r.accessKeyEnc, secretKeyEnc: r.secretKeyEnc };
}
