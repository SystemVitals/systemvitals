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
  DialogDescription,
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
import {
  CircleGauge,
  Clock,
  Plus,
  Pause,
  Play,
  Search,
  SearchX,
} from "lucide-react";
import { DurationSliderField } from "@/components/app/duration-slider-field";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import { planIntervalFloor } from "@/lib/plan-limits";
import { isValidCron, nextCronFires } from "@/lib/cron";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyField } from "@/components/app/copy-field";
import { PageHeader } from "@/components/app/page-header";
import { STATUS_LABELS } from "@/components/status-badge";
import { formatDateTime, formatRelativeTime, formatSpan } from "@/lib/format";
import { cn } from "@/lib/utils";
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
  target?: string | null;
  periodSeconds: number | null;
  intervalSeconds: number | null;
  graceSeconds: number;
  schedule: string | null;
  tz: string | null;
  lastEventAt: string | null;
  notificationChannelIds: string[];
}

interface CheckAllowance {
  used: number;
  limit: number;
  remaining: number;
}

function checkCountLabel(count: number) {
  return `${count} ${count === 1 ? "check" : "checks"}`;
}

type StatusFilter = "ALL" | CheckStatus;

// Problems first, so a failing check is never hidden below the fold.
const STATUS_ORDER: Record<CheckStatus, number> = {
  DOWN: 0,
  GRACE: 1,
  NEW: 2,
  UP: 3,
  PAUSED: 4,
};

const STATUS_FILTERS: StatusFilter[] = ["ALL", "DOWN", "GRACE", "NEW", "UP", "PAUSED"];

const STATUS_DOT: Record<CheckStatus, string> = {
  UP: "bg-success",
  DOWN: "bg-destructive",
  GRACE: "bg-warning",
  NEW: "bg-primary",
  PAUSED: "bg-muted-foreground/60",
};

const SEARCH_THRESHOLD = 6;

function scheduleSummary(check: CheckItem): string {
  if (check.type === "HEARTBEAT") {
    if (check.schedule) {
      return `Cron ${check.schedule} (${check.tz ?? "UTC"}) · ${formatSpan(check.graceSeconds)} grace`;
    }
    return `Every ${formatSpan(check.periodSeconds ?? 0)} · ${formatSpan(check.graceSeconds)} grace`;
  }
  return `Every ${formatSpan(check.intervalSeconds ?? check.periodSeconds ?? 0)}`;
}

function activitySummary(check: CheckItem): string {
  if (check.lastEventAt) {
    const verb = check.type === "HEARTBEAT" ? "Last ping" : "Last checked";
    return `${verb} ${formatRelativeTime(check.lastEventAt)}`;
  }
  if (check.status === "PAUSED") return "Paused before any activity";
  return check.type === "HEARTBEAT"
    ? "Waiting for the first ping"
    : "Waiting for the first probe";
}

function StatusFilterBar({
  counts,
  total,
  value,
  onChange,
}: {
  counts: Record<CheckStatus, number>;
  total: number;
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
}) {
  return (
    <div role="group" aria-label="Filter checks by status" className="flex flex-wrap gap-2">
      {STATUS_FILTERS.filter((filter) => filter === "ALL" || counts[filter] > 0).map(
        (filter) => {
          const count = filter === "ALL" ? total : counts[filter];
          const label = filter === "ALL" ? "All" : STATUS_LABELS[filter];
          const selected = value === filter;
          return (
            <button
              key={filter}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected && filter !== "ALL" ? "ALL" : filter)}
              className={cn(
                "inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15",
                !selected && filter === "DOWN" && "border-destructive/30 text-destructive",
              )}
            >
              {filter !== "ALL" && (
                <span aria-hidden="true" className={cn("size-2 rounded-full", STATUS_DOT[filter])} />
              )}
              {label}
              <span className="tabular-nums text-xs opacity-70">{count}</span>
            </button>
          );
        },
      )}
    </div>
  );
}

