import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, patch, post, type Site } from "../api";
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Table, cx } from "../components/ui";

// ---------------- Cron ----------------
interface CronJob {
  id: string;
  name: string;
  schedule: string;
  onCalendar: string;
  command: string;
  enabled: boolean;
}

export function CronTab({ site }: { site: Site }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cron", site.id], queryFn: () => api<{ jobs: CronJob[] }>(`/sites/${site.id}/cron`) });
  const presets = useQuery({ queryKey: ["cron-presets"], queryFn: () => api<{ presets: { label: string; value: string }[] }>("/cron/presets") });
  const [f, setF] = useState({ name: "", schedule: "*/15 * * * *", command: "" });
  const [note, setNote] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["cron", site.id] });
  const add = useMutation({
    mutationFn: () => post("/cron", { siteId: site.id, ...f }),
    onSuccess: () => {
      setF({ name: "", schedule: "*/15 * * * *", command: "" });
      refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (j: CronJob) => patch(`/cron/${j.id}`, { enabled: !j.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => del(`/cron/${id}`), onSuccess: refresh });
  const run = useMutation({ mutationFn: (id: string) => post<{ note: string }>(`/cron/${id}/run`), onSuccess: (r) => setNote(r.note) });

  return (
    <div className="space-y-6">
      <Card title={t("cron.add")}>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_12rem]"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <Field label={t("cron.name")}>
            <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Send renewal reminders" />
          </Field>
          <Field label={t("cron.schedule")} hint={<a className="text-indigo-600" href="https://crontab.guru" target="_blank" rel="noreferrer">crontab.guru ↗</a>}>
            <Input required value={f.schedule} onChange={(e) => setF({ ...f, schedule: e.target.value })} className="font-mono" />
          </Field>
          <div className="flex flex-wrap gap-1.5 sm:col-span-2">
            {presets.data?.presets.map((p) => (
              <button type="button" key={p.value} onClick={() => setF({ ...f, schedule: p.value })} className={cx("rounded-md border px-2 py-0.5 text-xs", f.schedule === p.value ? "border-indigo-400 bg-indigo-50" : "border-slate-200 hover:border-slate-300")}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="sm:col-span-2">
            <Field label={t("cron.command")} hint={t("cron.commandHint")}>
              <Input required value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} className="font-mono" placeholder="node dist/jobs/renewals.js" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <ErrorText error={add.error} />
            <Button type="submit" busy={add.isPending}>
              {t("common.add")}
            </Button>
          </div>
        </form>
      </Card>
      <Card title={t("cron.jobs")}>
        {note && <p className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{note}</p>}
        <ErrorText error={toggle.error ?? remove.error ?? run.error} />
        {q.data?.jobs.length ? (
          <Table head={[t("cron.name"), t("cron.schedule"), t("cron.command"), ""]}>
            {q.data.jobs.map((j) => (
              <tr key={j.id} className={cx(!j.enabled && "opacity-50")}>
                <td className="px-5 py-3 font-medium">{j.name}</td>
                <td className="px-5 py-3">
                  <code className="text-xs">{j.schedule}</code>
                  <p className="text-xs text-slate-400">{j.onCalendar}</p>
                </td>
                <td className="max-w-xs truncate px-5 py-3 font-mono text-xs" title={j.command}>
                  {j.command}
                </td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  <Button variant="ghost" onClick={() => run.mutate(j.id)}>
                    {t("cron.runNow")}
                  </Button>
                  <Button variant="ghost" onClick={() => toggle.mutate(j)}>
                    {j.enabled ? t("cron.pause") : t("cron.resume")}
                  </Button>
                  <Button variant="ghost" className="text-red-600" onClick={() => confirm(t("common.confirmDelete", { name: j.name })) && remove.mutate(j.id)}>
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
    </div>
  );
}

// ---------------- Logs ----------------
export function LogsTab({ site }: { site: Site }) {
  const { t } = useTranslation();
  const kinds = site.runtime === "php" ? ["access", "php-error", "cron"] : site.runtime === "static" ? ["access"] : ["app", "access", "cron"];
  const [log, setLog] = useState(kinds[0]!);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const box = useRef<HTMLPreElement>(null);
  const q = useQuery({
    queryKey: ["logs", site.id, log],
    queryFn: () => api<{ text: string; size: number }>(`/sites/${site.id}/logs?log=${log}&kb=200`),
    refetchInterval: follow ? 3000 : false,
  });
  const lines = (q.data?.text ?? "").split("\n").filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
  useEffect(() => {
    if (follow) box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [q.data, follow]);
  return (
    <Card
      title={t("sites.tabs.logs")}
      actions={
        <>
          <Select value={log} onChange={(e) => setLog(e.target.value)} className="w-auto py-1.5">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}.log
              </option>
            ))}
          </Select>
          <Input placeholder={t("logs.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40 py-1.5" />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-sm">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {t("logs.follow")}
          </label>
        </>
      }
    >
      <ErrorText error={q.error} />
      <pre ref={box} className="max-h-[65vh] min-h-[12rem] overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {q.data && !q.data.text ? t("logs.empty") : lines.join("\n")}
      </pre>
    </Card>
  );
}

