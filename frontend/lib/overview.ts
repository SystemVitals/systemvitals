import { formatElapsed, formatRelativeTime } from "@/lib/format";

export type OverviewRangeKey = "DAY" | "WEEK" | "MONTH" | "QUARTER";

export interface OverviewRange {
  key: OverviewRangeKey;
  param: "24h" | "7d" | "30d" | "90d";
  title: string;
  /** Window length; the API returns `rangeEnd - rangeStart` of exactly this. */
  seconds: number;
}

export const OVERVIEW_RANGES: OverviewRange[] = [
  { key: "DAY", param: "24h", title: "24 hours", seconds: 86_400 },
  { key: "WEEK", param: "7d", title: "7 days", seconds: 604_800 },
  { key: "MONTH", param: "30d", title: "30 days", seconds: 2_592_000 },
  { key: "QUARTER", param: "90d", title: "90 days", seconds: 7_776_000 },
];

/**
 * The range a loaded overview covers. While a newly selected range loads, the
 * page keeps showing the previous result, so labels must follow the data rather
 * than the URL.
 */
export function rangeOfOverview(overview: {
  rangeStart: string;
  rangeEnd: string;
}): OverviewRange | undefined {
  const seconds = (Date.parse(overview.rangeEnd) - Date.parse(overview.rangeStart)) / 1000;
  return OVERVIEW_RANGES.find((range) => range.seconds === seconds);
}

export function parseRangeParam(value: string | null): OverviewRangeKey {
  return OVERVIEW_RANGES.find((range) => range.param === value)?.key ?? "MONTH";
}

export function brokenDuration(
  entry: { state: "DOWN" | "LATE"; since: string; downAt: string | null },
  now: Date,
): { value: string; caption: "down for" | "late by" | "overdue by" } {
  const elapsed = (from: string) =>
    formatElapsed(Math.max(0, now.getTime() - new Date(from).getTime()));
  if (entry.state === "DOWN") {
    return { value: elapsed(entry.since), caption: "down for" };
  }
  if (entry.downAt && now.getTime() > new Date(entry.downAt).getTime()) {
    return { value: elapsed(entry.downAt), caption: "overdue by" };
  }
  return { value: elapsed(entry.since), caption: "late by" };
}

export function brokenReason(
  entry: {
    state: "DOWN" | "LATE";
    reason: string | null;
    downAt: string | null;
    check: { type: string; lastEventAt: string | null };
  },
  now: Date,
): string {
  if (entry.state === "LATE") {
    const remaining = entry.downAt
      ? new Date(entry.downAt).getTime() - now.getTime()
      : 0;
    return remaining > 0
      ? `goes DOWN in ${formatElapsed(remaining)}`
      : "should be DOWN; is the worker running?";
  }
  if (entry.check.type === "HEARTBEAT") {
    return entry.check.lastEventAt
      ? `no ping since ${formatRelativeTime(entry.check.lastEventAt, now)}`
      : "never pinged";
  }
  return entry.reason ?? "probe failing";
}

export function formatUptime(percent: number | null): string {
  if (percent === null) return "—";
  return percent === 100 ? "100%" : `${percent.toFixed(2)}%`;
}

export function formatBrokenSeconds(seconds: number): string {
  return seconds <= 0 ? "0m" : formatElapsed(seconds * 1000);
}

/**
 * Whether a check's longest outage is still open. A check can hold a long
 * closed outage and a short open one; only the longest span (clipped to the
 * range, open spans measured to `rangeEnd`) decides. Ties prefer the open span.
 */
export function isLongestOutageOngoing(
  outages: { startedAt: string; endedAt: string | null }[],
  rangeEnd: string,
): boolean {
  let longest = -1;
  let ongoing = false;
  for (const outage of outages) {
    const end = outage.endedAt === null ? Date.parse(rangeEnd) : Date.parse(outage.endedAt);
    const length = end - Date.parse(outage.startedAt);
    const open = outage.endedAt === null;
    if (length > longest || (length === longest && open)) {
      longest = length;
      ongoing = open;
    }
  }
  return ongoing;
}

/** `part` as a CSS percentage of `whole`, clamped to 0–100%, e.g. "30.94%". */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const share = Math.min(100, Math.max(0, (part / whole) * 100));
  return `${Number(share.toFixed(2))}%`;
}

export interface CheckBrokenTimeRow {
  check: { id: string; name: string; slug: string };
  organization: { id: string; name: string; slug: string };
  brokenSeconds: number;
  outageCount: number;
  longestOutageSeconds: number;
  ongoing: boolean;
  uptimePercent: number | null;
  outages: { startedAt: string; endedAt: string | null }[];
}
