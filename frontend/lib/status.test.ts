import { describe, it, expect } from "vitest";
import { overallStatus } from "./status";
describe("overallStatus", () => {
  it("operational when all UP", () => expect(overallStatus([{status:"UP"},{status:"UP"}])).toBe("operational"));
  it("down when any DOWN", () => expect(overallStatus([{status:"UP"},{status:"DOWN"}])).toBe("down"));
  it("degraded when GRACE and no DOWN", () => expect(overallStatus([{status:"UP"},{status:"GRACE"}])).toBe("degraded"));
  it("down takes precedence over grace", () => expect(overallStatus([{status:"DOWN"},{status:"GRACE"}])).toBe("down"));
  it("operational on empty", () => expect(overallStatus([])).toBe("operational"));
});
