import { describe, it, expect } from "vitest";
import { buildEscalationStepsJson } from "@/lib/escalation";

describe("buildEscalationStepsJson", () => {
  it("builds a single-step JSON string", () => {
    expect(
      buildEscalationStepsJson([{ channelId: "c1", delaySeconds: 300 }])
    ).toBe('[{"channelId":"c1","delaySeconds":300}]');
  });

  it("preserves order for multiple steps", () => {
    const result = buildEscalationStepsJson([
      { channelId: "c1", delaySeconds: 300 },
      { channelId: "c2", delaySeconds: 600 },
      { channelId: "c3", delaySeconds: 900 },
    ]);
    expect(result).toBe(
      '[{"channelId":"c1","delaySeconds":300},{"channelId":"c2","delaySeconds":600},{"channelId":"c3","delaySeconds":900}]'
    );
  });

  it("returns an empty array JSON string for empty input", () => {
    expect(buildEscalationStepsJson([])).toBe("[]");
  });
});
