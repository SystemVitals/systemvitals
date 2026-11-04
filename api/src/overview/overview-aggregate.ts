import { nextCronFire } from '../checks/cron';

export type OverviewRangeKey = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER';

export const RANGE_SECONDS: Record<OverviewRangeKey, number> = {
  DAY: 86400,
  WEEK: 604800,
  MONTH: 2592000,
  QUARTER: 7776000,
};

export interface AggregateCheck {
  id: string;
  organizationId: string;
  type: string;
  status: string;
  createdAt: Date;
  lastEventAt: Date | null;
  periodSeconds: number | null;
  graceSeconds: number | null;
  schedule: string | null;
  tz: string | null;
}

export interface AggregateOutage {
  checkId: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface AggregateInput {
  now: Date;
  rangeStart: Date;
  bucketStarts: Date[];
  organizationIds: string[];
  checks: AggregateCheck[];
  outages: AggregateOutage[];
}

export interface BrokenEntry {
  checkId: string;
  state: 'DOWN' | 'LATE';
  since: Date;
  downAt: Date | null;
}

/** One or more nearby outages, merged for the timeline. */
export interface OutageSpanResult {
  /** The first merged outage's start, clipped to the range. */
  startedAt: Date;
  /** Null when the merged outage that ends last is still ongoing. */
  endedAt: Date | null;
  outageCount: number;
  /** The merged outages' clipped durations, summed; gaps are not counted. */
  brokenSeconds: number;
}

export interface CheckTotals {
  checkId: string;
  brokenSeconds: number;
  outageCount: number;
  longestOutageSeconds: number;
  /** Whether the single longest outage (ties prefer the open one) is open. */
  longestOutageOngoing: boolean;
  ongoing: boolean;
  uptimePercent: number | null;
  /** At most MAX_TIMELINE_SPANS; totals above count every outage. */
  outages: OutageSpanResult[];
}

/**
 * Timeline spans per check. A flapping check can log thousands of outages in
 * 90 days; the timeline cannot draw them apart anyway, so nearby ones merge.
 */
export const MAX_TIMELINE_SPANS = 200;

export interface AggregateResult {
  needsFixing: BrokenEntry[];
  summary: {
    uptimePercent: number | null;
    brokenSeconds: number;
    outageCount: number;
    ongoingCount: number;
    medianOutageSeconds: number | null;
    longestOutageCheckId: string | null;
  };
  buckets: { start: Date; brokenSeconds: number }[];
  byOrganization: {
    organizationId: string;
    brokenSeconds: number;
    outageCount: number;
  }[];
  checks: CheckTotals[];
}

export function lateState(
  check: AggregateCheck,
  now: Date,
): { since: Date; downAt: Date } | null {
  if (
    check.type !== 'HEARTBEAT' ||
    check.status !== 'UP' ||
    check.lastEventAt === null
  ) {
    return null;
  }
  let expected: Date;
  if (check.schedule) {
    expected = nextCronFire(
      check.schedule,
      check.tz ?? 'UTC',
      check.lastEventAt,
    );
  } else if (check.periodSeconds !== null) {
    expected = new Date(
      check.lastEventAt.getTime() + check.periodSeconds * 1000,
    );
  } else {
    return null;
  }
  if (expected.getTime() >= now.getTime()) return null;
  return {
    since: expected,
    downAt: new Date(expected.getTime() + (check.graceSeconds ?? 0) * 1000),
  };
}

interface ClippedOutage {
  checkId: string;
  start: number;
  end: number;
  open: boolean;
  seconds: number;
}

interface Span {
  start: number;
  end: number;
  open: boolean;
  count: number;
  seconds: number;
}

/** Merges consecutive spans (sorted by start) closer than `gapMs`. */
function coalesce(spans: Span[], gapMs: number): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last === undefined || span.start - last.end >= gapMs) {
      merged.push({ ...span });
      continue;
    }
    // The open flag follows whichever outage ends last; ties prefer open.
    if (span.end > last.end) last.open = span.open;
    else if (span.end === last.end) last.open ||= span.open;
    last.end = Math.max(last.end, span.end);
    last.count += span.count;
    last.seconds += span.seconds;
  }
  return merged;
}

/**
 * Merges outages less than a thousandth of the range apart (about 43 minutes
 * over 30 days), then keeps doubling that gap until at most
 * MAX_TIMELINE_SPANS remain.
 */