function CheckAllowanceMeter({ allowance }: { allowance: CheckAllowance }) {
  const used = Math.max(0, allowance.used);
  const limit = Math.max(0, allowance.limit);
  const remaining = Math.max(0, allowance.remaining);
  const exhausted = remaining === 0;
  const usedPercentage =
    limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));

  return (
    <div
      role="status"
      aria-label="Check allowance"
      className={`min-w-44 rounded-lg border px-3 py-2 ${
        exhausted
          ? "border-destructive/30 bg-destructive/5"
          : "border-border/70 bg-muted/25"
      }`}
    >
      <div className="flex items-center gap-2">
        <CircleGauge
          aria-hidden="true"
          className={`size-4 shrink-0 ${
            exhausted ? "text-destructive" : "text-primary"
          }`}
        />
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-semibold leading-none ${
              exhausted ? "text-destructive" : "text-foreground"
            }`}
          >
            {checkCountLabel(remaining)} left
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {exhausted ? "Limit reached" : `${used} of ${limit} used`}
          </p>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/10"
      >
        <div
          className={`h-full rounded-full transition-[width] ${
            exhausted ? "bg-destructive" : "bg-primary"
          }`}
          style={{ width: `${usedPercentage}%` }}
        />
      </div>
    </div>
  );
}

const CHECK_TYPE_LABELS: Record<string, string> = {
  HEARTBEAT: "Heartbeat",
  HTTP: "HTTP",
  TCP: "TCP",
};

const CHECK_TYPE_HELP: Record<CheckType, string> = {
  HEARTBEAT:
    "For cron jobs, backups, and workers. Your job requests a ping URL when it runs; you're alerted when a ping doesn't arrive on time.",
  HTTP: "For websites and APIs. SystemVitals requests the URL on a schedule and alerts you when it fails or returns an unexpected status.",
  TCP: "For databases, mail servers, and other services. SystemVitals opens a connection to host:port and alerts you when it can't connect.",
};

function TypeBadge({ type }: { type: string }) {
  const labels: Record<string, string> = CHECK_TYPE_LABELS;
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
  allowance?: CheckAllowance;
  onCreated: () => void;
}

function CreateCheckDialog({
  open,
  onOpenChange,
  organizationId,
  allowance,
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
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New check</DialogTitle>
            {allowance && (
              <DialogDescription>
                {checkCountLabel(Math.max(0, allowance.remaining))} left on this
                plan.
              </DialogDescription>
            )}
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Type toggle */}
            <div className="space-y-2">
              <Label id="check-type-label">What do you want to monitor?</Label>
              <div
                role="group"
                aria-labelledby="check-type-label"
                className="flex gap-2"
              >
                {(["HEARTBEAT", "HTTP", "TCP"] as CheckType[]).map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant={checkType === t ? "default" : "outline"}
                    size="sm"
                    aria-pressed={checkType === t}
                    onClick={() => setCheckType(t)}
                  >
                    {CHECK_TYPE_LABELS[t]}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">{CHECK_TYPE_HELP[checkType]}</p>
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
                    <DurationSliderField
                      id="check-period"
                      label="Period"
                      valueMs={parseInt(periodSeconds || String(floor), 10) * 1000}
                      onValueMsChange={(ms) => setPeriodSeconds(String(Math.round(ms / 1000)))}
                      minMs={floor * 1000}
                      maxMs={86400 * 1000}
                      stepMs={1000}
                    />
                    <DurationSliderField
                      id="check-grace"
                      label="Grace"
                      valueMs={parseInt(graceSeconds || "0", 10) * 1000}
                      onValueMsChange={(ms) => setGraceSeconds(String(Math.round(ms / 1000)))}
                      minMs={0}
                      maxMs={3600 * 1000}
                      stepMs={1000}
                    />
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
                    <DurationSliderField
                      id="check-grace"
                      label="Grace"
                      valueMs={parseInt(graceSeconds || "0", 10) * 1000}
                      onValueMsChange={(ms) => setGraceSeconds(String(Math.round(ms / 1000)))}
                      minMs={0}
                      maxMs={3600 * 1000}
                      stepMs={1000}
                    />
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
                <DurationSliderField
                  id="check-interval"
                  label="Interval"
                  valueMs={parseInt(intervalSeconds || String(floor), 10) * 1000}
                  onValueMsChange={(ms) => setIntervalSeconds(String(Math.round(ms / 1000)))}
                  minMs={floor * 1000}
                  maxMs={3600 * 1000}
                  stepMs={1000}
                />
                <DurationSliderField
                  id="check-timeout"
                  label="Timeout"
                  valueMs={parseInt(timeoutMs || "1000", 10)}
                  onValueMsChange={(ms) => setTimeoutMs(String(ms))}
                  minMs={1000}
                  maxMs={60000}
                  stepMs={500}
                />
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
                type="button"
                variant="outline"
                disabled={loading}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  loading ||
                  (allowance?.remaining ?? 1) <= 0 ||
                  (checkType === "HEARTBEAT" &&
                    scheduleType === "cron" &&
                    !cronValid)
                }
              >
                {loading ? "Creating…" : "Create check"}
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
  organizationSlug: string;
  organizationName: string;
}

function ChecksList({
  organizationId,
  organizationSlug,
  organizationName,
}: ChecksListProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [search, setSearch] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [channelErrorDialog, setChannelErrorDialog] = useState<{
    organizationId: string;
    message: string;
  } | null>(null);

  const query = useQuery<{
    checks: CheckItem[];
    organizationCheckAllowance: CheckAllowance;
  }>(CHECKS, {
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

  const checks = useMemo(() => data?.checks ?? [], [data]);
  const allowance = data?.organizationCheckAllowance;
  const limitReached = allowance ? allowance.remaining <= 0 : false;
  const counts = useMemo(() => {
    const result: Record<CheckStatus, number> = {
      UP: 0,
      DOWN: 0,
      GRACE: 0,
      NEW: 0,
      PAUSED: 0,
    };
    for (const check of checks) {
      if (check.status in result) result[check.status] += 1;
    }
    return result;
  }, [checks]);
  // A filter for a status that no longer has checks would show an empty list
  // with no visible chip to clear it, so fall back to everything.
  const activeFilter =
    statusFilter !== "ALL" && counts[statusFilter] === 0 ? "ALL" : statusFilter;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleChecks = useMemo(
    () =>
      checks
        .filter((check) => activeFilter === "ALL" || check.status === activeFilter)
        .filter(
          (check) =>
            !normalizedSearch ||
            check.name.toLowerCase().includes(normalizedSearch) ||
            (check.target ?? "").toLowerCase().includes(normalizedSearch),
        )
        .sort(
          (a, b) =>
            (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
            a.name.localeCompare(b.name),
        ),
    [checks, activeFilter, normalizedSearch],
  );
  const problemCount = counts.DOWN + counts.GRACE;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={
          checks.length === 0 ? (
            <>
              Monitoring for <span className="font-medium text-foreground">{organizationName}</span>
            </>
          ) : problemCount > 0 ? (
            <>
              <span className="font-medium text-destructive">
                {problemCount} of {checkCountLabel(checks.length)} {problemCount === 1 ? "needs" : "need"} attention
              </span>{" "}
              in {organizationName}
            </>
          ) : (
            <>
              {checkCountLabel(checks.length)} in{" "}
              <span className="font-medium text-foreground">{organizationName}</span>
            </>
          )
        }
        actions={
          <>
            {allowance && <CheckAllowanceMeter allowance={allowance} />}
            <Button
              disabled={limitReached}
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-4 w-4 mr-1" />
              New check
            </Button>
          </>
        }
      />

      {limitReached && (
        <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm">
          You&apos;ve used every check on your plan. Delete a check you no longer need or{" "}
          <Link href="/billing" className="font-medium text-primary hover:underline">
            upgrade your plan
          </Link>{" "}
          to add more.
        </p>
      )}

      {checks.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <StatusFilterBar
            counts={counts}
            total={checks.length}
            value={activeFilter}
            onChange={setStatusFilter}
          />
          {checks.length >= SEARCH_THRESHOLD && (
            <div className="relative sm:w-64">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                aria-label="Search checks"
                placeholder="Search checks"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-8"
              />
            </div>
          )}
        </div>
      )}

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
        <Card className="border-dashed py-12">
          <CardContent className="flex flex-col items-center gap-4 text-center">
            <div className="space-y-1">
              <p className="font-heading text-base font-medium">No checks yet. Start monitoring your first service.</p>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                Use a heartbeat for cron jobs and workers that should check in on
                time, or an HTTP/TCP check for websites, APIs, and servers.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                disabled={limitReached}
                onClick={() => setShowCreate(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                New check
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {!loading && checks.length > 0 && visibleChecks.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
          <SearchX className="size-6" aria-hidden="true" />
          <p>No checks match your filters.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSearch("");
              setStatusFilter("ALL");
            }}
          >
            Clear filters
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {visibleChecks.map((check) => {
          const isHeartbeat = check.type === "HEARTBEAT";
          const pingUrl = check.pingSlug ? `${API_URL}/ping/${check.pingSlug}` : null;
          const isPaused = check.status === "PAUSED";
          const checkHref = `/${organizationSlug}/${check.slug}`;
          return (
            <Card
              key={check.id}
              className={cn(
                "transition-shadow hover:ring-foreground/20",
                check.status === "DOWN" && "ring-destructive/40 hover:ring-destructive/60",
                check.status === "GRACE" && "ring-warning/40 hover:ring-warning/60",
                isPaused && "bg-muted/30",
              )}
            >
              <CardHeader className="pb-1">
                <div className="flex items-start justify-between gap-3">
                  <CardTitle className="min-w-0 text-base">
                    <Link
                      href={checkHref}
                      className="block truncate hover:text-primary hover:underline"
                      title={check.name}
                    >
                      {check.name}
                    </Link>
                  </CardTitle>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <TypeBadge type={check.type} />
                    <StatusBadge status={check.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3">
                <div className="space-y-1 text-xs text-muted-foreground">
                  {!isHeartbeat && check.target && (
                    <p className="truncate font-mono text-foreground/80" title={check.target}>
                      {check.target}
                    </p>
                  )}
                  <p>{scheduleSummary(check)}</p>
                  <p
                    className="flex items-center gap-1"
                    title={check.lastEventAt ? formatDateTime(check.lastEventAt) : undefined}
                  >
                    <Clock className="size-3 shrink-0" aria-hidden="true" />
                    {activitySummary(check)}
                  </p>
                </div>
                {isHeartbeat && pingUrl && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Ping URL</p>
                    <CopyField value={pingUrl} label="ping URL" />
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
                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
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
                  <Link
                    href={checkHref}
                    className="text-sm font-medium text-primary hover:underline"
                    aria-label={`View details for ${check.name}`}
                  >
                    Details →
                  </Link>
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
        allowance={allowance}
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

  if (!activeOrg) {
    return (
      <div className="space-y-6">
        <PageHeader title="Dashboard" />
        <p className="text-muted-foreground">No organizations found.</p>
      </div>
    );
  }

  return (
    <ChecksList
      key={activeOrg.id}
      organizationId={activeOrg.id}
      organizationSlug={activeOrg.slug}
      organizationName={activeOrg.name}
    />
  );
}
