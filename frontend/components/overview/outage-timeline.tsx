"use client";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/lib/format";
import { formatBrokenSeconds, percentOf } from "@/lib/overview";
import { cn } from "@/lib/utils";

interface TimelineRow {
  check: { id: string; name: string };
  organization: { name: string };
  outages: { startedAt: string; endedAt: string | null }[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_TICKS = 8;

// Label column and track share one template, so the gridline overlays and the
// tick row line up with every row's track.
const COLUMNS = "grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 sm:grid-cols-[150px_minmax(0,1fr)]";

/**
 * Local-midnight ticks (or hour ticks for a 24h range), thinned to at most
 * MAX_TICKS. Ticks hugging either edge are dropped so they never collide with
 * the track start or the "Now" label.
 */
function axisTicks(startMs: number, endMs: number) {
  const span = endMs - startMs;
  const ticks: { at: number; label: string }[] = [];
  const hourly = span <= 2 * DAY_MS;
  const unitMs = hourly ? HOUR_MS : DAY_MS;
  const steps = hourly ? [1, 2, 3, 4, 6, 12] : [1, 2, 7, 14, 30];
  const step = steps.find((candidate) => span / (candidate * unitMs) <= MAX_TICKS) ?? steps.at(-1)!;

  const tick = new Date(startMs);
  if (hourly) tick.setMinutes(60, 0, 0);
  else tick.setHours(24, 0, 0, 0);
  for (let index = 0; tick.getTime() < endMs; index += 1) {
    // Hours are stepped in absolute time and days in calendar days, so a DST
    // change neither repeats nor skips a label.
    const keep = hourly ? tick.getHours() % step === 0 : index % step === 0;
    const share = (tick.getTime() - startMs) / span;
    if (keep && share > 0.04 && share < 0.88) {
      ticks.push({
        at: tick.getTime(),
        label: hourly
          ? tick.toLocaleTimeString(undefined, { hour: "numeric" })
          : tick.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      });
    }
    if (hourly) tick.setTime(tick.getTime() + HOUR_MS);
    else tick.setDate(tick.getDate() + 1);
  }
  return ticks;
}

function OutageSegment({
  outage,
  startMs,
  endMs,
}: {
  outage: { startedAt: string; endedAt: string | null };
  startMs: number;
  endMs: number;
}) {
  const span = endMs - startMs;
  const from = Math.max(startMs, Date.parse(outage.startedAt));
  const to = outage.endedAt === null ? endMs : Math.min(endMs, Date.parse(outage.endedAt));
  const left = percentOf(from - startMs, span);
  const width = percentOf(to - from, span);
  const duration = formatBrokenSeconds(Math.floor(Math.max(0, to - from) / 1000));
  const started = formatDateTime(outage.startedAt);
  const ended = outage.endedAt === null ? "ongoing" : formatDateTime(outage.endedAt);

  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={
          outage.endedAt === null
            ? `Down from ${started}, ongoing, ${duration}`
            : `Down from ${started} to ${ended}, ${duration}`
        }
        className="absolute inset-y-0 min-w-1 rounded-sm bg-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // When min-w-1 widens a short outage, grow it leftwards so it still ends
        // at its real end; an ongoing one then never pokes past the now line.
        style={{ left, width, marginLeft: `min(0px, calc(${width} - 0.25rem))` }}
      />
      <TooltipContent>
        <div className="space-y-0.5">
          <p className="font-medium">Down for {duration}</p>
          <p>
            {started} – {ended}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function LateMarker() {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label="Late: the expected ping has not arrived"
        className="absolute -inset-y-0.5 right-0 w-1.5 rounded-sm bg-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <TooltipContent>Late now: the expected ping has not arrived</TooltipContent>
    </Tooltip>
  );
}

export function OutageTimeline({
  rangeStart,
  rangeEnd,
  rows,
  late,
  maxRows = 10,
}: {
  rangeStart: string;
  rangeEnd: string;
  rows: TimelineRow[];
  late: { checkId: string }[];
  maxRows?: number;
}) {
  const startMs = Date.parse(rangeStart);
  const endMs = Date.parse(rangeEnd);
  const lateIds = new Set(late.map((entry) => entry.checkId));
  const shown = rows.slice(0, maxRows);
  const hiddenCount = rows.length - shown.length;
  const ticks = axisTicks(startMs, endMs);
  const position = (ms: number) => percentOf(ms - startMs, endMs - startMs);

  return (
    <TooltipProvider>
      <div className="space-y-3">
        <div className="relative">
          <div aria-hidden className={cn(COLUMNS, "pointer-events-none absolute inset-0")}>
            <div />
            <div className="relative hidden sm:block">
              {ticks.map((tick) => (
                <div
                  key={tick.at}
                  className="absolute inset-y-0 w-px bg-border"
                  style={{ left: position(tick.at) }}
                />
              ))}
            </div>
          </div>

          <ul aria-label="Checks with outages" className="relative">
            {shown.map((row) => (
              <li key={row.check.id} className={cn(COLUMNS, "items-center py-1.5")}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.check.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {row.organization.name}
                  </p>
                </div>
                <div className="relative h-3.5 rounded-sm bg-muted">
                  {row.outages.map((outage, index) => (
                    <OutageSegment
                      key={`${outage.startedAt}:${index}`}
                      outage={outage}
                      startMs={startMs}
                      endMs={endMs}
                    />
                  ))}
                  {lateIds.has(row.check.id) && <LateMarker />}
                </div>
              </li>
            ))}
          </ul>

          <div aria-hidden className={cn(COLUMNS, "pointer-events-none absolute inset-0")}>
            <div />
            <div className="relative">
              <div className="absolute inset-y-0 right-0 border-r border-dashed border-foreground/70" />
            </div>
          </div>
        </div>

        <div aria-hidden className={cn(COLUMNS, "hidden sm:grid")}>
          <div />
          <div className="relative h-4 text-xs text-muted-foreground tabular-nums">
            {ticks.map((tick) => (
              <span
                key={tick.at}
                className="absolute -translate-x-1/2 whitespace-nowrap"
                style={{ left: position(tick.at) }}
              >
                {tick.label}
              </span>
            ))}
            <span className="absolute right-0 whitespace-nowrap">Now</span>
          </div>
        </div>

        {hiddenCount > 0 && (
          <p className="text-xs text-muted-foreground">{`and ${hiddenCount} more`}</p>
        )}

        <ul aria-label="Legend" className="flex gap-4 text-xs text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm bg-destructive" />
            Down
          </li>
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-sm bg-warning" />
            Late
          </li>
        </ul>
      </div>
    </TooltipProvider>
  );
}
