export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} hr`;
}

const ELAPSED_UNITS = [
  { suffix: "d", ms: 24 * 60 * 60 * 1000 },
  { suffix: "h", ms: 60 * 60 * 1000 },
  { suffix: "m", ms: 60 * 1000 },
  { suffix: "s", ms: 1000 },
] as const;

/**
 * Humanise a span between two events, e.g. "1h 8m", "45m 12s", "7s".
 *
 * Distinct from `formatDuration`, which rounds to a single coarse unit for
 * configuration fields. This keeps two units and truncates rather than rounds,
 * so a label can never claim more elapsed time than actually passed.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return "<1s";

  const startIndex = ELAPSED_UNITS.findIndex((unit) => ms >= unit.ms);
  const parts: string[] = [];

  let remaining = ms;
  for (const unit of ELAPSED_UNITS.slice(startIndex, startIndex + 2)) {
    const value = Math.floor(remaining / unit.ms);
    remaining -= value * unit.ms;
    if (value > 0) parts.push(`${value}${unit.suffix}`);
  }

  return parts.join(" ");
}

const SPAN_UNITS = [
  { label: "day", seconds: 86_400 },
  { label: "hr", seconds: 3_600 },
  { label: "min", seconds: 60 },
  { label: "sec", seconds: 1 },
] as const;

/**
 * Exact, readable span for configuration values, e.g. "5 min", "1 hr 30 min",
 * "1 day". Unlike `formatDuration` it never rounds, so a 90-second grace period
 * reads "1 min 30 sec" rather than "2 min".
 */
export function formatSpan(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 sec";
  const parts: string[] = [];
  let remaining = Math.round(seconds);
  for (const unit of SPAN_UNITS) {
    const value = Math.floor(remaining / unit.seconds);
    if (value === 0) continue;
    remaining -= value * unit.seconds;
    parts.push(`${value} ${unit.label}${unit.label === "day" && value !== 1 ? "s" : ""}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

// `from` is where a unit takes over; days run to 45 so a 30-day expiry reads
// "in 30 days" instead of the vaguer "next month".
const RELATIVE_UNITS: {
  unit: Intl.RelativeTimeFormatUnit;
  seconds: number;
  from: number;
}[] = [
  { unit: "year", seconds: 31_536_000, from: 31_536_000 },
  { unit: "month", seconds: 2_592_000, from: 3_888_000 },
  { unit: "day", seconds: 86_400, from: 86_400 },
  { unit: "hour", seconds: 3_600, from: 3_600 },
  { unit: "minute", seconds: 60, from: 60 },
];

/**
 * "just now", "5 minutes ago", "in 30 days". Uses the largest whole unit so a
 * glance answers "how long ago / how soon"; pair it with the absolute date in a
 * tooltip when the exact moment matters.
 */
export function formatRelativeTime(value: string | Date, now: Date = new Date()): string {
  const deltaSeconds = (new Date(value).getTime() - now.getTime()) / 1000;
  const magnitude = Math.abs(deltaSeconds);
  if (magnitude < 45) return "just now";
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const { unit, seconds, from } of RELATIVE_UNITS) {
    if (magnitude >= from) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return formatter.format(deltaSeconds < 0 ? -1 : 1, "minute");
}

export function formatDateTime(value: string | Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
