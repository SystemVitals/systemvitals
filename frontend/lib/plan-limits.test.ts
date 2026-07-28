import { describe, it, expect } from "vitest";
import { planIntervalFloor, PLAN_INTERVAL_FLOOR } from "./plan-limits";

describe("planIntervalFloor", () => {
  it("SOLO floors at 300 seconds", () => {
    expect(planIntervalFloor("SOLO")).toBe(300);
  });

  it("SIGNAL and FLEET floor at 60 seconds", () => {
    expect(planIntervalFloor("SIGNAL")).toBe(60);
    expect(planIntervalFloor("FLEET")).toBe(60);
  });

  it("falls back to the SOLO floor for unknown plans", () => {
    expect(planIntervalFloor("bogus")).toBe(PLAN_INTERVAL_FLOOR.SOLO);
    expect(planIntervalFloor("")).toBe(PLAN_INTERVAL_FLOOR.SOLO);
  });

  it("no longer recognizes the retired tier names", () => {
    expect(planIntervalFloor("PRO")).toBe(PLAN_INTERVAL_FLOOR.SOLO);
    expect(planIntervalFloor("TEAM")).toBe(PLAN_INTERVAL_FLOOR.SOLO);
  });
});
