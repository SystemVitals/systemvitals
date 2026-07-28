import { describe, it, expect } from "vitest";
import { nextCronFires, isValidCron } from "./cron";
describe("frontend cron", () => {
  it("isValidCron", () => { expect(isValidCron("0 3 * * *")).toBe(true); expect(isValidCron("bad")).toBe(false); });
  it("nextCronFires returns N upcoming fires", () => {
    const fires = nextCronFires("0 3 * * *", "UTC", new Date("2026-06-22T04:00:00Z"), 3);
    expect(fires).toHaveLength(3);
    expect(fires[0].toISOString()).toBe("2026-06-23T03:00:00.000Z");
  });
});
