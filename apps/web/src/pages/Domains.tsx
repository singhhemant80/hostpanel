import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { api, del, post, put, type Domain, type Site } from "../api";
import { Badge, Button, Card, CopyText, Empty, ErrorText, Field, Input, Modal, Select, StatusBadge, Table } from "../components/ui";

export function DomainsPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["domains"], queryFn: () => api<{ domains: Domain[]; dnsTargets: { ipv4: string | null } }>("/domains") });
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api<{ sites: Site[] }>("/sites") });
  const [siteId, setSiteId] = useState("");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">{t("nav.domains")}</h1>
      <Card title={t("domains.add")}>
        {sites.data?.sites.length ? (
          <>
            <Field label={t("domains.site")}>
              <Select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                <option value="">—</option>
                {sites.data.sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            {siteId && (
              <div className="mt-4">
                <AddDomainForm siteId={siteId} />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-slate-500">
            <Link to="/sites/new" className="text-indigo-600 hover:underline">
              Create a site
            </Link>{" "}
            first; every domain points at a site.
          </p>
        )}
      </Card>
      <Card title={t("nav.domains")}>
        <DomainRows domains={q.data?.domains ?? []} dnsIp={q.data?.dnsTargets.ipv4 ?? null} showSite />
      </Card>
    </div>
  );
}

export function AddDomainForm({ siteId }: { siteId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [hostname, setHostname] = useState("");
  const [type, setType] = useState("alias");
  const [redirectTo, setRedirectTo] = useState("");
  const add = useMutation({
    mutationFn: () => post("/domains", { siteId, hostname, type, ...(type === "redirect" ? { redirectTo } : {}) }),
    onSuccess: () => {
      setHostname("");
      setRedirectTo("");
      void qc.invalidateQueries();
    },
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <Field label={t("domains.hostname")}>
        <Input required value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase().trim())} placeholder="www.example.com" />
      </Field>
      <Field label={t("domains.type")}>
        <Select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="alias">Alias (same site)</option>
          <option value="addon">Addon</option>
          <option value="subdomain">Subdomain</option>
          <option value="redirect">Redirect</option>
        </Select>
      </Field>
      <Button type="submit" busy={add.isPending}>
        {t("common.add")}
      </Button>
      {type === "redirect" && (
        <div className="sm:col-span-3">
          <Field label={t("domains.redirectTo")}>
            <Input required type="url" value={redirectTo} onChange={(e) => setRedirectTo(e.target.value.trim())} placeholder="https://example.com" />
          </Field>
        </div>
      )}
      <div className="sm:col-span-3">
        <ErrorText error={add.error} />
      </div>
    </form>
  );
}

export function DomainRows({ domains, dnsIp, showSite }: { domains: Domain[]; dnsIp: string | null; showSite?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [hint, setHint] = useState<Record<string, string>>({});
  const check = useMutation({
    mutationFn: (id: string) => post<{ dnsOk: boolean; hint: string }>(`/domains/${id}/check`),
    onSuccess: (r, id) => {
      setHint((h) => ({ ...h, [id]: r.hint }));
      void qc.invalidateQueries();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => del(`/domains/${id}`), onSuccess: () => void qc.invalidateQueries() });
  const primary = useMutation({ mutationFn: (id: string) => post(`/domains/${id}/primary`), onSuccess: () => void qc.invalidateQueries() });
  const [sslFor, setSslFor] = useState<Domain | null>(null);

  if (!domains.length) return <Empty>{t("common.none")}</Empty>;
  return (
    <>
      {dnsIp && (
        <p className="mb-4 text-sm text-slate-600">
          {t("domains.pointTo", { ip: "" })} <CopyText text={dnsIp} />
        </p>
      )}
      <Table head={[t("domains.hostname"), ...(showSite ? [t("domains.site")] : []), t("domains.type"), t("domains.dns"), t("domains.ssl"), ""]}>
        {domains.map((d) => (
          <tr key={d.id} className="align-top">
            <td className="px-5 py-3">
              <a href={`https://${d.hostname}`} target="_blank" rel="noreferrer" className="font-medium hover:text-indigo-600">
                {d.hostname}
              </a>
              {d.redirectTo && <p className="text-xs text-slate-500">→ {d.redirectTo}</p>}
              {hint[d.id] && <p className="mt-1 max-w-sm text-xs text-slate-600">{hint[d.id]}</p>}
            </td>
            {showSite && (
              <td className="px-5 py-3">
                {d.site && (
                  <Link to={`/sites/${d.site.id}`} className="hover:text-indigo-600">
                    {d.site.name}
                  </Link>
                )}
              </td>
            )}
            <td className="px-5 py-3">
              <Badge tone={d.type === "primary" ? "blue" : "gray"}>{d.type}</Badge>
            </td>
            <td className="px-5 py-3">
              <Badge tone={d.dnsOk ? "green" : "yellow"}>{d.dnsOk ? "OK" : "not verified"}</Badge>
            </td>
            <td className="px-5 py-3">
              <button onClick={() => setSslFor(d)} title={t("ssl.manage")}>
                <StatusBadge status={d.sslStatus} />
              </button>
              {d.certExpiresAt && <p className="text-xs text-slate-400">→ {new Date(d.certExpiresAt).toLocaleDateString()}</p>}
            </td>
            <td className="whitespace-nowrap px-5 py-3 text-right">
              <Button variant="ghost" busy={check.isPending && check.variables === d.id} onClick={() => check.mutate(d.id)}>
                {t("domains.check")}
              </Button>
              {d.type !== "primary" && d.type !== "redirect" && (
                <Button variant="ghost" onClick={() => primary.mutate(d.id)}>
                  {t("domains.makePrimary")}
                </Button>
              )}
              {d.type !== "primary" && (
                <Button
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => {
                    if (confirm(t("common.confirmDelete", { name: d.hostname }))) remove.mutate(d.id);
                  }}
                >
                  {t("common.delete")}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <ErrorText error={check.error ?? remove.error ?? primary.error} />
      <Modal open={!!sslFor} title={`SSL · ${sslFor?.hostname ?? ""}`} onClose={() => setSslFor(null)}>
        {sslFor && <SslForm domain={sslFor} onDone={() => setSslFor(null)} />}
      </Modal>
    </>
  );
}

function SslForm({ domain, onDone }: { domain: Domain; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [certificate, setCert] = useState("");
  const [privateKey, setKey] = useState("");
  const upload = useMutation({
    mutationFn: () => put(`/domains/${domain.id}/certificate`, { certificate, privateKey }),
    onSuccess: () => {
      void qc.invalidateQueries();
      onDone();
    },
  });
  const reset = useMutation({
    mutationFn: () => del(`/domains/${domain.id}/certificate`),
    onSuccess: () => {
      void qc.invalidateQueries();
      onDone();
    },
  });
  return (
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">{domain.sslStatus === "custom" ? t("ssl.customNow") : domain.sslStatus === "dns" ? t("ssl.dnsNow") : t("ssl.autoNow")}</p>
      <Field label={t("ssl.cert")}>
        <textarea rows={5} value={certificate} onChange={(e) => setCert(e.target.value)} className="block w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" />
      </Field>
      <Field label={t("ssl.key")}>
        <textarea rows={5} value={privateKey} onChange={(e) => setKey(e.target.value)} className="block w-full rounded-lg border border-slate-300 p-2 font-mono text-xs" placeholder="-----BEGIN PRIVATE KEY-----" />
      </Field>
      <ErrorText error={upload.error ?? reset.error} />
      <div className="flex gap-2">
        <Button busy={upload.isPending} disabled={!certificate || !privateKey} onClick={() => upload.mutate()}>
          {t("ssl.upload")}
        </Button>
        {domain.sslStatus === "custom" && (
          <Button variant="secondary" busy={reset.isPending} onClick={() => reset.mutate()}>
            {t("ssl.backToAuto")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Edit "/api/* → other site" rules for one domain. */
export function PathRulesEditor({ domain }: { domain: Domain }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sites = useQuery({ queryKey: ["sites"], queryFn: () => api<{ sites: Site[] }>("/sites") });
  const targets = (sites.data?.sites ?? []).filter((s) => (s.runtime === "node" || s.runtime === "python") && !s.background && s.id !== domain.site?.id);
  const [rules, setRules] = useState(domain.pathRules ?? []);
  const save = useMutation({
    mutationFn: () => put(`/domains/${domain.id}/paths`, { rules: rules.filter((r) => r.path && r.siteId) }),
    onSuccess: () => void qc.invalidateQueries(),
  });
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium">
        {t("domains.pathRules")} · <span className="text-indigo-600">{domain.hostname}</span>
      </p>
      <p className="mb-3 text-xs text-slate-500">{t("domains.pathRulesHint")}</p>
      {rules.map((r, i) => (
        <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_auto] gap-2">
          <Input value={r.path} placeholder="/api/*" className="font-mono" onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, path: e.target.value.trim() } : x)))} />
          <Select value={r.siteId} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, siteId: e.target.value } : x)))}>
            <option value="">—</option>
            {targets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button variant="ghost" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setRules([...rules, { path: "", siteId: "" }])}>
          + rule
        </Button>
        <Button variant="secondary" busy={save.isPending} onClick={() => save.mutate()}>
          {t("common.save")}
        </Button>
      </div>
      <ErrorText error={save.error} />
    </div>
  );
}
