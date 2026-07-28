"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@apollo/client/react";
import Link from "next/link";
import { CreditCard, ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ADMIN_SUBSCRIPTIONS } from "@/lib/admin-queries";
import { Skeleton } from "@/components/ui/skeleton";
import { planBadgeClass } from "@/lib/admin-types";
import { ADMIN_SET_USER_PLAN } from "@/lib/admin-queries";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

const PAGE_SIZE = 25;

export function positiveIntegerError(value: string, label: string) {
  if (value === "") return null;
  return /^[1-9]\d*$/.test(value)
    ? null
    : `${label} must be a positive integer.`;
}

interface AdminSubscriptionItem {
  id: string;
  userId: string;
  userEmail: string;
  plan: string;
  status: string;
  manualOverride: boolean;
  limitsJson: string | null;
}

interface AdminSubscriptionsData {
  adminSubscriptions: {
    items: AdminSubscriptionItem[];
    total: number;
  };
}

function statusBadgeClass(status: string) {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "bg-success/15 text-success";
    case "CANCELED":
    case "CANCELLED":
      return "bg-destructive/15 text-destructive";
    case "PAST_DUE":
      return "bg-warning/15 text-warning";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export default function AdminSubscriptionsPage() {
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<AdminSubscriptionItem | null>(null);
  const [plan, setPlan] = useState("");
  const [maxChecks, setMaxChecks] = useState("");
  const [minInterval, setMinInterval] = useState("");
  const [manualOverride, setManualOverride] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, loading, error, refetch } = useQuery<AdminSubscriptionsData>(
    ADMIN_SUBSCRIPTIONS,
    {
      variables: { page: page - 1, pageSize: PAGE_SIZE },
      fetchPolicy: "cache-and-network",
    },
  );
  const [setUserPlan, { loading: saving }] = useMutation(ADMIN_SET_USER_PLAN);

  const items = data?.adminSubscriptions.items ?? [];
  const total = data?.adminSubscriptions.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const maxChecksError = positiveIntegerError(maxChecks, "Max checks");
  const minIntervalError = positiveIntegerError(minInterval, "Min interval");
  const hasLimitError = maxChecksError !== null || minIntervalError !== null;

  const openEditor = (subscription: AdminSubscriptionItem) => {
    const limits = subscription.limitsJson
      ? (JSON.parse(subscription.limitsJson) as {
          maxChecks?: number;
          minIntervalSeconds?: number;
        })
      : {};
    setEditing(subscription);
    setPlan(subscription.plan);
    setMaxChecks(limits.maxChecks?.toString() ?? "");
    setMinInterval(limits.minIntervalSeconds?.toString() ?? "");
    setManualOverride(subscription.manualOverride);
    setErrorMessage(null);
  };

  const savePlan = async () => {
    if (!editing || !plan || hasLimitError) return;
    const limits: Record<string, number> = {};
    if (maxChecks) limits.maxChecks = Number(maxChecks);
    if (minInterval) limits.minIntervalSeconds = Number(minInterval);
    try {
      await setUserPlan({
        variables: {
          userId: editing.userId,
          plan,
          limitsJson: Object.keys(limits).length
            ? JSON.stringify(limits)
            : null,
          manualOverride,
        },
      });
      setEditing(null);
      await refetch();
    } catch (mutationError) {
      setErrorMessage(
        mutationError instanceof Error
          ? mutationError.message
          : "Failed to update account plan.",
      );
    }
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <CreditCard className="h-6 w-6 text-primary" />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Subscriptions
        </h1>
        {total > 0 && (
          <span className="ml-2 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {total}
          </span>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All subscriptions</CardTitle>
        </CardHeader>
        {loading && !data ? (
          <CardContent>
            <div className="space-y-2 py-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </CardContent>
        ) : error ? (
          <CardContent>
            <p className="text-sm text-destructive py-4">
              Error: {error.message}
            </p>
          </CardContent>
        ) : items.length === 0 ? (
          <CardContent>
            <p className="text-sm text-muted-foreground py-8 text-center">
              No subscriptions found.
            </p>
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {/* Header row */}
              <div className="grid grid-cols-[1fr_100px_100px_auto] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                <span>Account</span>
                <span>Plan</span>
                <span>Status</span>
                <span>Override</span>
              </div>
              {items.map((sub) => (
                <div
                  key={sub.id}
                  className="grid grid-cols-[1fr_100px_100px_auto] gap-3 items-center px-4 py-3 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0">
                    <Link
                      href={`/admin/users/${sub.userId}`}
                      className="text-sm font-medium hover:underline text-foreground truncate block"
                    >
                      {sub.userEmail}
                    </Link>
                    <p className="text-xs text-muted-foreground truncate">
                      {sub.userId}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide w-fit",
                      planBadgeClass(sub.plan),
                    )}
                  >
                    {sub.plan}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide w-fit",
                      statusBadgeClass(sub.status),
                    )}
                  >
                    {sub.status}
                  </span>
                  <div className="flex items-center gap-2 justify-end">
                    {sub.manualOverride && (
                      <span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-foreground">
                        Manual override
                      </span>
                    )}
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => openEditor(sub)}
                    >
                      Manage
                    </Button>
                  </div>
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

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setErrorMessage(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage account subscription</DialogTitle>
            <DialogDescription>
              Update the plan and optional custom limits for{" "}
              {editing?.userEmail}.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="account-plan">Plan</Label>
              <Select
                value={plan}
                onValueChange={(value) => value && setPlan(value)}
              >
                <SelectTrigger id="account-plan">
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SOLO">Solo</SelectItem>
                  <SelectItem value="SIGNAL">Signal</SelectItem>
                  <SelectItem value="FLEET">Fleet</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label htmlFor="max-checks">Max checks</Label>
                <Input
                  id="max-checks"
                  type="number"
                  min={1}
                  step={1}
                  value={maxChecks}
                  onChange={(event) => setMaxChecks(event.target.value)}
                  placeholder="Plan default"
                  aria-invalid={maxChecksError !== null}
                />
                {maxChecksError && (
                  <p className="text-xs text-destructive">{maxChecksError}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="min-interval">Min interval (seconds)</Label>
                <Input
                  id="min-interval"
                  type="number"
                  min={1}
                  step={1}
                  value={minInterval}
                  onChange={(event) => setMinInterval(event.target.value)}
                  placeholder="Plan default"
                  aria-invalid={minIntervalError !== null}
                />
                {minIntervalError && (
                  <p className="text-xs text-destructive">{minIntervalError}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="manual-override"
                checked={manualOverride}
                onCheckedChange={(checked) =>
                  setManualOverride(checked === true)
                }
              />
              <Label htmlFor="manual-override">Manual override</Label>
            </div>
          </div>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setErrorMessage(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={savePlan}
              disabled={saving || !plan || hasLimitError}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
