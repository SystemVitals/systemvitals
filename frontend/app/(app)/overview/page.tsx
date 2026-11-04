"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@apollo/client/react";
import { ACCOUNT_OVERVIEW } from "@/lib/queries";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import { OVERVIEW_RANGES, parseRangeParam } from "@/lib/overview";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
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

interface AccountOverviewData {
  accountOverview: {
    organizationCount: number;
    checkCount: number;
    needsFixing: BrokenCheckEntry[];
    summary: OverviewSummaryData;
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

function OverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const range = parseRangeParam(searchParams.get("range"));
  const rangeInfo = OVERVIEW_RANGES.find((item) => item.key === range)!;
  const [timeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [now, setNow] = useState(() => new Date());
  const [dismissedError, setDismissedError] = useState<unknown>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const query = useQuery<AccountOverviewData>(ACCOUNT_OVERVIEW, {
    variables: { range, timeZone },
  });
  usePollWhenVisible(query, CHECK_POLL_INTERVAL_MS);

  const overview = query.data?.accountOverview;
  const errorOpen = !!query.error && dismissedError !== query.error;

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
        <>
          <NeedsFixingCard entries={overview.needsFixing} now={now} />
          <SummaryTiles
            summary={overview.summary}
            checkCount={overview.checkCount}
            rangeTitle={rangeInfo.title}
          />
          {/* Task 6: charts, outages timeline, and longest-broken table go here. */}
        </>
      )}

      <Dialog
        open={errorOpen}
        onOpenChange={() => setDismissedError(query.error)}
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
