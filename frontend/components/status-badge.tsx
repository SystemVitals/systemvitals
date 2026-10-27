import { cn } from "@/lib/utils";

const STYLES: Record<string, string> = {
  UP: "bg-success/10 text-success ring-success/20",
  DOWN: "bg-destructive/10 text-destructive ring-destructive/20",
  GRACE: "bg-warning/10 text-warning ring-warning/20",
  PAUSED: "bg-muted text-muted-foreground ring-border",
  NEW: "bg-primary/10 text-primary ring-primary/20",
};

// Plain-language labels: "GRACE" and "NEW" are internal states that read as
// jargon on dashboards and public status pages.
export const STATUS_LABELS: Record<string, string> = {
  UP: "Up",
  DOWN: "Down",
  GRACE: "Late",
  PAUSED: "Paused",
  NEW: "Waiting",
};

export const STATUS_DESCRIPTIONS: Record<string, string> = {
  UP: "Working as expected",
  DOWN: "Failing or missed its deadline",
  GRACE: "Overdue, inside the grace period",
  PAUSED: "Not monitored and no alerts are sent",
  NEW: "Waiting for the first ping or probe",
};

export function StatusBadge({ status }: { status: keyof typeof STYLES | string }) {
  const cls = STYLES[status] ?? STYLES.NEW;
  const label = STATUS_LABELS[status] ?? status;
  return (
    <span
      role="status"
      aria-label={label}
      title={STATUS_DESCRIPTIONS[status]}
      className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", cls)}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
