import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, post } from "../api";
import { Badge, Button, Card, CopyText, Empty, ErrorText, Field, Input, Modal, Table, timeAgo } from "../components/ui";

interface Server {
  id: string;
  name: string;
  hostname: string;
  ipv4: string | null;
  status: string;
  isMain: boolean;
  wgAddress: string | null;
  joined: boolean;
  lastSeen: string | null;
  accounts: number;
}

export function ServersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["servers"], queryFn: () => api<{ servers: Server[]; multiServerReady: boolean }>("/servers"), refetchInterval: 15000 });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", hostname: "" });
  const [cmd, setCmd] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["servers"] });

  const add = useMutation({
    mutationFn: () => post<{ joinCommand: string }>("/servers", form),
    onSuccess: (r) => {
      setOpen(false);
      setForm({ name: "", hostname: "" });
      setCmd(r.joinCommand);
      refresh();
    },
  });
  const token = useMutation({ mutationFn: (s: Server) => post<{ joinCommand: string }>(`/servers/${s.id}/token`), onSuccess: (r) => setCmd(r.joinCommand) });
  const remove = useMutation({ mutationFn: (s: Server) => del(`/servers/${s.id}`), onSuccess: refresh });

  const online = (s: Server) => s.lastSeen && Date.now() - new Date(Number(s.lastSeen) || s.lastSeen).getTime() < 120_000;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t("nav.servers")}</h1>
          <p className="text-sm text-slate-500">{t("servers.intro")}</p>
        </div>
        <Button onClick={() => setOpen(true)} disabled={!q.data?.multiServerReady}>
          + {t("servers.add")}
        </Button>
      </div>
      {q.data && !q.data.multiServerReady && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t("servers.notReady")}</p>}
      <Card>
        {q.data?.servers.length ? (
          <Table head={[t("servers.name"), "IP", t("nav.accounts"), t("common.status"), ""]}>
            {q.data.servers.map((s) => (
              <tr key={s.id}>
                <td className="px-5 py-3">
                  <p className="font-medium">
                    {s.name || s.hostname} {s.isMain && <Badge tone="blue">{t("servers.main")}</Badge>}
                  </p>
                  <p className="text-xs text-slate-500">{s.hostname}</p>
                </td>
                <td className="px-5 py-3 font-mono text-xs">
                  {s.ipv4 ?? "–"}
                  {s.wgAddress && <p className="text-slate-400">{s.wgAddress}</p>}
                </td>
                <td className="px-5 py-3">{s.accounts}</td>
                <td className="px-5 py-3">
                  {!s.joined ? (
                    <Badge tone="yellow">{t("servers.waiting")}</Badge>
                  ) : online(s) ? (
                    <Badge tone="green">{t("servers.online")}</Badge>
                  ) : (
                    <Badge tone="red">{t("servers.offline")}</Badge>
                  )}
                  {s.lastSeen && <p className="text-xs text-slate-400">{timeAgo(new Date(Number(s.lastSeen) || s.lastSeen).toISOString())}</p>}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  {!s.joined && (
                    <Button variant="ghost" onClick={() => token.mutate(s)}>
                      {t("servers.joinCommand")}
                    </Button>
                  )}
                  {!s.isMain && (
                    <Button
                      variant="ghost"
                      className="text-red-600"
                      disabled={s.accounts > 0}
                      onClick={() => {
                        if (confirm(t("common.confirmDelete", { name: s.name || s.hostname }))) remove.mutate(s);
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
          <Empty>{t("common.none")}</Empty>
        )}
        <ErrorText error={token.error ?? remove.error} />
      </Card>

      <Modal open={open} title={t("servers.add")} onClose={() => setOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label={t("servers.name")}>
            <Input required placeholder="web-2" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label={t("servers.hostname")}>
            <Input required placeholder="web2.example.com" value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value.trim().toLowerCase() })} />
          </Field>
          <ErrorText error={add.error} />
          <Button type="submit" busy={add.isPending}>
            {t("common.create")}
          </Button>
        </form>
      </Modal>

      <Modal open={!!cmd} title={t("servers.joinCommand")} onClose={() => setCmd(null)} wide>
        <div className="space-y-3 text-sm">
          <p>{t("servers.joinHelp")}</p>
          <div className="break-all">{cmd && <CopyText text={cmd} />}</div>
          <p className="text-xs text-slate-500">{t("servers.joinNote")}</p>
        </div>
      </Modal>
    </div>
  );
}
