import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  UP: "bg-success/10 text-success ring-success/20",
  DOWN: "bg-destructive/10 text-destructive ring-destructive/20",
  GRACE: "bg-warning/10 text-warning ring-warning/20",
  PAUSED: "bg-muted text-muted-foreground ring-border",
  NEW: "bg-primary/10 text-primary ring-primary/20",
};

export function StatusBadge({ status }: { status: keyof typeof STYLES | string }) {
  const cls = STYLES[status] ?? STYLES.NEW;
  return (
    <span
      role="status"
      aria-label={status}
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", cls)}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {status}
    </span>
  );
}
