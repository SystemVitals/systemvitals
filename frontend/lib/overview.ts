import { formatElapsed, formatRelativeTime } from "@/lib/format";

export type OverviewRangeKey = "DAY" | "WEEK" | "MONTH" | "QUARTER";

export const OVERVIEW_RANGES: {
  key: OverviewRangeKey;
  param: "24h" | "7d" | "30d" | "90d";
  title: string;
}[] = [
  { key: "DAY", param: "24h", title: "24 hours" },
  { key: "WEEK", param: "7d", title: "7 days" },
  { key: "MONTH", param: "30d", title: "30 days" },
  { key: "QUARTER", param: "90d", title: "90 days" },
];

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
