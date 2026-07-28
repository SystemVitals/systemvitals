import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
const createdUserIds: string[] = [];

describe("API token project history", () => {
  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: { creatorUserId: { in: createdUserIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  it("retains scoped token metadata after its project is deleted", async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `api-token-project-history-${suffix}@systemvitals.com`,
        passwordHash: "x",
      },
    });
    createdUserIds.push(user.id);
    const organization = await prisma.organization.create({
      data: {
        name: "Historical organization",
        slug: `historical-org-${suffix}`,
        creatorUserId: user.id,
        memberships: { create: { userId: user.id, role: "OWNER" } },
      },
    });
    const project = await prisma.project.create({
      data: {
        name: "Historical project",
        slug: "historical-project",
        organizationId: organization.id,
      },
    });
    const token = await prisma.apiToken.create({
      data: {
        name: "Historical token",
        prefix: randomUUID().slice(0, 8),
        tokenHash: randomUUID(),
        scopes: ["checks:read", "checks:write"],
        userId: user.id,
        projectId: project.id,
        projectNameSnapshot: project.name,
        organizationNameSnapshot: organization.name,
      },
    });

    await prisma.project.delete({ where: { id: project.id } });

    const retained = await prisma.apiToken.findUniqueOrThrow({
      where: { id: token.id },
    });
    expect(retained.projectId).toBeNull();
    expect(retained.projectNameSnapshot).toBe("Historical project");
    expect(retained.organizationNameSnapshot).toBe("Historical organization");
  });

  it("backfills snapshots before changing the project foreign key to SET NULL", () => {
    const sql = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260724121500_preserve_api_token_project_history/migration.sql",
      ),
      "utf8",
    );

    expect(sql).toMatch(/UPDATE "api_tokens"[\s\S]*FROM "projects"/);
    expect(sql).toMatch(/JOIN "organizations"/);
    expect(sql).toMatch(/DROP CONSTRAINT "api_tokens_project_id_fkey"/);
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql.indexOf('UPDATE "api_tokens"')).toBeLessThan(
      sql.indexOf('DROP CONSTRAINT "api_tokens_project_id_fkey"'),
    );
  });
});
