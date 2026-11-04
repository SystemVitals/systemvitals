"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@apollo/client/react";
import { ACCOUNT_OVERVIEW } from "@/lib/queries";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import {
  OVERVIEW_RANGES,
  parseRangeParam,
  rangeOfOverview,
  type CheckBrokenTimeRow,
  type OverviewRange,
} from "@/lib/overview";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NeedsFixingCard,
  type BrokenCheckEntry,
} from "@/components/overview/needs-fixing-card";
import {
  SummaryTiles,
  type OverviewSummaryData,
} from "@/components/overview/summary-tiles";
import { BrokenTimeChart } from "@/components/overview/broken-time-chart";
import { OrganizationBrokenTime } from "@/components/overview/organization-broken-time";
import { OutageTimeline } from "@/components/overview/outage-timeline";
import { LongestBrokenTable } from "@/components/overview/longest-broken-table";

interface AccountOverviewData {
  accountOverview: {
    organizationCount: number;
    checkCount: number;
    rangeStart: string;
    rangeEnd: string;
    needsFixing: BrokenCheckEntry[];
    summary: OverviewSummaryData;
    buckets: { start: string; brokenSeconds: number }[];
    byOrganization: {
      organization: { id: string; name: string; slug: string };
      brokenSeconds: number;
      outageCount: number;
    }[];
    checks: CheckBrokenTimeRow[];
  };
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-16 w-full max-w-md" />
      <Skeleton className="h-48 w-full" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton
            key={index}
            className={index === 0 ? "col-span-2 h-24 lg:col-span-1" : "h-24"}
          />
        ))}
      </div>
    </div>
  );
}

function OutageHistory({
  overview,
  range,
}: {
  overview: AccountOverviewData["accountOverview"];
  range: OverviewRange;
}) {
  const hourly = range.key === "DAY";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Time broken per {hourly ? "hour" : "day"}</CardTitle>
            <CardDescription>DOWN time, summed across all checks</CardDescription>
          </CardHeader>
          <CardContent>
            <BrokenTimeChart buckets={overview.buckets} hourly={hourly} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Time broken by organization</CardTitle>
            <CardDescription>Last {range.title}</CardDescription>
          </CardHeader>
          <CardContent>
            <OrganizationBrokenTime rows={overview.byOrganization} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Outages, last {range.title}</CardTitle>
          <CardDescription>Each bar is a stretch of time a check was broken</CardDescription>
        </CardHeader>
        <CardContent>
          <OutageTimeline
            rangeStart={overview.rangeStart}
            rangeEnd={overview.rangeEnd}
            rows={overview.checks}
            late={overview.needsFixing
              .filter((entry) => entry.state === "LATE")
              .map((entry) => ({ checkId: entry.check.id }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Checks broken the longest</CardTitle>
          <CardDescription>Last {range.title}</CardDescription>
        </CardHeader>
        <CardContent>
          <LongestBrokenTable rows={overview.checks} />
        </CardContent>
      </Card>
    </div>
  );
}

function OverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = parseRangeParam(searchParams.get("range"));
  const rangeInfo = OVERVIEW_RANGES.find((item) => item.key === range)!;
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [now, setNow] = useState(() => new Date());
  // Polling repeats a failure every interval; remembering the dismissed message
  // keeps the same error from reopening the dialog each time.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const query = useQuery<AccountOverviewData>(ACCOUNT_OVERVIEW, {
    variables: { range, timeZone },
  });
  usePollWhenVisible(query, CHECK_POLL_INTERVAL_MS);

  // While a newly selected range loads, keep the previous result on screen
  // (dimmed) instead of flashing the skeleton; labels follow the data shown.
  const overview = (query.data ?? query.previousData)?.accountOverview;
  const loadingNextRange = query.loading && !query.data && !!overview;
  const shownRange = (overview && rangeOfOverview(overview)) ?? rangeInfo;
  const errorOpen = !!query.error && query.error.message !== dismissedError;

  const rangeControl = (
    <div role="group" aria-label="Time range" className="flex w-full gap-1 sm:w-auto">
      {OVERVIEW_RANGES.map((item) => (
        <Button
          key={item.key}
          type="button"
          size="sm"
          variant={item.key === range ? "default" : "outline"}
          aria-pressed={item.key === range}
          className="flex-1 sm:flex-none"
          onClick={() => router.replace(`/overview?range=${item.param}`)}
        >
          {item.param}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description={
          overview
            ? `All your organizations · ${plural(overview.organizationCount, "organization")} · ${plural(overview.checkCount, "check")}`
            : "All your organizations"
        }
        actions={<div className="w-full sm:w-auto">{rangeControl}</div>}
      />

      {!overview ? (
        query.loading ? <OverviewSkeleton /> : null
      ) : overview.organizationCount === 0 ? (
        <Card>
          <CardContent className="space-y-3 text-sm">
            <p>You are not in any organization yet.</p>
            <Button render={<Link href="/organizations" />} size="sm">
              Create an organization
            </Button>
          </CardContent>
        </Card>
      ) : overview.checkCount === 0 ? (
        <Card>
          <CardContent className="space-y-3 text-sm">
            <p>No checks yet. Add one to start tracking uptime across organizations.</p>
            <Button render={<Link href="/dashboard" />} size="sm">
              Go to the dashboard
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div
          aria-busy={loadingNextRange || undefined}
          className={cn("space-y-6 transition-opacity", loadingNextRange && "opacity-60")}
        >
          <NeedsFixingCard entries={overview.needsFixing} now={now} />
          <SummaryTiles
            summary={overview.summary}
            checkCount={overview.checkCount}
            rangeTitle={shownRange.title}
          />
          {overview.summary.outageCount === 0 ? (
            <Card>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  No outages in the last {shownRange.title}
                </p>
              </CardContent>
            </Card>
          ) : (
            <OutageHistory overview={overview} range={shownRange} />
          )}
        </div>
      )}

      <Dialog
        open={errorOpen}
        onOpenChange={(open) => {
          if (!open) setDismissedError(query.error?.message ?? null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Could not load the overview</DialogTitle>
            <DialogDescription>Something went wrong. Try again in a moment.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewContent />
    </Suspense>
  );
}
