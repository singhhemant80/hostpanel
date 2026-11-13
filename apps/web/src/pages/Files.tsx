import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, post, put } from "../api";
import { AccountPicker, formatBytes, useAccountChoice } from "../components/AccountPicker";
import { Button, Card, Empty, ErrorText, Field, Input, Modal, cx, timeAgo } from "../components/ui";

interface Entry {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mtime: number;
  mode: string;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parent = (p: string) => p.split("/").slice(0, -1).join("/");
const isArchive = (n: string) => /\.(zip|tar|tar\.gz|tgz|tar\.xz)$/i.test(n);

export function FilesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const choice = useAccountChoice();
  const acc = choice.account;
  const [dir, setDir] = useState("sites");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; content: string; isNew?: boolean } | null>(null);
  const [prompt, setPrompt] = useState<{ title: string; value: string; onOk: (v: string) => Promise<unknown> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const upload = useRef<HTMLInputElement>(null);

  const list = useQuery({
    queryKey: ["files", acc?.id, dir],
    queryFn: () => api<{ entries: Entry[]; truncated: boolean }>(`/accounts/${acc!.id}/files?path=${encodeURIComponent(dir)}`),
    enabled: Boolean(acc),
    retry: false,
  });
  const refresh = () => {
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ["files", acc?.id] });
  };
  const op = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const base = `/accounts/${acc?.id}/files`;

  async function open(e: Entry) {
    const path = join(dir, e.name);
    if (e.type === "dir" || e.type === "link") {
      setDir(path);
      setSelected(new Set());
      return;
    }
    setError(null);
    try {
      const r = await api<{ contentB64: string; binary: boolean }>(`${base}/content?path=${encodeURIComponent(path)}`);
      if (r.binary) return download(path, e.name);
      const bytes = Uint8Array.from(atob(r.contentB64), (c) => c.charCodeAt(0));
      setEditing({ path, content: new TextDecoder().decode(bytes) });
    } catch (err) {
      setError(err);
    }
  }

  async function download(path: string, name: string) {
    const r = await post<{ token: string }>(`${base}/download`, { path });
    window.location.href = `/api/v1${base}/download/${r.token}?name=${encodeURIComponent(name)}`;
  }

  async function uploadFiles(files: FileList) {
    for (const f of Array.from(files)) {
      setBusy(`${t("files.uploading")} ${f.name}`);
      const res = await fetch(`/api/v1${base}/upload?path=${encodeURIComponent(join(dir, f.name))}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "X-HostPanel": "1", "Content-Type": "application/octet-stream" },
        body: f,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(new Error(j.message ?? `Upload of ${f.name} failed`));
        break;
      }
    }
    setBusy(null);
    refresh();
  }

  const save = useMutation({
    mutationFn: () => put(`${base}/content`, { path: editing!.path, content: editing!.content }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  const crumbs = dir ? dir.split("/") : [];
  const sel = [...selected];
  const entries = list.data?.entries ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("nav.files")}</h1>
        <AccountPicker choice={choice} />
      </div>

      <Card>
        <div className="-mt-1 mb-4 flex flex-wrap items-center gap-2">
          <nav className="mr-auto flex flex-wrap items-center gap-1 text-sm">
            <button className="font-medium text-indigo-600 hover:underline" onClick={() => setDir("")}>
              ~
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="text-slate-400">/</span>
                <button className="text-indigo-600 hover:underline" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>
                  {c}
                </button>
              </span>
            ))}
          </nav>
          <Button variant="secondary" onClick={() => setPrompt({ title: t("files.newFolder"), value: "", onOk: (v) => post(`${base}/mkdir`, { path: join(dir, v) }) })}>
            + {t("files.newFolder")}
          </Button>
          <Button variant="secondary" onClick={() => setPrompt({ title: t("files.newFile"), value: "", onOk: async (v) => setEditing({ path: join(dir, v), content: "", isNew: true }) })}>
            + {t("files.newFile")}
          </Button>
          <Button onClick={() => upload.current?.click()}>{t("files.upload")}</Button>
          <input ref={upload} type="file" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files)} />
        </div>

        {sel.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-sm">
            <span className="mr-2 font-medium">{t("files.selected", { n: sel.length })}</span>
            <Button variant="secondary" onClick={() => setPrompt({ title: t("files.compress"), value: `${sel.length === 1 ? sel[0] : "archive"}.zip`, onOk: (v) => post(`${base}/compress`, { paths: sel.map((n) => join(dir, n)), to: join(dir, v) }) })}>
              {t("files.compress")}
            </Button>
            {sel.length === 1 && (
              <>
                <Button variant="secondary" onClick={() => setPrompt({ title: t("files.rename"), value: sel[0]!, onOk: (v) => post(`${base}/rename`, { from: join(dir, sel[0]!), to: join(dir, v) }) })}>
                  {t("files.rename")}
                </Button>
                <Button variant="secondary" onClick={() => setPrompt({ title: t("files.permissions"), value: entries.find((e) => e.name === sel[0])?.mode ?? "644", onOk: (v) => post(`${base}/chmod`, { path: join(dir, sel[0]!), mode: v }) })}>
                  {t("files.permissions")}
                </Button>
                {isArchive(sel[0]!) && (
                  <Button variant="secondary" busy={busy === "extract"} onClick={() => void op("extract", () => post(`${base}/extract`, { path: join(dir, sel[0]!), into: join(dir, sel[0]!.replace(/\.(zip|tar|tar\.gz|tgz|tar\.xz)$/i, "")) }))}>
                    {t("files.extract")}
                  </Button>
                )}
              </>
            )}
            <Button
              variant="danger"
              busy={busy === "delete"}
              onClick={() => {
                if (confirm(t("common.confirmDelete", { name: sel.join(", ") }))) void op("delete", () => post(`${base}/delete`, { paths: sel.map((n) => join(dir, n)) }));
              }}
            >
              {t("common.delete")}
            </Button>
          </div>
        )}
        {busy && <p className="mb-2 text-sm text-slate-500">{busy}…</p>}
        <ErrorText error={error ?? list.error} />

        {list.isLoading ? (
          <Empty>{t("common.loading")}</Empty>
        ) : (
          <div className="-mx-5 -mb-5 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-10 px-5 py-2.5">
                    <input
                      type="checkbox"
                      checked={entries.length > 0 && sel.length === entries.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(entries.map((x) => x.name)) : new Set())}
                    />
                  </th>
                  <th className="px-2 py-2.5">{t("files.name")}</th>
                  <th className="px-5 py-2.5 text-right">{t("files.size")}</th>
                  <th className="hidden px-5 py-2.5 sm:table-cell">{t("files.modified")}</th>
                  <th className="hidden px-5 py-2.5 sm:table-cell">{t("files.mode")}</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dir && (
                  <tr className="cursor-pointer hover:bg-slate-50" onClick={() => setDir(parent(dir))}>
                    <td />
                    <td className="px-2 py-2 text-slate-500" colSpan={5}>
                      ↰ ..
                    </td>
                  </tr>
                )}
                {entries.map((e) => (
                  <tr key={e.name} className={cx("hover:bg-slate-50", selected.has(e.name) && "bg-indigo-50/60")}>
                    <td className="px-5 py-2">
                      <input
                        type="checkbox"
                        checked={selected.has(e.name)}
                        onChange={(ev) => {
                          const s = new Set(selected);
                          if (ev.target.checked) s.add(e.name);
                          else s.delete(e.name);
                          setSelected(s);
                        }}
                      />
                    </td>
                    <td className="max-w-md px-2 py-2">
                      <button onClick={() => void open(e)} className="flex min-w-0 items-center gap-2 text-left hover:text-indigo-600">
                        <span className="shrink-0">{e.type === "dir" ? "📁" : e.type === "link" ? "🔗" : "📄"}</span>
                        <span className="truncate">{e.name}</span>
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-5 py-2 text-right text-slate-500">{e.type === "dir" ? "" : formatBytes(e.size)}</td>
                    <td className="hidden whitespace-nowrap px-5 py-2 text-slate-500 sm:table-cell">{timeAgo(new Date(e.mtime * 1000).toISOString())}</td>
                    <td className="hidden px-5 py-2 font-mono text-xs text-slate-500 sm:table-cell">{e.mode}</td>
                    <td className="whitespace-nowrap px-5 py-2 text-right">
                      {e.type === "file" && (
                        <Button variant="ghost" onClick={() => void download(join(dir, e.name), e.name).catch(setError)}>
                          ⤓
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {entries.length === 0 && <Empty>{t("files.empty")}</Empty>}
          </div>
        )}
      </Card>

      <Modal wide open={!!editing} title={editing?.path ?? ""} onClose={() => setEditing(null)}>
        {editing && (
          <div className="space-y-3">
            <textarea
              value={editing.content}
              onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              spellCheck={false}
              className="block h-[60vh] w-full rounded-lg border border-slate-300 p-3 font-mono text-xs leading-relaxed"
            />
            <ErrorText error={save.error} />
            <div className="flex gap-2">
              <Button busy={save.isPending} onClick={() => save.mutate()}>
                {t("common.save")}
              </Button>
              <Button variant="secondary" onClick={() => setEditing(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!prompt} title={prompt?.title ?? ""} onClose={() => setPrompt(null)}>
        {prompt && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const p = prompt;
              setPrompt(null);
              void op("op", () => p.onOk(p.value.trim()));
            }}
          >
            <Field label={t("files.name")}>
              <Input autoFocus required value={prompt.value} onChange={(e) => setPrompt({ ...prompt, value: e.target.value })} />
            </Field>
            <Button type="submit">{t("common.save")}</Button>
          </form>
        )}
      </Modal>
    </div>
  );
}
