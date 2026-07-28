import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { ChannelType, PrismaClient, Role } from "../src/index";

const prisma = new PrismaClient();
const suffix = randomUUID();
const email = `telegram-schema-${suffix}@systemvitals.test`;
const organizationSlug = `telegram-schema-${suffix}`;
const telegramUpdateId = randomUUID();

describe("managed Telegram persistence", () => {
  afterAll(async () => {
    await prisma.telegramConnectionChallenge.deleteMany({
      where: { telegramUpdateId },
    });
    await prisma.organization.deleteMany({
      where: { slug: organizationSlug },
    });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  it("stores a challenge and uniquely keys a managed project destination", async () => {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: "x",
        subscription: { create: {} },
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: "Telegram schema",
        slug: organizationSlug,
        creatorUserId: user.id,
        memberships: { create: { userId: user.id, role: Role.OWNER } },
        projects: { create: { name: "Production", slug: "production" } },
      },
      include: { projects: true },
    });
    const projectId = organization.projects[0].id;

    const challenge = await prisma.telegramConnectionChallenge.create({
      data: {
        tokenHash: randomBytes(32).toString("hex"),
        telegramUpdateId,
        chatId: "-1001234567890",
        chatType: "supergroup",
        chatTitle: "Operations",
        messageThreadId: 42,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    expect(challenge.chatId).toBe("-1001234567890");
    expect(challenge.messageThreadId).toBe(42);
    expect(challenge.deliveredAt).toBeNull();

    const deliveredAt = new Date("2032-03-04T05:06:07.000Z");
    const delivered = await prisma.telegramConnectionChallenge.update({
      where: { id: challenge.id },
      data: { deliveredAt },
    });
    expect(delivered.deliveredAt).toEqual(deliveredAt);

    const destinationKey = "chat:-1001234567890:topic:42";
    await prisma.notificationChannel.create({
      data: {
        projectId,
        type: ChannelType.TELEGRAM,
        destinationKey,
        config: {
          mode: "MANAGED",
          chatId: "-1001234567890",
          messageThreadId: 42,
        },
      },
    });
    await expect(
      prisma.notificationChannel.create({
        data: {
          projectId,
          type: ChannelType.TELEGRAM,
          destinationKey,
          config: {
            mode: "MANAGED",
            chatId: "-1001234567890",
            messageThreadId: 42,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "P2002",
    });

    const legacy = await prisma.notificationChannel.createMany({
      data: [
        {
          projectId,
          type: ChannelType.TELEGRAM,
          config: { botToken: "legacy-one", chatId: "1" },
        },
        {
          projectId,
          type: ChannelType.TELEGRAM,
          config: { botToken: "legacy-two", chatId: "2" },
        },
      ],
    });
    expect(legacy.count).toBe(2);
  });
});
