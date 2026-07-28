// Stripe plan catalog — the source of truth for what the bootstrap creates.
// Display prices in frontend/lib/site.ts mirror these amounts; keep in sync.

export type BillingInterval = 'month' | 'year';
export type PaidPlan = 'SIGNAL' | 'FLEET';

export interface PlanPrice {
  plan: PaidPlan;
  interval: BillingInterval;
  lookupKey: string;
  /** In the smallest currency unit (USD cents). */
  unitAmount: number;
}

export const PLAN_PRODUCT_NAMES: Record<PaidPlan, string> = {
  SIGNAL: 'SystemVitals Signal',
  FLEET: 'SystemVitals Fleet',
};

// Yearly = 50% off 12× monthly.
export const PLAN_PRICES: PlanPrice[] = [
  {
    plan: 'SIGNAL',
    interval: 'month',
    lookupKey: 'systemvitals_signal_month',
    unitAmount: 500,
  },
  {
    plan: 'SIGNAL',
    interval: 'year',
    lookupKey: 'systemvitals_signal_year',
    unitAmount: 3000,
  },
  {
    plan: 'FLEET',
    interval: 'month',
    lookupKey: 'systemvitals_fleet_month',
    unitAmount: 2000,
  },
  {
    plan: 'FLEET',
    interval: 'year',
    lookupKey: 'systemvitals_fleet_year',
    unitAmount: 12000,
  },
];

export const PLAN_CURRENCY = 'usd';
