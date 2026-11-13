import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, patch, post, type Package } from "../api";
import { Button, Card, Empty, ErrorText, Field, Input, Modal, StatusBadge, Table } from "../components/ui";

interface Reseller {
  id: string;
  email: string;
  name: string;
  status: string;
  resellerLimits: { maxAccounts: number; maxDiskMb: number; packageIds: string[] } | null;
  usage: { accounts: number; diskMb: number };
}

const blank = { name: "", email: "", password: "", maxAccounts: 10, maxDiskMb: 50000, packageIds: [] as string[] };

export function ResellersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["resellers"], queryFn: () => api<{ resellers: Reseller[] }>("/resellers") });
  const pkgs = useQuery({ queryKey: ["packages"], queryFn: () => api<{ packages: Package[] }>("/packages") });
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<Reseller | "new" | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["resellers"] });

  const save = useMutation({
    mutationFn: () =>
      editing === "new"
        ? post("/resellers", form)
        : patch(`/resellers/${(editing as Reseller).id}`, { maxAccounts: form.maxAccounts, maxDiskMb: form.maxDiskMb, packageIds: form.packageIds }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const status = useMutation({ mutationFn: (r: Reseller) => post(`/resellers/${r.id}/status`, { active: r.status !== "active" }), onSuccess: refresh });

  const openEdit = (r: Reseller | "new") => {
    setForm(r === "new" ? blank : { ...blank, name: r.name, email: r.email, maxAccounts: r.resellerLimits?.maxAccounts ?? 10, maxDiskMb: r.resellerLimits?.maxDiskMb ?? 50000, packageIds: r.resellerLimits?.packageIds ?? [] });
    setEditing(r);
  };
  const pkgName = (id: string) => pkgs.data?.packages.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("nav.resellers")}</h1>
          <p className="text-sm text-slate-500">{t("resellers.intro")}</p>
        </div>
        <Button onClick={() => openEdit("new")}>+ {t("resellers.new")}</Button>
      </div>
      <Card>
        {q.data?.resellers.length ? (
          <Table head={[t("resellers.name"), t("resellers.usage"), t("resellers.packages"), t("common.status"), ""]}>
            {q.data.resellers.map((r) => (
              <tr key={r.id}>
                <td className="px-5 py-3">
                  <p className="font-medium">{r.name}</p>
                  <p className="text-xs text-slate-500">{r.email}</p>
                </td>
                <td className="px-5 py-3 text-xs text-slate-600">
                  {r.usage.accounts}/{r.resellerLimits?.maxAccounts} {t("nav.accounts").toLowerCase()} · {Math.round(r.usage.diskMb / 1000)}/{Math.round((r.resellerLimits?.maxDiskMb ?? 0) / 1000)} GB
                </td>
                <td className="px-5 py-3 text-xs">{r.resellerLimits?.packageIds.map(pkgName).join(", ")}</td>
                <td className="px-5 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  <Button variant="ghost" onClick={() => openEdit(r)}>
                    {t("resellers.limits")}
                  </Button>
                  <Button variant="ghost" onClick={() => status.mutate(r)}>
                    {r.status === "active" ? t("accounts.suspend") : t("accounts.unsuspend")}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{t("common.none")}</Empty>
        )}
        <ErrorText error={status.error} />
      </Card>

      <Modal open={!!editing} title={editing === "new" ? t("resellers.new") : form.name} onClose={() => setEditing(null)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {editing === "new" && (
            <>
              <Field label={t("resellers.name")}>
                <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={t("login.email")}>
                <Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label={t("login.password")}>
                <Input required minLength={10} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("resellers.maxAccounts")}>
              <Input type="number" min={1} value={form.maxAccounts} onChange={(e) => setForm({ ...form, maxAccounts: Number(e.target.value) })} />
            </Field>
            <Field label={t("resellers.maxDisk")}>
              <Input type="number" min={100} value={form.maxDiskMb} onChange={(e) => setForm({ ...form, maxDiskMb: Number(e.target.value) })} />
            </Field>
          </div>
          <Field label={t("resellers.packages")} hint={t("resellers.packagesHint")}>
            <div className="space-y-1">
              {pkgs.data?.packages.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.packageIds.includes(p.id)}
                    onChange={(e) => setForm({ ...form, packageIds: e.target.checked ? [...form.packageIds, p.id] : form.packageIds.filter((x) => x !== p.id) })}
                  />
                  {p.name}
                </label>
              ))}
            </div>
          </Field>
          <ErrorText error={save.error} />
          <Button type="submit" busy={save.isPending} disabled={!form.packageIds.length}>
            {t("common.save")}
          </Button>
        </form>
      </Modal>
    </div>
  );
}
