import { describe, it, expect } from "vitest";
import {
  buildChannelConfig,
  type CreatableChannelType,
} from "@/lib/channel-config";

const creatableChannelTypes = {
  EMAIL: true,
  SLACK: true,
  WEBHOOK: true,
} satisfies Record<CreatableChannelType, true>;

describe("buildChannelConfig", () => {
  it("builds EMAIL config", () => {
    expect(buildChannelConfig("EMAIL", { email: "e" })).toBe('{"email":"e"}');
  });

  it("builds SLACK config", () => {
    expect(buildChannelConfig("SLACK", { webhookUrl: "u" })).toBe('{"webhookUrl":"u"}');
  });

  it("builds WEBHOOK config", () => {
    expect(buildChannelConfig("WEBHOOK", { url: "u" })).toBe('{"url":"u"}');
  });

  it("exposes only generic channel types that can be created", () => {
    expect(Object.keys(creatableChannelTypes)).toEqual([
      "EMAIL",
      "SLACK",
      "WEBHOOK",
    ]);
  });
});
