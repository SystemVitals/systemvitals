import Link from "next/link";
import { formatBrokenSeconds, formatUptime, type CheckBrokenTimeRow } from "@/lib/overview";
import { cn } from "@/lib/utils";

// Phone keeps Check, Time broken, and Uptime.
const WIDE_ONLY = "hidden sm:table-cell";

export function LongestBrokenTable({
  rows,
  limit = 10,
}: {
  rows: CheckBrokenTimeRow[];
  limit?: number;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Checks broken the longest, most broken time first</caption>
      <thead className="text-xs whitespace-nowrap text-muted-foreground">
        <tr className="border-b">
          <th scope="col" className="py-2 pr-3 text-left font-medium">
            Check
          </th>
          <th scope="col" className={cn(WIDE_ONLY, "px-3 py-2 text-left font-medium")}>
            Organization
          </th>
          <th scope="col" className={cn(WIDE_ONLY, "px-3 py-2 text-right font-medium")}>
            Outages
          </th>
          <th scope="col" className="px-3 py-2 text-right font-medium">
            Time broken
          </th>
          <th scope="col" className={cn(WIDE_ONLY, "px-3 py-2 text-right font-medium")}>
            Longest
          </th>
          <th scope="col" className="py-2 pl-3 text-right font-medium">
            Uptime
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, limit).map((row) => (
          <tr key={row.check.id} className="border-b last:border-0">
            <td className="py-2.5 pr-3 font-medium wrap-anywhere">
              <Link
                href={`/${row.organization.slug}/${row.check.slug}`}
                className="hover:underline"
              >
                {row.check.name}
              </Link>
            </td>
            <td className={cn(WIDE_ONLY, "px-3 py-2.5 text-muted-foreground")}>
              {row.organization.name}
            </td>
            <td className={cn(WIDE_ONLY, "px-3 py-2.5 text-right tabular-nums")}>
              {row.outageCount}
            </td>
            <td className="px-3 py-2.5 text-right whitespace-nowrap tabular-nums">
              {formatBrokenSeconds(row.brokenSeconds)}
            </td>
            <td className={cn(WIDE_ONLY, "px-3 py-2.5 text-right whitespace-nowrap tabular-nums")}>
              {formatBrokenSeconds(row.longestOutageSeconds)}
              {row.ongoing && (
                <span className="ml-1.5 text-[10px] font-semibold tracking-wide text-destructive">
                  ONGOING
                </span>
              )}
            </td>
            <td className="py-2.5 pl-3 text-right tabular-nums">
              {formatUptime(row.uptimePercent)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
