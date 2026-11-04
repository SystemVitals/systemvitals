import { Card, CardContent } from "@/components/ui/card";
import { formatBrokenSeconds, formatUptime } from "@/lib/overview";
import { cn } from "@/lib/utils";

export interface OverviewSummaryData {
  uptimePercent: number | null;
  brokenSeconds: number;
  outageCount: number;
  ongoingCount: number;
  medianOutageSeconds: number | null;
  longestOutage: {
    brokenSeconds: number;
    ongoing: boolean;
    check: { name: string };
  } | null;
}

function Tile({
  label,
  value,
  className,
  children,
}: {
  label: string;
  value: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm" className={className}>
      <CardContent className="space-y-1">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="font-heading text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

export function SummaryTiles({
  summary,
  checkCount,
  rangeTitle,
}: {
  summary: OverviewSummaryData;
  checkCount: number;
  rangeTitle: string;
}) {
  const longest = summary.longestOutage;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Last {rangeTitle}, all organizations
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile
          label="Uptime"
          value={formatUptime(summary.uptimePercent)}
          className="col-span-2 lg:col-span-1"
        >
          across {checkCount} {checkCount === 1 ? "check" : "checks"}
        </Tile>
        <Tile label="Time broken" value={formatBrokenSeconds(summary.brokenSeconds)}>
          summed over all checks
        </Tile>
        <Tile label="Outages" value={String(summary.outageCount)}>
          {summary.ongoingCount > 0 ? (
            <span className="text-destructive">{summary.ongoingCount} still ongoing</span>
          ) : (
            "none ongoing"
          )}
        </Tile>
        <Tile
          label="Typical fix time"
          value={
            summary.medianOutageSeconds === null
              ? "—"
              : formatBrokenSeconds(summary.medianOutageSeconds)
          }
        >
          median outage length
        </Tile>
        <Tile
          label="Longest outage"
          value={longest ? formatBrokenSeconds(longest.brokenSeconds) : "—"}
        >
          {longest ? (
            <>
              {longest.check.name}
              {longest.ongoing && <span className={cn("text-destructive")}>, ongoing</span>}
            </>
          ) : (
            "no outages"
          )}
        </Tile>
      </div>
    </section>
  );
}
