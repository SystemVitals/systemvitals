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

export interface OutageSpanResult {
  startedAt: Date;
  endedAt: Date | null;
}

export interface CheckTotals {
  checkId: string;
  brokenSeconds: number;
  outageCount: number;
  longestOutageSeconds: number;
  ongoing: boolean;
  uptimePercent: number | null;
  outages: OutageSpanResult[];
}

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
    checks.push({
      checkId: c.id,
      brokenSeconds: Math.round(broken),
      outageCount: list.length,
      longestOutageSeconds: Math.round(Math.max(...list.map((o) => o.seconds))),
      ongoing: list.some((o) => o.open),
      uptimePercent: measured ? uptime(broken, monitoredSeconds(c)) : null,
      outages: list.map((o) => ({
        startedAt: new Date(o.start),
        endedAt: o.open ? null : new Date(o.end),
      })),
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
