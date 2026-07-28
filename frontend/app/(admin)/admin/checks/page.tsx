"use client";

import { useState } from "react";
import { useQuery, useMutation } from "@apollo/client/react";
import { ChevronLeft, ChevronRight, Pause, Play, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusBadge } from "@/components/status-badge";
import {
  ADMIN_CHECKS,
  ADMIN_PAUSE_CHECK,
  ADMIN_RESUME_CHECK,
  ADMIN_DELETE_CHECK,
} from "@/lib/admin-queries";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 20;

const STATUS_OPTIONS = ["all", "UP", "DOWN", "GRACE", "NEW", "PAUSED"] as const;
type StatusFilter = (typeof STATUS_OPTIONS)[number];

interface AdminCheck {
  id: string;
  name: string;
  type: string;
  status: string;
  projectId: string;
  projectName: string;
  organizationId: string;
  organizationName: string;
}

interface AdminCheckList {
  items: AdminCheck[];
  total: number;
}

export default function AdminChecksPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Track which check id is currently mutating (pause/resume/delete)
  const [actionId, setActionId] = useState<string | null>(null);

  // Delete confirm dialog
  const [deleteTarget, setDeleteTarget] = useState<AdminCheck | null>(null);

  // Error dialog
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<{ adminChecks: AdminCheckList }>(
    ADMIN_CHECKS,
    {
      variables: {
        status: statusFilter === "all" ? undefined : statusFilter,
        page: page - 1,
        pageSize: PAGE_SIZE,
      },
      fetchPolicy: "cache-and-network",
    }
  );

  const [pauseCheck] = useMutation(ADMIN_PAUSE_CHECK, {
    onCompleted: () => { setActionId(null); refetch(); },
    onError: (err) => { setActionId(null); setErrorMessage(err.message); },
  });

  const [resumeCheck] = useMutation(ADMIN_RESUME_CHECK, {
    onCompleted: () => { setActionId(null); refetch(); },
    onError: (err) => { setActionId(null); setErrorMessage(err.message); },
  });

  const [deleteCheck, { loading: deleting }] = useMutation(ADMIN_DELETE_CHECK, {
    onCompleted: () => {
      setDeleteTarget(null);
      refetch();
    },
    onError: (err) => {
      setDeleteTarget(null);
      setErrorMessage(err.message);
    },
  });

  const checks = data?.adminChecks?.items ?? [];
  const total = data?.adminChecks?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleStatusChange = (s: StatusFilter) => {
    setStatusFilter(s);
    setPage(1);
  };

  return (
    <div>
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Checks</h1>
      <p className="mt-1 text-sm text-muted-foreground">{total} total checks across all organizations</p>

      {/* Status filter */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {STATUS_OPTIONS.map((s) => (
          <Button
            key={s}
            variant={statusFilter === s ? "default" : "outline"}
            size="sm"
            aria-pressed={statusFilter === s}
            onClick={() => handleStatusChange(s)}
          >
            {s === "all" ? "All" : s}
          </Button>
        ))}
      </div>

      <div className="mt-4">
        {loading && !data && (
          <div className="space-y-2 py-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        )}
        {error && (
          <p className="text-sm text-destructive py-4">Error loading checks: {error.message}</p>
        )}
        {!loading && !error && checks.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center">No checks found.</p>
        )}
        {checks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>All checks</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {checks.map((check) => (
                  <div
                    key={check.id}
                    className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{check.name}</span>
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {check.type}
                        </span>
                        <StatusBadge status={check.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground truncate">
                        {check.organizationName} / {check.projectName}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {check.status === "PAUSED" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={actionId === check.id}
                          onClick={() => {
                            setActionId(check.id);
                            resumeCheck({ variables: { id: check.id } });
                          }}
                          title="Resume check"
                          aria-label="Resume check"
                        >
                          <Play className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={actionId === check.id}
                          onClick={() => {
                            setActionId(check.id);
                            pauseCheck({ variables: { id: check.id } });
                          }}
                          title="Pause check"
                          aria-label="Pause check"
                        >
                          <Pause className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        disabled={deleting}
                        onClick={() => setDeleteTarget(check)}
                        title="Delete check"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete check</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <strong>{deleteTarget?.name}</strong>? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (deleteTarget) deleteCheck({ variables: { id: deleteTarget.id } });
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Error dialog */}
      <Dialog open={!!errorMessage} onOpenChange={() => setErrorMessage(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{errorMessage}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setErrorMessage(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
