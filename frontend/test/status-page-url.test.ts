import { describe, it, expect } from "vitest";
import { statusPagePublicPath } from "@/lib/status-page";

describe("statusPagePublicPath", () => {
  it("returns /status/<slug> for a normal slug", () => {
    expect(statusPagePublicPath("acme")).toBe("/status/acme");
  });

  it("encodes slugs that require URI encoding", () => {
    expect(statusPagePublicPath("my status/page")).toBe(
      "/status/my%20status%2Fpage"
    );
  });
});
