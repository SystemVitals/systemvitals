"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@apollo/client/react";
import { CHANNELS } from "@/lib/queries";
import { StatusBadge } from "@/components/status-badge";
import { ResponseTimeChart } from "@/components/response-time-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ArrowLeft, Pencil } from "lucide-react";
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
  projectId: string;
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
    variables: { projectId: check.projectId },
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

export function CheckDetail({
  check,
  loading,
  error,
  onRefetch,
  onMoved,
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
}) {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (error) Promise.resolve().then(() => setErrorMessage(error.message));
  }, [error]);

  // A `pingSlug` survives conversion away from HEARTBEAT so converting back
  // restores the same URL, but the endpoint itself is inert for any other
  // type (see `PingService.recordPing`) — showing the card here would
  // advertise a "working" ping URL that a curl against it will 404.
  const pingUrl =
    check?.pingSlug && check.type === "HEARTBEAT" ? `${API_URL}/ping/${check.pingSlug}` : null;
  const isActive = check && check.type !== "HEARTBEAT";

  // Determine whether to show the chart: active checks or any event with responseTimeMs
  const chartPoints = check?.events.map((e) => ({
    timestamp: e.timestamp,
    responseTimeMs: e.responseTimeMs,
  })) ?? [];
  const hasResponseData = chartPoints.some((p) => p.responseTimeMs !== null);
  const showChart = isActive || hasResponseData;

  return (
    <div className="px-4 py-6 sm:px-6 space-y-6">
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
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{check.name}</h1>
            <StatusBadge status={check.status} />
            <span className="text-xs text-muted-foreground uppercase tracking-wide">
              {check.type}
            </span>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4 mr-1" />
              Edit
            </Button>
            <MoveCheckDialog
              checkId={check.id}
              sourceProjectId={check.projectId}
              checkSlug={check.slug}
              onMoved={onMoved}
            />
          </div>

          {pingUrl && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Ping URL</CardTitle>
              </CardHeader>
              <CardContent>
                <CopyField value={pingUrl} />
              </CardContent>
            </Card>
          )}

          {isActive && check.target && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Target</CardTitle>
              </CardHeader>
              <CardContent>
                <code className="text-sm font-mono">{check.target}</code>
                {check.intervalSeconds && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Interval: {check.intervalSeconds}s
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {!isActive && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Schedule</CardTitle>
              </CardHeader>
              <CardContent>
                {check.schedule ? (
                  <>
                    <code className="font-mono text-sm">{check.schedule}</code> · {check.tz}
                    {check.nextExpectedAt && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Next: {new Date(check.nextExpectedAt).toLocaleString()}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Period: {check.periodSeconds}s · Grace: {check.graceSeconds}s
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <CheckNotificationChannelsSection
            key={`${check.id}:${check.projectId}`}
            check={check}
          />

          {showChart && (
            <div className="space-y-2">
              <h3 className="text-base font-medium">Response time</h3>
              <Card>
                <CardContent className="pt-4">
                  <ResponseTimeChart points={chartPoints} />
                </CardContent>
              </Card>
            </div>
          )}

          <div className="space-y-3">
            <h3 className="text-base font-medium">Recent events</h3>
            {check.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events yet.</p>
            ) : (
              <Card>
                <CardContent className="pt-4">
                  <EventTimeline events={check.events} />
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
