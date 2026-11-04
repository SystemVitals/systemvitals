import { formatBrokenSeconds, percentOf } from "@/lib/overview";
import { cn } from "@/lib/utils";

export function OrganizationBrokenTime({
  rows,
}: {
  rows: { organization: { id: string; name: string }; brokenSeconds: number }[];
}) {
  const max = rows.reduce((largest, row) => Math.max(largest, row.brokenSeconds), 0);

  return (
    <ul className="space-y-4">
      {rows.map(({ organization, brokenSeconds }) => {
        const width = percentOf(brokenSeconds, max);
        return (
          <li key={organization.id} className="space-y-1.5">
            <p className="truncate text-sm font-medium">{organization.name}</p>
            {/* The right margin leaves room for the widest bar's label. */}
            <div className="relative mr-16 h-3.5 rounded-sm bg-muted">
              <div
                data-slot="bar"
                aria-hidden
                className={cn("h-full rounded-sm bg-destructive", brokenSeconds > 0 && "min-w-1")}
                style={{ width }}
              />
              <span
                className="absolute top-1/2 -translate-y-1/2 pl-2 text-xs whitespace-nowrap tabular-nums"
                style={{ left: width }}
              >
                {formatBrokenSeconds(brokenSeconds)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
