"use client";
import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { getApolloContext } from "@apollo/client/react";

export interface Org {
  id: string;
  name: string;
  slug: string;
  role: string;
  plan: string;
  creatorUserId: string;
  creatorLabel: string;
  pingKey: string;
}
interface User { id: string; email: string; isAdmin: boolean; hasPassword: boolean; googleLinked: boolean; organizations: Org[] }

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  loginWithToken: (token: string) => Promise<void>;
  refetchMe: () => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<AuthCtx | null>(null);
const API = process.env.NEXT_PUBLIC_API_URL;

async function fetchMe(token: string): Promise<User | null> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: `{ me { id email isAdmin hasPassword googleLinked organizations { id name slug role plan creatorUserId creatorLabel pingKey } } }` }),
  });
  const json = await res.json();
  return json.data?.me ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // Optional: tests render AuthProvider without an ApolloProvider.
  const apolloClient = useContext(getApolloContext()).client;

  /**
   * Drops every cached query result when the signed-in account changes, so the
   * next account never sees the previous one's data (for example a cached
   * overview) while its own queries load.
   */
  async function clearApolloStore() {
    try {
      await apolloClient?.clearStore();
    } catch {
      // Clearing only discards cached data; a failure must not block auth.
    }
  }

  useEffect(() => {
    const token = localStorage.getItem("sv_token");
    if (!token) {
      Promise.resolve().then(() => setLoading(false));
      return;
    }
    fetchMe(token).then(setUser).finally(() => setLoading(false));
  }, []);

  async function authenticate(path: "login" | "signup", email: string, password: string) {
    const res = await fetch(`${API}/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error("Authentication failed");
    const { token } = await res.json();
    localStorage.setItem("sv_token", token);
    const me = await fetchMe(token);
    await clearApolloStore();
    setUser(me);
  }

  async function loginWithToken(token: string) {
    const me = await fetchMe(token);
    if (!me) throw new Error("Authentication failed");
    localStorage.setItem("sv_token", token);
    await clearApolloStore();
    setUser(me);
  }

  async function refetchMe() {
    const token = localStorage.getItem("sv_token");
    if (!token) return;
    setUser(await fetchMe(token));
  }

  return (
    <Ctx.Provider value={{
      user, loading,
      login: (e, p) => authenticate("login", e, p),
      signup: (e, p) => authenticate("signup", e, p),
      loginWithToken,
      refetchMe,
      logout: () => {
        localStorage.removeItem("sv_token");
        localStorage.removeItem("sv_admin_token");
        // Queue the signed-out render before the clear (itself a microtask), so
        // signed-in pages normally unmount before their in-flight queries are
        // cancelled under them.
        setUser(null);
        void clearApolloStore();
      },
    }}>{children}</Ctx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
