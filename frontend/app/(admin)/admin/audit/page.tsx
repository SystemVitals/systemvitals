"use client";

import { useState } from "react";
import { useQuery } from "@apollo/client/react";
import Link from "next/link";
import { FileText, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ADMIN_AUDIT_LOG } from "@/lib/admin-queries";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 25;

interface AuditLogItem {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  createdAt: string;
}


interface AdminAuditLogData {
  adminAuditLog: {
    items: AuditLogItem[];
    total: number;
  };
}

function actionBadgeClass(action: string) {
  switch (action.toLowerCase()) {
    case "impersonate":
      return "bg-warning/15 text-warning";
    case "delete":
      return "bg-destructive/15 text-destructive";
    case "suspend":
      return "bg-destructive/15 text-destructive";
    case "unsuspend":
      return "bg-success/15 text-success";
    case "grant_admin":
    case "revoke_admin":
      return "bg-primary/15 text-primary";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export default function AdminAuditPage() {
  const [page, setPage] = useState(1);

  const { data, loading, error } = useQuery<AdminAuditLogData>(ADMIN_AUDIT_LOG, {
    variables: { page: page - 1, pageSize: PAGE_SIZE },
    fetchPolicy: "cache-and-network",
  });

  const items = data?.adminAuditLog?.items ?? [];
  const total = data?.adminAuditLog?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <FileText className="h-6 w-6 text-primary" />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Audit log</h1>
        {total > 0 && (
          <span className="ml-2 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {total}
          </span>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All audit events</CardTitle>
        </CardHeader>
        {loading && !data ? (
          <CardContent>
            <div className="space-y-2 py-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </CardContent>
        ) : error && !data ? (
          <CardContent>
            <p className="text-sm text-destructive py-4">Error: {error.message}</p>
          </CardContent>
        ) : items.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground py-8 text-center">No audit events found.</p>
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_120px_1fr_160px] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                <span>Actor</span>
                <span>Action</span>
                <span>Target</span>
                <span>Time</span>
              </div>
              {items.map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[1fr_120px_1fr_160px] gap-3 items-center px-4 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/admin/users/${item.actorUserId}`}
                      className="text-sm font-medium truncate hover:underline"
                    >
                      {item.actorEmail ?? item.actorUserId}
                    </Link>
                    {item.actorEmail && (
                      <p className="text-xs text-muted-foreground truncate">{item.actorUserId}</p>
                    )}
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide w-fit ${actionBadgeClass(item.action ?? "")}`}
                  >
                    {(item.action ?? "").replace(/_/g, " ")}
                  </span>
                  <div className="min-w-0">
                    {item.targetType ? (
                      <>
                        <p className="text-sm font-medium truncate capitalize">
                          {item.targetType.toLowerCase()}
                        </p>
                        {item.targetId && (
                          <p className="text-xs text-muted-foreground font-mono truncate">
                            {item.targetId}
                          </p>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {item.createdAt ? new Date(item.createdAt).toLocaleString() : "—"}
                  </p>
                </div>
              ))}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t">
                <p className="text-xs text-muted-foreground">
                  Page {page} of {totalPages} — {total} total
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="sr-only">Previous</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <ChevronRight className="h-4 w-4" />
                    <span className="sr-only">Next</span>
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

    </div>
  );
}
