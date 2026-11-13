import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./index.css";
import "./i18n";
import { AuthProvider, useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { SitesPage } from "./pages/Sites";
import { NewSitePage } from "./pages/NewSite";
import { SiteDetailPage } from "./pages/SiteDetail";
import { DomainsPage } from "./pages/Domains";
import { DatabasesPage } from "./pages/Databases";
import { AccountsPage } from "./pages/Accounts";
import { PackagesPage } from "./pages/Packages";
import { SettingsPage } from "./pages/Settings";
import { FilesPage } from "./pages/Files";
import { BackupsPage } from "./pages/Backups";
import { DnsPage } from "./pages/Dns";
import { AccountAccessPage } from "./pages/AccountAccess";
import { ServerSettingsPage } from "./pages/ServerSettings";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="grid min-h-screen place-items-center text-slate-500">…</div>;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="sites" element={<SitesPage />} />
        <Route path="sites/new" element={<NewSitePage />} />
        <Route path="sites/:id" element={<SiteDetailPage />} />
        <Route path="domains" element={<DomainsPage />} />
        <Route path="databases" element={<DatabasesPage />} />
        <Route path="dns" element={<DnsPage />} />
        <Route path="files" element={<FilesPage />} />
        <Route path="backups" element={<BackupsPage />} />
        <Route path="access" element={<AccountAccessPage />} />
        {user.role === "admin" && <Route path="server" element={<ServerSettingsPage />} />}
        {user.role === "admin" && <Route path="accounts" element={<AccountsPage />} />}
        {user.role === "admin" && <Route path="packages" element={<PackagesPage />} />}
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
