import { parseExpression } from 'cron-parser';

export function nextCronFire(expr: string, tz: string, after: Date): Date {
  return parseExpression(expr, { currentDate: after, tz }).next().toDate();
}

export function isValidCron(expr: string): boolean {
  try {
    parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Smallest gap (seconds) between consecutive fires across the next 10 fires. */
export function minCronGapSeconds(expr: string, tz: string): number {
  const it = parseExpression(expr, { currentDate: new Date(0), tz });
  let prev = it.next().toDate().getTime();
  let min = Infinity;
  for (let i = 0; i < 10; i++) {
    const next = it.next().toDate().getTime();
    min = Math.min(min, (next - prev) / 1000);
    prev = next;
  }
  return min;
}
