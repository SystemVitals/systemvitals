"use client";
import { useRef, useState } from "react";
import { useQuery } from "@apollo/client/react";
import { useAuth } from "@/lib/auth-context";
import { MY_SUBSCRIPTION } from "@/lib/queries";
import { planUsageLabel } from "@/lib/plan-usage";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CreditCard, Zap, Users, CheckCircle } from "lucide-react";

type Interval = "month" | "year";

// Plan limits matching API plan-limits.ts, plus display prices matching
// api/src/billing/plan-pricing.ts (yearly = 50% off 12× monthly).
const PLAN_LIMITS: Record<
  string,
  {
    minIntervalSeconds: number;
    label: string;
    priceMonthly: string;
    yearlyPerMonth: string;
    priceYearly: string;
  }
> = {
  SOLO: { minIntervalSeconds: 300, label: "Solo", priceMonthly: "$0", yearlyPerMonth: "$0", priceYearly: "$0" },
  SIGNAL: { minIntervalSeconds: 60, label: "Signal", priceMonthly: "$5", yearlyPerMonth: "$2.50", priceYearly: "$30" },
  FLEET: { minIntervalSeconds: 60, label: "Fleet", priceMonthly: "$20", yearlyPerMonth: "$10", priceYearly: "$120" },
};

interface SubscriptionData {
  mySubscription: {
    plan: string;
    status: string;
    checkCount: number;
    maxChecks: number;
    organizationCount: number;
  };
}

const API = process.env.NEXT_PUBLIC_API_URL;

