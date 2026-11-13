import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, put } from "../api";
import { useAuth } from "../auth";
import { AccountPicker, formatBytes, useAccountChoice } from "../components/AccountPicker";
import { Badge, Button, Card, CopyText, ErrorText, Field, Input } from "../components/ui";

interface Access {
  sftp: boolean;
  shell: boolean;
  passwordSet: boolean;
  sshKeys: string[];
  host: string | null;
  username: string;
  port: number;
}
interface Usage {
  usage: {
    diskBytes: number | null;
    memoryBytes: number | null;
    cpuSeconds: number | null;
    tasks: number | null;
    units: { unit: string; active: string; memoryBytes: number | null; cpuSeconds: number | null }[];
  };
  limits: { diskMb: number; ramMb: number; cpuPercent: number };
  sites: { id: string; name: string; units: string[] }[];
}

function Meter({ label, used, limit, text }: { label: string; used: number | null; limit: number; text: string }) {
  const pct = used === null ? 0 : Math.min(100, (used / limit) * 100);
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span className="text-slate-600">{label}</span>
        <span className="font-medium">{text}</span>
      </div>
      <div className="h-2 rounded-full bg-slate-100">
        <div className={`h-2 rounded-full ${pct > 90 ? "bg-red-500" : pct > 70 ? "bg-amber-500" : "bg-indigo-500"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AccountAccessPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const choice = useAccountChoice();
  const acc = choice.account;
  const access = useQuery({ queryKey: ["access", acc?.id], queryFn: () => api<Access>(`/accounts/${acc!.id}/access`), enabled: Boolean(acc) });
  const usage = useQuery({ queryKey: ["usage", acc?.id], queryFn: () => api<Usage>(`/accounts/${acc!.id}/usage`), enabled: Boolean(acc), refetchInterval: 30_000 });
  const [form, setForm] = useState({ sftp: false, shell: false, password: "", keys: "" });
  useEffect(() => {
    if (access.data) setForm({ sftp: access.data.sftp, shell: access.data.shell, password: "", keys: access.data.sshKeys.join("\n") });
  }, [access.data]);
  const save = useMutation({
    mutationFn: () =>
      put(`/accounts/${acc!.id}/access`, {
        sftp: form.sftp,
        shell: form.shell,
        ...(form.password ? { password: form.password } : {}),
        sshKeys: form.keys.split("\n").map((k) => k.trim()).filter(Boolean),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["access", acc?.id] }),
  });
  const u = usage.data;
  const memUnits = (u?.usage.units ?? []).filter((x) => x.memoryBytes !== null);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("nav.access")}</h1>
        <AccountPicker choice={choice} />
      </div>

      <Card title={t("access.usage")}>
        {u ? (
          <div className="space-y-4">
            <Meter label={t("access.disk")} used={u.usage.diskBytes} limit={u.limits.diskMb * 1048576} text={`${formatBytes(u.usage.diskBytes)} / ${formatBytes(u.limits.diskMb * 1048576)}`} />
            <Meter label={t("access.ram")} used={u.usage.memoryBytes} limit={u.limits.ramMb * 1048576} text={`${formatBytes(u.usage.memoryBytes)} / ${formatBytes(u.limits.ramMb * 1048576)}`} />
            <p className="text-xs text-slate-500">
              CPU {t("access.limit")}: {u.limits.cpuPercent}% · {t("access.cpuUsed")}: {u.usage.cpuSeconds ?? "—"}s · {t("access.processes")}: {u.usage.tasks ?? "—"}
            </p>
            {memUnits.length > 0 && (
              <ul className="divide-y divide-slate-100 text-sm">
                {memUnits.map((x) => (
                  <li key={x.unit} className="flex justify-between py-1.5">
                    <span className="font-mono text-xs">{x.unit.replace(/^hp-[^-]+-/, "").replace(/\.service$/, "")}</span>
                    <span>
                      <Badge tone={x.active === "active" ? "green" : "gray"}>{x.active}</Badge> {formatBytes(x.memoryBytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500">{usage.error ? (usage.error as Error).message : t("common.loading")}</p>
        )}
      </Card>

      <Card title={t("access.title")}>
        {access.data && (
          <div className="space-y-4">
            <div className="grid gap-2 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-3">
              <span>
                {t("access.host")}: <CopyText text={access.data.host ?? "—"} />
              </span>
              <span>
                {t("access.user")}: <CopyText text={access.data.username} />
              </span>
              <span>
                {t("access.port")}: <CopyText text={String(access.data.port)} />
              </span>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.sftp} onChange={(e) => setForm({ ...form, sftp: e.target.checked })} /> {t("access.sftp")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.shell}
                disabled={user?.role !== "admin" && !access.data.shell}
                onChange={(e) => setForm({ ...form, shell: e.target.checked, sftp: e.target.checked || form.sftp })}
              />
              {t("access.shell")}
              {user?.role !== "admin" && !access.data.shell && <span className="text-xs text-slate-500">({t("access.shellAdmin")})</span>}
            </label>
            <Field label={access.data.passwordSet ? t("access.newPassword") : t("access.password")} hint={t("access.passwordHint")}>
              <Input type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
            <Field label={t("access.keys")} hint={t("access.keysHint")}>
              <textarea value={form.keys} onChange={(e) => setForm({ ...form, keys: e.target.value })} rows={4} className="block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" placeholder="ssh-ed25519 AAAA... you@laptop" />
            </Field>
            <ErrorText error={save.error} />
            <Button busy={save.isPending} onClick={() => save.mutate()}>
              {t("common.save")}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
