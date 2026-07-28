import { describe, it, expect } from "vitest";
import { formatDuration, formatElapsed } from "./format";
describe("formatDuration", () => {
  it("formats sub-minute as seconds", () => { expect(formatDuration(1)).toBe("1 sec"); expect(formatDuration(45)).toBe("45 sec"); });
  it("formats minutes", () => { expect(formatDuration(60)).toBe("1 min"); expect(formatDuration(300)).toBe("5 min"); });
  it("formats hours", () => { expect(formatDuration(3600)).toBe("1 hr"); expect(formatDuration(86400)).toBe("24 hr"); });
});

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatElapsed", () => {
  it("collapses anything under a second", () => {
    expect(formatElapsed(0)).toBe("<1s");
    expect(formatElapsed(999)).toBe("<1s");
  });

  it("formats whole seconds", () => {
    expect(formatElapsed(1 * SEC)).toBe("1s");
    expect(formatElapsed(7 * SEC)).toBe("7s");
    expect(formatElapsed(59 * SEC)).toBe("59s");
  });

  it("pairs minutes with seconds", () => {
    expect(formatElapsed(45 * MIN + 12 * SEC)).toBe("45m 12s");
  });

  it("pairs hours with minutes, dropping the seconds as the third unit", () => {
    expect(formatElapsed(1 * HOUR + 8 * MIN + 49 * SEC)).toBe("1h 8m");
  });

  it("pairs days with hours", () => {
    expect(formatElapsed(2 * DAY + 3 * HOUR + 30 * MIN)).toBe("2d 3h");
  });

  it("omits a zero-valued smaller unit", () => {
    expect(formatElapsed(2 * HOUR)).toBe("2h");
    expect(formatElapsed(1 * MIN)).toBe("1m");
    expect(formatElapsed(3 * DAY)).toBe("3d");
  });

  it("truncates rather than rounds, so a label never overstates the gap", () => {
    expect(formatElapsed(59 * SEC + 999)).toBe("59s");
    expect(formatElapsed(1 * HOUR + 59 * MIN + 59 * SEC)).toBe("1h 59m");
  });

  it("treats negative input as no elapsed time", () => {
    expect(formatElapsed(-5 * SEC)).toBe("<1s");
  });
});
