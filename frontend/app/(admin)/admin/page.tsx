"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@apollo/client/react";
import Link from "next/link";
import { Users, Building2, FolderKanban, Activity, Bell } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import { ADMIN_METRICS } from "@/lib/admin-queries";
import { Skeleton } from "@/components/ui/skeleton";

interface StatusCount {
  status: string;
  count: number;
}

interface AdminUserRef {
  id: string;
  email: string;
  createdAt: string;
}

interface DayCount {
  day: string;
  count: number;
}

interface AdminMetrics {
  totalUsers: number;
  totalOrgs: number;
  totalProjects: number;
  totalChecks: number;
  alertsLast24h: number;
  checksByStatus: StatusCount[];
  recentSignups: AdminUserRef[];
  signupsPerDay: DayCount[];
}

const METRIC_CARDS = [
  { key: "totalUsers" as const, label: "Users", Icon: Users },
  { key: "totalOrgs" as const, label: "Organizations", Icon: Building2 },
  { key: "totalProjects" as const, label: "Projects", Icon: FolderKanban },
  { key: "totalChecks" as const, label: "Checks", Icon: Activity },
  { key: "alertsLast24h" as const, label: "Alerts (24h)", Icon: Bell },
];

function SignupsChart({ data }: { data: DayCount[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground py-4 text-center">No signups in the last 14 days.</p>;
  }
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <figure aria-label="Signups per day" className="flex items-end gap-1 h-24 w-full">
      {data.map(({ day, count }) => (
        <div key={day} className="flex-1 flex flex-col items-center gap-1 group relative">
          <div
            className="w-full rounded-sm bg-primary transition-all"
            style={{ height: `${Math.max(4, (count / max) * 80)}px` }}
            title={`${day}: ${count} signups`}
            aria-label={`${day}: ${count} signups`}
            role="img"
          />
          <span className="absolute -top-5 left-1/2 -translate-x-1/2 hidden group-hover:block text-[10px] whitespace-nowrap bg-popover border border-border rounded px-1 py-0.5 shadow text-popover-foreground z-10">
            {day}: {count}
          </span>
        </div>
      ))}
    </figure>
  );
}

export default function AdminOverviewPage() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, loading, error } = useQuery<{ adminMetrics: AdminMetrics }>(ADMIN_METRICS, {
    fetchPolicy: "cache-and-network",
  });

  useEffect(() => {
    if (error) {
      Promise.resolve().then(() => setErrorMessage(error.message));
    }
  }, [error]);

  const metrics = data?.adminMetrics;

  if (loading && !metrics) {
    return (
      <div className="space-y-8">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Platform overview</h1>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-3/4 rounded-lg" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-1/2 rounded-lg" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Platform overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">Live snapshot of all platform activity.</p>
      </div>

      {/* Totals row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {METRIC_CARDS.map(({ key, label, Icon }) => (
          <Card key={key}>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="font-heading text-3xl font-bold tabular-nums">
                {metrics ? metrics[key].toLocaleString() : "—"}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Checks by status */}
      {metrics && metrics.checksByStatus.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Checks by status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {metrics.checksByStatus.map(({ status, count }) => (
                <div key={status} className="flex items-center gap-2">
                  <StatusBadge status={status} />
                  <span className="text-sm font-medium tabular-nums">{count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Signups per day chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Signups — last 14 days</CardTitle>
          </CardHeader>
          <CardContent>
            {metrics ? (
              <SignupsChart data={metrics.signupsPerDay} />
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
            )}
            {metrics && metrics.signupsPerDay.length > 0 && (
              <div className="mt-3 flex justify-between text-[11px] text-muted-foreground">
                <span>{metrics.signupsPerDay[0]?.day}</span>
                <span>{metrics.signupsPerDay[metrics.signupsPerDay.length - 1]?.day}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent signups */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Recent signups</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {metrics && metrics.recentSignups.length === 0 && (
              <p className="text-sm text-muted-foreground py-4 text-center px-6">No users yet.</p>
            )}
            {metrics && metrics.recentSignups.length > 0 && (
              <div className="divide-y divide-border">
                {metrics.recentSignups.map((user) => (
                  <Link
                    key={user.id}
                    href={`/admin/users/${user.id}`}
                    className="flex items-center justify-between px-6 py-2.5 hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-sm truncate max-w-[200px]">{user.email}</span>
                    <span className="text-xs text-muted-foreground shrink-0 ml-4">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Error dialog */}
      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </div>
  );
}
