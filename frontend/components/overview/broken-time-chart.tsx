"use client";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { formatBrokenSeconds } from "@/lib/overview";

interface Bucket {
  start: string;
  brokenSeconds: number;
}

interface Point extends Bucket {
  /** brokenSeconds in the axis unit (hours, or minutes for small values). */
  amount: number;
}

const CHART_CONFIG = {
  brokenSeconds: { label: "Time broken", color: "var(--destructive)" },
} satisfies ChartConfig;

// Below two hours an hour axis reads as "0h, 1h, 2h" with every bar near the
// floor; minutes keep small outages legible.
const MINUTES_BELOW_SECONDS = 2 * 3600;

function bucketLabel(start: string, hourly: boolean): string {
  return new Date(start).toLocaleString(
    undefined,
    hourly
      ? { month: "short", day: "numeric", hour: "numeric" }
      : { weekday: "short", month: "short", day: "numeric" },
  );
}

function BucketTooltip({
  active,
  payload,
  hourly,
}: {
  active?: boolean;
  payload?: Array<{ payload: Point }>;
  hourly: boolean;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border bg-card px-2.5 py-1.5 shadow-md">
      <p className="text-sm font-semibold tabular-nums">
        {formatBrokenSeconds(point.brokenSeconds)}
      </p>
      <p className="text-xs text-muted-foreground">{bucketLabel(point.start, hourly)}</p>
    </div>
  );
}

export function BrokenTimeChart({
  buckets,
  hourly,
}: {
  buckets: Bucket[];
  hourly: boolean;
}) {
  const max = buckets.reduce((largest, bucket) => Math.max(largest, bucket.brokenSeconds), 0);
  const inHours = max >= MINUTES_BELOW_SECONDS;
  const unitSeconds = inHours ? 3600 : 60;
  const unit = inHours ? "h" : "m";
  const series: Point[] = buckets.map((bucket) => ({
    ...bucket,
    amount: bucket.brokenSeconds / unitSeconds,
  }));
  const lastStart = buckets.at(-1)?.start;
  const label = `Time broken per ${hourly ? "hour" : "day"}`;

  const formatTick = (start: string) => {
    if (!hourly && start === lastStart) return "Today";
    return hourly
      ? new Date(start).toLocaleTimeString(undefined, { hour: "numeric" })
      : new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  return (
    <div className="space-y-2">
      <ChartContainer
        config={CHART_CONFIG}
        role="figure"
        aria-label={label}
        className="h-[200px] w-full"
      >
        <BarChart
          accessibilityLayer
          data={series}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
          <XAxis
            dataKey="start"
            tickFormatter={formatTick}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
            tickMargin={8}
            className="text-[11px] tabular-nums"
          />
          <YAxis
            width={40}
            tickFormatter={(value: number) => `${value}${unit}`}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            domain={[0, "auto"]}
            className="text-[11px] tabular-nums"
          />
          <ChartTooltip content={<BucketTooltip hourly={hourly} />} />
          <Bar
            dataKey="amount"
            fill="var(--color-brokenSeconds)"
            radius={[4, 4, 0, 0]}
            maxBarSize={24}
            // Polling refetches every 15s; animating would replay the bars each time.
            isAnimationActive={false}
          />
        </BarChart>
      </ChartContainer>

      {/* A tooltip must never be the only way to read a value. */}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <div className="mt-2 max-h-56 overflow-y-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">{label}, oldest first</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 text-left font-medium">
                  {hourly ? "Hour" : "Day"}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  Time broken
                </th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.start} className="border-t">
                  <td className="py-1 text-muted-foreground">{bucketLabel(bucket.start, hourly)}</td>
                  <td className="py-1 text-right tabular-nums">
                    {formatBrokenSeconds(bucket.brokenSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
