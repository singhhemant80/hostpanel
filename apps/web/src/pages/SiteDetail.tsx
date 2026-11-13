import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, del, patch, post, put, type Deployment, type Site, type SystemInfo } from "../api";
import { Badge, Button, Card, CopyText, Empty, ErrorText, Field, Input, Modal, Select, StatusBadge, Table, cx, timeAgo } from "../components/ui";
import { runtimeLabel } from "./Sites";
import { DomainRows, AddDomainForm, PathRulesEditor } from "./Domains";
import { CronTab, LogsTab } from "./SiteTabs";
import { lazy, Suspense } from "react";
const TerminalTab = lazy(() => import("./TerminalTab"));
import { useAuth } from "../auth";

interface SiteResponse {
  site: Site;
  dnsTargets: { ipv4: string | null; ipv6: string | null };
  webhookUrl: string;
}

const TABS = ["overview", "deployments", "github", "domains", "env", "cron", "logs", "terminal", "settings"] as const;

export function SiteDetailPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as (typeof TABS)[number]) ?? "overview";
  const q = useQuery({ queryKey: ["site", id], queryFn: () => api<SiteResponse>(`/sites/${id}`), refetchInterval: 8000 });
  const site = q.data?.site;
  if (q.error) return <ErrorText error={q.error} />;
  if (!site) return <p className="text-slate-500">{t("common.loading")}</p>;
  const primary = site.domains.find((d) => d.type === "primary") ?? site.domains[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">{site.name}</h1>
            <StatusBadge status={site.status} />
            <Badge tone={site.running ? "green" : "gray"}>{site.running ? t("sites.running") : t("sites.stopped")}</Badge>
            {site.background && <Badge tone="blue">worker</Badge>}
          </div>
          {primary && (
            <a href={`https://${primary.hostname}`} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 hover:underline">
              {primary.hostname} ↗
            </a>
          )}
        </div>
        <SiteActions site={site} />
      </div>

      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200">
        {TABS.map((k) => (
          <button
            key={k}
            onClick={() => setParams({ tab: k })}
            className={cx("whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium", tab === k ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800")}
          >
            {t(`sites.tabs.${k}`)}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview data={q.data!} />}
      {tab === "deployments" && <Deployments site={site} />}
      {tab === "github" && <GitHubTab site={site} webhookUrl={q.data!.webhookUrl} />}
      {tab === "domains" &&
        (site.background ? (
          <Card>
            <Empty>This is a background worker, so it has no domains. To expose an app on part of a domain, add a path rule on the web site that owns the domain.</Empty>
          </Card>
        ) : (
          <Card title={t("sites.tabs.domains")}>
            <AddDomainForm siteId={site.id} />
            <div className="mt-5">
              <DomainRows domains={site.domains} dnsIp={q.data!.dnsTargets.ipv4} />
            </div>
            <div className="mt-6 space-y-4">
              {site.domains
                .filter((d) => d.type !== "redirect")
                .map((d) => (
                  <PathRulesEditor key={d.id} domain={{ ...d, site: { id: site.id, name: site.name, runtime: site.runtime } }} />
                ))}
            </div>
          </Card>
        ))}
      {tab === "env" && <EnvTab site={site} />}
      {tab === "cron" && <CronTab site={site} />}
      {tab === "logs" && <LogsTab site={site} />}
      {tab === "terminal" && <TerminalAccess site={site} />}
      {tab === "settings" && <SettingsTab site={site} />}
    </div>
  );
}

function SiteActions({ site }: { site: Site }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [, setParams] = useSearchParams();
  const action = useMutation({
    mutationFn: (a: string) => post(`/sites/${site.id}/${a}`),
    onSuccess: (_d, a) => {
      void qc.invalidateQueries({ queryKey: ["site", site.id] });
      if (a === "deploy") setParams({ tab: "deployments" });
    },
  });
  return (
    <div className="flex flex-wrap gap-2">
      {(site.runtime === "node" || site.runtime === "python") &&
        (["start", "stop", "restart"] as const).map((a) => (
          <Button key={a} variant="secondary" busy={action.isPending && action.variables === a} onClick={() => action.mutate(a)}>
            {t(`sites.${a}`)}
          </Button>
        ))}
      <Button disabled={!site.git} title={site.git ? "" : "Connect GitHub first"} busy={action.isPending && action.variables === "deploy"} onClick={() => action.mutate("deploy")}>
        {t("sites.deploy")}
      </Button>
      {action.error && <ErrorText error={action.error} />}
    </div>
  );
}

function Overview({ data }: { data: SiteResponse }) {
  const { t } = useTranslation();
  const s = data.site;
  const rows: [string, React.ReactNode][] = [
    [t("sites.runtime"), `${runtimeLabel[s.runtime]} ${s.runtime !== "static" ? s.runtimeVersion : ""}`],
    ["GitHub", s.git ? `${s.git.repoFullName} @ ${s.git.branch}` : "—"],
    ["Release", s.currentRelease ?? t("sites.neverDeployed")],
    ...(s.port ? ([["Internal port", `127.0.0.1:${s.port}${s.instances > 1 ? `–${s.port + s.instances - 1}` : ""}`]] as [string, string][]) : []),
    ...(s.port !== null
      ? (s.processes ?? []).map((p, i) => [`Process ${p.name}`, `127.0.0.1:${s.port! + s.instances + i}${p.path ? ` ← ${p.path}` : ""}`] as [string, string])
      : []),
    ...(s.redis ? ([["Redis", "private, REDIS_URL is set"]] as [string, string][]) : []),
    ["Folder", s.paths ? <CopyText text={s.paths.home} /> : "—"],
    [t("sites.buildCmd"), s.buildCmd ? <code className="text-xs">{s.buildCmd}</code> : "—"],
    ...(s.startCmd ? ([[t("sites.startCmd"), <code className="text-xs">{s.startCmd}</code>]] as [string, React.ReactNode][]) : []),
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title={t("sites.tabs.overview")}>
        <dl className="space-y-2.5 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t("sites.tabs.domains")}>
        <ul className="space-y-2 text-sm">
          {s.domains.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2">
              <span className="font-medium">{d.hostname}</span>
              <span className="flex gap-1.5">
                <Badge>{d.type}</Badge>
                <Badge tone={d.dnsOk ? "green" : "yellow"}>DNS {d.dnsOk ? "✓" : "?"}</Badge>
              </span>
            </li>
          ))}
        </ul>
        {data.dnsTargets.ipv4 && (
          <p className="mt-4 text-xs text-slate-500">
            A record → <CopyText text={data.dnsTargets.ipv4} />
          </p>
        )}
      </Card>
    </div>
  );
}

function Deployments({ site }: { site: Site }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["deployments", site.id],
    queryFn: () => api<{ deployments: Deployment[] }>(`/sites/${site.id}/deployments`),
    refetchInterval: (query) => (query.state.data?.deployments.some((d) => d.status === "queued" || d.status === "building") ? 2000 : 10_000),
  });
  const [logFor, setLogFor] = useState<Deployment | null>(null);
  const rollback = useMutation({
    mutationFn: (depId: string) => post(`/deployments/${depId}/rollback`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["deployments", site.id] }),
  });
  const deps = q.data?.deployments ?? [];

  return (
    <Card title={t("sites.tabs.deployments")}>
      {deps.length === 0 ? (
        <Empty>{site.git ? t("sites.neverDeployed") : "Connect a GitHub repository on the GitHub tab, then press Deploy now."}</Empty>
      ) : (
        <Table head={["Commit", t("common.status"), "Trigger", "", ""]}>
          {deps.map((d) => (
            <tr key={d.id}>
              <td className="max-w-xs px-5 py-3">
                <p className="truncate">
                  {d.commitSha && <code className="mr-1.5 text-xs text-slate-500">{d.commitSha.slice(0, 7)}</code>}
                  {d.commitMessage ?? "—"}
                </p>
                {d.error && <p className="truncate text-xs text-red-600">{d.error}</p>}
              </td>
              <td className="px-5 py-3">
                <StatusBadge status={d.status} />
              </td>
              <td className="px-5 py-3 text-slate-500">
                {d.trigger}
                {d.author ? ` · ${d.author}` : ""} · {timeAgo(d.createdAt)}
              </td>
              <td className="px-5 py-3">
                <Button variant="ghost" onClick={() => setLogFor(d)}>
                  {t("sites.viewLog")}
                </Button>
              </td>
              <td className="px-5 py-3">
                {d.releaseName && d.status === "superseded" && (
                  <Button variant="secondary" busy={rollback.isPending && rollback.variables === d.id} onClick={() => rollback.mutate(d.id)}>
                    {t("sites.rollback")}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <ErrorText error={rollback.error} />
      <Modal wide open={!!logFor} title={`${t("sites.viewLog")} · ${logFor?.commitSha?.slice(0, 7) ?? logFor?.id ?? ""}`} onClose={() => setLogFor(null)}>
        {logFor && <LogViewer deploymentId={logFor.id} />}
      </Modal>
    </Card>
  );
}

function LogViewer({ deploymentId }: { deploymentId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState("");
  const offset = useRef(0);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let stop = false;
    offset.current = 0;
    setText("");
    const tick = async () => {
      try {
        const r = await api<{ text: string; offset: number; done: boolean; status: string }>(`/deployments/${deploymentId}/log?offset=${offset.current}`);
        if (stop) return;
        offset.current = r.offset;
        if (r.text) setText((t) => t + r.text);
        setStatus(r.status);
        if (!r.done) setTimeout(tick, 1500);
      } catch {
        if (!stop) setTimeout(tick, 3000);
      }
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [deploymentId]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [text]);
  return (
    <div>
      <div className="mb-2">
        <StatusBadge status={status || "queued"} />
      </div>
      <pre ref={box} className="max-h-[60vh] overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
        {text || "Waiting for the build to start…"}
      </pre>
    </div>
  );
}

function GitHubTab({ site, webhookUrl }: { site: Site; webhookUrl: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["info"], queryFn: () => api<SystemInfo>("/system/info") });
  const [repo, setRepo] = useState(site.git?.repoFullName ?? "");
  const [branch, setBranch] = useState(site.git?.branch ?? "main");
  const [auto, setAuto] = useState(site.git?.autoDeploy ?? true);
  const save = useMutation({
    mutationFn: () => post(`/sites/${site.id}/git`, { repoFullName: repo, branch, autoDeploy: auto }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site", site.id] }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/sites/${site.id}/git`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site", site.id] }),
  });
  return (
    <Card title="GitHub">
      {info.data && !info.data.github.configured && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t("github.notConfigured")}</p>}
      <form
        className="grid gap-4 sm:grid-cols-[1fr_12rem]"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label={t("github.repo")}>
          <Input required value={repo} onChange={(e) => setRepo(e.target.value.trim())} placeholder="owner/repo" />
        </Field>
        <Field label={t("github.branch")}>
          <Input required value={branch} onChange={(e) => setBranch(e.target.value.trim())} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
          {t("github.autoDeploy")}
        </label>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" busy={save.isPending}>
            {site.git ? t("common.save") : t("github.connect")}
          </Button>
          {site.git && (
            <Button type="button" variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              {t("github.disconnect")}
            </Button>
          )}
          {info.data?.github.installUrl && (
            <a href={info.data.github.installUrl} target="_blank" rel="noreferrer" className="self-center text-sm text-indigo-600 hover:underline">
              {t("github.install")} ↗
            </a>
          )}
        </div>
      </form>
      <ErrorText error={save.error ?? remove.error} />
      <p className="mt-5 text-xs text-slate-500">
        Pushes reach the panel through the GitHub App webhook: <CopyText text={webhookUrl} />
      </p>
    </Card>
  );
}

function EnvTab({ site }: { site: Site }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [rows, setRows] = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [paste, setPaste] = useState("");
  const save = useMutation({
    mutationFn: (vars: { key: string; value: string }[]) => put(`/sites/${site.id}/env`, { vars }),
    onSuccess: () => {
      setRows([{ key: "", value: "" }]);
      setPaste("");
      void qc.invalidateQueries({ queryKey: ["site", site.id] });
    },
  });
  const remove = useMutation({
    mutationFn: (key: string) => del(`/sites/${site.id}/env/${encodeURIComponent(key)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site", site.id] }),
  });
  const fromPaste = () =>
    paste
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim().replace(/^["']|["']$/g, "") };
      });

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title={t("sites.tabs.env")}>
        {site.env?.length ? (
          <ul className="divide-y divide-slate-100 text-sm">
            {site.env.map((e) => (
              <li key={e.key} className="flex items-center justify-between py-2">
                <code>{e.key}</code>
                <span className="flex items-center gap-3">
                  <span className="text-slate-400">••••••</span>
                  <Button variant="ghost" onClick={() => remove.mutate(e.key)}>
                    {t("common.delete")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>{t("common.none")}</Empty>
        )}
        <p className="mt-3 text-xs text-slate-500">Values are encrypted and never shown again. Redeploy or restart to apply changes.</p>
      </Card>
      <Card title={`${t("common.add")} / update`}>
        {rows.map((r, i) => (
          <div key={i} className="mb-2 grid grid-cols-[1fr_1.4fr] gap-2">
            <Input placeholder="KEY" value={r.key} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x)))} className="font-mono" />
            <Input placeholder="value" value={r.value} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="font-mono" />
          </div>
        ))}
        <Button variant="ghost" onClick={() => setRows([...rows, { key: "", value: "" }])}>
          + row
        </Button>
        <Field label="…or paste a .env file">
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={4} className="block w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs" />
        </Field>
        <div className="mt-3">
          <Button busy={save.isPending} onClick={() => save.mutate([...rows.filter((r) => r.key), ...fromPaste()])}>
            {t("common.save")}
          </Button>
        </div>
        <ErrorText error={save.error} />
      </Card>
    </div>
  );
}

function SettingsTab({ site }: { site: Site }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["info"], queryFn: () => api<SystemInfo>("/system/info") });
  const [form, setForm] = useState({
    runtime: site.runtime,
    runtimeVersion: site.runtimeVersion,
    rootDir: site.rootDir,
    publicDir: site.publicDir,
    buildCmd: site.buildCmd,
    startCmd: site.startCmd,
    instances: site.instances,
    healthPath: site.healthPath,
    processes: site.processes ?? [],
    redis: site.redis ?? false,
  });
  const rt = info.data?.runtimes.find((r) => r.id === form.runtime);
  const save = useMutation({
    mutationFn: () =>
      patch(`/sites/${site.id}`, {
        ...form,
        processes: form.processes.map((p) => ({ ...p, path: p.path?.trim() ? p.path.trim() : null })),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["site", site.id] }),
  });
  const remove = useMutation({
    mutationFn: () => del(`/sites/${site.id}`),
    onSuccess: () => nav("/sites"),
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm({ ...form, [k]: v });

  return (
    <div className="space-y-6">
      <Card title={t("sites.tabs.settings")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("sites.runtime")}>
            <Select
              value={form.runtime}
              onChange={(e) => {
                const r = info.data?.runtimes.find((x) => x.id === e.target.value);
                setForm({ ...form, runtime: e.target.value as Site["runtime"], runtimeVersion: r?.defaultVersion ?? "-" });
              }}
            >
              {info.data?.runtimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {runtimeLabel[r.id]}
                </option>
              ))}
            </Select>
          </Field>
          {form.runtime !== "static" && (
            <Field label={t("sites.version")}>
              <Select value={form.runtimeVersion} onChange={(e) => set("runtimeVersion", e.target.value)}>
                {rt?.versions.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("sites.rootDir")}>
            <Input value={form.rootDir} onChange={(e) => set("rootDir", e.target.value.trim())} />
          </Field>
          {form.runtime === "php" || form.runtime === "static" ? (
            <Field label={t("sites.publicDir")}>
              <Input value={form.publicDir} onChange={(e) => set("publicDir", e.target.value.trim())} />
            </Field>
          ) : (
            <Field label={t("sites.staticDir")} hint={t("sites.staticDirHint")}>
              <Input placeholder="public-site" value={form.publicDir} onChange={(e) => set("publicDir", e.target.value.trim())} />
            </Field>
          )}
          <Field label={t("sites.buildCmd")}>
            <Input value={form.buildCmd} onChange={(e) => set("buildCmd", e.target.value)} className="font-mono" />
          </Field>
          {(form.runtime === "node" || form.runtime === "python") && (
            <>
              <Field label={t("sites.startCmd")}>
                <Input value={form.startCmd} onChange={(e) => set("startCmd", e.target.value)} className="font-mono" />
              </Field>
              <Field label={t("sites.instances")} hint="Each instance gets its own port; Caddy load-balances between them">
                <Input type="number" min={1} max={8} value={form.instances} onChange={(e) => set("instances", Number(e.target.value))} />
              </Field>
              <Field label={t("sites.healthPath")}>
                <Input value={form.healthPath} onChange={(e) => set("healthPath", e.target.value)} />
              </Field>
            </>
          )}
        </div>
        <div className="mt-4">
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            {t("common.save")}
          </Button>
        </div>
        <ErrorText error={save.error} />
      </Card>
      {(form.runtime === "node" || form.runtime === "python") && (
        <Card title={t("sites.processes.title")}>
          <p className="mb-4 text-sm text-slate-600">{t("sites.processes.help")}</p>
          <div className="space-y-3">
            {form.processes.map((p, i) => {
              const upd = (patchP: Partial<typeof p>) => set("processes", form.processes.map((x, j) => (j === i ? { ...x, ...patchP } : x)));
              return (
                <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-[8rem_1fr_9rem_auto]">
                  <Input placeholder="api" value={p.name} onChange={(e) => upd({ name: e.target.value.toLowerCase() })} />
                  <Input placeholder="cd apps/api && node dist/server.js" value={p.command} onChange={(e) => upd({ command: e.target.value })} className="font-mono" />
                  <Input placeholder={t("sites.processes.pathPlaceholder")} value={p.path ?? ""} onChange={(e) => upd({ path: e.target.value })} />
                  <Button variant="ghost" className="text-red-600" onClick={() => set("processes", form.processes.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                  <p className="text-xs text-slate-500 sm:col-span-4">
                    {p.name ? <code>PORT_{p.name.toUpperCase().replace(/-/g, "_")}</code> : null} {p.path ? t("sites.processes.routed", { path: p.path }) : t("sites.processes.background")}
                  </p>
                </div>
              );
            })}
          </div>
          {form.processes.length < 6 && (
            <Button variant="secondary" className="mt-3" onClick={() => set("processes", [...form.processes, { name: "", command: "", path: null }])}>
              + {t("sites.processes.add")}
            </Button>
          )}
          <label className="mt-5 flex items-start gap-2 border-t border-slate-100 pt-4 text-sm">
            <input type="checkbox" className="mt-0.5" checked={form.redis} onChange={(e) => set("redis", e.target.checked)} />
            <span>
              <span className="font-medium">{t("sites.processes.redis")}</span>
              <span className="block text-xs text-slate-500">{t("sites.processes.redisHelp")}</span>
            </span>
          </label>
          <div className="mt-4">
            <Button busy={save.isPending} onClick={() => save.mutate()}>
              {t("common.save")}
            </Button>
            <ErrorText error={save.error} />
          </div>
        </Card>
      )}
      <Card title="Danger zone">
        <Button
          variant="danger"
          busy={remove.isPending}
          onClick={() => {
            if (confirm(t("common.confirmDelete", { name: site.name }))) remove.mutate();
          }}
        >
          {t("common.delete")} {site.name}
        </Button>
        <ErrorText error={remove.error} />
      </Card>
    </div>
  );
}

function TerminalAccess({ site }: { site: Site }) {
  const { user } = useAuth();
  const access = useQuery({ queryKey: ["access", site.accountId], queryFn: () => api<{ shell: boolean }>(`/accounts/${site.accountId}/access`) });
  if (access.isLoading) return null;
  return (
    <Suspense fallback={null}>
      <TerminalTab site={site} allowed={user?.role === "admin" || Boolean(access.data?.shell)} />
    </Suspense>
  );
}
