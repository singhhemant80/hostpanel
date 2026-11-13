import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, post, type Account } from "../api";
import { useAuth } from "../auth";
import { Button, Card, CopyText, Empty, ErrorText, Field, Input, Modal, Select, StatusBadge, Table } from "../components/ui";

interface Db {
  id: string;
  engine: string;
  name: string;
  dbUser: string;
  status: string;
  account: { username: string };
}
interface Creds {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  url: string;
}

export function DatabasesPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["databases"], queryFn: () => api<{ databases: Db[] }>("/databases"), refetchInterval: 8000 });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const [open, setOpen] = useState(false);
  const [engine, setEngine] = useState("mariadb");
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const [creds, setCreds] = useState<Creds | null>(null);

  const create = useMutation({
    mutationFn: () => post<{ database: Db }>("/databases", { engine, name, accountId: accountId || undefined }),
    onSuccess: async (r) => {
      setOpen(false);
      setName("");
      void qc.invalidateQueries({ queryKey: ["databases"] });
      setCreds(await api<Creds>(`/databases/${r.database.id}/credentials`));
    },
  });
  const reveal = useMutation({ mutationFn: (id: string) => api<Creds>(`/databases/${id}/credentials`), onSuccess: setCreds });
  const remove = useMutation({ mutationFn: (id: string) => del(`/databases/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["databases"] }) });
  const active = accounts.data?.accounts.filter((a) => a.status === "active") ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("nav.databases")}</h1>
        <Button onClick={() => setOpen(true)}>+ {t("databases.new")}</Button>
      </div>
      <Card>
        {q.data?.databases.length ? (
          <Table head={[t("databases.name"), t("databases.engine"), t("databases.user"), t("common.status"), ""]}>
            {q.data.databases.map((d) => (
              <tr key={d.id}>
                <td className="px-5 py-3 font-medium">{d.name}</td>
                <td className="px-5 py-3">{d.engine === "mariadb" ? "MariaDB" : "PostgreSQL"}</td>
                <td className="px-5 py-3 font-mono text-xs">{d.dbUser}</td>
                <td className="px-5 py-3">
                  <StatusBadge status={d.status} />
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  <Button variant="ghost" onClick={() => reveal.mutate(d.id)}>
                    {t("databases.showCredentials")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(t("common.confirmDelete", { name: d.name }))) remove.mutate(d.id);
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
      </Card>

      <Modal open={open} title={t("databases.new")} onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          {(user?.role === "admin" || active.length > 1) && (
            <Field label={t("accounts.username")}>
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                <option value="">—</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.username}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("databases.engine")}>
            <Select value={engine} onChange={(e) => setEngine(e.target.value)}>
              <option value="mariadb">MariaDB (MySQL)</option>
              <option value="postgres">PostgreSQL</option>
            </Select>
          </Field>
          <Field label={t("databases.name")} hint="Your account name is added in front, e.g. crapplet_app">
            <Input required pattern="[a-z][a-z0-9_]{1,30}" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </Field>
          <ErrorText error={create.error} />
          <Button type="submit" busy={create.isPending}>
            {t("common.create")}
          </Button>
        </form>
      </Modal>

      <Modal open={!!creds} title={creds?.database ?? ""} onClose={() => setCreds(null)}>
        {creds && (
          <div className="space-y-2 text-sm">
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{t("databases.passwordOnce")}</p>
            {(["host", "port", "database", "user", "password"] as const).map((k) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="text-slate-500">{k}</span>
                <CopyText text={String(creds[k])} />
              </div>
            ))}
            <div className="pt-2">
              <span className="text-slate-500">DATABASE_URL</span>
              <div className="mt-1 break-all">
                <CopyText text={creds.url} />
              </div>
            </div>
          </div>
        )}
      </Modal>
      <ErrorText error={reveal.error ?? remove.error} />
    </div>
  );
}
