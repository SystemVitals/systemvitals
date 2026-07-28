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
