import { afterEach, describe, expect, it, vi } from "vitest";

describe("worker queue configuration", () => {
  const legacyQueueEnvName = ["QUEUE", "ESCALATION"].join("_");
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalLegacyQueue = process.env[legacyQueueEnvName];

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
    if (originalLegacyQueue === undefined) {
      delete process.env[legacyQueueEnvName];
    } else {
      process.env[legacyQueueEnvName] = originalLegacyQueue;
    }
    vi.resetModules();
  });

  it("does not expose legacy escalation queue configuration", async () => {
    process.env.DATABASE_URL = "postgresql://worker-config.test/systemvitals";
    process.env[legacyQueueEnvName] = "legacy-escalation";
    vi.resetModules();

    const { config } = await import("../src/config.js");

    expect(config).not.toHaveProperty("queueEscalation");
  });
});
