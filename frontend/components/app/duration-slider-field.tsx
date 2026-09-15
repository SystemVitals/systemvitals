"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";

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
  function commitSeconds(raw: string) {
    const seconds = parseFloat(raw);
    if (!Number.isFinite(seconds)) {
      onValueMsChange(clampMs(valueMs, minMs, maxMs, stepMs));
      return;
    }
    onValueMsChange(clampMs(Math.round(seconds * 1000), minMs, maxMs, stepMs));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            type="number"
            min={minMs / 1000}
            max={maxMs / 1000}
            step={stepMs / 1000}
            className="h-8 w-16 text-right font-mono text-sm"
            value={valueMs / 1000}
            onChange={(event) => commitSeconds(event.target.value)}
            onBlur={(event) => commitSeconds(event.target.value)}
          />
          <span className="text-sm text-muted-foreground font-mono">s</span>
        </div>
      </div>
      <Slider
        min={minMs}
        max={maxMs}
        step={stepMs}
        value={[valueMs]}
        onValueChange={(value) => {
          const next = Array.isArray(value) ? value[0] : value;
          onValueMsChange(clampMs(next, minMs, maxMs, stepMs));
        }}
      />
    </div>
  );
}
