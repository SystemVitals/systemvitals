"use client";
import { useEffect, useState } from "react";
import { useMutation } from "@apollo/client/react";
import { UPDATE_CHECK } from "@/lib/queries";
import { planIntervalFloor } from "@/lib/plan-limits";
import { useOrg } from "@/lib/org-context";
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
import { isValidCron } from "@/lib/cron";

type CheckType = "HEARTBEAT" | "HTTP" | "TCP";

const CHECK_TYPES: CheckType[] = ["HEARTBEAT", "HTTP", "TCP"];

const TYPE_LABELS: Record<CheckType, string> = {
  HEARTBEAT: "Heartbeat",
  HTTP: "HTTP",
  TCP: "TCP",
};

function asCheckType(value: string): CheckType {
  return (CHECK_TYPES as readonly string[]).includes(value)
    ? (value as CheckType)
    : "HEARTBEAT";
}

/**
 * What `conversionWarning` describes is enforced server-side by
 * `resolveCheckUpdate` in `api/src/checks/check-update.ts`: switching the
 * type always clears the outgoing mode's columns, and — because the input
 * value for the *new* mode is never inherited from the old one on a
 * conversion — the client must resend every field the new mode needs.
 */
function conversionWarning(
  fromType: CheckType,
  toType: CheckType,
  fromIsCron: boolean
): string | null {
  if (fromType === toType) return null;

  if (toType === "HEARTBEAT") {
    const cleared =
      fromType === "HTTP"
        ? "target, method, expected status, interval and timeout"
        : "target, interval and timeout";
    return `Converting to Heartbeat clears this check's ${cleared}. Its ping URL is kept if it already has one.`;
  }

  if (fromType === "HEARTBEAT") {
    const cleared = fromIsCron ? "schedule and timezone" : "period and grace";
    return `Converting to ${TYPE_LABELS[toType]} clears this check's ${cleared}. Its ping URL is kept and will work again if you convert back.`;
  }

  // HTTP <-> TCP
  if (toType === "TCP") {
    return "Converting to TCP clears this check's method and expected status.";
  }

  return null; // TCP -> HTTP: nothing is cleared, method/expected status are simply gained.
}

export interface EditableCheck {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  type: string;
  periodSeconds: number | null;
  graceSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  target: string | null;
  method: string | null;
  expectedStatus: number | null;
  intervalSeconds: number | null;
  timeoutMs: number | null;
}

/**
 * What `onSaved` hands back after a successful save — just enough for a
 * caller to notice an in-place slug rename (see the slug route's `onRefetch`,
 * which navigates instead of refetching when this doesn't match the URL).
 */
export interface UpdatedCheck {
  slug: string;
}

interface EditCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  check: EditableCheck;
  onSaved: (updatedCheck: UpdatedCheck) => void;
}

