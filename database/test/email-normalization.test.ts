import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
const RUN = Date.now();

/**
 * Documents the database-level behaviour that forces email normalization to
 * live in the application layer.
 *
 * This is NOT the regression coverage for the duplicate-account bug — that
 * lives in `api/src/auth/auth.service.spec.ts`, which drives the real
 * `normalizeEmail` helper through signup / login / loginWithGoogle. Nothing
 * here can call that helper: `database/` has no dependency on `api/`, so these
 * cases would have to re-implement it and would then keep passing even if the
 * real one changed. They pin the DB contract, nothing more.
 */
describe("users.email — database-level case behaviour", () => {
  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { contains: "email-norm" } },
    });
    await prisma.$disconnect();
  });

  it("compares byte-exact, so the database will not fold case for us", async () => {
    const email = `Email-Norm-Raw+${RUN}@Example.com`;
    await prisma.user.create({ data: { email, passwordHash: "x" } });

    const found = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    // No citext, no case-insensitive collation: a mixed-case row is simply
    // invisible to a lowercase lookup. That is how one person ended up with two
    // accounts once Google — which always returns lowercase — was added.
    expect(found).toBeNull();
  });

  it("treats addresses differing only by case as distinct rows", async () => {
    const lower = `email-norm-case+${RUN}@example.com`;
    const upper = `Email-Norm-Case+${RUN}@Example.com`;

    const a = await prisma.user.create({
      data: { email: lower, passwordHash: "x" },
    });
    // The @unique constraint does NOT prevent this. Hence migration
    // 20260722121736_normalize_user_emails raises on pre-existing collisions
    // instead of blindly lowercasing and hitting a constraint violation
    // mid-deploy.
    const b = await prisma.user.create({
      data: { email: upper, passwordHash: "x" },
    });

    expect(a.id).not.toBe(b.id);
  });

  it("rejects a second account with a byte-identical address", async () => {
    const canonical = `email-norm-dup+${RUN}@example.com`;
    await prisma.user.create({ data: { email: canonical, passwordHash: "x" } });

    await expect(
      prisma.user.create({ data: { email: canonical, passwordHash: "y" } }),
    ).rejects.toThrow();
  });
});
