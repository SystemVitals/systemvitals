import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${process.pid}`;
const USER_ID = `account-billing-user-${RUN}`;
const ORGANIZATION_ID = `account-billing-org-${RUN}`;

describe("account billing migration contract", () => {
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: ORGANIZATION_ID } });
    await prisma.user.deleteMany({ where: { id: USER_ID } });
    await prisma.$disconnect();
  });

  it("creates a user account subscription and a creator organization", async () => {
    const user = await prisma.user.create({
      data: {
        id: USER_ID,
        email: `account-billing+${RUN}@systemvitals.com`,
        passwordHash: "x",
        stripeCustomerId: `cus_account_billing_${RUN}`,
        subscription: {
          create: {
            plan: "SOLO",
            status: "active",
          },
        },
        createdOrganizations: {
          create: {
            id: ORGANIZATION_ID,
            name: "Account Billing Contract",
            slug: `account-billing-${RUN}`,
          },
        },
      },
      include: {
        subscription: true,
        createdOrganizations: true,
      },
    });

    expect(user.subscription).toMatchObject({
      userId: USER_ID,
      organizationId: null,
      plan: "SOLO",
    });
    expect(user.createdOrganizations).toHaveLength(1);
    expect(user.createdOrganizations[0]).toMatchObject({
      id: ORGANIZATION_ID,
      creatorUserId: USER_ID,
    });
  });

  it("persists durable account checkout attempt identity and session state", async () => {
    const attemptId = `attempt-${RUN}`;
    const createdAt = new Date("2026-07-23T12:00:00.000Z");
    const expiresAt = new Date("2026-07-24T12:00:00.000Z");
    const cleanupCreatedAt = new Date("2026-07-23T12:01:00.000Z");

    const user = await prisma.user.update({
      where: { id: USER_ID },
      data: {
        billingStateVersion: { increment: 1 },
        checkoutAttemptId: attemptId,
        checkoutAttemptPlan: "SIGNAL",
        checkoutAttemptInterval: "month",
        checkoutAttemptCreatedAt: createdAt,
        checkoutSessionId: `cs_${RUN}`,
        checkoutSessionUrl: "https://checkout.stripe.test/session",
        checkoutSessionExpiresAt: expiresAt,
        checkoutCleanupSessionId: `cs_cleanup_${RUN}`,
        checkoutCleanupCreatedAt: cleanupCreatedAt,
      },
    });

    expect(user).toMatchObject({
      billingStateVersion: 1,
      checkoutInFlightCount: 0,
      checkoutAttemptId: attemptId,
      checkoutAttemptPlan: "SIGNAL",
      checkoutAttemptInterval: "month",
      checkoutAttemptCreatedAt: createdAt,
      checkoutSessionId: `cs_${RUN}`,
      checkoutSessionUrl: "https://checkout.stripe.test/session",
      checkoutSessionExpiresAt: expiresAt,
      checkoutCleanupSessionId: `cs_cleanup_${RUN}`,
      checkoutCleanupCreatedAt: cleanupCreatedAt,
    });
  });

  it("queues multiple distinct cleanup sessions and rejects duplicate session ownership", async () => {
    const secondUser = await prisma.user.create({
      data: {
        email: `account-billing-cleanup+${RUN}@systemvitals.com`,
        passwordHash: "x",
      },
    });
    try {
      await prisma.checkoutCleanupIntent.createMany({
        data: [
          { userId: USER_ID, stripeSessionId: `cs_cleanup_a_${RUN}` },
          { userId: USER_ID, stripeSessionId: `cs_cleanup_b_${RUN}` },
        ],
      });

      await expect(
        prisma.checkoutCleanupIntent.create({
          data: {
            userId: secondUser.id,
            stripeSessionId: `cs_cleanup_a_${RUN}`,
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
      await expect(
        prisma.checkoutCleanupIntent.count({ where: { userId: USER_ID } }),
      ).resolves.toBe(2);
    } finally {
      await prisma.user.delete({ where: { id: secondUser.id } });
    }
  });

  it("prevents the durable checkout in-flight counter from underflowing", async () => {
    await expect(
      prisma.user.update({
        where: { id: USER_ID },
        data: { checkoutInFlightCount: { decrement: 1 } },
      }),
    ).rejects.toThrow("users_checkout_in_flight_count_nonnegative");
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: USER_ID } }),
    ).resolves.toMatchObject({ checkoutInFlightCount: 0 });
  });
});
