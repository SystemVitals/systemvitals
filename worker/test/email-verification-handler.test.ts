import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEmailVerification } from "../src/email-verification-handler.js";
import { CollectingMailer } from "../src/mailer.js";

const rawToken = "raw-token";
const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
const now = new Date("2026-07-27T12:00:00.000Z");

const pendingChannel = {
  id: "channel-1",
  type: "EMAIL",
  config: { email: "alerts@example.com" },
  enabled: false,
  verifiedAt: null,
  verificationTokenHash: tokenHash,
  verificationExpiresAt: new Date("2026-07-28T12:00:00.000Z"),
  project: { name: "Production" },
};

function prismaWith(channel: unknown) {
  return {
    notificationChannel: {
      findUnique: vi.fn().mockResolvedValue(channel),
    },
  };
}

describe("handleEmailVerification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the current pending channel a plain-text verification link", async () => {
    const mailer = new CollectingMailer();

    const sent = await handleEmailVerification(
      prismaWith(pendingChannel) as never,
      {
        mailer,
        appUrl: "https://systemvitals.link/dashboard?ignored=true",
      },
      { channelId: "channel-1", rawToken },
    );

    expect(sent).toBe(true);
    expect(mailer.sent).toEqual([
      {
        to: "alerts@example.com",
        subject:
          "Verify alerts@example.com for Production on SystemVitals",
        text: expect.stringContaining(
          "https://systemvitals.link/verify-email?token=raw-token",
        ),
      },
    ]);
    expect(mailer.sent[0]?.text).toContain("expires in 24 hours");
    expect(mailer.sent[0]?.text).toContain(
      "If you weren't expecting this, you can ignore this email.",
    );
  });

  it.each([
    ["deleted", null],
    ["non-email", { ...pendingChannel, type: "SLACK" }],
    [
      "expired",
      {
        ...pendingChannel,
        verificationExpiresAt: new Date("2026-07-27T12:00:00.000Z"),
      },
    ],
    ["missing expiry", { ...pendingChannel, verificationExpiresAt: null }],
    [
      "hash mismatch",
      { ...pendingChannel, verificationTokenHash: "different-hash" },
    ],
    ["missing hash", { ...pendingChannel, verificationTokenHash: null }],
    [
      "verified",
      { ...pendingChannel, verifiedAt: new Date("2026-07-27T11:00:00.000Z") },
    ],
    ["enabled", { ...pendingChannel, enabled: true }],
  ])("skips a %s channel", async (_state, channel) => {
    const mailer = new CollectingMailer();

    const sent = await handleEmailVerification(
      prismaWith(channel) as never,
      { mailer, appUrl: "https://systemvitals.link" },
      { channelId: "channel-1", rawToken },
    );

    expect(sent).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("propagates SMTP rejection so BullMQ can retry", async () => {
    const smtpError = new Error("SMTP unavailable");
    const mailer = {
      send: vi.fn().mockRejectedValue(smtpError),
    };

    await expect(
      handleEmailVerification(
        prismaWith(pendingChannel) as never,
        { mailer, appUrl: "https://systemvitals.link" },
        { channelId: "channel-1", rawToken },
      ),
    ).rejects.toBe(smtpError);
  });
});

describe("email verification worker registration", () => {
  it("defaults to the API queue name", async () => {
    const previous = process.env["QUEUE_EMAIL_VERIFICATION"];
    delete process.env["QUEUE_EMAIL_VERIFICATION"];
    vi.resetModules();

    try {
      const { config } = await import("../src/config.js");
      expect(config.queueEmailVerification).toBe("email-verification");
    } finally {
      if (previous === undefined) {
        delete process.env["QUEUE_EMAIL_VERIFICATION"];
      } else {
        process.env["QUEUE_EMAIL_VERIFICATION"] = previous;
      }
      vi.resetModules();
    }
  });

  it("trims a safe custom queue name and normalizes an APP_URL origin", async () => {
    const previousQueue = process.env["QUEUE_EMAIL_VERIFICATION"];
    const previousAppUrl = process.env["APP_URL"];
    process.env["QUEUE_EMAIL_VERIFICATION"] = "  verification_delivery-2  ";
    process.env["APP_URL"] = "https://app.example.test/";
    vi.resetModules();

    try {
      const { config } = await import("../src/config.js");
      expect(config.queueEmailVerification).toBe("verification_delivery-2");
      expect(config.appUrl).toBe("https://app.example.test");
    } finally {
      if (previousQueue === undefined) {
        delete process.env["QUEUE_EMAIL_VERIFICATION"];
      } else {
        process.env["QUEUE_EMAIL_VERIFICATION"] = previousQueue;
      }
      if (previousAppUrl === undefined) {
        delete process.env["APP_URL"];
      } else {
        process.env["APP_URL"] = previousAppUrl;
      }
      vi.resetModules();
    }
  });

  it.each([
    "   ",
    "verification:delivery",
    "bad\nqueue",
    "verification delivery",
  ])("rejects unsafe email-verification queue name %p", async (queueName) => {
    const previous = process.env["QUEUE_EMAIL_VERIFICATION"];
    process.env["QUEUE_EMAIL_VERIFICATION"] = queueName;
    vi.resetModules();

    try {
      await expect(import("../src/config.js")).rejects.toThrow(
        "QUEUE_EMAIL_VERIFICATION has an invalid format",
      );
    } finally {
      if (previous === undefined) {
        delete process.env["QUEUE_EMAIL_VERIFICATION"];
      } else {
        process.env["QUEUE_EMAIL_VERIFICATION"] = previous;
      }
      vi.resetModules();
    }
  });

  it.each([
    "ftp://app.example.test",
    "https://user:password@app.example.test",
    "https://app.example.test/dashboard",
    "https://app.example.test?source=worker",
    "https://app.example.test/#fragment",
    "not a URL",
  ])("rejects unsafe APP_URL %p", async (appUrl) => {
    const previous = process.env["APP_URL"];
    process.env["APP_URL"] = appUrl;
    vi.resetModules();

    try {
      await expect(import("../src/config.js")).rejects.toThrow(
        "APP_URL must be a credential-free HTTP(S) origin",
      );
    } finally {
      if (previous === undefined) {
        delete process.env["APP_URL"];
      } else {
        process.env["APP_URL"] = previous;
      }
      vi.resetModules();
    }
  });

  it("registers verification delivery for observation, readiness, and shutdown with immediate payload removal", async () => {
    const source = await readFile(
      new URL("../cli/worker.ts", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(
      /new Queue<\s*EmailVerificationJob,\s*void,\s*"email-verification"\s*>/,
    );
    expect(source).toContain(
      "new Worker<EmailVerificationJob, void>",
    );
    expect(source).toContain(
      "handleEmailVerification(",
    );
    expect(source).toContain(
      'observeQueue(emailVerificationQueue, "email-verification")',
    );
    expect(source).toContain(
      'observeWorker(emailVerificationWorker, "email-verification")',
    );
    expect(source).toContain(
      'readyWorker(emailVerificationWorker, "email-verification")',
    );
    expect(source).toMatch(
      /emailVerificationJobOptions\s*=\s*\{[\s\S]*?attempts:\s*3,[\s\S]*?type:\s*"exponential",\s*delay:\s*5000[\s\S]*?removeOnComplete:\s*true,[\s\S]*?removeOnFail:\s*true/,
    );
  });
});
