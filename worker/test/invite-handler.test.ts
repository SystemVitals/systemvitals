import { describe, it, expect } from "vitest";
import { handleInvite } from "../src/invite-handler.js";
import { CollectingMailer } from "../src/mailer.js";

function prismaWith(invite: unknown) {
  return {
    invite: {
      findUnique: async () => invite,
    },
  };
}

const pending = {
  id: "inv1",
  email: "invitee@example.com",
  token: "tok1",
  role: "MEMBER",
  acceptedAt: null,
  revokedAt: null,
  expiresAt: new Date(Date.now() + 86_400_000),
  organization: { name: "Acme" },
  invitedBy: { email: "owner@example.com" },
};

const deps = (mailer: CollectingMailer) => ({
  mailer,
  appUrl: "https://app.example.com",
});

describe("handleInvite", () => {
  it("sends one mail to the invitee containing the accept link", async () => {
    const mailer = new CollectingMailer();

    const sent = await handleInvite(
      prismaWith(pending) as never,
      deps(mailer),
      { inviteId: "inv1" },
    );

    expect(sent).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe("invitee@example.com");
    expect(mailer.sent[0].text).toContain(
      "https://app.example.com/invite/tok1",
    );
    expect(mailer.sent[0].text).toContain("Acme");
    expect(mailer.sent[0].subject).toContain("Acme");
  });

  it("does nothing when the invite no longer exists", async () => {
    const mailer = new CollectingMailer();

    const sent = await handleInvite(prismaWith(null) as never, deps(mailer), {
      inviteId: "gone",
    });

    expect(sent).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  it("does not send for a revoked, accepted or expired invite", async () => {
    for (const override of [
      { revokedAt: new Date() },
      { acceptedAt: new Date() },
      { expiresAt: new Date(Date.now() - 1000) },
    ]) {
      const mailer = new CollectingMailer();
      const sent = await handleInvite(
        prismaWith({ ...pending, ...override }) as never,
        deps(mailer),
        { inviteId: "inv1" },
      );
      expect(sent).toBe(false);
      expect(mailer.sent).toHaveLength(0);
    }
  });
});