function timelineSpans(
  outages: ClippedOutage[],
  rangeMs: number,
): OutageSpanResult[] {
  const sorted: Span[] = outages
    .map((o) => ({
      start: o.start,
      end: Math.max(o.start, o.end),
      open: o.open,
      count: 1,
      seconds: o.seconds,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let gapMs = Math.max(1, rangeMs / 1000);
  let spans = coalesce(sorted, gapMs);
  while (spans.length > MAX_TIMELINE_SPANS) {
    gapMs *= 2;
    spans = coalesce(spans, gapMs);
  }
  return spans.map((span) => ({
    startedAt: new Date(span.start),
    endedAt: span.open ? null : new Date(span.end),
    outageCount: span.count,
    brokenSeconds: Math.round(span.seconds),
  }));
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function aggregateOverview(input: AggregateInput): AggregateResult {
  const { now, rangeStart } = input;
  const nowMs = now.getTime();
  const rangeStartMs = rangeStart.getTime();

  const checkById = new Map(input.checks.map((c) => [c.id, c]));

  const clipped: ClippedOutage[] = [];
  for (const o of input.outages) {
    if (!checkById.has(o.checkId)) continue;
    const start = Math.max(o.startedAt.getTime(), rangeStartMs);
    const end = o.endedAt ? o.endedAt.getTime() : nowMs;
    clipped.push({
      checkId: o.checkId,
      start,
      end,
      open: o.endedAt === null,
      seconds: Math.max(0, (end - start) / 1000),
    });
  }

  // Needs fixing
  const openStartByCheck = new Map<string, Date>();
  for (const o of input.outages) {
    if (o.endedAt === null) openStartByCheck.set(o.checkId, o.startedAt);
  }
  const down: BrokenEntry[] = [];
  const late: BrokenEntry[] = [];
  for (const c of input.checks) {
    if (c.status === 'DOWN') {
      down.push({
        checkId: c.id,
        state: 'DOWN',
        since: openStartByCheck.get(c.id) ?? c.lastEventAt ?? now,
        downAt: null,
      });
      continue;
    }
    const l = lateState(c, now);
    if (l)
      late.push({
        checkId: c.id,
        state: 'LATE',
        since: l.since,
        downAt: l.downAt,
      });
  }
  const bySince = (a: BrokenEntry, b: BrokenEntry) =>
    a.since.getTime() - b.since.getTime();
  const needsFixing = [...down.sort(bySince), ...late.sort(bySince)];

  // Summary
  const durations = clipped.map((o) => o.seconds).sort((a, b) => a - b);
  let longest: ClippedOutage | null = null;
  for (const o of clipped) {
    if (longest === null || o.seconds > longest.seconds) longest = o;
  }
  const totalBroken = durations.reduce((sum, s) => sum + s, 0);

  // Uptime
  const monitoredSeconds = (c: AggregateCheck) =>
    Math.max(0, (nowMs - Math.max(rangeStartMs, c.createdAt.getTime())) / 1000);
  const isMeasured = (c: AggregateCheck) =>
    !(c.status === 'PAUSED' || (c.status === 'NEW' && c.lastEventAt === null));
  const uptime = (broken: number, monitored: number) =>
    monitored > 0 ? 100 * (1 - broken / monitored) : null;

  // Per check
  const perCheck = new Map<string, ClippedOutage[]>();
  for (const o of clipped) {
    const list = perCheck.get(o.checkId) ?? [];
    list.push(o);
    perCheck.set(o.checkId, list);
  }
  const checks: CheckTotals[] = [];
  let measuredBroken = 0;
  let measuredMonitored = 0;
  for (const c of input.checks) {
    const list = perCheck.get(c.id) ?? [];
    const broken = list.reduce((sum, o) => sum + o.seconds, 0);
    const measured = isMeasured(c);
    if (measured) {
      measuredBroken += broken;
      measuredMonitored += monitoredSeconds(c);
    }
    if (list.length === 0) continue;
    let longestSeconds = -1;
    let longestOpen = false;
    for (const o of list) {
      if (
        o.seconds > longestSeconds ||
        (o.seconds === longestSeconds && o.open)
      ) {
        longestSeconds = o.seconds;
        longestOpen = o.open;
      }
    }
    checks.push({
      checkId: c.id,
      brokenSeconds: Math.round(broken),
      outageCount: list.length,
      longestOutageSeconds: Math.round(longestSeconds),
      longestOutageOngoing: longestOpen,
      ongoing: list.some((o) => o.open),
      uptimePercent: measured ? uptime(broken, monitoredSeconds(c)) : null,
      outages: timelineSpans(list, nowMs - rangeStartMs),
    });
  }
  checks.sort((a, b) => b.brokenSeconds - a.brokenSeconds);

  // Buckets
  const buckets = input.bucketStarts.map((start, i) => {
    const lo = Math.max(start.getTime(), rangeStartMs);
    const hi = Math.min(input.bucketStarts[i + 1]?.getTime() ?? nowMs, nowMs);
    let seconds = 0;
    for (const o of clipped) {
      seconds += Math.max(
        0,
        (Math.min(o.end, hi) - Math.max(o.start, lo)) / 1000,
      );
    }
    return { start, brokenSeconds: Math.round(seconds) };
  });

  // Organizations
  const byOrganization = input.organizationIds.map((organizationId) => {
    let seconds = 0;
    let count = 0;
    for (const o of clipped) {
      if (checkById.get(o.checkId)!.organizationId !== organizationId) continue;
      seconds += o.seconds;
      count += 1;
    }
    return {
      organizationId,
      brokenSeconds: Math.round(seconds),
      outageCount: count,
    };
  });
  byOrganization.sort((a, b) => b.brokenSeconds - a.brokenSeconds);

  const med = median(durations);
  return {
    needsFixing,
    summary: {
      uptimePercent: uptime(measuredBroken, measuredMonitored),
      brokenSeconds: Math.round(totalBroken),
      outageCount: clipped.length,
      ongoingCount: clipped.filter((o) => o.open).length,
      medianOutageSeconds: med === null ? null : Math.round(med),
      longestOutageCheckId: longest?.checkId ?? null,
    },
    buckets,
    byOrganization,
    checks,
  };
}
