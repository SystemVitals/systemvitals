import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
const RUN = Date.now();
const EMAIL = `google-oauth+${RUN}@systemvitals.com`;
const GOOGLE_ID = `google-sub-${RUN}`;

describe("google oauth data contract", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: "google-oauth" } } });
    await prisma.$disconnect();
  });

  it("creates a user with no passwordHash", async () => {
    const user = await prisma.user.create({
      data: { email: EMAIL, googleId: GOOGLE_ID },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.googleId).toBe(GOOGLE_ID);
  });

  it("enforces googleId uniqueness", async () => {
    await expect(
      prisma.user.create({
        data: { email: `google-oauth-dup+${RUN}@systemvitals.com`, googleId: GOOGLE_ID },
      }),
    ).rejects.toThrow();
  });

  it("allows many users with a null googleId", async () => {
    const a = await prisma.user.create({
      data: { email: `google-oauth-a+${RUN}@systemvitals.com`, passwordHash: "x" },
    });
    const b = await prisma.user.create({
      data: { email: `google-oauth-b+${RUN}@systemvitals.com`, passwordHash: "x" },
    });
    expect(a.googleId).toBeNull();
    expect(b.googleId).toBeNull();
  });
});
