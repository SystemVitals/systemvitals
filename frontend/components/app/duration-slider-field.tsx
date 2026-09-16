"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  availableDurationUnits,
  durationUnitToMs,
  DURATION_UNIT_LABEL,
  msToDurationUnit,
  nicestDurationUnit,
  type DurationUnit,
} from "@/lib/duration-units";

function clampMs(ms: number, minMs: number, maxMs: number, stepMs: number) {
  const snapped = Math.round(ms / stepMs) * stepMs;
  return Math.min(maxMs, Math.max(minMs, snapped));
}

export function DurationSliderField({
  id,
  label,
  valueMs,
  onValueMsChange,
  minMs,
  maxMs,
  stepMs,
}: {
  id: string;
  label: string;
  valueMs: number;
  onValueMsChange: (ms: number) => void;
  minMs: number;
  maxMs: number;
  stepMs: number;
}) {
  const units = availableDurationUnits(maxMs);
  const [draft, setDraft] = useState<string | null>(null);
  const [unit, setUnit] = useState<DurationUnit>(() =>
    nicestDurationUnit(valueMs, units),
  );
  const selectedUnit = units.includes(unit) ? unit : units[0];
  const displayValue = draft ?? msToDurationUnit(valueMs, selectedUnit);

  function commit(raw: string) {
    const amount = parseFloat(raw);
    setDraft(null);
    if (!Number.isFinite(amount)) {
      onValueMsChange(clampMs(valueMs, minMs, maxMs, stepMs));
      return;
    }
    onValueMsChange(
      clampMs(
        Math.round(durationUnitToMs(amount, selectedUnit)),
        minMs,
        maxMs,
        stepMs,
      ),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            type="number"
            min={msToDurationUnit(minMs, selectedUnit)}
            max={msToDurationUnit(maxMs, selectedUnit)}
            step={msToDurationUnit(stepMs, selectedUnit)}
            className="h-8 w-20 text-right font-mono text-sm"
            value={displayValue}
            onChange={(event) => {
              const raw = event.target.value;
              setDraft(raw);
              const amount = parseFloat(raw);
              if (!Number.isFinite(amount)) {
                return;
              }
              const nextMs = Math.round(durationUnitToMs(amount, selectedUnit));
              if (nextMs >= minMs && nextMs <= maxMs) {
                onValueMsChange(clampMs(nextMs, minMs, maxMs, stepMs));
              }
            }}
            onBlur={(event) => commit(event.target.value)}
          />
          {units.length === 1 ? (
            <span className="text-sm text-muted-foreground font-mono">s</span>
          ) : (
            <div role="group" aria-label="Unit" className="flex gap-0.5">
              {units.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={option === selectedUnit ? "default" : "outline"}
                  aria-pressed={option === selectedUnit}
                  aria-label={DURATION_UNIT_LABEL[option]}
                  onClick={() => {
                    setDraft(null);
                    setUnit(option);
                  }}
                >
                  {option}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
      <Slider
        min={minMs}
        max={maxMs}
        step={stepMs}
        value={[valueMs]}
        aria-label={`${label} range`}
        onValueChange={(value) => {
          setDraft(null);
          const next = Array.isArray(value) ? value[0] : value;
          onValueMsChange(clampMs(next, minMs, maxMs, stepMs));
        }}
      />
    </div>
  );
}
