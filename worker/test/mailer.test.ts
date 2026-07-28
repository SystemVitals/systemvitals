import { afterEach, describe, expect, it, vi } from "vitest";
import { NodemailerMailer } from "../src/mailer.js";

describe("NodemailerMailer without SMTP", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs token-free metadata without the message body or transport payload", async () => {
    const previousSmtpHost = process.env["SMTP_HOST"];
    delete process.env["SMTP_HOST"];
    const sentinel = "verification-bearer-token-SENTINEL";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const mailer = new NodemailerMailer();
      await mailer.send({
        to: "alerts@example.com",
        subject: "Verify alerts@example.com",
        text: `Secret verification link: https://example.test/?token=${sentinel}`,
      });

      const output = JSON.stringify(log.mock.calls);
      expect(output).toContain("recipientCount");
      expect(output).not.toContain(sentinel);
      expect(output).not.toContain("Secret verification link");
      expect(output).not.toContain("alerts@example.com");
      expect(output).not.toContain("Verify alerts@example.com");
    } finally {
      if (previousSmtpHost === undefined) {
        delete process.env["SMTP_HOST"];
      } else {
        process.env["SMTP_HOST"] = previousSmtpHost;
      }
    }
  });
});
