export const PLAN_INTERVAL_FLOOR: Record<string, number> = { SOLO: 300, SIGNAL: 60, FLEET: 60 };
export function planIntervalFloor(plan: string): number {
  return PLAN_INTERVAL_FLOOR[plan] ?? PLAN_INTERVAL_FLOOR.SOLO;
}