export function EditCheckDialog({ open, onOpenChange, check, onSaved }: EditCheckDialogProps) {
  const currentType = asCheckType(check.type);
  const { orgs } = useOrg();
  const owningOrg = orgs.find((org) => org.id === check.organizationId);
  const intervalFloor = planIntervalFloor(owningOrg?.plan ?? "SOLO");

  const [type, setType] = useState<CheckType>(currentType);
  const [name, setName] = useState(check.name);
  const [slug, setSlug] = useState(check.slug);

  // Heartbeat fields
  const [periodSeconds, setPeriodSeconds] = useState(String(check.periodSeconds ?? 300));
  const [graceSeconds, setGraceSeconds] = useState(String(check.graceSeconds ?? 60));
  const [scheduleType, setScheduleType] = useState<"simple" | "cron">(
    check.schedule ? "cron" : "simple"
  );
  const [schedule, setSchedule] = useState(check.schedule ?? "0 3 * * *");
  const [tz, setTz] = useState(check.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);

  // Active (HTTP/TCP) fields
  const [target, setTarget] = useState(check.target ?? "");
  const [intervalSeconds, setIntervalSeconds] = useState(String(check.intervalSeconds ?? 60));
  const [timeoutMs, setTimeoutMs] = useState(String(check.timeoutMs ?? 5000));
  const [method, setMethod] = useState(check.method ?? "GET");
  const [expectedStatus, setExpectedStatus] = useState(
    check.expectedStatus != null ? String(check.expectedStatus) : ""
  );

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Re-sync the form whenever a different check is opened for editing.
  useEffect(() => {
    if (!open) return;
    Promise.resolve().then(() => {
      setType(asCheckType(check.type));
      setName(check.name);
      setSlug(check.slug);
      setPeriodSeconds(String(check.periodSeconds ?? 300));
      setGraceSeconds(String(check.graceSeconds ?? 60));
      setScheduleType(check.schedule ? "cron" : "simple");
      setSchedule(check.schedule ?? "0 3 * * *");
      setTz(check.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
      setTarget(check.target ?? "");
      setIntervalSeconds(String(check.intervalSeconds ?? 60));
      setTimeoutMs(String(check.timeoutMs ?? 5000));
      setMethod(check.method ?? "GET");
      setExpectedStatus(check.expectedStatus != null ? String(check.expectedStatus) : "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, check.id]);

  const [updateCheck, { loading, error: mutationError }] = useMutation<{
    updateCheck: UpdatedCheck;
  }>(UPDATE_CHECK, {
    onCompleted: (data) => {
      onSaved(data.updateCheck);
    },
  });

  useEffect(() => {
    if (mutationError) Promise.resolve().then(() => setErrorMessage(mutationError.message));
  }, [mutationError]);

  const cronValid = scheduleType !== "cron" || isValidCron(schedule);
  const periodMinimum =
    type === currentType &&
    currentType === "HEARTBEAT" &&
    !check.schedule &&
    check.periodSeconds != null
      ? Math.min(intervalFloor, check.periodSeconds)
      : intervalFloor;
  const intervalMinimum =
    type === currentType &&
    currentType !== "HEARTBEAT" &&
    check.intervalSeconds != null
      ? Math.min(intervalFloor, check.intervalSeconds)
      : intervalFloor;

  function cadenceError(): string | null {
    if (type === "HEARTBEAT" && scheduleType === "simple") {
      const period = parseInt(periodSeconds, 10);
      const unchanged =
        type === currentType &&
        currentType === "HEARTBEAT" &&
        !check.schedule &&
        period === check.periodSeconds;
      return !unchanged && period < intervalFloor
        ? `Period must be at least ${intervalFloor} seconds.`
        : null;
    }

    if (type === "HTTP" || type === "TCP") {
      const interval = parseInt(intervalSeconds, 10);
      const unchanged =
        type === currentType &&
        interval === check.intervalSeconds;
      return !unchanged && interval < intervalFloor
        ? `Interval must be at least ${intervalFloor} seconds.`
        : null;
    }

    return null;
  }

  function buildInput(): Record<string, unknown> {
    const input: Record<string, unknown> = { name: name.trim() };
    if (type !== currentType) input.type = type;
    if (slug.trim() !== check.slug) input.slug = slug.trim();

    if (type === "HEARTBEAT") {
      input.graceSeconds = parseInt(graceSeconds, 10);
      if (scheduleType === "cron") {
        input.schedule = schedule;
        input.tz = tz;
      } else {
        input.periodSeconds = parseInt(periodSeconds, 10);
      }
    } else {
      input.target = target;
      input.intervalSeconds = parseInt(intervalSeconds, 10);
      input.timeoutMs = parseInt(timeoutMs, 10);
      if (type === "HTTP") {
        input.method = method;
        if (expectedStatus.trim() !== "") {
          input.expectedStatus = parseInt(expectedStatus, 10);
        }
      }
    }
    return input;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const validationError = cadenceError();
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    try {
      await updateCheck({ variables: { id: check.id, input: buildInput() } });
    } catch {
      // Surfaced via `mutationError` above.
    }
  }

  const warning = conversionWarning(currentType, type, !!check.schedule);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit check</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <div className="flex gap-2">
                {CHECK_TYPES.map((t) => (
                  <Button
                    key={t}
                    type="button"
                    variant={type === t ? "default" : "outline"}
                    size="sm"
                    aria-pressed={type === t}
                    onClick={() => {
                      // HTTP and TCP both use the `target` field, so nothing
                      // about the UI forces it to be re-entered when crossing
                      // between them — but the two shapes are incompatible
                      // (a URL is not host:port). Left alone, a stale HTTP
                      // URL sails through TCP's loose validation and the
                      // worker can never parse a port out of it: permanently
                      // DOWN with no error surfaced anywhere. Clearing it
                      // forces the user to enter a target that actually fits
                      // the newly selected type.
                      const crossesHttpTcp =
                        (type === "HTTP" && t === "TCP") || (type === "TCP" && t === "HTTP");
                      if (crossesHttpTcp) setTarget("");
                      setType(t);
                    }}
                  >
                    {TYPE_LABELS[t]}
                  </Button>
                ))}
              </div>
            </div>

            {warning && (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-muted-foreground">
                {warning}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="edit-check-name">Name</Label>
              <Input
                id="edit-check-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-check-slug">URL slug</Label>
              <Input
                id="edit-check-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground font-mono">.../{slug}</p>
              <p className="text-xs text-muted-foreground">
                Changing the slug changes this check&apos;s URL. The old URL will stop working —
                there is no redirect.
              </p>
            </div>

            {type === "HEARTBEAT" && (
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
                  <div className="space-y-2">
                    <Label htmlFor="edit-check-period">Period (seconds)</Label>
                    <Input
                      id="edit-check-period"
                      type="number"
                      min={periodMinimum}
                      value={periodSeconds}
                      onChange={(e) => setPeriodSeconds(e.target.value)}
                      required
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="edit-check-schedule">Cron expression</Label>
                      <Input
                        id="edit-check-schedule"
                        placeholder="0 3 * * *"
                        value={schedule}
                        onChange={(e) => setSchedule(e.target.value)}
                        className="font-mono"
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-check-tz">Timezone</Label>
                      <Select value={tz} onValueChange={(v) => v && setTz(v)}>
                        <SelectTrigger id="edit-check-tz" className="w-full">
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
                    {!cronValid && (
                      <p className="text-sm text-destructive" role="alert">
                        Invalid cron expression
                      </p>
                    )}
                  </>
                )}

                <div className="space-y-2">
                  <Label htmlFor="edit-check-grace">Grace (seconds)</Label>
                  <Input
                    id="edit-check-grace"
                    type="number"
                    min={0}
                    value={graceSeconds}
                    onChange={(e) => setGraceSeconds(e.target.value)}
                    required
                  />
                </div>
              </>
            )}

            {(type === "HTTP" || type === "TCP") && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="edit-check-target">
                    {type === "HTTP" ? "Target URL" : "Target (host:port)"}
                  </Label>
                  <Input
                    id="edit-check-target"
                    placeholder={type === "HTTP" ? "https://example.com" : "example.com:443"}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-check-interval">Interval (seconds)</Label>
                  <Input
                    id="edit-check-interval"
                    type="number"
                    min={intervalMinimum}
                    value={intervalSeconds}
                    onChange={(e) => setIntervalSeconds(e.target.value)}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-check-timeout">Timeout (ms)</Label>
                  <Input
                    id="edit-check-timeout"
                    type="number"
                    min={1}
                    value={timeoutMs}
                    onChange={(e) => setTimeoutMs(e.target.value)}
                    required
                  />
                </div>
                {type === "HTTP" && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="edit-check-method">Method</Label>
                      <Select value={method} onValueChange={(v) => v && setMethod(v)}>
                        <SelectTrigger id="edit-check-method" className="w-full">
                          <SelectValue placeholder="Method" />
                        </SelectTrigger>
                        <SelectContent>
                          {["GET", "POST", "HEAD", "PUT", "DELETE"].map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="edit-check-expected-status">
                        Expected status code{" "}
                        <span className="text-muted-foreground">(optional, default 200)</span>
                      </Label>
                      <Input
                        id="edit-check-expected-status"
                        type="number"
                        min="100"
                        max="599"
                        placeholder="200"
                        value={expectedStatus}
                        onChange={(e) => setExpectedStatus(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </>
            )}

            <DialogFooter>
              <Button type="submit" disabled={loading || !cronValid}>
                {loading ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
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
    </>
  );
}
