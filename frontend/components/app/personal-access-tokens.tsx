"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@apollo/client/react";
import { KeyRound, RotateCcw } from "lucide-react";

import { API_TOKENS, REVOKE_API_TOKEN } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectAgentDialog } from "@/components/app/connect-agent-dialog";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

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
  "account:manage": "Manage account",
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

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function formatDay(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function isAccountToken(token: ApiToken) {
  return token.scopes.includes("account:manage");
}

/** What the token can reach, in words rather than raw scope strings. */
function accessSummary(token: ApiToken): string {
  if (isDeletedWorkspaceConnection(token)) return "Workspace unavailable";
  if (isAccountToken(token)) return "Account-wide · all your organizations";
  if (token.organizationName) return `Checks in ${token.organizationName}`;
  return "All organizations";
}

function TokenMeta({
  label,
  value,
  title,
  tone,
}: {
  label: string;
  value: string;
  title?: string;
  tone?: "warning" | "muted";
}) {
  return (
    <div title={title}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "mt-0.5",
          tone === "warning" && "font-medium text-warning",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
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
    <div role="status" aria-label="Loading access tokens" className="divide-y">
      <span className="sr-only">Loading access tokens</span>
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

export function PersonalAccessTokensSection({ now = systemNow }: { now?: () => Date }) {
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
  const connections = data?.apiTokens ?? noConnections;

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

  function refreshConnections() {
    setRefreshError(null);
    void refetch().catch(() => {
      if (mountedRef.current) {
        setRefreshError(
          "Token history couldn't be refreshed. Reload the page to review and revoke any newly created credentials.",
        );
      }
    });
  }

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
            "The token was revoked, but the latest history couldn't be refreshed. Reload the page to try again.",
          );
        }
      }
      if (mountedRef.current) {
        setSelected(null);
      }
    } catch {
      if (mountedRef.current) {
        setRevokeError(
          "We couldn't revoke this token. Its status has not changed. Try again.",
        );
      }
    } finally {
      revokingRef.current = false;
      if (mountedRef.current) {
        setRevoking(false);
      }
    }
  }

  const activeTokens = connections.filter(
    (token) => connectionStatus(token, currentTime) === "Active",
  );
  const inactiveTokens = connections.filter(
    (token) => connectionStatus(token, currentTime) !== "Active",
  );

  function renderToken(token: ApiToken) {
    const status = connectionStatus(token, currentTime);
    const expiresAt = token.expiresAt ? new Date(token.expiresAt) : null;
    const expiringSoon =
      status === "Active" &&
      expiresAt !== null &&
      expiresAt.getTime() - currentTime.getTime() <= EXPIRING_SOON_MS;
    return (
      <li
        key={token.id}
        aria-label={token.name}
        className={cn("py-4 first:pt-0 last:pb-0", status !== "Active" && "opacity-70")}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-heading font-medium">{token.name}</h3>
              <StatusBadge status={status} />
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <code
                className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground/80"
                title="Token prefix. The full secret is only shown when the token is created."
              >
                {token.prefix}…
              </code>
              <span>{accessSummary(token)}</span>
            </p>
            {!isAccountToken(token) && token.scopes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {token.scopes.map((scope) => (
                  <Badge key={scope} variant="outline">
                    {scopeLabels[scope] ?? scope}
                  </Badge>
                ))}
              </div>
            )}
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-3">
              <TokenMeta
                label="Created"
                value={formatRelativeTime(token.createdAt, currentTime)}
                title={formatDateTime(token.createdAt)}
              />
              <TokenMeta
                label="Last used"
                value={
                  token.lastUsedAt
                    ? formatRelativeTime(token.lastUsedAt, currentTime)
                    : "Never used"
                }
                title={token.lastUsedAt ? formatDateTime(token.lastUsedAt) : undefined}
                tone={token.lastUsedAt ? undefined : "muted"}
              />
              {token.revokedAt ? (
                <TokenMeta
                  label="Revoked on"
                  value={formatDay(token.revokedAt)}
                  title={formatDateTime(token.revokedAt)}
                />
              ) : status === "Expired" && token.expiresAt ? (
                <TokenMeta
                  label="Expired on"
                  value={formatDay(token.expiresAt)}
                  title={formatDateTime(token.expiresAt)}
                />
              ) : (
                <TokenMeta
                  label="Expires"
                  value={
                    token.expiresAt
                      ? formatRelativeTime(token.expiresAt, currentTime)
                      : "Never"
                  }
                  title={token.expiresAt ? formatDateTime(token.expiresAt) : undefined}
                  tone={expiringSoon ? "warning" : undefined}
                />
              )}
            </dl>
          </div>
          {!token.revokedAt && (
            <Button
              variant="outline"
              size="sm"
              className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
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
  }

  return (
    <section id="personal-access-tokens" aria-label="Personal access tokens" className="scroll-mt-6 space-y-4">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" aria-hidden="true" />
            <h2 className="font-heading text-lg font-semibold tracking-tight">
              Personal access tokens
            </h2>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Let AI agents like Claude Code, Codex, and Cursor, or your own scripts, manage
            SystemVitals for you. A token acts as you across every organization you belong to,
            with your current roles. Each secret is shown only once, when you create it.
          </p>
        </div>
        <div className="sm:shrink-0">
          <ConnectAgentDialog
            scope="account"
            onCreated={refreshConnections}
            onReviewConnections={refreshConnections}
          />
        </div>
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
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 id="connection-history-heading" className="font-heading font-medium">
            Your tokens
          </h2>
          {connections.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {activeTokens.length} active
              {inactiveTokens.length > 0 && ` · ${inactiveTokens.length} revoked or expired`}
            </p>
          )}
        </div>

        {loading && !data ? (
          <LoadingRows />
        ) : error ? (
          <div
            role="alert"
            className="flex flex-col items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p>
              <span className="font-medium">Couldn&apos;t load access tokens.</span>{" "}
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
            <h3 className="mt-3 font-heading font-medium">No access tokens yet</h3>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              Create a personal access token to let an agent manage your account. You&apos;ll get
              copy-and-paste setup for Claude Code, Codex, Cursor, or cURL.
            </p>
          </div>
        ) : (
          // One keyed list, active first: a token revoked or expiring while the
          // page is open moves down in place instead of jumping elsewhere.
          <ul className="divide-y">{[...activeTokens, ...inactiveTokens].map(renderToken)}</ul>
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
            <DialogTitle>Revoke access token?</DialogTitle>
            <DialogDescription>
              Anything using <strong className="font-medium text-foreground">{selected?.name}</strong>{" "}
              will immediately lose access. This action cannot be undone.
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
              {revoking ? "Revoking…" : "Revoke token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
