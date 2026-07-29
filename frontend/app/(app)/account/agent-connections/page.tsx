"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "@apollo/client/react";
import { KeyRound, RotateCcw, ShieldCheck } from "lucide-react";

import { API_TOKENS, REVOKE_API_TOKEN } from "@/lib/queries";
import { useOrg } from "@/lib/org-context";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  organizationId: string | null;
  projectName: string | null;
  organizationName: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiTokensData {
  apiTokens: ApiToken[];
}

interface RevokeApiTokenData {
  revokeApiToken: boolean;
}

type ConnectionStatus = "Active" | "Expired" | "Inactive" | "Revoked";

const scopeLabels: Record<string, string> = {
  "checks:read": "Read checks",
  "checks:write": "Manage checks",
  read: "Read",
  write: "Write",
};
const systemNow = () => new Date();
const noConnections: ApiToken[] = [];

function connectionStatus(token: ApiToken, now: Date): ConnectionStatus {
  if (token.revokedAt) return "Revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= now.getTime()) {
    return "Expired";
  }
  if (isDeletedWorkspaceConnection(token)) return "Inactive";
  return "Active";
}

function isDeletedWorkspaceConnection(token: ApiToken) {
  return token.organizationId === null && token.projectName !== null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  if (status === "Active") {
    return (
      <Badge className="bg-success/10 text-success ring-1 ring-success/20">
        {status}
      </Badge>
    );
  }
  if (status === "Revoked") {
    return <Badge variant="destructive">{status}</Badge>;
  }
  if (status === "Inactive") {
    return <Badge variant="secondary">{status}</Badge>;
  }
  return (
    <Badge className="bg-warning/10 text-warning ring-1 ring-warning/20">
      {status}
    </Badge>
  );
}

