"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useApolloClient, useMutation, useQuery } from "@apollo/client/react";
import { CHANNELS, DELETE_CHECK, PAUSE_CHECK, RESUME_CHECK } from "@/lib/queries";
import { StatusBadge } from "@/components/status-badge";
import { ResponseTimeChart } from "@/components/response-time-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { formatDateTime, formatRelativeTime, formatSpan } from "@/lib/format";
import { CopyField } from "@/components/app/copy-field";
import { Skeleton } from "@/components/ui/skeleton";
import { EventTimeline, type TimelineEvent } from "@/components/app/event-timeline";
import { EditCheckDialog, type UpdatedCheck } from "@/components/app/edit-check-dialog";
import {
  MoveCheckDialog,
  type MoveDestination,
} from "@/components/app/move-check-dialog";
import {
  CheckNotificationChannels,
  type NotificationChannelOption,
} from "@/components/app/check-notification-channels";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8888";

type CheckStatus = "UP" | "DOWN" | "GRACE" | "NEW" | "PAUSED";

type CheckEvent = TimelineEvent;

export interface CheckDetailData {
  id: string;
  organizationId: string;
  notificationChannelIds: string[];
  name: string;
  slug: string;
  type: string;
  target: string | null;
  method: string | null;
  expectedStatus: number | null;
  intervalSeconds: number | null;
  timeoutMs: number | null;
  periodSeconds: number | null;
  graceSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  nextExpectedAt: string | null;
  status: CheckStatus;
  pingSlug: string | null;
  events: CheckEvent[];
}

function NotificationChannelsPlaceholder({
  state,
}: {
  state: "loading" | "error";
}) {
  const loading = state === "loading";
  const label = loading
    ? "Loading notification channels"
    : "Notification channels unavailable";

  return (
    <section
      role="status"
      aria-label={label}
      aria-live="polite"
      className="w-full overflow-hidden rounded-lg border border-border/70 bg-background"
    >
      <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
        <h3 className="text-sm font-medium text-foreground">Notifications</h3>
      </div>
      <div className="px-4 py-4 text-sm text-muted-foreground">
        {loading ? "Loading notification channels…" : label}
      </div>
    </section>
  );
}

