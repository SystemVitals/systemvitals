"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    // Base64url → base64
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeEmailFromToken(token: string): string | null {
  const parsed = decodeJwtPayload(token);
  if (!parsed) return null;
  const email = parsed.email;
  return typeof email === "string" ? email : null;
}

export function ImpersonationBanner() {
  const { user } = useAuth();
  const [isImpersonating, setIsImpersonating] = useState(false);
  const [impersonatedEmail, setImpersonatedEmail] = useState<string | null>(null);

  useEffect(() => {
    const adminToken = localStorage.getItem("sv_admin_token");
    if (!adminToken) {
      Promise.resolve().then(() => {
        setIsImpersonating(false);
        setImpersonatedEmail(null);
      });
      return;
    }
    const currentToken = localStorage.getItem("sv_token");
    const payload = currentToken ? decodeJwtPayload(currentToken) : null;
    const hasActClaim = Boolean(payload?.act);
    if (!hasActClaim) {
      Promise.resolve().then(() => {
        setIsImpersonating(false);
        setImpersonatedEmail(null);
      });
      return;
    }
    const email = currentToken ? decodeEmailFromToken(currentToken) : null;
    Promise.resolve().then(() => {
      setIsImpersonating(true);
      setImpersonatedEmail(email ?? user?.email ?? null);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: localStorage tokens are set once during impersonation and don't change across re-renders
  }, []);

  if (!isImpersonating) return null;

  function handleExit() {
    const adminToken = localStorage.getItem("sv_admin_token");
    if (adminToken) {
      localStorage.setItem("sv_token", adminToken);
    }
    localStorage.removeItem("sv_admin_token");
    window.location.assign("/admin/users");
  }

  return (
    <div role="alert" className="sticky top-0 z-50 flex items-center justify-between gap-4 bg-warning px-4 py-2 text-sm font-medium text-warning-foreground">
      <span>
        Viewing as{" "}
        <span className="font-semibold">{impersonatedEmail ?? "unknown user"}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={handleExit}>Exit</Button>
    </div>
  );
}
