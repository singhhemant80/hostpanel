import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, put } from "../api";
import { Button, Card, ErrorText, Field, Input, Select } from "../components/ui";

interface BackupSettings {
  enabled: boolean;
  hour: number;
  keepLocal: number;
  remote: { endpoint: string; region: string; bucket: string; prefix: string; keysSet: boolean } | null;
}

export function ServerSettingsPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">{t("nav.server")}</h1>
      <BackupSettingsCard />
      <DnsSettingsCard />
    </div>
  );
}

function BackupSettingsCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["settings", "backups"], queryFn: () => api<BackupSettings>("/settings/backups") });
  const [f, setF] = useState({ enabled: true, hour: 2, keepLocal: 7, useRemote: false, endpoint: "", region: "auto", bucket: "", prefix: "hostpanel", accessKey: "", secretKey: "" });
  useEffect(() => {
    const d = q.data;
    if (d) setF((x) => ({ ...x, enabled: d.enabled, hour: d.hour, keepLocal: d.keepLocal, useRemote: Boolean(d.remote), ...(d.remote ? { endpoint: d.remote.endpoint, region: d.remote.region, bucket: d.remote.bucket, prefix: d.remote.prefix } : {}) }));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      put("/settings/backups", {
        enabled: f.enabled,
        hour: f.hour,
        keepLocal: f.keepLocal,
        remote: f.useRemote
          ? { endpoint: f.endpoint, region: f.region || "auto", bucket: f.bucket, prefix: f.prefix, ...(f.accessKey ? { accessKey: f.accessKey } : {}), ...(f.secretKey ? { secretKey: f.secretKey } : {}) }
          : null,
      }),
    onSuccess: () => void q.refetch(),
  });
  return (
    <Card title={t("nav.backups")}>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> {t("settings.nightly")}
        </label>
        <Field label={t("settings.hour")}>
          <Select value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("settings.keep")}>
          <Input type="number" min={1} max={60} value={f.keepLocal} onChange={(e) => setF({ ...f, keepLocal: Number(e.target.value) })} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-3">
          <input type="checkbox" checked={f.useRemote} onChange={(e) => setF({ ...f, useRemote: e.target.checked })} /> {t("settings.remote")}
        </label>
        {f.useRemote && (
          <>
            <div className="sm:col-span-2">
              <Field label="Endpoint" hint="e.g. https://s3.us-west-004.backblazeb2.com or https://<id>.r2.cloudflarestorage.com">
                <Input value={f.endpoint} onChange={(e) => setF({ ...f, endpoint: e.target.value.trim() })} />
              </Field>
            </div>
            <Field label="Region">
              <Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value.trim() })} />
            </Field>
            <Field label="Bucket">
              <Input value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value.trim() })} />
            </Field>
            <Field label="Folder prefix">
              <Input value={f.prefix} onChange={(e) => setF({ ...f, prefix: e.target.value.trim() })} />
            </Field>
            <div />
            <Field label="Access key ID" hint={q.data?.remote?.keysSet ? t("settings.keepSecret") : undefined}>
              <Input value={f.accessKey} onChange={(e) => setF({ ...f, accessKey: e.target.value.trim() })} autoComplete="off" />
            </Field>
            <Field label="Secret access key" hint={q.data?.remote?.keysSet ? t("settings.keepSecret") : undefined}>
              <Input type="password" value={f.secretKey} onChange={(e) => setF({ ...f, secretKey: e.target.value.trim() })} autoComplete="off" />
            </Field>
          </>
        )}
      </div>
      <ErrorText error={save.error} />
      <Button className="mt-4" busy={save.isPending} onClick={() => save.mutate()}>
        {t("common.save")}
      </Button>
    </Card>
  );
}

function DnsSettingsCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["settings", "dns"], queryFn: () => api<{ provider: string; tokenSet: boolean; accountId: string | null }>("/settings/dns") });
  const [f, setF] = useState({ provider: "none", apiToken: "", accountId: "" });
  useEffect(() => {
    if (q.data) setF({ provider: q.data.provider, apiToken: "", accountId: q.data.accountId ?? "" });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => put("/settings/dns", { provider: f.provider, ...(f.apiToken ? { apiToken: f.apiToken } : {}), ...(f.accountId ? { accountId: f.accountId } : {}) }),
    onSuccess: () => void q.refetch(),
  });
  return (
    <Card title={t("nav.dns")}>
      <p className="mb-4 text-sm text-slate-600">{t("settings.dnsHint")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            <option value="none">—</option>
            <option value="cloudflare">Cloudflare</option>
          </Select>
        </Field>
        {f.provider === "cloudflare" && (
          <>
            <Field label="API token" hint={q.data?.tokenSet ? t("settings.keepSecret") : "Zone:Read, DNS:Edit (Zone:Edit to create zones)"}>
              <Input type="password" value={f.apiToken} onChange={(e) => setF({ ...f, apiToken: e.target.value.trim() })} autoComplete="off" />
            </Field>
            <Field label="Account ID (optional)" hint={t("settings.cfAccount")}>
              <Input value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value.trim() })} />
            </Field>
          </>
        )}
      </div>
      <ErrorText error={save.error} />
      <Button className="mt-4" busy={save.isPending} onClick={() => save.mutate()}>
        {t("common.save")}
      </Button>
    </Card>
  );
}
