import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, post, type Account, type Package } from "../api";
import { useAuth } from "../auth";
import { Button, Card, Empty, ErrorText, Field, Input, Modal, Select, StatusBadge, Table, timeAgo } from "../components/ui";

export function AccountsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const servers = useQuery({
    queryKey: ["servers"],
    queryFn: () => api<{ servers: { id: string; name: string; hostname: string; joined: boolean; isMain: boolean }[] }>("/servers"),
    enabled: isAdmin,
  });
  const reseller = useQuery({
    queryKey: ["reseller-me"],
    queryFn: () => api<{ reseller: { limits: { maxAccounts: number; maxDiskMb: number } | null; usage: { accounts: number; diskMb: number } } | null }>("/reseller/me"),
    enabled: user?.role === "reseller",
  });
  const q = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts"), refetchInterval: 8000 });
  const pkgs = useQuery({ queryKey: ["packages"], queryFn: () => api<{ packages: Package[] }>("/packages") });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", username: "", password: "", packageId: "", locale: "en", serverId: "" });

  const create = useMutation({
    mutationFn: () => post("/accounts", { ...form, serverId: form.serverId || undefined }),
    onSuccess: () => {
      setOpen(false);
      setForm({ name: "", email: "", username: "", password: "", packageId: "", locale: "en", serverId: "" });
      void qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
  const suspend = useMutation({
    mutationFn: (a: Account) => post(`/accounts/${a.id}/suspend`, { suspended: a.status !== "suspended" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/accounts/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["accounts"] }) });
  const set = (k: keyof typeof form, v: string) => setForm({ ...form, [k]: v });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("nav.accounts")}</h1>
        <Button onClick={() => setOpen(true)}>+ {t("accounts.new")}</Button>
      </div>
      {reseller.data?.reseller?.limits && (
        <p className="rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
          {t("resellers.myUsage", {
            accounts: reseller.data.reseller.usage.accounts,
            maxAccounts: reseller.data.reseller.limits.maxAccounts,
            disk: Math.round(reseller.data.reseller.usage.diskMb / 1000),
            maxDisk: Math.round(reseller.data.reseller.limits.maxDiskMb / 1000),
          })}
        </p>
      )}
      <Card>
        {q.data?.accounts.length ? (
          <Table head={[t("accounts.username"), "Owner", t("accounts.package"), "Usage", t("common.status"), ""]}>
            {q.data.accounts.map((a) => (
              <tr key={a.id}>
                <td className="px-5 py-3">
                  <p className="font-medium">{a.username}</p>
                  <p className="font-mono text-xs text-slate-500">{a.linuxUser}</p>
                </td>
                <td className="px-5 py-3">
                  <p>{a.user.name}</p>
                  <p className="text-xs text-slate-500">{a.user.email}</p>
                  {isAdmin && a.reseller && <p className="text-xs text-indigo-600">{t("resellers.via", { name: a.reseller.name })}</p>}
                  {isAdmin && (servers.data?.servers.length ?? 0) > 1 && (
                    <p className="text-xs text-slate-400">{servers.data?.servers.find((s) => s.id === a.serverId)?.name ?? ""}</p>
                  )}
                </td>
                <td className="px-5 py-3">{a.package.name}</td>
                <td className="px-5 py-3 text-xs text-slate-600">
                  {a.counts.sites}/{a.package.maxSites} sites · {a.counts.domains}/{a.package.maxDomains} domains · {a.counts.databases}/{a.package.maxDatabases} DBs
                </td>
                <td className="px-5 py-3">
                  <StatusBadge status={a.status} />
                  <p className="text-xs text-slate-400">{timeAgo(a.createdAt)}</p>
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  <Button variant="ghost" onClick={() => suspend.mutate(a)} disabled={a.status !== "active" && a.status !== "suspended"}>
                    {a.status === "suspended" ? t("accounts.unsuspend") : t("accounts.suspend")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(t("common.confirmDelete", { name: a.username }))) remove.mutate(a.id);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{t("common.none")}</Empty>
        )}
        <ErrorText error={suspend.error ?? remove.error} />
      </Card>

      <Modal open={open} title={t("accounts.new")} onClose={() => setOpen(false)}>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <Field label="Name">
            <Input required value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Email">
            <Input required type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label={t("accounts.username")} hint="Becomes the Linux user hp_<name>">
            <Input required pattern="[a-z][a-z0-9_-]{1,23}" value={form.username} onChange={(e) => set("username", e.target.value.toLowerCase())} />
          </Field>
          <Field label="Password" hint="10+ characters">
            <Input required minLength={10} type="password" value={form.password} onChange={(e) => set("password", e.target.value)} />
          </Field>
          <Field label={t("accounts.package")}>
            <Select required value={form.packageId} onChange={(e) => set("packageId", e.target.value)}>
              <option value="">—</option>
              {pkgs.data?.packages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {isAdmin && (servers.data?.servers.filter((s) => s.joined).length ?? 0) > 1 && (
            <Field label={t("servers.server")}>
              <Select value={form.serverId} onChange={(e) => set("serverId", e.target.value)}>
                {servers.data?.servers
                  .filter((s) => s.joined)
                  .map((s) => (
                    <option key={s.id} value={s.isMain ? "" : s.id}>
                      {s.name || s.hostname}
                      {s.isMain ? " (main)" : ""}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          <Field label="Language">
            <Select value={form.locale} onChange={(e) => set("locale", e.target.value)}>
              <option value="en">English</option>
              <option value="hi">हिन्दी</option>
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <ErrorText error={create.error} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" busy={create.isPending}>
              {t("common.create")}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
