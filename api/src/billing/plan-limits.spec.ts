import {
  PAID_MIN_INTERVAL_SECONDS,
  planLimitsFor,
  PLAN_LIMITS,
} from './plan-limits';

describe('plan-limits', () => {
  it('PLAN_LIMITS has correct SOLO values', () => {
    expect(PLAN_LIMITS.SOLO.maxChecks).toBe(5);
    expect(PLAN_LIMITS.SOLO.minIntervalSeconds).toBe(300);
  });

  it('PLAN_LIMITS has correct SIGNAL values', () => {
    expect(PLAN_LIMITS.SIGNAL.maxChecks).toBe(100);
    expect(PLAN_LIMITS.SIGNAL.minIntervalSeconds).toBe(
      PAID_MIN_INTERVAL_SECONDS,
    );
  });

  it('PLAN_LIMITS has correct FLEET values', () => {
    expect(PLAN_LIMITS.FLEET.maxChecks).toBe(1000);
    expect(PLAN_LIMITS.FLEET.minIntervalSeconds).toBe(
      PAID_MIN_INTERVAL_SECONDS,
    );
  });

  it('planLimitsFor("SOLO").maxChecks === 5', () => {
    expect(planLimitsFor('SOLO').maxChecks).toBe(5);
  });

  it('exports a one-minute paid minimum interval', () => {
    expect(PAID_MIN_INTERVAL_SECONDS).toBe(60);
    expect(planLimitsFor('SIGNAL').minIntervalSeconds).toBe(60);
    expect(planLimitsFor('FLEET').minIntervalSeconds).toBe(60);
  });

  it('planLimitsFor("FLEET").maxChecks === 1000', () => {
    expect(planLimitsFor('FLEET').maxChecks).toBe(1000);
  });

  it('planLimitsFor("bogus") returns SOLO limits', () => {
    const limits = planLimitsFor('bogus');
    expect(limits.maxChecks).toBe(PLAN_LIMITS.SOLO.maxChecks);
    expect(limits.minIntervalSeconds).toBe(PLAN_LIMITS.SOLO.minIntervalSeconds);
  });

  it('planLimitsFor("") returns SOLO limits', () => {
    const limits = planLimitsFor('');
    expect(limits.maxChecks).toBe(PLAN_LIMITS.SOLO.maxChecks);
    expect(limits.minIntervalSeconds).toBe(PLAN_LIMITS.SOLO.minIntervalSeconds);
  });

  it('the retired tier names are no longer recognized', () => {
    expect(planLimitsFor('FREE')).toEqual(PLAN_LIMITS.SOLO);
    expect(planLimitsFor('PRO')).toEqual(PLAN_LIMITS.SOLO);
    expect(planLimitsFor('TEAM')).toEqual(PLAN_LIMITS.SOLO);
  });
});
