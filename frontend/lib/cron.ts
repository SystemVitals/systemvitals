import { parseExpression } from "cron-parser";

export function isValidCron(expr: string): boolean {
  try {
    parseExpression(expr);
    return true;
  } catch {
    return false;
  }
}

export function nextCronFires(expr: string, tz: string, after: Date, count: number): Date[] {
  const it = parseExpression(expr, { currentDate: after, tz });
  return Array.from({ length: count }, () => it.next().toDate());
}
