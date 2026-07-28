"use client";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";

interface Point {
  timestamp: string;
  responseTimeMs: number | null;
}

interface ResponseTimeChartProps {
  points: Point[];
}

const CHART_CONFIG = {
  responseTimeMs: { label: "Response time", color: "var(--chart-2)" },
} satisfies ChartConfig;

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

function formatClock(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Values lead and the timestamp follows: the reader already knows what is
 * plotted and came for the number.
 */
function ResponseTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Point }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  return (
    <div className="rounded-lg border bg-card px-2.5 py-1.5 shadow-md">
      <p className="text-sm font-semibold tabular-nums">
        {point.responseTimeMs === null ? "No response" : formatMs(point.responseTimeMs)}
      </p>
      <p className="text-xs text-muted-foreground">
        {new Date(point.timestamp).toLocaleString()}
      </p>
    </div>
  );
}

export function ResponseTimeChart({ points }: ResponseTimeChartProps) {
  // The API returns events newest-first; plotting in that order runs time
  // backwards across the x-axis. Nulls are kept so an outage breaks the line
  // rather than being drawn straight over.
  const series = [...points].reverse();
  const hasData = series.some((p) => p.responseTimeMs !== null);

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-20 text-sm text-muted-foreground">
        No data
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <ChartContainer config={CHART_CONFIG} className="h-[160px] w-full">
        <LineChart accessibilityLayer data={series} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="0" />
          <XAxis
            dataKey="timestamp"
            tickFormatter={formatClock}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
            tickMargin={8}
            className="text-[11px] tabular-nums"
          />
          <YAxis
            // Recharts word-wraps tick text that exceeds the axis width less its
            // tick margin. "320 ms" sits right on that boundary at 56, so wide
            // digits wrap to a second line while "160 ms" does not. Leave slack.
            width={72}
            tickFormatter={(ms: number) => formatMs(ms)}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            domain={[0, "auto"]}
            className="text-[11px] tabular-nums"
          />
          <ChartTooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }} content={<ResponseTooltip />} />
          <Line
            dataKey="responseTimeMs"
            type="linear"
            stroke="var(--chart-2)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            connectNulls={false}
            // Polling refetches every 15s; animating would replay the draw each time.
            isAnimationActive={false}
            dot={{ r: 4, fill: "var(--chart-2)", stroke: "var(--card)", strokeWidth: 2 }}
            activeDot={{ r: 6, fill: "var(--chart-2)", stroke: "var(--card)", strokeWidth: 2 }}
          />
        </LineChart>
      </ChartContainer>

      {/* A tooltip must never be the only way to read a value. */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <div className="mt-2 max-h-56 overflow-y-auto">
          <table className="w-full text-xs">
            <caption className="sr-only">Response time by measurement, oldest first</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="text-left font-medium py-1">Time</th>
                <th scope="col" className="text-right font-medium py-1">Response time</th>
              </tr>
            </thead>
            <tbody>
              {series.map((p) => (
                <tr key={p.timestamp} className="border-t">
                  <td className="py-1 text-muted-foreground">
                    {new Date(p.timestamp).toLocaleString()}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {p.responseTimeMs === null ? "No response" : formatMs(p.responseTimeMs)}
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