export default function BillingPage() {
  const { user } = useAuth();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [queryErrorDismissed, setQueryErrorDismissed] = useState(false);
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [interval, setInterval] = useState<Interval>("month");
  const actionInFlight = useRef(false);

  const {
    data: subData,
    loading: subLoading,
    error: subError,
  } = useQuery<SubscriptionData>(MY_SUBSCRIPTION);

  if (!user) return null;

  const subscription =
    !subLoading && !subError ? subData?.mySubscription : undefined;
  const currentPlan = subscription?.plan;
  const subStatus = subscription?.status;
  const planInfo = currentPlan ? PLAN_LIMITS[currentPlan] : undefined;
  const checkCount = subscription?.checkCount ?? 0;
  const maxChecks = subscription?.maxChecks ?? 0;
  const organizationCount = subscription?.organizationCount ?? 0;
  const usageLabel = planUsageLabel(checkCount, maxChecks);
  const actionsDisabled = !subscription || loadingAction !== null;
  const displayedError =
    errorMessage ?? (queryErrorDismissed ? null : subError?.message);

  async function callBillingEndpoint(path: "checkout" | "portal", plan?: "SIGNAL" | "FLEET") {
    if (!subscription || actionInFlight.current) return;

    const token = localStorage.getItem("sv_token");
    if (!token) {
      setErrorMessage("You are not logged in. Please sign in again.");
      return;
    }

    actionInFlight.current = true;
    const key = plan ?? "portal";
    setLoadingAction(key);
    setErrorMessage(null);

    try {
      const body =
        path === "checkout" && plan
          ? JSON.stringify({ plan, interval })
          : JSON.stringify({});
      const res = await fetch(`${API}/billing/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body,
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ message: "Request failed" })) as { message?: string };
        throw new Error(errBody.message ?? `HTTP ${res.status}`);
      }

      const data = await res.json() as { url: string };
      window.location.href = data.url;
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "An unexpected error occurred.");
    } finally {
      actionInFlight.current = false;
      setLoadingAction(null);
    }
  }

  return (
    <div className="px-4 py-6 sm:px-6 space-y-6">
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your account plan and subscription.
        </p>
      </div>

      {/* Current Plan Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CreditCard className="h-4 w-4" />
            Current Plan
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {subLoading ? (
            <p className="text-sm text-muted-foreground">Loading plan info…</p>
          ) : subscription && planInfo ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">{planInfo.label}</span>
                <span
                  className={`font-mono text-xs px-2 py-0.5 rounded-full font-medium ${
                    subStatus === "active"
                      ? "bg-success/15 text-success"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {subStatus}
                </span>
              </div>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-medium text-foreground">Check usage:</span>{" "}
                  {usageLabel} across {organizationCount}{" "}
                  {organizationCount === 1 ? "organization" : "organizations"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Min interval:</span>{" "}
                  <span className="font-mono">{planInfo.minIntervalSeconds}s</span> between checks
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Plan information is unavailable.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Billing interval toggle */}
      <div className="flex items-center gap-3">
        <div
          role="group"
          aria-label="Billing interval"
          className="inline-flex items-center rounded-full border p-1 text-sm"
        >
          <button
            type="button"
            aria-pressed={interval === "month"}
            disabled={actionsDisabled}
            onClick={() => setInterval("month")}
            className={cn(
              "rounded-full px-4 py-1.5 font-medium transition-colors",
              interval === "month"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Monthly
          </button>
          <button
            type="button"
            aria-pressed={interval === "year"}
            disabled={actionsDisabled}
            onClick={() => setInterval("year")}
            className={cn(
              "rounded-full px-4 py-1.5 font-medium transition-colors flex items-center gap-2",
              interval === "year"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Yearly
            <Badge variant="secondary" className="text-[10px]">
              Save 50%
            </Badge>
          </button>
        </div>
      </div>

      {/* Plan options */}
      <div className="grid gap-4 md:grid-cols-3">
        {/* SOLO */}
        <Card className={currentPlan === "SOLO" ? "ring-2 ring-primary" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {currentPlan === "SOLO" && <CheckCircle className="h-4 w-4 text-primary" />}
              Solo
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>Up to 5 checks</li>
              <li>5 min min interval</li>
            </ul>
            {subscription && currentPlan === "SOLO" ? (
              <Button variant="outline" size="sm" disabled className="w-full">
                Current plan
              </Button>
            ) : null}
          </CardContent>
        </Card>

        {/* SIGNAL */}
        <Card className={currentPlan === "SIGNAL" ? "ring-2 ring-primary" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {currentPlan === "SIGNAL" && <CheckCircle className="h-4 w-4 text-primary" />}
              <Zap className="h-4 w-4" />
              Signal
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-semibold">
                  {interval === "year" ? PLAN_LIMITS.SIGNAL.yearlyPerMonth : PLAN_LIMITS.SIGNAL.priceMonthly}
                </span>
                <span className="text-xs text-muted-foreground">/mo</span>
              </div>
              <p className="text-xs text-muted-foreground h-4">
                {interval === "year" ? `${PLAN_LIMITS.SIGNAL.priceYearly} billed yearly` : ""}
              </p>
            </div>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>Up to 100 checks</li>
              <li>60 sec min interval</li>
            </ul>
            {subscription && currentPlan === "SIGNAL" ? (
              <Button variant="outline" size="sm" disabled className="w-full">
                Current plan
              </Button>
            ) : subscription ? (
              <Button
                size="sm"
                className="w-full"
                disabled={loadingAction !== null}
                onClick={() => callBillingEndpoint("checkout", "SIGNAL")}
              >
                {loadingAction === "SIGNAL" ? "Redirecting…" : "Upgrade to Signal"}
              </Button>
            ) : null}
          </CardContent>
        </Card>

        {/* FLEET */}
        <Card className={currentPlan === "FLEET" ? "ring-2 ring-primary" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              {currentPlan === "FLEET" && <CheckCircle className="h-4 w-4 text-primary" />}
              <Users className="h-4 w-4" />
              Fleet
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-semibold">
                  {interval === "year" ? PLAN_LIMITS.FLEET.yearlyPerMonth : PLAN_LIMITS.FLEET.priceMonthly}
                </span>
                <span className="text-xs text-muted-foreground">/mo</span>
              </div>
              <p className="text-xs text-muted-foreground h-4">
                {interval === "year" ? `${PLAN_LIMITS.FLEET.priceYearly} billed yearly` : ""}
              </p>
            </div>
            <ul className="text-sm text-muted-foreground space-y-1">
              <li>Up to 1,000 checks</li>
              <li>60 sec min interval</li>
            </ul>
            {subscription && currentPlan === "FLEET" ? (
              <Button variant="outline" size="sm" disabled className="w-full">
                Current plan
              </Button>
            ) : subscription ? (
              <Button
                size="sm"
                className="w-full"
                disabled={loadingAction !== null}
                onClick={() => callBillingEndpoint("checkout", "FLEET")}
              >
                {loadingAction === "FLEET" ? "Redirecting…" : "Upgrade to Fleet"}
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {/* Manage billing */}
      {subscription && currentPlan !== "SOLO" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Manage billing</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Update your payment method, download invoices, or cancel your subscription.
            </p>
            <Button
              variant="outline"
              disabled={loadingAction !== null}
              onClick={() => callBillingEndpoint("portal")}
            >
              {loadingAction === "portal" ? "Redirecting…" : "Open billing portal"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Error dialog */}
      <Dialog
        open={!!displayedError}
        onOpenChange={(open) => {
          if (!open) {
            setErrorMessage(null);
            setQueryErrorDismissed(true);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Error</DialogTitle>
            <DialogDescription>{displayedError}</DialogDescription>
          </DialogHeader>
          <Button
            autoFocus
            onClick={() => {
              setErrorMessage(null);
              setQueryErrorDismissed(true);
            }}
          >
            Dismiss
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
