import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();

describe("database smoke", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: "smoke@systemvitals.com" } });
    await prisma.$disconnect();
  });

  it("creates and reads a user", async () => {
    const user = await prisma.user.create({
      data: { email: "smoke@systemvitals.com", passwordHash: "x" },
    });
    const found = await prisma.user.findUnique({ where: { id: user.id } });
    expect(found?.email).toBe("smoke@systemvitals.com");
    expect(found?.id).toMatch(/^c[a-z0-9]+$/); // cuid, not an int
  });
});
