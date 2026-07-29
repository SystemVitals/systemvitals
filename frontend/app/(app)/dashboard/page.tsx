"use client";
import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "@apollo/client/react";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import {
  CHANNELS,
  CHECKS,
  CREATE_CHECK,
  PAUSE_CHECK,
  RESUME_CHECK,
  CREATE_ACTIVE_CHECK,
} from "@/lib/queries";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Pause, Play } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { formatDuration } from "@/lib/format";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import { planIntervalFloor } from "@/lib/plan-limits";
import { isValidCron, nextCronFires } from "@/lib/cron";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyField } from "@/components/app/copy-field";
import { ConnectAgentDialog } from "@/components/app/connect-agent-dialog";
import {
  CheckNotificationChannels,
  type NotificationChannelOption,
} from "@/components/app/check-notification-channels";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8888";

type CheckStatus = "UP" | "DOWN" | "GRACE" | "NEW" | "PAUSED";
type CheckType = "HEARTBEAT" | "HTTP" | "TCP";

interface CheckItem {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: CheckStatus;
  pingSlug: string | null;
  periodSeconds: number | null;
  intervalSeconds: number | null;
  graceSeconds: number;
  schedule: string | null;
  tz: string | null;
  lastEventAt: string | null;
  notificationChannelIds: string[];
}

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = {
    HEARTBEAT: "Heartbeat",
    HTTP: "HTTP",
    TCP: "TCP",
  };
  return (
    <span
      className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-muted text-muted-foreground"
    >
      {labels[type] ?? type}
    </span>
  );
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
      <div className="border-b border-border/60 bg-muted/20 px-3 py-2">
        <h3 className="text-sm font-medium text-foreground">Notifications</h3>
      </div>
      <div className="px-3 py-3 text-sm text-muted-foreground">
        {loading ? "Loading notification channels…" : label}
      </div>
    </section>
  );
}

interface CreateCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  onCreated: () => void;
}

