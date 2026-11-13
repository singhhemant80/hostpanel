import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, post } from "../api";
import { useAuth } from "../auth";
import { AccountPicker, formatBytes, useAccountChoice } from "../components/AccountPicker";
import { Badge, Button, Card, Empty, ErrorText, Modal, StatusBadge, Table, timeAgo } from "../components/ui";

interface Backup {
  id: string;
  accountId: string;
  trigger: string;
  status: string;
  fileName: string | null;
  sizeBytes: number | null;
  remote: boolean;
  contents: { sites: string[]; databases: { engine: string; name: string }[] } | null;
  error: string | null;
  createdAt: string;
  account: { username: string };
}

export function BackupsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const choice = useAccountChoice();
  const q = useQuery({
    queryKey: ["backups"],
    queryFn: () => api<{ backups: Backup[] }>("/backups"),
    refetchInterval: (query) => (query.state.data?.backups.some((b) => ["queued", "running", "restoring", "deleting"].includes(b.status)) ? 3000 : 15_000),
  });
  const [restore, setRestore] = useState<Backup | null>(null);
  const run = useMutation({ mutationFn: () => post(`/accounts/${choice.account!.id}/backups`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["backups"] }) });
  const remove = useMutation({ mutationFn: (id: string) => del(`/backups/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["backups"] }) });
  const list = (q.data?.backups ?? []).filter((b) => user?.role !== "admin" || choice.accounts.length <= 1 || b.accountId === choice.account?.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("nav.backups")}</h1>
        <div className="flex items-center gap-3">
          <AccountPicker choice={choice} />
          <Button busy={run.isPending} disabled={!choice.account} onClick={() => run.mutate()}>
            {t("backups.now")}
          </Button>
        </div>
      </div>
      <ErrorText error={run.error ?? remove.error} />
      <Card>
        {list.length ? (
          <Table head={[t("backups.when"), t("backups.contents"), t("files.size"), t("common.status"), ""]}>
            {list.map((b) => (
              <tr key={b.id} className="align-top">
                <td className="whitespace-nowrap px-5 py-3">
                  <p className="font-medium">{new Date(b.createdAt).toLocaleString()}</p>
                  <p className="text-xs text-slate-500">
                    {b.trigger} · {b.account.username}
                  </p>
                </td>
                <td className="px-5 py-3 text-xs text-slate-600">
                  {b.contents?.sites.length ?? 0} sites, {b.contents?.databases.length ?? 0} DBs
                  {b.remote && (
                    <span className="ml-2">
                      <Badge tone="blue">remote</Badge>
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-5 py-3">{formatBytes(b.sizeBytes)}</td>
                <td className="px-5 py-3">
                  <StatusBadge status={b.status} />
                  {b.error && <p className="mt-1 max-w-xs text-xs text-red-600">{b.error}</p>}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  {b.status === "done" && (
                    <>
                      <a href={`/api/v1/backups/${b.id}/download`} className="mr-1 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
                        {t("backups.download")}
                      </a>
                      <Button variant="ghost" onClick={() => setRestore(b)}>
                        {t("backups.restore")}
                      </Button>
                    </>
                  )}
                  {!["queued", "running", "restoring", "deleting"].includes(b.status) && (
                    <Button
                      variant="ghost"
                      className="text-red-600"
                      onClick={() => {
                        if (confirm(t("common.confirmDelete", { name: b.fileName ?? "backup" }))) remove.mutate(b.id);
                      }}
                    >
                      {t("common.delete")}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{t("backups.none")}</Empty>
        )}
      </Card>
      <p className="text-xs text-slate-500">{t("backups.hint")}</p>
      <Modal open={!!restore} title={t("backups.restore")} onClose={() => setRestore(null)}>
        {restore && <RestoreForm backup={restore} onDone={() => setRestore(null)} />}
      </Modal>
    </div>
  );
}

function RestoreForm({ backup, onDone }: { backup: Backup; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [sites, setSites] = useState<string[]>([]);
  const [dbs, setDbs] = useState<string[]>([]);
  const go = useMutation({
    mutationFn: () => post(`/backups/${backup.id}/restore`, { sites, databases: dbs }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backups"] });
      onDone();
    },
  });
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="space-y-4 text-sm">
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">{t("backups.restoreWarn")}</p>
      <div>
        <p className="mb-1 font-medium">{t("nav.sites")}</p>
        {backup.contents?.sites.map((s) => (
          <label key={s} className="flex items-center gap-2 py-0.5">
            <input type="checkbox" checked={sites.includes(s)} onChange={() => toggle(sites, setSites, s)} /> {s}
          </label>
        ))}
      </div>
      <div>
        <p className="mb-1 font-medium">{t("nav.databases")}</p>
        {backup.contents?.databases.length ? (
          backup.contents.databases.map((d) => (
            <label key={d.name} className="flex items-center gap-2 py-0.5">
              <input type="checkbox" checked={dbs.includes(d.name)} onChange={() => toggle(dbs, setDbs, d.name)} /> {d.name} <span className="text-slate-400">({d.engine})</span>
            </label>
          ))
        ) : (
          <p className="text-slate-500">—</p>
        )}
      </div>
      <ErrorText error={go.error} />
      <Button variant="danger" busy={go.isPending} disabled={!sites.length && !dbs.length} onClick={() => go.mutate()}>
        {t("backups.restore")}
      </Button>
    </div>
  );
}
