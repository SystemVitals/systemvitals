import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/index";

const prisma = new PrismaClient();
const uniqueId = randomUUID();
let organizationId: string | undefined;
let userId: string | undefined;
let projectId: string;
let counter = 0;

async function createCheck(status?: "NEW" | "UP" | "DOWN" | "PAUSED") {
  counter += 1;
  return prisma.check.create({
    data: {
      name: `Outage check ${counter}`,
      slug: `outage-check-${counter}-${uniqueId}`,
      type: "HEARTBEAT",
      projectId,
      ...(status ? { status } : {}),
    },
  });
}

function setStatus(id: string, status: "NEW" | "UP" | "DOWN" | "PAUSED") {
  return prisma.check.update({ where: { id }, data: { status } });
}

function outagesOf(checkId: string) {
  return prisma.checkOutage.findMany({
    where: { checkId },
    orderBy: { startedAt: "asc" },
  });
}

describe("check outage trigger", () => {
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `check-outages-${uniqueId}@systemvitals.com`,
        passwordHash: "x",
      },
    });
    userId = user.id;
    const organization = await prisma.organization.create({
      data: {
        name: "Check outages",
        slug: `check-outages-${uniqueId}`,
        creatorUserId: user.id,
      },
    });
    organizationId = organization.id;
    const project = await prisma.project.create({
      data: {
        name: "Check outages",
        slug: `check-outages-${uniqueId}`,
        organizationId: organization.id,
      },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    if (organizationId) {
      await prisma.organization.deleteMany({ where: { id: organizationId } });
    }
    if (userId) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await prisma.$disconnect();
  });

  it("opens one outage when a check becomes DOWN", async () => {
    const check = await createCheck();
    await setStatus(check.id, "UP");
    await setStatus(check.id, "DOWN");

    const outages = await outagesOf(check.id);
    expect(outages).toHaveLength(1);
    expect(outages[0].endedAt).toBeNull();
    expect(
      Math.abs(outages[0].startedAt.getTime() - Date.now()),
    ).toBeLessThan(5000);
  });

  it("ignores status writes that do not change status", async () => {
    const check = await createCheck();
    await setStatus(check.id, "DOWN");
    await setStatus(check.id, "DOWN");
    await prisma.check.update({
      where: { id: check.id },
      data: { lastEventAt: new Date() },
    });

    expect(await outagesOf(check.id)).toHaveLength(1);
  });

  it.each(["UP", "PAUSED", "NEW"] as const)(
    "closes the open outage when the check leaves DOWN for %s",
    async (next) => {
      const check = await createCheck();
      await setStatus(check.id, "DOWN");
      await setStatus(check.id, next);

      const outages = await outagesOf(check.id);
      expect(outages).toHaveLength(1);
      expect(outages[0].endedAt).not.toBeNull();
      expect(outages[0].endedAt!.getTime()).toBeGreaterThanOrEqual(
        outages[0].startedAt.getTime(),
      );
    },
  );

  it("records a check inserted as DOWN", async () => {
    const check = await createCheck("DOWN");

    const outages = await outagesOf(check.id);
    expect(outages).toHaveLength(1);
    expect(outages[0].endedAt).toBeNull();
  });

  it("keeps at most one open outage per check", async () => {
    const check = await createCheck("DOWN");

    await expect(
      prisma.$executeRaw`INSERT INTO check_outages (check_id, started_at) VALUES (${check.id}, now() AT TIME ZONE 'UTC')`,
    ).rejects.toThrow(/23505/);
  });

  it("cascades outages when the check is deleted", async () => {
    const check = await createCheck("DOWN");
    expect(await outagesOf(check.id)).toHaveLength(1);

    await prisma.check.delete({ where: { id: check.id } });

    expect(await outagesOf(check.id)).toHaveLength(0);
  });
});
