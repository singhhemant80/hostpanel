import { createContext, useContext, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, post, type User } from "./api";
import { setLanguage } from "./i18n";

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string, totp?: string) => Promise<void>;
  signOut: () => Promise<void>;
  reload: () => void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const r = await api<{ user: User }>("/auth/me");
        return r.user;
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
  });

  const value: AuthState = {
    user: me.data ?? null,
    loading: me.isLoading,
    async signIn(email, password, totp) {
      const r = await post<{ user: User }>("/auth/login", { email, password, ...(totp ? { totp } : {}) });
      setLanguage(r.user.locale);
      qc.setQueryData(["me"], r.user);
    },
    async signOut() {
      await post("/auth/logout").catch(() => undefined);
      qc.clear();
      qc.setQueryData(["me"], null);
    },
    reload: () => void qc.invalidateQueries({ queryKey: ["me"] }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
