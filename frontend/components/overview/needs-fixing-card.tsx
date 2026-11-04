import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { brokenDuration, brokenReason } from "@/lib/overview";
import { cn } from "@/lib/utils";

export interface BrokenCheckEntry {
  state: "DOWN" | "LATE";
  since: string;
  downAt: string | null;
  reason: string | null;
  check: {
    id: string;
    name: string;
    slug: string;
    type: string;
    lastEventAt: string | null;
    description: string | null;
  };
  organization: { id: string; name: string; slug: string };
}

const TYPE_LABELS: Record<string, string> = {
  HEARTBEAT: "Heartbeat",
  HTTP: "HTTP",
  TCP: "TCP",
};

export function NeedsFixingCard({
  entries,
  now,
}: {
  entries: BrokenCheckEntry[];
  now: Date;
}) {
  return (
    <Card className="border-destructive/35">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Needs fixing
          {entries.length > 0 && (
            <Badge variant="destructive" aria-label={`${entries.length} broken`}>
              {entries.length}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>Broken right now, longest first</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="flex items-center gap-2 text-sm font-medium text-success">
            <CheckCircle2 className="size-4" aria-hidden />
            Nothing needs fixing
          </p>
        ) : (
          <ul className="divide-y">
            {entries.map((entry) => {
              const duration = brokenDuration(entry, now);
              const down = entry.state === "DOWN";
              return (
                <li key={entry.check.id} className="space-y-2 py-4 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold",
                          down
                            ? "bg-destructive/10 text-destructive"
                            : "bg-warning/15 text-warning",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-1.5 rounded-full",
                            down ? "bg-destructive" : "bg-warning",
                          )}
                        />
                        {entry.state}
                      </span>
                      <div>
                        <Link
                          href={`/${entry.organization.slug}/${entry.check.slug}`}
                          className="font-medium hover:underline"
                        >
                          {entry.check.name}
                        </Link>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        <span className="font-semibold text-foreground">
                          {entry.organization.name}
                        </span>
                        {" · "}
                        {TYPE_LABELS[entry.check.type] ?? entry.check.type}
                        {" · "}
                        {brokenReason(entry, now)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={cn(
                          "text-xl font-semibold tabular-nums",
                          down ? "text-destructive" : "text-warning",
                        )}
                      >
                        {duration.value}
                      </p>
                      <p className="text-xs text-muted-foreground">{duration.caption}</p>
                    </div>
                  </div>
                  {entry.check.description && (
                    <p className="line-clamp-2 rounded-md bg-muted px-3 py-2 text-sm">
                      <span className="font-semibold">How to fix:</span>{" "}
                      {entry.check.description}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
