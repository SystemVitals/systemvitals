import { cn } from "@/lib/utils";

// Compact EKG mark for favicons/wordmark — static, no animation.
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("h-6 w-6", className)}>
      <path
        d="M2 13 H7 l1.5 -2 l1.5 4 l1.5 -9 l2 14 l1.5 -8 l1.5 1 H22"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