function CreateCheckDialog({
  open,
  onOpenChange,
  organizationId,
  onCreated,
}: CreateCheckDialogProps) {
  const { orgs } = useOrg();
  const owningOrg = orgs.find((org) => org.id === organizationId);
  const floor = planIntervalFloor(owningOrg?.plan ?? "SOLO");

  const [checkType, setCheckType] = useState<CheckType>("HEARTBEAT");
  const [name, setName] = useState("");

  // Heartbeat fields
  const [periodSeconds, setPeriodSeconds] = useState("300");
  const [graceSeconds, setGraceSeconds] = useState("60");
  const [scheduleType, setScheduleType] = useState<"simple" | "cron">("simple");
  const [schedule, setSchedule] = useState("0 3 * * *");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);

  // Active (HTTP/TCP) fields
  const [target, setTarget] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState("60");
  const [timeoutMs, setTimeoutMs] = useState("5000");
  const [expectedStatus, setExpectedStatus] = useState("");

  const [createCheck, { loading: loadingHeartbeat, error: heartbeatError }] = useMutation(CREATE_CHECK, {
    onCompleted: () => {
      resetForm();
      onCreated();
      onOpenChange(false);
    },
  });

  const [createActiveCheck, { loading: loadingActive, error: activeError }] = useMutation(CREATE_ACTIVE_CHECK, {
    onCompleted: () => {
      resetForm();
      onCreated();
      onOpenChange(false);
    },
  });

  const loading = loadingHeartbeat || loadingActive;

  useEffect(() => {
    Promise.resolve().then(() => {
      setIntervalSeconds((prev) => {
        const n = parseInt(prev || "0", 10);
        return Number.isFinite(n) && n < floor ? String(floor) : prev;
      });
      setPeriodSeconds((prev) => {
        const n = parseInt(prev || "0", 10);
        return Number.isFinite(n) && n < floor ? String(floor) : prev;
      });
    });
  }, [floor]);

  function resetForm() {
    setName("");
    setPeriodSeconds("300");
    setGraceSeconds("60");
    setTarget("");
    setIntervalSeconds("60");
    setTimeoutMs("5000");
    setExpectedStatus("");
    setCheckType("HEARTBEAT");
    setScheduleType("simple");
    setSchedule("0 3 * * *");
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }

  const cronValid = isValidCron(schedule);
  const cronPreview = cronValid ? nextCronFires(schedule, tz, new Date(), 3) : [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (checkType === "HEARTBEAT") {
      if (scheduleType === "cron") {
        await createCheck({
          variables: {
            organizationId,
            name,
            graceSeconds: parseInt(graceSeconds, 10),
            schedule,
            tz,
          },
        });
      } else {
        await createCheck({
          variables: {
            organizationId,
            name,
            periodSeconds: parseInt(periodSeconds, 10),
            graceSeconds: parseInt(graceSeconds, 10),
          },
        });
      }
    } else {
      await createActiveCheck({
        variables: {
          organizationId,
          name,
          type: checkType,
          target,
          intervalSeconds: parseInt(intervalSeconds, 10),
          timeoutMs: parseInt(timeoutMs, 10),
          ...(checkType === "HTTP" && expectedStatus
            ? { expectedStatus: parseInt(expectedStatus, 10) }
            : {}),
        },
      });
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New check</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Type toggle */}
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="flex gap-2">
                {(["HEARTBEAT", "HTTP", "TCP"] as CheckType[]).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant={checkType === t ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCheckType(t)}
                  >
                    {t === "HEARTBEAT" ? "Heartbeat" : t}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="check-name">Name</Label>
              <Input
                id="check-name"
                placeholder={checkType === "HEARTBEAT" ? "My cron job" : "My endpoint"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            {checkType === "HEARTBEAT" && (
              <>
                <div className="space-y-2">
                  <Label>Schedule</Label>
                  <div className="flex gap-2">
                    {(["simple", "cron"] as const).map((s) => (
                      <Button
                        key={s}
                        type="button"
                        variant={scheduleType === s ? "default" : "outline"}
                        size="sm"
                        onClick={() => setScheduleType(s)}
                      >
                        {s === "simple" ? "Simple period" : "Cron schedule"}
                      </Button>
                    ))}
                  </div>
                </div>

                {scheduleType === "simple" ? (
                  <>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="check-period">Period</Label>
                        <span className="text-sm text-muted-foreground font-mono">{formatDuration(parseInt(periodSeconds || "0", 10))}</span>
                      </div>
                      <Slider id="check-period" min={floor} max={86400} step={1}
                        value={[parseInt(periodSeconds || String(floor), 10)]}
                        onValueChange={(v) => setPeriodSeconds(String(Array.isArray(v) ? v[0] : v))} />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="check-grace">Grace</Label>
                        <span className="text-sm text-muted-foreground font-mono">{formatDuration(parseInt(graceSeconds || "0", 10))}</span>
                      </div>
                      <Slider id="check-grace" min={0} max={3600} step={1}
                        value={[parseInt(graceSeconds || "0", 10)]}
                        onValueChange={(v) => setGraceSeconds(String(Array.isArray(v) ? v[0] : v))} />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="check-schedule">Cron expression</Label>
                      <Input
                        id="check-schedule"
                        placeholder="0 3 * * *"
                        value={schedule}
                        onChange={(e) => setSchedule(e.target.value)}
                        className="font-mono"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="check-tz">Timezone</Label>
                      <Select value={tz} onValueChange={(v) => v && setTz(v)}>
                        <SelectTrigger id="check-tz" className="w-full">
                          <SelectValue placeholder="Timezone" />
                        </SelectTrigger>
                        <SelectContent>
                          {Intl.supportedValuesOf("timeZone").map((z) => (
                            <SelectItem key={z} value={z}>
                              {z}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label htmlFor="check-grace">Grace</Label>
                        <span className="text-sm text-muted-foreground font-mono">{formatDuration(parseInt(graceSeconds || "0", 10))}</span>
                      </div>
                      <Slider id="check-grace" min={0} max={3600} step={1}
                        value={[parseInt(graceSeconds || "0", 10)]}
                        onValueChange={(v) => setGraceSeconds(String(Array.isArray(v) ? v[0] : v))} />
                    </div>
                    {cronValid ? (
                      <div className="space-y-1">
                        <p className="text-sm text-muted-foreground">Next runs:</p>
                        <ul className="text-sm font-mono text-muted-foreground space-y-0.5">
                          {cronPreview.map((d, i) => (
                            <li key={i}>{d.toLocaleString()}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-sm text-destructive" role="alert">
                        Invalid cron expression
                      </p>
                    )}
                  </>
                )}
              </>
            )}

            {(checkType === "HTTP" || checkType === "TCP") && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="check-target">
                    {checkType === "HTTP" ? "URL" : "Host:Port"}
                  </Label>
                  <Input
                    id="check-target"
                    placeholder={
                      checkType === "HTTP" ? "https://example.com" : "example.com:443"
                    }
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="check-interval">Interval</Label>
                    <span className="text-sm text-muted-foreground font-mono">{formatDuration(parseInt(intervalSeconds || "0", 10))}</span>
                  </div>
                  <Slider id="check-interval" min={floor} max={3600} step={1}
                    value={[parseInt(intervalSeconds || String(floor), 10)]}
                    onValueChange={(v) => setIntervalSeconds(String(Array.isArray(v) ? v[0] : v))} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="check-timeout">Timeout</Label>
                    <span className="text-sm text-muted-foreground font-mono">{Math.round(parseInt(timeoutMs || "0", 10) / 1000)} s</span>
                  </div>
                  <Slider id="check-timeout" min={1000} max={60000} step={500}
                    value={[parseInt(timeoutMs || "1000", 10)]}
                    onValueChange={(v) => setTimeoutMs(String(Array.isArray(v) ? v[0] : v))} />
                </div>
                {checkType === "HTTP" && (
                  <div className="space-y-2">
                    <Label htmlFor="check-expected-status">
                      Expected status code{" "}
                      <span className="text-muted-foreground">(optional, default 200)</span>
                    </Label>
                    <Input
                      id="check-expected-status"
                      type="number"
                      min="100"
                      max="599"
                      placeholder="200"
                      value={expectedStatus}
                      onChange={(e) => setExpectedStatus(e.target.value)}
                    />
                  </div>
                )}
              </>
            )}

            {(heartbeatError || activeError) && (
              <p role="alert" className="text-sm text-destructive">
                {(heartbeatError || activeError)?.message}
              </p>
            )}
            <DialogFooter>
              <Button
                type="submit"
                disabled={loading || (checkType === "HEARTBEAT" && scheduleType === "cron" && !cronValid)}
              >
                {loading ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface ChecksListProps {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
}

function ChecksList({
  organizationId,
  organizationName,
  organizationSlug,
}: ChecksListProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [channelErrorDialog, setChannelErrorDialog] = useState<{
    organizationId: string;
    message: string;
  } | null>(null);

  const query = useQuery<{ checks: CheckItem[] }>(CHECKS, {
    variables: { organizationId },
    // Apollo 4 defaults this to true, which would flip `loading` on every poll,
    // flashing the skeleton and the empty state over good content every 15s.
    notifyOnNetworkStatusChange: false,
  });
  const { data, refetch, loading, error: queryError } = query;
  const {
    data: channelData,
    loading: channelLoading,
    error: channelError,
    refetch: refetchChannels,
  } = useQuery<{
    channels: NotificationChannelOption[];
  }>(CHANNELS, {
    variables: { organizationId },
  });
  const channels = useMemo(
    () => (channelData?.channels ?? []).filter((channel) => channel.enabled),
    [channelData],
  );

  usePollWhenVisible(query, CHECK_POLL_INTERVAL_MS);

  const [pauseCheck, { error: pauseError }] = useMutation(PAUSE_CHECK, {
    onCompleted: () => refetch(),
  });

  const [resumeCheck, { error: resumeError }] = useMutation(RESUME_CHECK, {
    onCompleted: () => refetch(),
  });

  useEffect(() => {
    if (queryError) Promise.resolve().then(() => setErrorMessage(queryError.message));
  }, [queryError]);

  useEffect(() => {
    if (pauseError) Promise.resolve().then(() => setErrorMessage(pauseError.message));
  }, [pauseError]);

  useEffect(() => {
    if (resumeError) Promise.resolve().then(() => setErrorMessage(resumeError.message));
  }, [resumeError]);

  useEffect(() => {
    if (channelError) {
      Promise.resolve().then(() =>
        setChannelErrorDialog({
          organizationId,
          message: "Could not load notification channels. Please try again.",
        }),
      );
    } else if (channelData) {
      Promise.resolve().then(() =>
        setChannelErrorDialog((current) =>
          current?.organizationId === organizationId ? null : current,
        ),
      );
    }
  }, [channelData, channelError, organizationId]);

  const checks = data?.checks ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Checks</h2>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectAgentDialog
            organizationId={organizationId}
            organizationName={organizationName}
          />
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New check
          </Button>
        </div>
      </div>

      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-5 w-3/4 rounded-lg" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-4 w-full rounded-lg" />
                <Skeleton className="h-4 w-2/3 rounded-lg" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!loading && checks.length === 0 && (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">No checks yet. Start monitoring your first service.</p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="h-4 w-4 mr-1" />
                New check
              </Button>
              <ConnectAgentDialog
                organizationId={organizationId}
                organizationName={organizationName}
                secondary
              />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {checks.map((check) => {
          const isHeartbeat = check.type === "HEARTBEAT";
          const pingUrl = check.pingSlug ? `${API_URL}/ping/${check.pingSlug}` : null;
          const isPaused = check.status === "PAUSED";
          return (
            <Card key={check.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    <Link
                      href={`/${organizationSlug}/${check.slug}`}
                      className="hover:underline"
                    >
                      {check.name}
                    </Link>
                  </CardTitle>
                  <div className="flex items-center gap-1.5">
                    <TypeBadge type={check.type} />
                    <StatusBadge status={check.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {isHeartbeat && pingUrl && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Ping URL</p>
                    <CopyField value={pingUrl} />
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  {isHeartbeat
                    ? (check.schedule
                        ? `${check.schedule} · ${check.tz} · Grace: ${check.graceSeconds}s`
                        : `Period: ${check.periodSeconds}s · Grace: ${check.graceSeconds}s`)
                    : `Interval: ${check.intervalSeconds ?? check.periodSeconds}s`}
                </div>
                {check.lastEventAt && (
                  <div className="text-xs text-muted-foreground">
                    Last event: {new Date(check.lastEventAt).toLocaleString()}
                  </div>
                )}
                {channelLoading && !channelData ? (
                  <NotificationChannelsPlaceholder state="loading" />
                ) : channelError && !channelData ? (
                  <NotificationChannelsPlaceholder state="error" />
                ) : channelData ? (
                  <CheckNotificationChannels
                    checkId={check.id}
                    checkName={check.name}
                    notificationChannelIds={check.notificationChannelIds}
                    channels={channels}
                    variant="compact"
                  />
                ) : (
                  <NotificationChannelsPlaceholder state="loading" />
                )}
                <div>
                  {isPaused ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => resumeCheck({ variables: { id: check.id } })}
                    >
                      <Play className="h-3 w-3 mr-1" />
                      Resume
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => pauseCheck({ variables: { id: check.id } })}
                    >
                      <Pause className="h-3 w-3 mr-1" />
                      Pause
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <CreateCheckDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        organizationId={organizationId}
        onCreated={() => refetch()}
      />

      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <Button onClick={() => setErrorMessage(null)}>Dismiss</Button>
        </DialogContent>
      </Dialog>

      <Dialog
        open={channelErrorDialog?.organizationId === organizationId}
        onOpenChange={(open) => {
          if (!open) setChannelErrorDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notification channels unavailable</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {channelErrorDialog?.message}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setChannelErrorDialog(null)}
            >
              Dismiss
            </Button>
            <Button
              aria-label="Retry notification channels"
              disabled={channelLoading}
              onClick={() => {
                setChannelErrorDialog(null);
                void refetchChannels().catch(() => undefined);
              }}
            >
              {channelLoading ? "Retrying…" : "Retry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  const { activeOrg } = useOrg();

  if (!user) return null;

  return (
    <div className="px-4 py-6 sm:px-6 space-y-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Dashboard</h1>
      </div>

      {!activeOrg ? (
        <p className="text-muted-foreground">No organizations found.</p>
      ) : (
        <ChecksList
          key={activeOrg.id}
          organizationId={activeOrg.id}
          organizationName={activeOrg.name}
          organizationSlug={activeOrg.slug}
        />
      )}
    </div>
  );
}
