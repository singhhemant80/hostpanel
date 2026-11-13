import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, type Site } from "../api";
import { Badge, Card, Empty, StatusBadge, timeAgo } from "../components/ui";

export const runtimeLabel: Record<string, string> = { php: "PHP", node: "Node.js", python: "Python", static: "Static" };

export function SitesPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["sites"], queryFn: () => api<{ sites: Site[] }>("/sites"), refetchInterval: 10_000 });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t("nav.sites")}</h1>
        <Link to="/sites/new" className="rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-700">
          + {t("sites.new")}
        </Link>
      </div>
      {q.data?.sites.length === 0 && (
        <Card>
          <Empty>{t("common.none")}</Empty>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {q.data?.sites.map((s) => {
          const last = s.deployments?.[0];
          const primary = s.domains.find((d) => d.type === "primary") ?? s.domains[0];
          return (
            <Link key={s.id} to={`/sites/${s.id}`} className="block rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-indigo-300">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{s.name}</p>
                  <p className="truncate text-sm text-indigo-600">{primary?.hostname}</p>
                </div>
                <StatusBadge status={s.status} />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="blue">
                  {runtimeLabel[s.runtime]} {s.runtime !== "static" ? s.runtimeVersion : ""}
                </Badge>
                {s.git && <Badge>{`${s.git.repoFullName}@${s.git.branch}`}</Badge>}
                {s.domains.length > 1 && <Badge>+{s.domains.length - 1} domains</Badge>}
                <span className="ml-auto text-slate-500">
                  {last ? (
                    <>
                      {t("sites.lastDeploy")}: <StatusBadge status={last.status} /> {timeAgo(last.createdAt)}
                    </>
                  ) : (
                    t("sites.neverDeployed")
                  )}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
