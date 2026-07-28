export type PlanTier = 'SOLO' | 'SIGNAL' | 'FLEET';

export interface PlanLimits {
  maxChecks: number;
  minIntervalSeconds: number;
}

export const PAID_MIN_INTERVAL_SECONDS = 60;

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  SOLO: { maxChecks: 5, minIntervalSeconds: 300 },
  SIGNAL: {
    maxChecks: 100,
    minIntervalSeconds: PAID_MIN_INTERVAL_SECONDS,
  },
  FLEET: {
    maxChecks: 1000,
    minIntervalSeconds: PAID_MIN_INTERVAL_SECONDS,
  },
};

export function planLimitsFor(plan: string): PlanLimits {
  if (plan === 'SOLO' || plan === 'SIGNAL' || plan === 'FLEET') {
    return PLAN_LIMITS[plan];
  }
  return PLAN_LIMITS.SOLO;
}

export function effectiveLimits(plan: string, limitsJson: unknown): PlanLimits {
  const base = planLimitsFor(plan);
  if (limitsJson && typeof limitsJson === 'object') {
    const o = limitsJson as Partial<PlanLimits>;
    const overriddenMinInterval =
      typeof o.minIntervalSeconds === 'number'
        ? o.minIntervalSeconds
        : base.minIntervalSeconds;
    return {
      maxChecks: typeof o.maxChecks === 'number' ? o.maxChecks : base.maxChecks,
      minIntervalSeconds:
        plan === 'SIGNAL' || plan === 'FLEET'
          ? Math.max(overriddenMinInterval, PAID_MIN_INTERVAL_SECONDS)
          : overriddenMinInterval,
    };
  }
  return base;
}
