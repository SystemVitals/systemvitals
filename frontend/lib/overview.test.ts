import { describe, expect, it } from "vitest";
import {
  brokenDuration,
  brokenReason,
  formatBrokenSeconds,
  formatUptime,
  isLongestOutageOngoing,
  parseRangeParam,
  percentOf,
  rangeOfOverview,
} from "./overview";

const now = new Date("2026-11-04T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();
const MIN = 60_000;

describe("parseRangeParam", () => {
  it("maps URL params to range keys and defaults to MONTH", () => {
    expect(parseRangeParam("7d")).toBe("WEEK");
    expect(parseRangeParam(null)).toBe("MONTH");
    expect(parseRangeParam("bogus")).toBe("MONTH");
  });
});

describe("rangeOfOverview", () => {
  it("names the range a loaded overview covers", () => {
    const rangeEnd = now.toISOString();
    expect(rangeOfOverview({ rangeStart: ago(24 * 60 * MIN), rangeEnd })?.key).toBe("DAY");
    expect(rangeOfOverview({ rangeStart: ago(90 * 24 * 60 * MIN), rangeEnd })?.key).toBe(
      "QUARTER",
    );
    expect(rangeOfOverview({ rangeStart: ago(MIN), rangeEnd })).toBeUndefined();
  });
});

describe("brokenDuration", () => {
  it("describes DOWN, LATE and overdue entries", () => {
    expect(
      brokenDuration({ state: "DOWN", since: ago(192 * MIN), downAt: null }, now),
    ).toEqual({ value: "3h 12m", caption: "down for" });
    expect(
      brokenDuration({ state: "LATE", since: ago(6 * MIN), downAt: ahead(9 * MIN) }, now),
    ).toEqual({ value: "6m", caption: "late by" });
    expect(
      brokenDuration({ state: "LATE", since: ago(8 * MIN), downAt: ago(2 * MIN) }, now),
    ).toEqual({ value: "2m", caption: "overdue by" });
  });
});

describe("brokenReason", () => {
  it("explains why a check is broken", () => {
    const http = { type: "HTTP", lastEventAt: null };
    expect(
      brokenReason({ state: "DOWN", reason: "HTTP 503", downAt: null, check: http }, now),
    ).toBe("HTTP 503");
    expect(
      brokenReason({ state: "DOWN", reason: null, downAt: null, check: http }, now),
    ).toBe("probe failing");
    expect(
      brokenReason(
        { state: "LATE", reason: null, downAt: ahead(9 * MIN), check: { type: "HEARTBEAT", lastEventAt: null } },
        now,
      ),
    ).toBe("goes DOWN in 9m");
    expect(
      brokenReason(
        { state: "LATE", reason: null, downAt: ago(MIN), check: { type: "HEARTBEAT", lastEventAt: null } },
        now,
      ),
    ).toBe("should be DOWN; is the worker running?");
  });

  it("describes DOWN heartbeats by their last ping", () => {
    expect(
      brokenReason(
        { state: "DOWN", reason: null, downAt: null, check: { type: "HEARTBEAT", lastEventAt: null } },
        now,
      ),
    ).toBe("never pinged");
    expect(
      brokenReason(
        { state: "DOWN", reason: null, downAt: null, check: { type: "HEARTBEAT", lastEventAt: ago(3 * 3600_000) } },
        now,
      ),
    ).toMatch(/^no ping since /);
  });
});

describe("formatters", () => {
  it("formats uptime and broken seconds", () => {
    expect(formatUptime(99.7577)).toBe("99.76%");
    expect(formatUptime(100)).toBe("100%");
    expect(formatUptime(null)).toBe("—");
    expect(formatBrokenSeconds(0)).toBe("0m");
    expect(formatBrokenSeconds(34620)).toBe("9h 37m");
  });
});

describe("percentOf", () => {
  it("returns a clamped CSS percentage", () => {
    expect(percentOf(34620, 111900)).toBe("30.94%");
    expect(percentOf(111900, 111900)).toBe("100%");
    expect(percentOf(0, 111900)).toBe("0%");
    expect(percentOf(5, 0)).toBe("0%");
    expect(percentOf(-5, 10)).toBe("0%");
    expect(percentOf(15, 10)).toBe("100%");
  });
});

describe("isLongestOutageOngoing", () => {
  const rangeEnd = now.toISOString();
  const closed = (startAgo: number, length: number) => ({
    startedAt: ago(startAgo),
    endedAt: ago(startAgo - length),
  });
  const open = (startAgo: number) => ({ startedAt: ago(startAgo), endedAt: null });

  it("is true when the longest span is still open", () => {
    expect(isLongestOutageOngoing([closed(600 * MIN, 60 * MIN), open(90 * MIN)], rangeEnd)).toBe(
      true,
    );
  });

  it("is false when the longest span closed and only a shorter one is open", () => {
    expect(isLongestOutageOngoing([closed(600 * MIN, 120 * MIN), open(10 * MIN)], rangeEnd)).toBe(
      false,
    );
  });

  it("measures an open span up to rangeEnd and prefers it on a tie", () => {
    expect(isLongestOutageOngoing([closed(600 * MIN, 30 * MIN), open(30 * MIN)], rangeEnd)).toBe(
      true,
    );
  });

  it("is false without outages", () => {
    expect(isLongestOutageOngoing([], rangeEnd)).toBe(false);
  });
});
