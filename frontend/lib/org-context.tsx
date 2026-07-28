"use client";
import { createContext, useContext, useState, ReactNode } from "react";
import { useAuth } from "./auth-context";
import type { Org } from "./auth-context";

export type { Org };
export const ACTIVE_ORG_STORAGE_KEY = "sv_active_org";

interface OrgCtx {
  orgs: Org[];
  activeOrg: Org | null;
  activeOrgId: string | null;
  setActiveOrgId: (id: string) => void;
}

const Ctx = createContext<OrgCtx | null>(null);

/**
 * Reads the stored active-org id. Safe to call during the first render:
 * `(app)/layout.tsx` renders only a loading spinner until auth resolves, so
 * OrgProvider never appears in server-rendered output and there is nothing to
 * hydrate against. The `typeof window` guard keeps that assumption honest if
 * the provider is ever mounted somewhere that does render on the server.
 */
function readStoredOrgId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const orgs = user?.organizations ?? [];

  // Lazy initializer rather than a mount effect: an effect runs after the
  // browser paints, so the first frame would show orgs[0] and then swap to
  // the org the user actually chose -- a visible flash for anyone in more
  // than one organization.
  const [storedId, setStoredId] = useState<string | null>(readStoredOrgId);

  // Self-heal: if the stored org is gone (invite revoked, member removed,
  // org deleted) fall back to the first one the user still belongs to. This
  // is derived on every render from the live `orgs`, so a mid-session loss of
  // access recovers on the next refetchMe without the stale stored id ever
  // needing to be rewritten.
  const activeOrg = orgs.find((o) => o.id === storedId) ?? orgs[0] ?? null;

  function setActiveOrgId(id: string) {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, id);
    setStoredId(id);
  }

  return (
    <Ctx.Provider
      value={{
        orgs,
        activeOrg,
        activeOrgId: activeOrg?.id ?? null,
        setActiveOrgId,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useOrg() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}
