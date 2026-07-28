import { effectiveLimits, PLAN_LIMITS } from './plan-limits';

describe('effectiveLimits', () => {
  it('falls back to tier limits when no override', () => {
    expect(effectiveLimits('SOLO', null)).toEqual(PLAN_LIMITS.SOLO);
  });

  it('prefers the override JSON when present', () => {
    expect(
      effectiveLimits('SOLO', { maxChecks: 999, minIntervalSeconds: 10 }),
    ).toEqual({
      maxChecks: 999,
      minIntervalSeconds: 10,
    });
  });

  it('merges partial overrides over tier defaults', () => {
    expect(effectiveLimits('SOLO', { maxChecks: 7 })).toEqual({
      maxChecks: 7,
      minIntervalSeconds: PLAN_LIMITS.SOLO.minIntervalSeconds,
    });
  });

  it.each(['SIGNAL', 'FLEET'] as const)(
    'clamps a %s interval override below the paid minimum while retaining maxChecks',
    (plan) => {
      expect(
        effectiveLimits(plan, { maxChecks: 321, minIntervalSeconds: 1 }),
      ).toEqual({
        maxChecks: 321,
        minIntervalSeconds: 60,
      });
    },
  );

  it.each(['SIGNAL', 'FLEET'] as const)(
    'retains a %s interval override above the paid minimum',
    (plan) => {
      expect(effectiveLimits(plan, { minIntervalSeconds: 90 })).toEqual({
        maxChecks: PLAN_LIMITS[plan].maxChecks,
        minIntervalSeconds: 90,
      });
    },
  );

  it('does not clamp SOLO interval overrides', () => {
    expect(effectiveLimits('SOLO', { minIntervalSeconds: 1 })).toEqual({
      maxChecks: PLAN_LIMITS.SOLO.maxChecks,
      minIntervalSeconds: 1,
    });
  });
});
