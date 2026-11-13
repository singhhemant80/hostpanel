import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api, post, type Account } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, CopyText, ErrorText, Field, Input, Modal, Select } from "../components/ui";

interface CatalogApp {
  id: string;
  name: string;
  description: string;
  database: string | null;
  adminUser: boolean;
  minutes: string;
  runtime: string;
}
interface InstallResult {
  site: { id: string; name: string };
  deploymentId: string;
  admin: { user: string; password: string; email: string; url: string } | null;
  database: { name: string; user: string } | null;
}

const colors: Record<string, string> = { wordpress: "bg-sky-600", laravel: "bg-red-500", nextjs: "bg-slate-900", django: "bg-emerald-700" };

export function AppsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ["apps"], queryFn: () => api<{ apps: CatalogApp[] }>("/apps/catalog") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const active = accounts.data?.accounts.filter((a) => a.status === "active") ?? [];
  const [pick, setPick] = useState<CatalogApp | null>(null);
  const [form, setForm] = useState({ name: "", domain: "", accountId: "", adminEmail: "" });
  const [done, setDone] = useState<InstallResult | null>(null);

  const install = useMutation({
    mutationFn: () =>
      post<InstallResult>("/apps/install", {
        template: pick!.id,
        name: form.name,
        domain: form.domain,
        accountId: form.accountId || undefined,
        adminEmail: form.adminEmail || undefined,
      }),
    onSuccess: (r) => {
      setPick(null);
      setForm({ name: "", domain: "", accountId: "", adminEmail: "" });
      setDone(r);
      void qc.invalidateQueries({ queryKey: ["sites"] });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t("nav.apps")}</h1>
        <p className="text-sm text-slate-500">{t("apps.intro")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {catalog.data?.apps.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start gap-3">
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg text-lg font-bold text-white ${colors[a.id] ?? "bg-indigo-600"}`}>{a.name[0]}</span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{a.name}</p>
                <p className="mt-1 text-sm text-slate-600">{a.description}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge>{a.runtime}</Badge>
                  {a.database && <Badge tone="blue">{a.database}</Badge>}
                  <Badge tone="gray">~{a.minutes} min</Badge>
                </div>
              </div>
            </div>
            <div className="mt-4 text-right">
              <Button onClick={() => setPick(a)}>{t("apps.install")}</Button>
            </div>
          </Card>
        ))}
      </div>
      <ErrorText error={catalog.error} />

      <Modal open={!!pick} title={t("apps.installTitle", { name: pick?.name })} onClose={() => setPick(null)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            install.mutate();
          }}
        >
          {(user?.role !== "user" || active.length > 1) && (
            <Field label={t("accounts.username")}>
              <Select value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value })} required>
                <option value="">—</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.username}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("apps.siteName")} hint={t("apps.siteNameHint")}>
            <Input required pattern="[a-z][a-z0-9-]{1,30}" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} />
          </Field>
          <Field label={t("apps.domain")} hint={t("apps.domainHint")}>
            <Input required placeholder="blog.example.com" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value.trim().toLowerCase() })} />
          </Field>
          {pick?.adminUser && (
            <Field label={t("apps.adminEmail")}>
              <Input type="email" placeholder={user?.email} value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} />
            </Field>
          )}
          <ErrorText error={install.error} />
          <Button type="submit" busy={install.isPending}>
            {t("apps.install")}
          </Button>
        </form>
      </Modal>

      <Modal open={!!done} title={t("apps.started")} onClose={() => setDone(null)}>
        {done && (
          <div className="space-y-3 text-sm">
            <p>{t("apps.startedHelp")}</p>
            {done.admin && (
              <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="font-medium text-amber-900">{t("apps.adminOnce")}</p>
                <Row k={t("apps.adminUrl")} v={done.admin.url} />
                <Row k={t("email.username")} v={done.admin.user} />
                <Row k={t("login.password")} v={done.admin.password} />
                <Row k={t("login.email")} v={done.admin.email} />
              </div>
            )}
            {done.database && <p className="text-slate-600">{t("apps.dbCreated", { name: done.database.name })}</p>}
            <Link to={`/sites/${done.site.id}`}>
              <Button>{t("apps.viewProgress")}</Button>
            </Link>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-600">{k}</span>
      <CopyText text={v} />
    </div>
  );
}