function CheckNotificationChannelsSection({
  check,
}: {
  check: CheckDetailData;
}) {
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const {
    data,
    loading,
    error,
    refetch,
  } = useQuery<{ channels: NotificationChannelOption[] }>(CHANNELS, {
    variables: { organizationId: check.organizationId },
  });
  const channels = useMemo(
    () => (data?.channels ?? []).filter((channel) => channel.enabled),
    [data],
  );

  useEffect(() => {
    if (error && !data) {
      Promise.resolve().then(() => setErrorDialogOpen(true));
    } else if (data) {
      Promise.resolve().then(() => setErrorDialogOpen(false));
    }
  }, [data, error]);

  return (
    <>
      {loading && !data ? (
        <NotificationChannelsPlaceholder state="loading" />
      ) : error && !data ? (
        <NotificationChannelsPlaceholder state="error" />
      ) : data ? (
        <CheckNotificationChannels
          checkId={check.id}
          checkName={check.name}
          notificationChannelIds={check.notificationChannelIds ?? []}
          channels={channels}
          variant="detail"
        />
      ) : (
        <NotificationChannelsPlaceholder state="loading" />
      )}

      <Dialog
        open={errorDialogOpen && !data}
        onOpenChange={(open) => setErrorDialogOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notification channels unavailable</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Could not load notification channels. Please try again.
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setErrorDialogOpen(false)}
            >
              Dismiss
            </Button>
            <Button
              aria-label="Retry notification channels"
              disabled={loading}
              onClick={() => {
                setErrorDialogOpen(false);
                void refetch().catch(() => undefined);
              }}
            >
              {loading ? "Retrying…" : "Retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const VISIBLE_EVENT_STEP = 15;
// Matches `events(limit: 50)` in the CHECK queries.
const EVENT_WINDOW = 50;

const TYPE_LABELS: Record<string, string> = {
  HEARTBEAT: "Heartbeat",
  HTTP: "HTTP",
  TCP: "TCP",
};

/**
 * Figures derived from the loaded event window (the latest 50 events), so
 * each label says it describes recent activity rather than all-time history.
 */
function eventStats(events: CheckEvent[], status: CheckStatus | undefined) {
  const decided = events.filter((e) => e.status === "UP" || e.status === "DOWN");
  const up = decided.filter((e) => e.status === "UP").length;
  const responseTimes = events
    .map((e) => e.responseTimeMs)
    .filter((value): value is number => value !== null);
  let streakStart: string | null = null;
  // Only a streak that matches the check's current state says how long it
  // has been up or down; a newer status change may not have an event yet.
  if (events.length > 0 && events[0].status === status) {
    const current = events[0].status;
    for (const event of events) {
      if (event.status !== current) break;
      streakStart = event.timestamp;
    }
  }
  return {
    uptime: decided.length > 0 ? (up / decided.length) * 100 : null,
    sampleSize: decided.length,
    averageResponseMs:
      responseTimes.length > 0
        ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
        : null,
    streakStart,
    // The streak may continue past the loaded window only when that window
    // is full; otherwise the oldest event is the check's first.
    streakCoversWindow:
      streakStart !== null &&
      events.length >= EVENT_WINDOW &&
      events.every((e) => e.status === events[0].status),
  };
}

function streakLength(since: string, now: number): string {
  const seconds = Math.max(0, (now - new Date(since).getTime()) / 1000);
  // Seconds are noise once a streak passes a minute.
  return formatSpan(seconds < 60 ? Math.max(1, Math.round(seconds)) : Math.round(seconds / 60) * 60);
}

function StatTile({
  label,
  value,
  hint,
  title,
}: {
  label: string;
  value: string;
  hint?: string;
  title?: string;
}) {
  return (
    <div className="rounded-xl border bg-card px-4 py-3" title={title}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export function CheckDetail({
  check,
  loading,
  error,
  onRefetch,
  onMoved,
  onDeleted,
}: {
  check: CheckDetailData | undefined;
  loading: boolean;
  error?: Error;
  // Called after a save. The id route ignores the updated check and always
  // refetches; the slug route uses it to detect an in-place rename and
  // navigate instead — see that route's `onRefetch` for why a bare refetch
  // there would 404 the page.
  onRefetch: (updatedCheck?: UpdatedCheck) => void;
  onMoved: (destination: MoveDestination) => void;
  // Where to go once the check is gone. Routes that only render a lookup
  // state omit it, which also hides the Delete action.
  onDeleted?: () => void;
}) {
  const client = useApolloClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [visibleEvents, setVisibleEvents] = useState(VISIBLE_EVENT_STEP);
  // Relative times tick on their own so a quiet check doesn't read "just now"
  // for minutes; polling refreshes the data itself.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const [pauseCheck, { loading: pausing }] = useMutation(PAUSE_CHECK, {
    onCompleted: () => onRefetch(),
    onError: (e) => setErrorMessage(e.message),
  });
  const [resumeCheck, { loading: resuming }] = useMutation(RESUME_CHECK, {
    onCompleted: () => onRefetch(),
    onError: (e) => setErrorMessage(e.message),
  });
  const [deleteCheck, { loading: deleting }] = useMutation<{ deleteCheck: boolean }>(
    DELETE_CHECK,
  );

  useEffect(() => {
    if (error) Promise.resolve().then(() => setErrorMessage(error.message));
  }, [error]);

  async function handleDelete() {
    if (!check) return;
    try {
      const result = await deleteCheck({ variables: { id: check.id } });
      if (result.data?.deleteCheck !== true) throw new Error("Delete was not confirmed.");
      try {
        client.cache.evict({ id: "ROOT_QUERY", fieldName: "checks" });
        client.cache.evict({ id: "ROOT_QUERY", fieldName: "organizationCheckAllowance" });
        client.cache.gc();
      } catch {
        // The check is gone; a stale list refreshes on the next poll.
      }
      setConfirmingDelete(false);
      onDeleted?.();
    } catch (e) {
      setConfirmingDelete(false);
      setErrorMessage(
        e instanceof Error && e.message
          ? e.message
          : "We couldn't delete this check. Try again.",
      );
    }
  }

  // A `pingSlug` survives conversion away from HEARTBEAT so converting back
  // restores the same URL, but the endpoint itself is inert for any other
  // type (see `PingService.recordPing`) — showing the card here would
  // advertise a "working" ping URL that a curl against it will 404.
  const pingUrl =
    check?.pingSlug && check.type === "HEARTBEAT" ? `${API_URL}/ping/${check.pingSlug}` : null;
  const isActive = check && check.type !== "HEARTBEAT";
  const isPaused = check?.status === "PAUSED";
  const stats = useMemo(
    () => eventStats(check?.events ?? [], check?.status),
    [check?.events, check?.status],
  );

  // Determine whether to show the chart: active checks or any event with responseTimeMs
  const chartPoints = check?.events.map((e) => ({
    timestamp: e.timestamp,
    responseTimeMs: e.responseTimeMs,
  })) ?? [];
  const hasResponseData = chartPoints.some((p) => p.responseTimeMs !== null);
  const showChart = isActive || hasResponseData;
  const lastEvent = check?.events[0];
  const pingOverdue =
    check?.type === "HEARTBEAT" &&
    !isPaused &&
    !!check.nextExpectedAt &&
    new Date(check.nextExpectedAt).getTime() < now;
  const hasStreak =
    (check?.status === "DOWN" || check?.status === "UP") && stats.streakStart !== null;

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to dashboard
      </Link>

      {loading && (
        <div className="space-y-6">
          <Skeleton className="h-8 w-1/2 rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full rounded-lg" />
          ))}
        </div>
      )}

      {check && (
        <>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="min-w-0 break-words font-heading text-2xl font-semibold tracking-tight">
                  {check.name}
                </h1>
                <StatusBadge status={check.status} />
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                  {TYPE_LABELS[check.type] ?? check.type}
                </span>
              </div>
              {isPaused && (
                <p className="text-sm text-muted-foreground">
                  Paused — this check isn&apos;t monitored and won&apos;t send alerts until you resume it.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isPaused ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={resuming}
                  onClick={() => resumeCheck({ variables: { id: check.id } })}
                >
                  <Play className="h-4 w-4 mr-1" />
                  Resume
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pausing}
                  onClick={() => pauseCheck({ variables: { id: check.id } })}
                >
                  <Pause className="h-4 w-4 mr-1" />
                  Pause
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4 mr-1" />
                Edit
              </Button>
              <MoveCheckDialog
                checkId={check.id}
                sourceOrganizationId={check.organizationId}
                checkSlug={check.slug}
                onMoved={onMoved}
              />
              {onDeleted && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmingDelete(true)}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label={
                hasStreak ? (check.status === "DOWN" ? "Down for" : "Up for") : "Last activity"
              }
              value={
                hasStreak && stats.streakStart
                  ? `${streakLength(stats.streakStart, now)}${stats.streakCoversWindow ? "+" : ""}`
                  : lastEvent
                    ? formatRelativeTime(lastEvent.timestamp, new Date(now))
                    : "No activity yet"
              }
              hint={
                hasStreak && stats.streakStart
                  ? `Since ${formatDateTime(stats.streakStart)}`
                  : undefined
              }
            />
            <StatTile
              label="Uptime"
              value={stats.uptime === null ? "—" : `${stats.uptime.toFixed(stats.uptime === 100 ? 0 : 1)}%`}
              hint={
                stats.sampleSize > 0
                  ? `Last ${stats.sampleSize} ${stats.sampleSize === 1 ? "event" : "events"}`
                  : undefined
              }
            />
            <StatTile
              label="Avg response"
              value={stats.averageResponseMs === null ? "—" : `${stats.averageResponseMs} ms`}
              hint={stats.averageResponseMs === null ? undefined : "Recent events"}
            />
            <StatTile
              label={
                check.type === "HEARTBEAT"
                  ? pingOverdue
                    ? "Ping was due"
                    : "Next ping due"
                  : "Last checked"
              }
              value={
                check.type === "HEARTBEAT"
                  ? check.nextExpectedAt
                    ? formatRelativeTime(check.nextExpectedAt, new Date(now))
                    : "—"
                  : lastEvent
                    ? formatRelativeTime(lastEvent.timestamp, new Date(now))
                    : "—"
              }
              title={
                check.type === "HEARTBEAT" && check.nextExpectedAt
                  ? formatDateTime(check.nextExpectedAt)
                  : lastEvent
                    ? formatDateTime(lastEvent.timestamp)
                    : undefined
              }
            />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3">
                {isActive ? (
                  <>
                    {check.target && (
                      <DetailRow label={check.type === "TCP" ? "Host and port" : "URL"}>
                        <code className="break-all font-mono">{check.target}</code>
                      </DetailRow>
                    )}
                    {check.intervalSeconds && (
                      <DetailRow label="Checked every">{formatSpan(check.intervalSeconds)}</DetailRow>
                    )}
                    {check.timeoutMs && (
                      <DetailRow label="Timeout">{formatSpan(check.timeoutMs / 1000)}</DetailRow>
                    )}
                    {check.type === "HTTP" && (
                      <DetailRow label="Expected status">
                        {check.expectedStatus ?? 200}
                        {check.method ? ` · ${check.method}` : ""}
                      </DetailRow>
                    )}
                  </>
                ) : check.schedule ? (
                  <>
                    <DetailRow label="Schedule">
                      <code className="font-mono">{check.schedule}</code>
                      <span className="text-muted-foreground"> · {check.tz}</span>
                    </DetailRow>
                    {check.graceSeconds !== null && (
                      <DetailRow label="Grace period">{formatSpan(check.graceSeconds)}</DetailRow>
                    )}
                    {check.nextExpectedAt && (
                      <DetailRow label="Next run">
                        {formatDateTime(check.nextExpectedAt)}
                      </DetailRow>
                    )}
                  </>
                ) : (
                  <>
                    <DetailRow label="Expected every">{formatSpan(check.periodSeconds ?? 0)}</DetailRow>
                    {check.graceSeconds !== null && (
                      <DetailRow label="Grace period">{formatSpan(check.graceSeconds)}</DetailRow>
                    )}
                  </>
                )}
              </dl>
            </CardContent>
          </Card>

          {pingUrl && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Ping URL</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <CopyField value={pingUrl} label="ping URL" />
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">
                    Request this URL (GET or POST) each time your job finishes successfully. If a
                    ping doesn&apos;t arrive within the schedule plus the grace period, the check
                    goes down and your channels are alerted. For example, append this to a cron
                    command:
                  </p>
                  <CopyField value={`curl -fsS -m 10 --retry 3 ${pingUrl}`} label="cron command" />
                </div>
              </CardContent>
            </Card>
          )}

          <CheckNotificationChannelsSection
            key={`${check.id}:${check.organizationId}`}
            check={check}
          />

          {showChart && (
            <div className="space-y-2">
              <h2 className="text-base font-medium">Response time</h2>
              <Card>
                <CardContent className="pt-4">
                  <ResponseTimeChart points={chartPoints} />
                </CardContent>
              </Card>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-base font-medium">Recent events</h2>
              {check.events.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  Showing {Math.min(visibleEvents, check.events.length)} of {check.events.length}
                </span>
              )}
            </div>
            {check.events.length === 0 ? (
              <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                {check.type === "HEARTBEAT"
                  ? "No pings yet. Events appear here as soon as the ping URL is requested."
                  : "No events yet. The first probe runs within one interval."}
              </p>
            ) : (
              <Card>
                <CardContent className="space-y-4 pt-4">
                  <EventTimeline events={check.events.slice(0, visibleEvents)} />
                  {check.events.length > visibleEvents && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setVisibleEvents((count) => count + VISIBLE_EVENT_STEP * 2)}
                    >
                      Show more events
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </>
      )}

      {check && (
        <EditCheckDialog
          open={editing}
          onOpenChange={setEditing}
          check={check}
          onSaved={(updatedCheck) => {
            setEditing(false);
            onRefetch(updatedCheck);
          }}
        />
      )}

      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          if (!deleting) setConfirmingDelete(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {check?.name}?</DialogTitle>
            <DialogDescription>
              Monitoring stops immediately and the check&apos;s history is removed.
              {check?.type === "HEARTBEAT" &&
                " Its ping URL stops working, so remove it from your job too."}{" "}
              This cannot be undone. To stop alerts temporarily, pause the check instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? "Deleting…" : "Delete check"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
