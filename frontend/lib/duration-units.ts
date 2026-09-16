export const DURATION_UNITS = ["s", "min", "hr"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export const DURATION_UNIT_MS: Record<DurationUnit, number> = {
  s: 1_000,
  min: 60_000,
  hr: 3_600_000,
};

export const DURATION_UNIT_LABEL: Record<DurationUnit, string> = {
  s: "Seconds",
  min: "Minutes",
  hr: "Hours",
};

export function availableDurationUnits(maxMs: number): DurationUnit[] {
  const units: DurationUnit[] = ["s"];
  if (maxMs > 60_000) units.push("min");
  if (maxMs >= 3_600_000) units.push("hr");
  return units;
}

export function nicestDurationUnit(
  valueMs: number,
  units: DurationUnit[],
): DurationUnit {
  if (valueMs === 0) {
    return units.includes("s") ? "s" : units[0];
  }
  for (const unit of [...units].reverse()) {
    const size = DURATION_UNIT_MS[unit];
    if (valueMs >= size && valueMs % size === 0) {
      return unit;
    }
  }
  return units[0];
}

export function msToDurationUnit(ms: number, unit: DurationUnit): number {
  return ms / DURATION_UNIT_MS[unit];
}

export function durationUnitToMs(value: number, unit: DurationUnit): number {
  return value * DURATION_UNIT_MS[unit];
}
