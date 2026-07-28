import { describe, it, expect } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("falls back to /dashboard for null", () => {
    expect(safeNext(null)).toBe("/dashboard");
  });

  it("falls back to /dashboard for undefined", () => {
    expect(safeNext(undefined)).toBe("/dashboard");
  });

  it("falls back to /dashboard for an empty string", () => {
    expect(safeNext("")).toBe("/dashboard");
  });

  it("falls back to /dashboard for an absolute off-site URL", () => {
    expect(safeNext("https://evil.com")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a protocol-relative URL", () => {
    expect(safeNext("//evil.com")).toBe("/dashboard");
  });

  it("falls back to /dashboard for a backslash-prefixed path", () => {
    expect(safeNext("/\\evil.com")).toBe("/dashboard");
  });

  it("preserves a valid same-origin invite path", () => {
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
  });
});
