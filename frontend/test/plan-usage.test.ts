import { describe, it, expect } from "vitest";
import { planUsageLabel } from "@/lib/plan-usage";

describe("planUsageLabel", () => {
  it("formats basic usage", () => {
    expect(planUsageLabel(3, 5)).toBe("3 / 5 checks");
  });

  it("formats zero used", () => {
    expect(planUsageLabel(0, 5)).toBe("0 / 5 checks");
  });

  it("handles used > max (over-limit)", () => {
    expect(planUsageLabel(6, 5)).toBe("6 / 5 checks");
  });

  it("handles zero max", () => {
    expect(planUsageLabel(0, 0)).toBe("0 / 0 checks");
  });

  it("formats larger numbers", () => {
    expect(planUsageLabel(42, 1000)).toBe("42 / 1000 checks");
  });
});
