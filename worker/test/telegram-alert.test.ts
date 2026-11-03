import { describe, it, expect } from "vitest";
import {
  buildTelegramDownAlertMessage,
  buildTelegramRecoveryAlertMessage,
} from "../src/telegram-alert.js";

const base = {
  appUrl: "https://app.example.com",
  organizationSlug: "acme",
  project: { name: "Default" },
  check: {
    name: "Nightly backup",
    slug: "nightly-backup",
    type: "HEARTBEAT",
    periodSeconds: 86_400,
    intervalSeconds: null,
    description: null as string | null,
  },
  totalPings: 3,
  lastSuccessAt: new Date("2026-08-06T11:00:00.000Z"),
  otherChecksNotUp: 0,
  now: new Date("2026-08-07T12:00:00.000Z"),
};

describe("buildTelegramDownAlertMessage", () => {
  it("leaves the message unchanged when the check has no description", () => {
    const text = buildTelegramDownAlertMessage(base);
    expect(text).not.toContain("How to fix");
    expect(text.endsWith("All the other checks are up.")).toBe(true);
  });

  it("appends the description as HTML-escaped fix instructions", () => {
    const text = buildTelegramDownAlertMessage({
      ...base,
      check: {
        ...base.check,
        description: "1. Run `restart <worker>`\n2. Check R&D logs",
      },
    });
    expect(text.split("\n").slice(-4)).toEqual([
      "",
      "<b>How to fix:</b>",
      "1. Run `restart &lt;worker&gt;`",
      "2. Check R&amp;D logs",
    ]);
  });
});

describe("buildTelegramRecoveryAlertMessage", () => {
  it("does not repeat the fix instructions on recovery", () => {
    const text = buildTelegramRecoveryAlertMessage({
      ...base,
      check: { ...base.check, description: "Restart the worker" },
      downtimeStartedAt: new Date("2026-08-07T11:00:00.000Z"),
    });
    expect(text).not.toContain("How to fix");
    expect(text).not.toContain("Restart the worker");
  });
});
