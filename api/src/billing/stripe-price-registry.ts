import { Injectable } from '@nestjs/common';
import type { PlanTier } from './plan-limits';
import { BillingInterval, PaidPlan, PLAN_PRICES } from './plan-pricing';

/**
 * In-memory lookup_key → Stripe price id map, populated by
 * StripePlanBootstrapService at boot. STRIPE_PRICE_SIGNAL / STRIPE_PRICE_FLEET
 * env vars remain supported as *monthly* overrides and take precedence.
 */
@Injectable()
export class StripePriceRegistry {
  private readonly byLookupKey = new Map<string, string>();

  // Env overrides read lazily so tests can set env vars per-case.
  private envOverride(plan: PaidPlan): string {
    return (
      (plan === 'SIGNAL'
        ? process.env.STRIPE_PRICE_SIGNAL
        : process.env.STRIPE_PRICE_FLEET) ?? ''
    );
  }

  register(lookupKey: string, priceId: string): void {
    this.byLookupKey.set(lookupKey, priceId);
  }

  priceIdFor(plan: PaidPlan, interval: BillingInterval): string {
    if (interval === 'month') {
      const override = this.envOverride(plan);
      if (override) return override;
    }
    const entry = PLAN_PRICES.find(
      (p) => p.plan === plan && p.interval === interval,
    );
    if (!entry) return '';
    return this.byLookupKey.get(entry.lookupKey) ?? '';
  }

  planForPriceId(priceId: string): PlanTier | null {
    if (!priceId) return null;
    for (const plan of ['SIGNAL', 'FLEET'] as const) {
      if (this.envOverride(plan) === priceId) return plan;
    }
    for (const entry of PLAN_PRICES) {
      if (this.byLookupKey.get(entry.lookupKey) === priceId) return entry.plan;
    }
    return null;
  }
}
