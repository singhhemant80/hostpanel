import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type Account } from "../api";
import { Select } from "./ui";

/** Remembers which hosting account the user is working in (admins and multi-account users). */
export function useAccountChoice(): { accounts: Account[]; account: Account | null; setAccountId: (id: string) => void; loading: boolean } {
  const q = useQuery({ queryKey: ["accounts"], queryFn: () => api<{ accounts: Account[] }>("/accounts") });
  const [id, setId] = useState<string>(() => {
    try {
      return localStorage.getItem("hp_account") ?? "";
    } catch {
      return "";
    }
  });
  const accounts = q.data?.accounts ?? [];
  const account = accounts.find((a) => a.id === id) ?? accounts.find((a) => a.status === "active") ?? accounts[0] ?? null;
  useEffect(() => {
    if (account && account.id !== id) setId(account.id);
  }, [account, id]);
  return {
    accounts,
    account,
    loading: q.isLoading,
    setAccountId: (v: string) => {
      setId(v);
      try {
        localStorage.setItem("hp_account", v);
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export function AccountPicker({ choice }: { choice: ReturnType<typeof useAccountChoice> }) {
  const { t } = useTranslation();
  if (choice.accounts.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-slate-500">{t("accounts.username")}</span>
      <Select value={choice.account?.id ?? ""} onChange={(e) => choice.setAccountId(e.target.value)} className="w-auto py-1.5">
        {choice.accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.username}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
