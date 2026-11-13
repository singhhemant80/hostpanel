import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, post, put } from "../api";
import { AccountPicker, useAccountChoice } from "../components/AccountPicker";
import { Badge, Button, Card, CopyText, Empty, ErrorText, Field, Input, Modal, Select, Table, cx } from "../components/ui";

interface Zone {
  id: string;
  name: string;
  status: string;
  nameservers: string[];
  account?: { username: string };
}
interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  priority?: number;
  proxied?: boolean;
  proxiable?: boolean;
}
const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV", "CAA", "NS"];

export function DnsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const choice = useAccountChoice();
  const zones = useQuery({ queryKey: ["zones"], queryFn: () => api<{ configured: boolean; zones: Zone[] }>("/dns/zones") });
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => post<{ zone: Zone }>("/dns/zones", { name, accountId: choice.account?.id }),
    onSuccess: (r) => {
      setName("");
      setZoneId(r.zone.id);
      void qc.invalidateQueries({ queryKey: ["zones"] });
    },
  });
  const current = zones.data?.zones.find((z) => z.id === zoneId) ?? zones.data?.zones[0];

  if (zones.data && !zones.data.configured) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold">{t("nav.dns")}</h1>
        <Card>
          <p className="text-sm text-slate-600">{t("dns.notConfigured")}</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("nav.dns")}</h1>
        <AccountPicker choice={choice} />
      </div>
      <Card title={t("dns.addZone")}>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="min-w-[16rem] flex-1">
            <Field label={t("domains.hostname")} hint={t("dns.addZoneHint")}>
              <Input required value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} placeholder="example.com" />
            </Field>
          </div>
          <Button type="submit" busy={add.isPending}>
            {t("common.add")}
          </Button>
        </form>
        <ErrorText error={add.error} />
      </Card>

      {zones.data?.zones.length ? (
        <div className="flex flex-wrap gap-2">
          {zones.data.zones.map((z) => (
            <button
              key={z.id}
              onClick={() => setZoneId(z.id)}
              className={cx("rounded-lg border px-3 py-1.5 text-sm font-medium", current?.id === z.id ? "border-indigo-500 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white hover:border-slate-300")}
            >
              {z.name}
            </button>
          ))}
        </div>
      ) : null}
      {current && <ZoneRecords zone={current} />}
    </div>
  );
}

function ZoneRecords({ zone }: { zone: Zone }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["records", zone.id], queryFn: () => api<{ zone: Zone; records: DnsRecord[] }>(`/dns/zones/${zone.id}/records`) });
  const [editing, setEditing] = useState<Partial<DnsRecord> | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["records", zone.id] });
  const save = useMutation({
    mutationFn: (r: Partial<DnsRecord>) => {
      const body = { type: r.type, name: r.name, content: r.content, ttl: r.ttl ?? 1, priority: r.priority, proxied: r.proxied };
      return r.id ? put(`/dns/zones/${zone.id}/records/${r.id}`, body) : post(`/dns/zones/${zone.id}/records`, body);
    },
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/dns/zones/${zone.id}/records/${id}`), onSuccess: refresh });
  const template = useMutation({ mutationFn: (tpl: string) => post(`/dns/zones/${zone.id}/template`, { template: tpl }), onSuccess: refresh });
  const z = q.data?.zone ?? zone;
  const short = (n: string) => (n === z.name ? "@" : n.endsWith(`.${z.name}`) ? n.slice(0, -z.name.length - 1) : n);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {z.name} <Badge tone={z.status === "active" ? "green" : "yellow"}>{z.status}</Badge>
        </span>
      }
      actions={
        <>
          <Select className="w-auto py-1.5" value="" onChange={(e) => e.target.value && template.mutate(e.target.value)}>
            <option value="">{t("dns.templates")}</option>
            <option value="web">{t("dns.tplWeb")}</option>
            <option value="google-workspace">Google Workspace mail</option>
            <option value="zoho">Zoho Mail</option>
          </Select>
          <Button onClick={() => setEditing({ type: "A", name: "@", content: "", ttl: 1 })}>+ {t("dns.record")}</Button>
        </>
      }
    >
      {z.status !== "active" && z.nameservers.length > 0 && (
        <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t("dns.setNameservers")}{" "}
          {z.nameservers.map((ns) => (
            <span key={ns} className="mr-1">
              <CopyText text={ns} />
            </span>
          ))}
        </div>
      )}
      <ErrorText error={q.error ?? remove.error ?? template.error} />
      {q.data?.records.length ? (
        <Table head={["Type", "Name", "Content", "TTL", ""]}>
          {q.data.records.map((r) => (
            <tr key={r.id}>
              <td className="px-5 py-2.5">
                <Badge tone="blue">{r.type}</Badge>
              </td>
              <td className="px-5 py-2.5 font-medium">{short(r.name)}</td>
              <td className="max-w-xs truncate px-5 py-2.5 font-mono text-xs" title={r.content}>
                {r.priority !== undefined && r.type === "MX" ? `${r.priority} ` : ""}
                {r.content}
                {r.proxied && <span className="ml-2 text-orange-500">☁</span>}
              </td>
              <td className="px-5 py-2.5 text-slate-500">{r.ttl === 1 ? "auto" : r.ttl}</td>
              <td className="whitespace-nowrap px-5 py-2.5 text-right">
                <Button variant="ghost" onClick={() => setEditing({ ...r, name: short(r.name) })}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => {
                    if (confirm(t("common.confirmDelete", { name: `${r.type} ${r.name}` }))) remove.mutate(r.id);
                  }}
                >
                  {t("common.delete")}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty>{q.isLoading ? t("common.loading") : t("common.none")}</Empty>
      )}

      <Modal open={!!editing} title={editing?.id ? t("dns.editRecord") : t("dns.record")} onClose={() => setEditing(null)}>
        {editing && (
          <form
            className="grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(editing);
            }}
          >
            <Field label="Type">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value })}>
                {TYPES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </Field>
            <Field label="Name" hint={`@ = ${z.name}`}>
              <Input required value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Content">
                <Input required value={editing.content ?? ""} onChange={(e) => setEditing({ ...editing, content: e.target.value })} className="font-mono" />
              </Field>
            </div>
            {(editing.type === "MX" || editing.type === "SRV") && (
              <Field label="Priority">
                <Input type="number" min={0} value={editing.priority ?? 10} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) })} />
              </Field>
            )}
            <Field label="TTL (1 = auto)">
              <Input type="number" min={1} value={editing.ttl ?? 1} onChange={(e) => setEditing({ ...editing, ttl: Number(e.target.value) })} />
            </Field>
            {["A", "AAAA", "CNAME"].includes(editing.type ?? "") && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={!!editing.proxied} onChange={(e) => setEditing({ ...editing, proxied: e.target.checked })} />
                {t("dns.proxied")}
              </label>
            )}
            <div className="sm:col-span-2">
              <ErrorText error={save.error} />
              <Button type="submit" busy={save.isPending} className="mt-2">
                {t("common.save")}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </Card>
  );
}
