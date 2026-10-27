import { describe, it, expect } from "vitest";
import { formatDuration, formatElapsed, formatRelativeTime, formatSpan } from "./format";
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

describe("formatSpan", () => {
  it("keeps exact values in up to two units", () => {
    expect(formatSpan(45)).toBe("45 sec");
    expect(formatSpan(60)).toBe("1 min");
    expect(formatSpan(90)).toBe("1 min 30 sec");
    expect(formatSpan(300)).toBe("5 min");
    expect(formatSpan(5400)).toBe("1 hr 30 min");
    expect(formatSpan(86_400)).toBe("1 day");
    expect(formatSpan(2 * 86_400)).toBe("2 days");
  });

  it("treats empty or invalid spans as zero", () => {
    expect(formatSpan(0)).toBe("0 sec");
    expect(formatSpan(Number.NaN)).toBe("0 sec");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-26T12:00:00Z");

  it("collapses moments under a minute", () => {
    expect(formatRelativeTime("2026-10-26T11:59:30Z", now)).toBe("just now");
  });

  it("describes the past with the largest whole unit", () => {
    expect(formatRelativeTime("2026-10-26T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelativeTime("2026-10-26T09:00:00Z", now)).toBe("3 hours ago");
    expect(formatRelativeTime("2026-10-25T12:00:00Z", now)).toBe("yesterday");
  });

  it("describes the future", () => {
    expect(formatRelativeTime("2026-11-25T12:00:00Z", now)).toBe("in 30 days");
    expect(formatRelativeTime("2026-10-29T12:00:00Z", now)).toBe("in 3 days");
    expect(formatRelativeTime("2027-01-26T12:00:00Z", now)).toBe("in 3 months");
  });
});
