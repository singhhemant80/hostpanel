import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, patch, post, type Package } from "../api";
import { Button, Card, ErrorText, Field, Input, Modal, Table } from "../components/ui";

const blank = { name: "", diskMb: 5000, bandwidthGb: 100, maxSites: 1, maxDomains: 3, maxDatabases: 1, cpuPercent: 50, ramMb: 512 };
const numeric: { key: keyof typeof blank; label: string }[] = [
  { key: "diskMb", label: "Disk (MB)" },
  { key: "bandwidthGb", label: "Bandwidth (GB/month)" },
  { key: "maxSites", label: "Sites" },
  { key: "maxDomains", label: "Domains" },
  { key: "maxDatabases", label: "Databases" },
  { key: "cpuPercent", label: "CPU (% of one core)" },
  { key: "ramMb", label: "RAM (MB)" },
];

export function PackagesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["packages"], queryFn: () => api<{ packages: Package[] }>("/packages") });
  const [editing, setEditing] = useState<(typeof blank & { id?: string }) | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const { id, ...body } = editing!;
      return id ? patch(`/packages/${id}`, body) : post("/packages", body);
    },
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ["packages"] });
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/packages/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["packages"] }) });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("nav.packages")}</h1>
        <Button onClick={() => setEditing({ ...blank })}>+ {t("packages.new")}</Button>
      </div>
      <Card>
        <Table head={["Name", "Disk", "Sites / domains / DBs", "CPU · RAM", "Accounts", ""]}>
          {q.data?.packages.map((p) => (
            <tr key={p.id}>
              <td className="px-5 py-3 font-medium">{p.name}</td>
              <td className="px-5 py-3">{(p.diskMb / 1000).toFixed(0)} GB</td>
              <td className="px-5 py-3">
                {p.maxSites} / {p.maxDomains} / {p.maxDatabases}
              </td>
              <td className="px-5 py-3">
                {p.cpuPercent}% · {p.ramMb >= 1024 ? `${p.ramMb / 1024} GB` : `${p.ramMb} MB`}
              </td>
              <td className="px-5 py-3">{p.accountCount ?? 0}</td>
              <td className="whitespace-nowrap px-5 py-3 text-right">
                <Button variant="ghost" onClick={() => setEditing({ ...p })}>
                  Edit
                </Button>
                <Button variant="ghost" className="text-red-600" disabled={!!p.accountCount} onClick={() => remove.mutate(p.id)}>
                  {t("common.delete")}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        <ErrorText error={remove.error} />
      </Card>
      <Modal open={!!editing} title={editing?.id ? editing.name : t("packages.new")} onClose={() => setEditing(null)}>
        {editing && (
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <div className="sm:col-span-2">
              <Field label="Name">
                <Input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </Field>
            </div>
            {numeric.map((n) => (
              <Field key={n.key} label={n.label}>
                <Input type="number" min={0} required value={editing[n.key]} onChange={(e) => setEditing({ ...editing, [n.key]: Number(e.target.value) })} />
              </Field>
            ))}
            <div className="sm:col-span-2">
              <ErrorText error={save.error} />
              <Button type="submit" busy={save.isPending} className="mt-2">
                {t("common.save")}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
