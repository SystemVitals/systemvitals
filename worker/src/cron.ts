// cron-parser@4 is CommonJS and attaches `parseExpression` as a static property,
// which Node's ESM loader cannot see as a named export. Importing the default
// and reaching through it is the only form that survives a native ESM load.
import cronParser from "cron-parser";

const { parseExpression } = cronParser;

/** Next scheduled fire strictly after `after`, evaluated in `tz`. */
export function nextCronFire(expr: string, tz: string, after: Date): Date {
  const it = parseExpression(expr, { currentDate: after, tz });
  return it.next().toDate();
}

/** A cron check is overdue when the next expected fire after the last ping, plus grace, is in the past. */
export function isCronOverdue(
  lastEventAt: Date,
  schedule: string,
  tz: string,
  graceSeconds: number,
  now: Date,
): boolean {
  const expected = nextCronFire(schedule, tz, lastEventAt);
  return expected.getTime() + graceSeconds * 1000 < now.getTime();
}
