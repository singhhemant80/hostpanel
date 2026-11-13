import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "../auth";
import { LANGUAGES, setLanguage } from "../i18n";
import { cx } from "./ui";

const icons: Record<string, string> = {
  dashboard: "M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10",
  sites: "M3 5h18v14H3zM3 9h18M7 7h.01M10 7h.01",
  domains: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18",
  databases: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  accounts: "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 4-6 8-6s8 2 8 6",
  packages: "M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10",
  dns: "M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01",
  files: "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z",
  backups: "M12 3v12M7 10l5 5 5-5M4 19h16",
  access: "M4 6h16v12H4zM7 10l3 2-3 2M12 14h5",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  email: "M3 6h18v12H3zM3 6l9 7 9-7",
  apps: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  resellers: "M9 11a3 3 0 100-6 3 3 0 000 6zM17 11a3 3 0 100-6M3 20c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 2 6 5",
  servers: "M4 4h16v5H4zM4 15h16v5H4zM12 9v6M8 6.5h.01M8 17.5h.01",
  settings: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={icons[name]} />
    </svg>
  );
}

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user, signOut } = useAuth();
  const items = ["dashboard", "sites", "apps", "domains", "dns", "email", "databases", "files", "backups", "access"];
  const adminItems = user?.role === "admin" ? ["accounts", "resellers", "packages", "servers", "server"] : ["accounts"];

  const link = (key: string) => (
    <NavLink
      key={key}
      to={key === "dashboard" ? "/" : `/${key}`}
      end={key === "dashboard"}
      className={({ isActive }) =>
        cx("flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium", isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")
      }
    >
      <Icon name={key} />
      {t(`nav.${key}`)}
    </NavLink>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-3 py-4 md:flex">
        <div className="mb-6 flex items-center gap-2 px-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">H</span>
          <span className="font-semibold">{t("app.name")}</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {items.map(link)}
          {user?.role !== "user" && (
            <>
              <p className="mb-1 mt-5 px-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{t("nav.admin")}</p>
              {adminItems.map(link)}
            </>
          )}
          <div className="mt-auto">{link("settings")}</div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5 md:px-8">
          <span className="flex items-center gap-2 font-semibold md:hidden">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-600 text-xs font-bold text-white">H</span>
            {t("app.name")}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <select
              aria-label="Language"
              value={i18n.language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-sm"
            >
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="hidden text-sm text-slate-500 sm:inline">{user?.email}</span>
            <button onClick={() => void signOut()} className="whitespace-nowrap text-sm font-medium text-slate-600 hover:text-slate-900">
              {t("nav.logout")}
            </button>
          </div>
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 py-1.5 md:hidden">
          {[...items, ...(user?.role !== "user" ? adminItems : []), "settings"].map(link)}
        </nav>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
