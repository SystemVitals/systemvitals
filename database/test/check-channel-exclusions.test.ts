import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
let organizationId: string | undefined;
let userId: string | undefined;

describe("check channel exclusion persistence contract", () => {
  afterAll(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  it("enforces composite uniqueness and cascades from checks and channels", async () => {
    const uniqueId = randomUUID();
    const checkId = `exclusion-check-${uniqueId}`;
    const firstChannelId = `exclusion-channel-one-${uniqueId}`;
    const secondChannelId = `exclusion-channel-two-${uniqueId}`;

    const user = await prisma.user.create({
      data: {
        email: `check-channel-exclusions-${uniqueId}@systemvitals.com`,
        passwordHash: "x",
      },
    });
    userId = user.id;

    const organization = await prisma.organization.create({
      data: {
        name: "Check channel exclusions",
        slug: `check-channel-exclusions-${uniqueId}`,
        creatorUserId: user.id,
      },
    });
    organizationId = organization.id;

    const project = await prisma.project.create({
      data: {
        name: "Check channel exclusions",
        slug: `check-channel-exclusions-${uniqueId}`,
        organizationId: organization.id,
      },
    });

    await prisma.check.create({
      data: {
        id: checkId,
        name: "Excluded check",
        slug: `excluded-check-${uniqueId}`,
        type: "HEARTBEAT",
        projectId: project.id,
      },
    });
    await prisma.notificationChannel.createMany({
      data: [
        {
          id: firstChannelId,
          projectId: project.id,
          type: "WEBHOOK",
          destinationKey: `first-${uniqueId}`,
          config: {},
        },
        {
          id: secondChannelId,
          projectId: project.id,
          type: "WEBHOOK",
          destinationKey: `second-${uniqueId}`,
          config: {},
        },
      ],
    });

    const firstExclusion = {
      checkId,
      channelId: firstChannelId,
    };
    await prisma.checkChannelExclusion.create({ data: firstExclusion });
    await prisma.checkChannelExclusion.create({
      data: { checkId, channelId: secondChannelId },
    });

    await expect(
      prisma.checkChannelExclusion.create({ data: firstExclusion }),
    ).rejects.toMatchObject({ code: "P2002" });

    await prisma.check.delete({ where: { id: checkId } });

    await expect(
      prisma.checkChannelExclusion.count({ where: { checkId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.notificationChannel.count({
        where: { id: { in: [firstChannelId, secondChannelId] } },
      }),
    ).resolves.toBe(2);

    await prisma.check.create({
      data: {
        id: checkId,
        name: "Recreated excluded check",
        slug: `recreated-excluded-check-${uniqueId}`,
        type: "HEARTBEAT",
        projectId: project.id,
      },
    });
    await prisma.checkChannelExclusion.create({ data: firstExclusion });

    await prisma.notificationChannel.delete({
      where: { id: firstChannelId },
    });

    await expect(
      prisma.checkChannelExclusion.count({
        where: { channelId: firstChannelId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.check.count({ where: { id: checkId } }),
    ).resolves.toBe(1);
  });
});
