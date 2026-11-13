import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, del, patch, post, put, type Account } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, CopyText, Empty, ErrorText, Field, Input, Modal, Select, Table } from "../components/ui";

interface MailDomain {
  id: string;
  name: string;
  catchAll: string | null;
  mailboxCount: number;
  aliasCount: number;
  account: { username: string };
}
interface Mailbox {
  id: string;
  address: string;
  quotaMb: number;
  enabled: boolean;
  usedMb: number | null;
}
interface Alias {
  id: string;
  source: string;
  destinations: string[];
}
interface DnsRec {
  type: string;
  name: string;
  content: string;
  priority?: number;
  purpose: string;
}
interface Detail {
  domain: { id: string; name: string; catchAll: string | null };
  mailboxes: Mailbox[];
  aliases: Alias[];
  dns: DnsRec[];
  canApplyDns: boolean;
  limits: { maxMailboxes: number; used: number };
  client: { webmail: string; imap: { host: string; port: number; security: string }; pop3: { host: string; port: number; security: string }; smtp: { host: string; port: number; security: string; altPort: number } };
}

export function EmailPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["mail"], queryFn: () => api<{ domains: MailDomain[]; mailHost: string }>("/mail/domains") });
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const [selected, setSelected] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState("");
  const active = accounts.data?.accounts.filter((a) => a.status === "active") ?? [];

  const add = useMutation({
    mutationFn: () => post<{ domain: { id: string } }>("/mail/domains", { name, accountId: accountId || undefined }),
    onSuccess: (r) => {
      setAddOpen(false);
      setName("");
      void qc.invalidateQueries({ queryKey: ["mail"] });
      setSelected(r.domain.id);
    },
  });
  const current = selected ?? list.data?.domains[0]?.id ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("nav.email")}</h1>
        <div className="flex gap-2">
          <a href="/webmail/" target="_blank" rel="noreferrer">
            <Button variant="secondary">{t("email.openWebmail")}</Button>
          </a>
          <Button onClick={() => setAddOpen(true)}>+ {t("email.addDomain")}</Button>
        </div>
      </div>

      {list.data && !list.data.domains.length ? (
        <Card>
          <Empty>{t("email.noDomains")}</Empty>
        </Card>
      ) : (
        <div className="flex flex-wrap gap-2">
          {list.data?.domains.map((d) => (
            <button
              key={d.id}
              onClick={() => setSelected(d.id)}
              className={`rounded-lg border px-3 py-2 text-left text-sm ${d.id === current ? "border-indigo-500 bg-indigo-50" : "border-slate-200 bg-white hover:bg-slate-50"}`}
            >
              <p className="font-medium">{d.name}</p>
              <p className="text-xs text-slate-500">
                {t("email.counts", { mailboxes: d.mailboxCount, aliases: d.aliasCount })}
                {user?.role !== "user" && ` · ${d.account.username}`}
              </p>
            </button>
          ))}
        </div>
      )}

      {current && <DomainDetail key={current} id={current} onDeleted={() => setSelected(null)} />}

      <Modal open={addOpen} title={t("email.addDomain")} onClose={() => setAddOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          {(user?.role !== "user" || active.length > 1) && (
            <Field label={t("accounts.username")}>
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
                <option value="">—</option>
                {active.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.username}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t("email.domain")} hint={t("email.domainHint")}>
            <Input required placeholder="example.com" value={name} onChange={(e) => setName(e.target.value.trim().toLowerCase())} />
          </Field>
          <ErrorText error={add.error} />
          <Button type="submit" busy={add.isPending}>
            {t("common.add")}
          </Button>
        </form>
      </Modal>
    </div>
  );
}

function DomainDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mail", id], queryFn: () => api<Detail>(`/mail/domains/${id}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["mail"] });
  };
  const [boxOpen, setBoxOpen] = useState(false);
  const [box, setBox] = useState({ localPart: "", password: "", quotaMb: 1024 });
  const [aliasOpen, setAliasOpen] = useState(false);
  const [alias, setAlias] = useState({ localPart: "", destinations: "" });
  const [pwFor, setPwFor] = useState<Mailbox | null>(null);
  const [newPw, setNewPw] = useState("");
  const [catchAll, setCatchAll] = useState<string | null>(null);
  const [dnsResult, setDnsResult] = useState<{ created: string[]; skipped: string[] } | null>(null);

  const addBox = useMutation({
    mutationFn: () => post("/mail/mailboxes", { domainId: id, ...box }),
    onSuccess: () => {
      setBoxOpen(false);
      setBox({ localPart: "", password: "", quotaMb: 1024 });
      refresh();
    },
  });
  const updBox = useMutation({ mutationFn: ({ mb, body }: { mb: Mailbox; body: object }) => patch(`/mail/mailboxes/${mb.id}`, body), onSuccess: refresh });
  const delBox = useMutation({ mutationFn: (mb: Mailbox) => del(`/mail/mailboxes/${mb.id}`), onSuccess: refresh });
  const addAlias = useMutation({
    mutationFn: () =>
      post("/mail/aliases", {
        domainId: id,
        localPart: alias.localPart,
        destinations: alias.destinations
          .split(/[\s,;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setAliasOpen(false);
      setAlias({ localPart: "", destinations: "" });
      refresh();
    },
  });
  const delAlias = useMutation({ mutationFn: (a: Alias) => del(`/mail/aliases/${a.id}`), onSuccess: refresh });
  const saveCatchAll = useMutation({ mutationFn: (v: string | null) => put(`/mail/domains/${id}/catchall`, { catchAll: v }), onSuccess: refresh });
  const applyDns = useMutation({ mutationFn: () => post<{ created: string[]; skipped: string[] }>(`/mail/domains/${id}/dns`), onSuccess: setDnsResult });
  const delDomain = useMutation({
    mutationFn: () => del(`/mail/domains/${id}`),
    onSuccess: () => {
      onDeleted();
      refresh();
    },
  });

  if (!q.data) return <ErrorText error={q.error} />;
  const d = q.data;
  const ca = catchAll ?? d.domain.catchAll ?? "";

  return (
    <div className="space-y-6">
      <Card
        title={t("email.mailboxes", { used: d.limits.used, max: d.limits.maxMailboxes })}
        actions={
          <Button onClick={() => setBoxOpen(true)} disabled={d.limits.used >= d.limits.maxMailboxes}>
            + {t("email.newMailbox")}
          </Button>
        }
      >
        {d.mailboxes.length ? (
          <Table head={[t("email.address"), t("email.usage"), t("common.status"), ""]}>
            {d.mailboxes.map((m) => (
              <tr key={m.id}>
                <td className="px-5 py-3 font-medium">{m.address}</td>
                <td className="px-5 py-3 text-xs text-slate-600">
                  {m.usedMb ?? "–"} / {m.quotaMb} MB
                  {m.usedMb !== null && (
                    <div className="mt-1 h-1.5 w-28 rounded bg-slate-100">
                      <div className="h-1.5 rounded bg-indigo-500" style={{ width: `${Math.min(100, (m.usedMb / m.quotaMb) * 100)}%` }} />
                    </div>
                  )}
                </td>
                <td className="px-5 py-3">{m.enabled ? <Badge tone="green">{t("email.enabled")}</Badge> : <Badge tone="red">{t("email.disabled")}</Badge>}</td>
                <td className="whitespace-nowrap px-5 py-3 text-right">
                  <Button variant="ghost" onClick={() => setPwFor(m)}>
                    {t("email.changePassword")}
                  </Button>
                  <Button variant="ghost" onClick={() => updBox.mutate({ mb: m, body: { enabled: !m.enabled } })}>
                    {m.enabled ? t("email.disable") : t("email.enable")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-red-600"
                    onClick={() => {
                      if (confirm(t("email.confirmDeleteMailbox", { name: m.address }))) delBox.mutate(m);
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{t("common.none")}</Empty>
        )}
        <ErrorText error={updBox.error ?? delBox.error} />
      </Card>

      <Card title={t("email.forwarders")} actions={<Button variant="secondary" onClick={() => setAliasOpen(true)}>+ {t("email.newForwarder")}</Button>}>
        {d.aliases.length ? (
          <Table head={[t("email.from"), t("email.to"), ""]}>
            {d.aliases.map((a) => (
              <tr key={a.id}>
                <td className="px-5 py-3 font-medium">{a.source}</td>
                <td className="px-5 py-3 text-xs">{a.destinations.join(", ")}</td>
                <td className="px-5 py-3 text-right">
                  <Button variant="ghost" className="text-red-600" onClick={() => delAlias.mutate(a)}>
                    {t("common.delete")}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{t("common.none")}</Empty>
        )}
        <div className="mt-5 flex flex-wrap items-end gap-2 border-t border-slate-100 pt-4">
          <div className="min-w-[16rem] flex-1">
            <Field label={t("email.catchAll")} hint={t("email.catchAllHint", { domain: d.domain.name })}>
              <Input type="email" placeholder="you@example.com" value={ca} onChange={(e) => setCatchAll(e.target.value)} />
            </Field>
          </div>
          <Button variant="secondary" busy={saveCatchAll.isPending} onClick={() => saveCatchAll.mutate(ca.trim() || null)}>
            {t("common.save")}
          </Button>
        </div>
        <ErrorText error={delAlias.error ?? saveCatchAll.error} />
      </Card>

      <Card
        title={t("email.dnsRecords")}
        actions={
          d.canApplyDns && (
            <Button variant="secondary" busy={applyDns.isPending} onClick={() => applyDns.mutate()}>
              {t("email.addToCloudflare")}
            </Button>
          )
        }
      >
        <p className="mb-3 text-sm text-slate-600">{t("email.dnsHelp")}</p>
        <div className="space-y-3">
          {d.dns.map((r, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge tone="blue">{r.type}</Badge>
                <CopyText text={r.name} />
                {r.priority !== undefined && <span className="text-xs text-slate-500">priority {r.priority}</span>}
                <span className="text-xs text-slate-500">{r.purpose}</span>
              </div>
              <div className="break-all">
                <CopyText text={r.content} />
              </div>
            </div>
          ))}
        </div>
        {dnsResult && (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {t("email.dnsApplied", { created: dnsResult.created.length, skipped: dnsResult.skipped.length })}
          </p>
        )}
        <ErrorText error={applyDns.error} />
      </Card>

      <Card title={t("email.clientSettings")}>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <Setting label={t("email.webmail")} value={d.client.webmail} />
          <Setting label={t("email.username")} value={t("email.usernameHint")} plain />
          <Setting label="IMAP" value={`${d.client.imap.host} : ${d.client.imap.port} (${d.client.imap.security})`} />
          <Setting label="POP3" value={`${d.client.pop3.host} : ${d.client.pop3.port} (${d.client.pop3.security})`} />
          <Setting label="SMTP" value={`${d.client.smtp.host} : ${d.client.smtp.port} (${d.client.smtp.security}) · ${d.client.smtp.altPort} (SSL/TLS)`} />
        </div>
      </Card>

      <div className="text-right">
        <Button
          variant="danger"
          busy={delDomain.isPending}
          onClick={() => {
            if (confirm(t("email.confirmDeleteDomain", { name: d.domain.name }))) delDomain.mutate();
          }}
        >
          {t("email.removeDomain")}
        </Button>
        <ErrorText error={delDomain.error} />
      </div>

      <Modal open={boxOpen} title={t("email.newMailbox")} onClose={() => setBoxOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            addBox.mutate();
          }}
        >
          <Field label={t("email.address")}>
            <div className="flex items-center gap-2">
              <Input required value={box.localPart} onChange={(e) => setBox({ ...box, localPart: e.target.value.toLowerCase() })} />
              <span className="text-sm text-slate-500">@{d.domain.name}</span>
            </div>
          </Field>
          <Field label={t("login.password")} hint={t("email.passwordHint")}>
            <Input required minLength={10} type="password" autoComplete="new-password" value={box.password} onChange={(e) => setBox({ ...box, password: e.target.value })} />
          </Field>
          <Field label={t("email.quota")}>
            <Input type="number" min={50} value={box.quotaMb} onChange={(e) => setBox({ ...box, quotaMb: Number(e.target.value) })} />
          </Field>
          <ErrorText error={addBox.error} />
          <Button type="submit" busy={addBox.isPending}>
            {t("common.create")}
          </Button>
        </form>
      </Modal>

      <Modal open={aliasOpen} title={t("email.newForwarder")} onClose={() => setAliasOpen(false)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            addAlias.mutate();
          }}
        >
          <Field label={t("email.from")}>
            <div className="flex items-center gap-2">
              <Input required value={alias.localPart} onChange={(e) => setAlias({ ...alias, localPart: e.target.value.toLowerCase() })} />
              <span className="text-sm text-slate-500">@{d.domain.name}</span>
            </div>
          </Field>
          <Field label={t("email.to")} hint={t("email.toHint")}>
            <Input required value={alias.destinations} onChange={(e) => setAlias({ ...alias, destinations: e.target.value })} />
          </Field>
          <ErrorText error={addAlias.error} />
          <Button type="submit" busy={addAlias.isPending}>
            {t("common.create")}
          </Button>
        </form>
      </Modal>

      <Modal open={!!pwFor} title={pwFor?.address ?? ""} onClose={() => setPwFor(null)}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (pwFor)
              updBox.mutate(
                { mb: pwFor, body: { password: newPw } },
                {
                  onSuccess: () => {
                    setPwFor(null);
                    setNewPw("");
                  },
                },
              );
          }}
        >
          <Field label={t("email.newPassword")} hint={t("email.passwordHint")}>
            <Input required minLength={10} type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          </Field>
          <ErrorText error={updBox.error} />
          <Button type="submit" busy={updBox.isPending}>
            {t("common.save")}
          </Button>
        </form>
      </Modal>
    </div>
  );
}

function Setting({ label, value, plain }: { label: string; value: string; plain?: boolean }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      {plain ? <p>{value}</p> : <CopyText text={value} />}
    </div>
  );
}
