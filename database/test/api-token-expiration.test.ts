import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

describe("API token expiration", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it("stores optional expiration timestamps", async () => {
    const user = await prisma.user.create({
      data: {
        email: `api-token-expiration-${randomUUID()}@systemvitals.com`,
        passwordHash: "x",
      },
    });
    createdUserIds.push(user.id);

    const expiresAt = new Date("2030-01-02T00:00:00.000Z");
    const [withoutExpiration, withExpiration] = await Promise.all([
      prisma.apiToken.create({
        data: {
          name: "No expiration",
          prefix: randomUUID().slice(0, 8),
          tokenHash: randomUUID(),
          scopes: ["read"],
          userId: user.id,
        },
      }),
      prisma.apiToken.create({
        data: {
          name: "Fixed expiration",
          prefix: randomUUID().slice(0, 8),
          tokenHash: randomUUID(),
          scopes: ["read"],
          userId: user.id,
          expiresAt,
        },
      }),
    ]);

    expect(withoutExpiration.expiresAt).toBeNull();
    expect(withExpiration.expiresAt?.toISOString()).toBe(
      "2030-01-02T00:00:00.000Z",
    );
  });
});
