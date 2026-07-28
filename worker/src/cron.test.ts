import { describe, it, expect } from "vitest";
import { nextCronFire, isCronOverdue } from "./cron.js";

describe("nextCronFire", () => {
  it("returns the next daily 03:00 fire after a given instant (UTC)", () => {
    const after = new Date("2026-06-22T04:00:00Z"); // just past 03:00
    const next = nextCronFire("0 3 * * *", "UTC", after);
    expect(next.toISOString()).toBe("2026-06-23T03:00:00.000Z");
  });
  it("honours timezone (03:00 America/Sao_Paulo = 06:00Z, no DST in June)", () => {
    const after = new Date("2026-06-22T07:00:00Z");
    const next = nextCronFire("0 3 * * *", "America/Sao_Paulo", after);
    expect(next.toISOString()).toBe("2026-06-23T06:00:00.000Z");
  });
});

describe("isCronOverdue", () => {
  const sched = "0 3 * * *", tz = "UTC", grace = 600; // 10 min grace
  it("not overdue when the next expected fire + grace is still in the future", () => {
    const last = new Date("2026-06-22T03:00:00Z");        // pinged at 03:00
    const now = new Date("2026-06-23T03:05:00Z");          // next fire 06-23 03:00, +grace = 03:10 > now
    expect(isCronOverdue(last, sched, tz, grace, now)).toBe(false);
  });
  it("overdue when the next expected fire + grace has passed", () => {
    const last = new Date("2026-06-22T03:00:00Z");
    const now = new Date("2026-06-23T03:20:00Z");          // past 03:10
    expect(isCronOverdue(last, sched, tz, grace, now)).toBe(true);
  });
});
