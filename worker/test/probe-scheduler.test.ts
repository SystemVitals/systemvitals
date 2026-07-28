import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@systemvitals/database";
import { findDueProbes } from "../src/probe-scheduler.js";

const prisma = new PrismaClient();

// IDs to track created records for cleanup
let userId: string;
let orgId: string;
let projectId: string;

let checkHttpNeverProbedId: string;   // (a) HTTP, lastEventAt=null → due
let checkHttpFreshId: string;         // (b) HTTP, lastEventAt=5s ago, interval=60 → NOT due
let checkTcpOverdueId: string;        // (c) TCP, lastEventAt=2min ago, interval=60 → due
let checkPausedOverdueId: string;     // (d) PAUSED, overdue → NOT due
let checkHeartbeatOverdueId: string;  // (e) HEARTBEAT, overdue → NOT due

beforeAll(async () => {
  // Clean up any stale test artifacts from prior failed runs
  const staleProjects = await prisma.project.findMany({
    where: { name: "Probe Scheduler Test Project" },
    select: { id: true },
  });
  if (staleProjects.length > 0) {
    const staleProjectIds = staleProjects.map((p) => p.id);
    const staleChecks = await prisma.check.findMany({
      where: { projectId: { in: staleProjectIds } },
      select: { id: true },
    });
    const staleCheckIds = staleChecks.map((c) => c.id);
    if (staleCheckIds.length > 0) {
      await prisma.checkEvent.deleteMany({ where: { checkId: { in: staleCheckIds } } });
      await prisma.check.deleteMany({ where: { id: { in: staleCheckIds } } });
    }
    await prisma.project.deleteMany({ where: { id: { in: staleProjectIds } } });
  }
  const staleOrgs = await prisma.organization.findMany({
    where: { name: "Probe Scheduler Test Org" },
    select: { id: true },
  });
  if (staleOrgs.length > 0) {
    const staleOrgIds = staleOrgs.map((o) => o.id);
    await prisma.membership.deleteMany({ where: { organizationId: { in: staleOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: staleOrgIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: "@probe-test.invalid" } } });

  // Create user
  const user = await prisma.user.create({
    data: {
      email: `probe-scheduler-test-${Date.now()}@probe-test.invalid`,
      passwordHash: "testhash",
    },
  });
  userId = user.id;

  // Create organization
  const org = await prisma.organization.create({
    data: {
      name: "Probe Scheduler Test Org",
      slug: "probe-scheduler-test-org",
      creatorUserId: userId,
    },
  });
  orgId = org.id;

  // Create membership
  await prisma.membership.create({
    data: {
      userId,
      organizationId: orgId,
      role: "OWNER",
    },
  });

  // Create project
  const project = await prisma.project.create({
    data: {
      name: "Probe Scheduler Test Project",
      slug: "probe-scheduler-test-project",
      organizationId: orgId,
    },
  });
  projectId = project.id;

  const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
  const fiveSecondsAgo = new Date(Date.now() - 5 * 1000);

  // (a) Active HTTP check, lastEventAt=null → due (never probed)
  const checkHttpNeverProbed = await prisma.check.create({
    data: {
      name: "HTTP Never Probed",
      slug: "http-never-probed",
      type: "HTTP",
      status: "UP",
      projectId,
      intervalSeconds: 60,
      target: "https://example.com",
    },
  });
  checkHttpNeverProbedId = checkHttpNeverProbed.id;

  // (b) Active HTTP check, lastEventAt=5s ago, intervalSeconds=60 → NOT due (fresh)
  const checkHttpFresh = await prisma.check.create({
    data: {
      name: "HTTP Fresh",
      slug: "http-fresh",
      type: "HTTP",
      status: "UP",
      projectId,
      intervalSeconds: 60,
      target: "https://example.com",
      lastEventAt: fiveSecondsAgo,
    },
  });
  checkHttpFreshId = checkHttpFresh.id;

  // (c) Active TCP check, lastEventAt=2min ago, intervalSeconds=60 → due (overdue)
  const checkTcpOverdue = await prisma.check.create({
    data: {
      name: "TCP Overdue",
      slug: "tcp-overdue",
      type: "TCP",
      status: "UP",
      projectId,
      intervalSeconds: 60,
      target: "example.com:443",
      lastEventAt: twoMinutesAgo,
    },
  });
  checkTcpOverdueId = checkTcpOverdue.id;

  // (d) PAUSED HTTP check, overdue → NOT due (paused)
  const checkPausedOverdue = await prisma.check.create({
    data: {
      name: "Paused HTTP Overdue",
      slug: "paused-http-overdue",
      type: "HTTP",
      status: "PAUSED",
      projectId,
      intervalSeconds: 60,
      target: "https://example.com",
      lastEventAt: twoMinutesAgo,
    },
  });
  checkPausedOverdueId = checkPausedOverdue.id;

  // (e) HEARTBEAT check, overdue → NOT due (heartbeat excluded)
  const checkHeartbeatOverdue = await prisma.check.create({
    data: {
      name: "Heartbeat Overdue",
      slug: "heartbeat-overdue",
      type: "HEARTBEAT",
      status: "UP",
      projectId,
      intervalSeconds: 60,
      lastEventAt: twoMinutesAgo,
    },
  });
  checkHeartbeatOverdueId = checkHeartbeatOverdue.id;
});

afterAll(async () => {
  const allIds = [
    checkHttpNeverProbedId,
    checkHttpFreshId,
    checkTcpOverdueId,
    checkPausedOverdueId,
    checkHeartbeatOverdueId,
  ].filter(Boolean);

  await prisma.checkEvent.deleteMany({ where: { checkId: { in: allIds } } });
  await prisma.check.deleteMany({ where: { id: { in: allIds } } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.membership.deleteMany({ where: { userId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("findDueProbes", () => {
  it("returns due HTTP/TCP checks and excludes fresh, paused, and heartbeat checks", async () => {
    const due = await findDueProbes(prisma, new Date());
    const dueIds = new Set(due.map((c) => c.id));

    // (a) HTTP never probed → should be due
    expect(dueIds.has(checkHttpNeverProbedId)).toBe(true);

    // (c) TCP probed 2min ago, interval=60s → should be due
    expect(dueIds.has(checkTcpOverdueId)).toBe(true);

    // (b) HTTP probed 5s ago, interval=60s → should NOT be due
    expect(dueIds.has(checkHttpFreshId)).toBe(false);

    // (d) PAUSED check overdue → should NOT be due
    expect(dueIds.has(checkPausedOverdueId)).toBe(false);

    // (e) HEARTBEAT check overdue → should NOT be due
    expect(dueIds.has(checkHeartbeatOverdueId)).toBe(false);
  });
});
