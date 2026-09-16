import { describe, expect, it } from "vitest";
import {
  availableDurationUnits,
  durationUnitToMs,
  msToDurationUnit,
  nicestDurationUnit,
} from "./duration-units";

describe("availableDurationUnits", () => {
  it("keeps timeout-scale ranges in seconds only", () => {
    expect(availableDurationUnits(60_000)).toEqual(["s"]);
  });

  it("adds minutes when the range is longer than one minute", () => {
    expect(availableDurationUnits(3_600_000)).toEqual(["s", "min", "hr"]);
  });

  it("adds minutes but not hours when the max is under an hour", () => {
    expect(availableDurationUnits(3_599_000)).toEqual(["s", "min"]);
  });
});

describe("nicestDurationUnit", () => {
  const all = ["s", "min", "hr"] as const;

  it("uses seconds for zero and for values that are not whole minutes", () => {
    expect(nicestDurationUnit(0, [...all])).toBe("s");
    expect(nicestDurationUnit(45_000, [...all])).toBe("s");
  });

  it("uses the coarsest whole unit", () => {
    expect(nicestDurationUnit(5_000, [...all])).toBe("s");
    expect(nicestDurationUnit(60_000, [...all])).toBe("min");
    expect(nicestDurationUnit(300_000, [...all])).toBe("min");
    expect(nicestDurationUnit(3_600_000, [...all])).toBe("hr");
  });

  it("does not pick a unit that is not offered", () => {
    expect(nicestDurationUnit(3_600_000, ["s"])).toBe("s");
  });
});

describe("duration unit conversion", () => {
  it("converts between milliseconds and the selected unit", () => {
    expect(msToDurationUnit(300_000, "min")).toBe(5);
    expect(durationUnitToMs(5, "min")).toBe(300_000);
    expect(durationUnitToMs(2, "hr")).toBe(7_200_000);
  });
});
