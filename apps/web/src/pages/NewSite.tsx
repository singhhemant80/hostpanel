import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, post, type Account, type RuntimeInfo, type Site, type SystemInfo } from "../api";
import { useAuth } from "../auth";
import { Button, Card, ErrorText, Field, Input, Select, cx } from "../components/ui";
import { runtimeLabel } from "./Sites";

export function NewSitePage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user } = useAuth();
  const info = useQuery({ queryKey: ["info"], queryFn: () => api<SystemInfo>("/system/info") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });

  const [accountId, setAccountId] = useState("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [runtime, setRuntime] = useState<RuntimeInfo["id"]>("node");
  const [version, setVersion] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [rootDir, setRootDir] = useState("");
  const [publicDir, setPublicDir] = useState("");
  const [buildCmd, setBuildCmd] = useState("");
  const [startCmd, setStartCmd] = useState("");
  const [background, setBackground] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const rt = info.data?.runtimes.find((r) => r.id === runtime);
  useEffect(() => {
    if (!rt) return;
    setVersion(rt.defaultVersion);
    setBuildCmd(rt.defaults.buildCmd);
    setStartCmd(rt.defaults.startCmd);
    setPublicDir(rt.defaults.publicDir);
  }, [rt]);
  useEffect(() => {
    const active = accounts.data?.accounts.filter((a) => a.status === "active") ?? [];
    if (!accountId && active.length) setAccountId(active[0]!.id);
  }, [accounts.data, accountId]);

  async function detect() {
    setDetecting(true);
    setError(null);
    try {
      const r = await api<{ runtime: RuntimeInfo["id"]; defaults: RuntimeInfo["defaults"] }>(
        `/github/detect?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}&dir=${encodeURIComponent(rootDir)}`,
      );
      setRuntime(r.runtime);
    } catch (e) {
      setError(e);
    } finally {
      setDetecting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { site } = await post<{ site: Site }>("/sites", {
        accountId: accountId || undefined,
        name,
        runtime,
        runtimeVersion: version,
        primaryDomain: background ? undefined : domain,
        background,
        rootDir,
        publicDir,
        buildCmd,
        startCmd,
      });
      if (repo.trim()) {
        await post(`/sites/${site.id}/git`, { repoFullName: repo.trim(), branch, autoDeploy: true });
        await post(`/sites/${site.id}/deploy`).catch(() => undefined);
      }
      nav(`/sites/${site.id}${repo.trim() ? "?tab=deployments" : ""}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const activeAccounts = accounts.data?.accounts.filter((a) => a.status === "active") ?? [];

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">{t("sites.new")}</h1>

      <Card title="1. Basics">
        <div className="grid gap-4 sm:grid-cols-2">
          {(user?.role === "admin" || activeAccounts.length > 1) && (
            <Field label={t("accounts.username")}>
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.username} ({a.package.name})
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("sites.name")} hint="Lower-case letters, digits, - and _">
            <Input required pattern="[a-z][a-z0-9_-]{1,23}" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="crapplet-web" />
          </Field>
          {!background && (
            <Field label={t("sites.primaryDomain")} hint={info.data?.dnsTargets.ipv4 ? t("domains.pointTo", { ip: info.data.dnsTargets.ipv4 }) : undefined}>
              <Input required value={domain} onChange={(e) => setDomain(e.target.value.toLowerCase().trim())} placeholder="example.com" />
            </Field>
          )}
        </div>
      </Card>

      <Card title="2. GitHub (optional)">
        {info.data && !info.data.github.configured && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t("github.notConfigured")}</p>}
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <Field label={t("github.repo")}>
            <Input value={repo} onChange={(e) => setRepo(e.target.value.trim())} placeholder="singhhemant80/crapplet-panel" />
          </Field>
          <Field label={t("github.branch")}>
            <Input value={branch} onChange={(e) => setBranch(e.target.value.trim())} />
          </Field>
          <Button type="button" variant="secondary" busy={detecting} disabled={!repo.includes("/")} onClick={() => void detect()}>
            {t("github.detect")}
          </Button>
        </div>
        {info.data?.github.installUrl && (
          <a href={info.data.github.installUrl} target="_blank" rel="noreferrer" className="mt-3 inline-block text-sm text-indigo-600 hover:underline">
            {t("github.install")} ↗
          </a>
        )}
      </Card>

      <Card title={`3. ${t("sites.runtime")}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {info.data?.runtimes.map((r) => (
            <button
              type="button"
              key={r.id}
              onClick={() => setRuntime(r.id)}
              className={cx("rounded-lg border px-3 py-3 text-left text-sm font-medium", runtime === r.id ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/20" : "border-slate-200 hover:border-slate-300")}
            >
              {runtimeLabel[r.id]}
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {runtime !== "static" && (
            <Field label={t("sites.version")}>
              <Select value={version} onChange={(e) => setVersion(e.target.value)}>
                {rt?.versions.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("sites.rootDir")} hint="Leave empty for the repo root, e.g. apps/web for a monorepo">
            <Input value={rootDir} onChange={(e) => setRootDir(e.target.value.trim())} placeholder="" />
          </Field>
          {(runtime === "php" || runtime === "static") && (
            <Field label={t("sites.publicDir")} hint="Folder served to visitors, e.g. public or dist">
              <Input value={publicDir} onChange={(e) => setPublicDir(e.target.value.trim())} />
            </Field>
          )}
          <Field label={t("sites.buildCmd")}>
            <Input value={buildCmd} onChange={(e) => setBuildCmd(e.target.value)} className="font-mono" />
          </Field>
          {(runtime === "node" || runtime === "python") && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
              {t("sites.background")}
            </label>
          )}
          {(runtime === "node" || runtime === "python") && (
            <Field label={t("sites.startCmd")} hint={background ? undefined : "Must listen on $PORT (127.0.0.1)"}>
              <Input value={startCmd} onChange={(e) => setStartCmd(e.target.value)} className="font-mono" />
            </Field>
          )}
        </div>
      </Card>

      <ErrorText error={error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => nav(-1)}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" busy={busy}>
          {t("common.create")}
        </Button>
      </div>
    </form>
  );
}