function LoadingRows() {
  return (
    <div role="status" aria-label="Loading agent connections" className="divide-y">
      <span className="sr-only">Loading agent connections</span>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          data-testid="connection-skeleton"
          className="space-y-3 py-5 first:pt-0"
        >
          <div className="flex items-center justify-between gap-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-64 max-w-full" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-24 rounded-full" />
            <Skeleton className="h-5 w-28 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function AgentConnectionsPage({ now = systemNow }: { now?: () => Date }) {
  const { activeOrg } = useOrg();
  const { data, loading, error, refetch } = useQuery<ApiTokensData>(API_TOKENS, {
    fetchPolicy: "cache-and-network",
  });
  const [revokeApiToken] = useMutation<RevokeApiTokenData, { id: string }>(
    REVOKE_API_TOKEN,
  );
  const [selected, setSelected] = useState<ApiToken | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [currentTime, setCurrentTime] = useState(now);
  const revokingRef = useRef(false);
  const mountedRef = useRef(true);
  const connections = useMemo(
    () =>
      (data?.apiTokens ?? noConnections).filter(
        (token) =>
          token.organizationId === activeOrg?.id ||
          token.organizationId === null,
      ),
    [activeOrg?.id, data?.apiTokens],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const currentTimestamp = currentTime.getTime();
    const nearestExpiration = connections.reduce<number | null>((nearest, token) => {
      if (token.revokedAt || !token.expiresAt) return nearest;
      const expiresAt = new Date(token.expiresAt).getTime();
      if (expiresAt <= currentTimestamp) return nearest;
      return nearest === null || expiresAt < nearest ? expiresAt : nearest;
    }, null);
    if (nearestExpiration === null) return;

    const maxSafeDelay = 2_147_483_647;
    const delay = Math.min(nearestExpiration - currentTimestamp, maxSafeDelay);
    const timer = window.setTimeout(() => setCurrentTime(now()), delay);
    return () => window.clearTimeout(timer);
  }, [connections, currentTime, now]);

  async function handleRevoke() {
    if (!selected || revokingRef.current) return;
    revokingRef.current = true;
    setRevoking(true);
    setRevokeError(null);
    setRefreshError(null);
    try {
      const revokedAt = now().toISOString();
      const result = await revokeApiToken({
        variables: { id: selected.id },
        update(cache, { data: mutationData }) {
          if (mutationData?.revokeApiToken !== true) return;
          const cached = cache.readQuery<ApiTokensData>({ query: API_TOKENS });
          if (!cached) return;
          cache.writeQuery<ApiTokensData>({
            query: API_TOKENS,
            data: {
              apiTokens: cached.apiTokens.map((token) =>
                token.id === selected.id ? { ...token, revokedAt } : token,
              ),
            },
          });
        },
      });
      if (result.data?.revokeApiToken !== true) throw new Error("Revoke was not confirmed");
      try {
        await refetch();
      } catch {
        if (mountedRef.current) {
          setRefreshError(
            "The connection was revoked, but the latest history couldn't be refreshed. Reload the page to try again.",
          );
        }
      }
      if (mountedRef.current) {
        setSelected(null);
      }
    } catch {
      if (mountedRef.current) {
        setRevokeError(
          "We couldn't revoke this connection. Its status has not changed. Try again.",
        );
      }
    } finally {
      revokingRef.current = false;
      if (mountedRef.current) {
        setRevoking(false);
      }
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Agent connections
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Review and revoke the credentials used by coding agents and automation.
        </p>
      </header>

      {refreshError && (
        <p
          role="alert"
          className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm"
        >
          {refreshError}
        </p>
      )}

      <section
        aria-labelledby="connection-history-heading"
        className="rounded-xl border bg-card p-4 shadow-xs sm:p-6"
      >
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="connection-history-heading" className="font-heading font-medium">
              Connection history
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Expired, revoked, and unavailable-workspace credentials remain here for your
              records.
            </p>
          </div>
          <ShieldCheck className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>

        {loading && !data ? (
          <LoadingRows />
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p>
              <span className="font-medium">Couldn&apos;t load agent connections.</span>{" "}
              Check your connection and try again.
            </p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RotateCcw aria-hidden="true" />
              Try again
            </Button>
          </div>
        ) : connections.length === 0 ? (
          <div className="rounded-lg border border-dashed px-5 py-10 text-center">
            <KeyRound className="mx-auto h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-3 font-heading font-medium">No agent connections yet</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Open an organization and choose Connect agent to create one.
            </p>
            <Link href="/dashboard" className={`${buttonVariants()} mt-4`}>
              Go to dashboard
            </Link>
          </div>
        ) : (
          <ul className="divide-y">
            {connections.map((token) => {
              const status = connectionStatus(token, currentTime);
              const location = isDeletedWorkspaceConnection(token)
                ? "Workspace unavailable"
                : token.organizationName ?? "All organizations";
              return (
                <li
                  key={token.id}
                  aria-label={token.name}
                  className="py-5 first:pt-0 last:pb-0"
                >
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate font-heading font-medium">{token.name}</h3>
                        <StatusBadge status={status} />
                        <code className="text-xs text-muted-foreground">{token.prefix}…</code>
                      </div>
                      <p className="text-sm text-muted-foreground">{location}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {token.scopes.map((scope) => (
                          <Badge key={scope} variant="outline">
                            {scopeLabels[scope] ?? scope}
                          </Badge>
                        ))}
                      </div>
                      <dl className="grid gap-x-8 gap-y-2 text-xs sm:grid-cols-3">
                        <div>
                          <dt className="text-muted-foreground">Created</dt>
                          <dd className="mt-0.5">{formatDate(token.createdAt)}</dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Expires</dt>
                          <dd className="mt-0.5">
                            {token.expiresAt ? formatDate(token.expiresAt) : "Never"}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Last used</dt>
                          <dd className="mt-0.5">
                            {token.lastUsedAt ? formatDate(token.lastUsedAt) : "Never used"}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    {!token.revokedAt && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => {
                          setRevokeError(null);
                          setSelected(token);
                        }}
                        aria-label={`Revoke ${token.name}`}
                      >
                        Revoke
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open && !revoking) {
            setSelected(null);
            setRevokeError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke agent connection?</DialogTitle>
            <DialogDescription>
              {selected?.name} will immediately lose access. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {revokeError && (
            <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {revokeError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={revoking}
              onClick={() => {
                setSelected(null);
                setRevokeError(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={revoking} onClick={() => void handleRevoke()}>
              {revoking ? "Revoking…" : "Revoke connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AgentConnectionsRoute() {
  return <AgentConnectionsPage />;
}
