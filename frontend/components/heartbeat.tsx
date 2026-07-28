"use client";
import { useId } from "react";
import { cn } from "@/lib/utils";

// A normalized EKG trace: flat baseline → small P bump → sharp QRS spike → flat.
const TRACE =
  "M0 24 H40 l6 -2 l5 4 l8 0 l4 -16 l5 30 l5 -22 l6 6 H100 l6 -2 l5 4 l8 0 l4 -16 l5 30 l5 -22 l6 6 H200";

const SIZES = {
  hero: "h-24 w-full",
  mark: "h-5 w-7",
  divider: "h-8 w-full opacity-60",
} as const;

export function Heartbeat({
  variant = "hero",
  className,
}: {
  variant?: keyof typeof SIZES;
  className?: string;
}) {
  const animate = variant !== "mark";
  const gid = useId();
  const gradId = `sv-pulse-${gid.replace(/:/g, "")}`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 48"
      preserveAspectRatio="none"
      className={cn(SIZES[variant], className)}
    >
      {/* faint full baseline */}
      <path d={TRACE} fill="none" stroke="currentColor" strokeWidth={1} className="text-border" />
      {/* drawn pulse — teal-ink line with coral peak via gradient */}
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--primary)" />
          <stop offset="50%" stopColor="var(--accent)" />
          <stop offset="100%" stopColor="var(--primary)" />
        </linearGradient>
      </defs>
      <path
        d={TRACE}
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={animate ? "sv-ekg" : undefined}
      />
    </svg>
  );
}
