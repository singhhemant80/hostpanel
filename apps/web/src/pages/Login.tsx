import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { LANGUAGES, setLanguage } from "../i18n";
import { Button, ErrorText, Field, Input } from "../components/ui";

export function LoginPage() {
  const { t, i18n } = useTranslation();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password, needTotp ? totp : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_required") setNeedTotp(true);
      else setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-indigo-50 to-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-indigo-600 font-bold text-white">H</span>
          <h1 className="text-lg font-semibold">{t("login.title")}</h1>
        </div>
        <Field label={t("login.email")}>
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("login.password")}>
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {needTotp && (
          <Field label={t("login.totp")}>
            <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required autoFocus value={totp} onChange={(e) => setTotp(e.target.value.trim())} />
          </Field>
        )}
        <ErrorText error={error} />
        <Button type="submit" busy={busy} className="w-full">
          {t("login.submit")}
        </Button>
        <div className="flex justify-center gap-3 text-xs text-slate-500">
          {LANGUAGES.map((l) => (
            <button type="button" key={l.code} onClick={() => setLanguage(l.code)} className={i18n.language === l.code ? "font-semibold text-indigo-600" : ""}>
              {l.label}
            </button>
          ))}
        </div>
      </form>
    </div>
  );
}
