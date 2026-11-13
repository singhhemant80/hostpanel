import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { patch, post } from "../api";
import { useAuth } from "../auth";
import { LANGUAGES, setLanguage } from "../i18n";
import { Button, Card, CopyText, ErrorText, Field, Input, Select } from "../components/ui";

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { user, reload } = useAuth();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const lang = useMutation({
    mutationFn: (locale: string) => patch("/auth/me", { locale }),
    onSuccess: (_d, locale) => {
      setLanguage(locale);
      reload();
    },
  });
  const pw = useMutation({ mutationFn: () => post("/auth/password", { current: cur, next }), onSuccess: () => window.location.reload() });
  const setup = useMutation({ mutationFn: () => post<{ secret: string }>("/auth/2fa/setup"), onSuccess: (r) => setSecret(r.secret) });
  const enable = useMutation({
    mutationFn: () => post("/auth/2fa/enable", { code }),
    onSuccess: () => {
      setSecret(null);
      setCode("");
      reload();
    },
  });
  const disable = useMutation({
    mutationFn: () => post("/auth/2fa/disable", { code }),
    onSuccess: () => {
      setCode("");
      reload();
    },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">{t("nav.settings")}</h1>
      <Card title={t("settings.profile")}>
        <p className="text-sm">
          {user?.name} · {user?.email} · <span className="text-slate-500">{user?.role}</span>
        </p>
        <div className="mt-4 max-w-xs">
          <Field label={t("settings.language")}>
            <Select value={i18n.language} onChange={(e) => lang.mutate(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      <Card title={t("settings.password")}>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            pw.mutate();
          }}
        >
          <Field label={t("settings.current")}>
            <Input type="password" required value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label={t("settings.next")}>
            <Input type="password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <div className="sm:col-span-2">
            <ErrorText error={pw.error} />
            <Button type="submit" busy={pw.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Card>

      <Card title={t("settings.twofa")}>
        {user?.totpEnabled ? (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Code">
              <Input inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.trim())} />
            </Field>
            <Button variant="danger" busy={disable.isPending} onClick={() => disable.mutate()}>
              {t("settings.disable2fa")}
            </Button>
          </div>
        ) : secret ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">{t("settings.scan")}</p>
            <CopyText text={secret} />
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Code">
                <Input inputMode="numeric" pattern="\d{6}" value={code} onChange={(e) => setCode(e.target.value.trim())} />
              </Field>
              <Button busy={enable.isPending} onClick={() => enable.mutate()}>
                {t("settings.enable2fa")}
              </Button>
            </div>
          </div>
        ) : (
          <Button busy={setup.isPending} onClick={() => setup.mutate()}>
            {t("settings.enable2fa")}
          </Button>
        )}
        <ErrorText error={setup.error ?? enable.error ?? disable.error} />
      </Card>
    </div>
  );
}
