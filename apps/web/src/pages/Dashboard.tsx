import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Deployment } from "../api";
import { useAuth } from "../auth";
import { Card, Empty, StatusBadge, timeAgo } from "../components/ui";

interface Overview {
  counts: { sites: number; domains: number; databases: number; accounts: number };
  recentDeployments: Deployment[];
}
interface Stats {
  stats: { hostname: string; uptimeSec: number; load: number[]; memTotalMb: number; memFreeMb: number; diskTotalGb: number; diskFreeGb: number; cpus: number } | null;
  error?: string;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api<Overview>("/system/overview"), refetchInterval: 10_000 });
  const stats = useQuery({ queryKey: ["stats"], queryFn: () => api<Stats>("/system/stats"), enabled: user?.role === "admin", refetchInterval: 30_000 });
  const c = overview.data?.counts;

  const tiles = [
    { key: "sites", n: c?.sites, to: "/sites" },
    { key: "domains", n: c?.domains, to: "/domains" },
    { key: "databases", n: c?.databases, to: "/databases" },
    ...(user?.role === "admin" ? [{ key: "accounts", n: c?.accounts, to: "/accounts" }] : []),
  ];
  const s = stats.data?.stats;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t("dashboard.welcome", { name: user?.name })}</h1>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((x) => (
          <Link key={x.key} to={x.to} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm hover:border-indigo-300">
            <p className="text-sm text-slate-500">{t(`nav.${x.key}`)}</p>
            <p className="mt-1 text-2xl font-semibold">{x.n ?? "–"}</p>
          </Link>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={t("dashboard.recentDeploys")} className="lg:col-span-2">
          {overview.data?.recentDeployments.length ? (
            <ul className="-my-2 divide-y divide-slate-100">
              {overview.data.recentDeployments.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <div className="min-w-0">
                    <Link to={`/sites/${d.siteId}?tab=deployments`} className="font-medium hover:text-indigo-600">
                      {d.site?.name}
                    </Link>
                    <p className="truncate text-slate-500">
                      {d.commitSha ? <code className="mr-1.5">{d.commitSha.slice(0, 7)}</code> : null}
                      {d.commitMessage ?? d.trigger}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-xs text-slate-400">{timeAgo(d.createdAt)}</span>
                    <StatusBadge status={d.status} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{t("common.none")}</Empty>
          )}
        </Card>

        {user?.role === "admin" && (
          <Card title={t("dashboard.server")}>
            {s ? (
              <dl className="space-y-2 text-sm">
                <Row k="Host" v={s.hostname} />
                <Row k="CPU" v={`${s.cpus} cores · load ${s.load.map((l) => l.toFixed(2)).join(" / ")}`} />
                <Row k="RAM" v={`${((s.memTotalMb - s.memFreeMb) / 1024).toFixed(1)} / ${(s.memTotalMb / 1024).toFixed(1)} GB`} />
                <Row k="Disk" v={`${s.diskTotalGb - s.diskFreeGb} / ${s.diskTotalGb} GB`} />
                <Row k="Uptime" v={`${Math.floor(s.uptimeSec / 86400)}d ${Math.floor((s.uptimeSec % 86400) / 3600)}h`} />
              </dl>
            ) : (
              <p className="text-sm text-slate-500">{stats.data?.error ?? t("common.loading")}</p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-slate-500">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}
