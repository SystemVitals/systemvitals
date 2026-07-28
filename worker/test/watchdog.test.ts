import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, CheckStatus } from "@systemvitals/database";
import { sweepOverdue } from "../src/watchdog.js";

const prisma = new PrismaClient();

// IDs to track created records for cleanup
let userId: string;
let orgId: string;
let projectId: string;
let checkOverdueId: string;
let checkFreshId: string;
let checkPausedId: string;
let checkCronOverdueId: string;
let checkCronFreshId: string;

beforeAll(async () => {
  // Clean up any stale test artifacts from prior failed runs
  const staleProjects = await prisma.project.findMany({
    where: { name: "Watchdog Test Project" },
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
    where: { name: "Watchdog Test Org" },
    select: { id: true },
  });
  if (staleOrgs.length > 0) {
    const staleOrgIds = staleOrgs.map((o) => o.id);
    await prisma.membership.deleteMany({ where: { organizationId: { in: staleOrgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: staleOrgIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { endsWith: "@test.invalid" } } });

  // Create user
  const user = await prisma.user.create({
    data: {
      email: `watchdog-test-${Date.now()}@test.invalid`,
      passwordHash: "testhash",
    },
  });
  userId = user.id;

  // Create organization
  const org = await prisma.organization.create({
    data: {
      name: "Watchdog Test Org",
      slug: "watchdog-test-org",
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
      name: "Watchdog Test Project",
      slug: "watchdog-test-project",
      organizationId: orgId,
    },
  });
  projectId = project.id;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const fiveSecondsAgo = new Date(Date.now() - 5 * 1000);

  // (a) Overdue check: UP, lastEventAt 1h ago, period=60, grace=60
  // Window = 60+60 = 120s; 1h >> 120s → should be swept
  const checkOverdue = await prisma.check.create({
    data: {
      name: "Overdue Heartbeat",
      slug: "overdue-heartbeat",
      type: "HEARTBEAT",
      status: "UP",
      projectId,
      periodSeconds: 60,
      graceSeconds: 60,
      lastEventAt: oneHourAgo,
    },
  });
  checkOverdueId = checkOverdue.id;

  // (b) Fresh check: UP, lastEventAt 5s ago, period=60, grace=60
  // Window = 120s; 5s << 120s → should NOT be swept
  const checkFresh = await prisma.check.create({
    data: {
      name: "Fresh Heartbeat",
      slug: "fresh-heartbeat",
      type: "HEARTBEAT",
      status: "UP",
      projectId,
      periodSeconds: 60,
      graceSeconds: 60,
      lastEventAt: fiveSecondsAgo,
    },
  });
  checkFreshId = checkFresh.id;

  // (c) Paused overdue check: PAUSED, lastEventAt 1h ago → NOT swept
  const checkPaused = await prisma.check.create({
    data: {
      name: "Paused Heartbeat",
      slug: "paused-heartbeat",
      type: "HEARTBEAT",
      status: "PAUSED",
      projectId,
      periodSeconds: 60,
      graceSeconds: 60,
      lastEventAt: oneHourAgo,
    },
  });
  checkPausedId = checkPaused.id;

  // (d) Overdue cron check: UP, schedule fires every minute, lastEventAt 1h ago, grace=60
  // Next fire after 1h ago is within a minute of then; expected+grace is far in the past → should be swept
  const checkCronOverdue = await prisma.check.create({
    data: {
      name: "Overdue Cron Check",
      slug: "overdue-cron-check",
      type: "HEARTBEAT",
      status: "UP",
      projectId,
      periodSeconds: null,
      graceSeconds: 60,
      schedule: "* * * * *",
      tz: "UTC",
      lastEventAt: oneHourAgo,
    },
  });
  checkCronOverdueId = checkCronOverdue.id;

  // (e) Fresh cron check: UP, schedule fires every minute, lastEventAt just now, grace=600
  // Next fire after "now" is within a minute; expected+grace (~660s) is still in the future → should NOT be swept
  const checkCronFresh = await prisma.check.create({
    data: {
      name: "Fresh Cron Check",
      slug: "fresh-cron-check",
      type: "HEARTBEAT",
      status: "UP",
      projectId,
      periodSeconds: null,
      graceSeconds: 600,
      schedule: "* * * * *",
      tz: "UTC",
      lastEventAt: new Date(),
    },
  });
  checkCronFreshId = checkCronFresh.id;
});

afterAll(async () => {
  // Clean up in dependency order
  const allCheckIds = [checkOverdueId, checkFreshId, checkPausedId, checkCronOverdueId, checkCronFreshId];
  await prisma.checkEvent.deleteMany({ where: { checkId: { in: allCheckIds } } });
  await prisma.check.deleteMany({ where: { id: { in: allCheckIds } } });
  await prisma.project.delete({ where: { id: projectId } });
  await prisma.membership.deleteMany({ where: { userId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("sweepOverdue", () => {
  it("marks the overdue UP check as DOWN, writes a CheckEvent, enqueues alert, returns 1", async () => {
    const enqueuedJobs: Array<{ checkId: string; kind: "down" | "recovery" }> = [];
    const fakeEnqueue = async (job: { checkId: string; kind: "down" | "recovery" }) => {
      enqueuedJobs.push(job);
    };

    const count = await sweepOverdue(prisma, fakeEnqueue, new Date());

    // Should have swept at least 1 check (only check (a) among ours is overdue;
    // orphaned UP checks from other test runs may also appear in the global sweep)
    expect(count).toBeGreaterThanOrEqual(1);

    // Check (a) should now be DOWN
    const updatedCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkOverdueId } });
    expect(updatedCheck.status).toBe(CheckStatus.DOWN);

    // A DOWN CheckEvent should exist for check (a) — exactly one since it was freshly created
    const events = await prisma.checkEvent.findMany({
      where: { checkId: checkOverdueId, status: CheckStatus.DOWN },
    });
    expect(events.length).toBe(1);
    expect(events[0]?.error).toBe("missed heartbeat");

    // fakeEnqueue was called with the overdue check's job
    expect(enqueuedJobs.some(j => j.checkId === checkOverdueId && j.kind === "down")).toBe(true);

    // The fresh and paused checks were NOT enqueued
    expect(enqueuedJobs.some(j => j.checkId === checkFreshId)).toBe(false);
    expect(enqueuedJobs.some(j => j.checkId === checkPausedId)).toBe(false);

    // Check (b) fresh — still UP
    const freshCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkFreshId } });
    expect(freshCheck.status).toBe(CheckStatus.UP);

    // Check (c) paused — still PAUSED
    const pausedCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkPausedId } });
    expect(pausedCheck.status).toBe(CheckStatus.PAUSED);

    // Check (d) cron overdue — marked DOWN, event written, alert enqueued
    const updatedCronCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkCronOverdueId } });
    expect(updatedCronCheck.status).toBe(CheckStatus.DOWN);

    const cronEvents = await prisma.checkEvent.findMany({
      where: { checkId: checkCronOverdueId, status: CheckStatus.DOWN },
    });
    expect(cronEvents.length).toBe(1);
    expect(cronEvents[0]?.error).toBe("missed heartbeat");

    expect(enqueuedJobs.some(j => j.checkId === checkCronOverdueId && j.kind === "down")).toBe(true);

    // Check (e) cron fresh — still within schedule + grace, untouched
    const freshCronCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkCronFreshId } });
    expect(freshCronCheck.status).toBe(CheckStatus.UP);
    expect(enqueuedJobs.some(j => j.checkId === checkCronFreshId)).toBe(false);
  });
});

describe("sweepOverdue: read-then-write race with a mid-sweep conversion (Fix 3)", () => {
  let raceUserId: string;
  let raceOrgId: string;
  let raceProjectId: string;
  let checkRaceId: string;
  let checkDecoyId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `watchdog-race-test-${Date.now()}@test.invalid`,
        passwordHash: "testhash",
      },
    });
    raceUserId = user.id;

    const org = await prisma.organization.create({
      data: {
        name: `Watchdog Race Test Org ${Date.now()}`,
        slug: `watchdog-race-test-org-${Date.now()}`,
        creatorUserId: raceUserId,
      },
    });
    raceOrgId = org.id;

    await prisma.membership.create({
      data: { userId: raceUserId, organizationId: raceOrgId, role: "OWNER" },
    });

    const project = await prisma.project.create({
      data: {
        name: `Watchdog Race Test Project ${Date.now()}`,
        slug: `watchdog-race-test-project-${Date.now()}`,
        organizationId: raceOrgId,
      },
    });
    raceProjectId = project.id;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Overdue heartbeat that will be "converted" to HTTP by the racing
    // caller in between the sweep's read and its write.
    const checkRace = await prisma.check.create({
      data: {
        name: "Race Heartbeat",
        slug: "race-heartbeat",
        type: "HEARTBEAT",
        status: "UP",
        projectId: raceProjectId,
        periodSeconds: 60,
        graceSeconds: 60,
        lastEventAt: oneHourAgo,
      },
    });
    checkRaceId = checkRace.id;

    // A genuinely overdue heartbeat with no race, to prove the guard doesn't
    // also swallow checks that were never converted.
    const checkDecoy = await prisma.check.create({
      data: {
        name: "Decoy Overdue Heartbeat",
        slug: "decoy-overdue-heartbeat",
        type: "HEARTBEAT",
        status: "UP",
        projectId: raceProjectId,
        periodSeconds: 60,
        graceSeconds: 60,
        lastEventAt: oneHourAgo,
      },
    });
    checkDecoyId = checkDecoy.id;
  });

  afterAll(async () => {
    const allIds = [checkRaceId, checkDecoyId];
    await prisma.checkEvent.deleteMany({ where: { checkId: { in: allIds } } });
    await prisma.check.deleteMany({ where: { id: { in: allIds } } });
    await prisma.project.delete({ where: { id: raceProjectId } });
    await prisma.membership.deleteMany({ where: { userId: raceUserId } });
    await prisma.organization.delete({ where: { id: raceOrgId } });
    await prisma.user.delete({ where: { id: raceUserId } });
  });

  it("does not mark DOWN, write an event, or alert for a check converted away from HEARTBEAT between the sweep's read and its write", async () => {
    // A thin wrapper around the real PrismaClient that performs the race:
    // right after `sweepOverdue`'s initial `findMany` resolves (with
    // `checkRace` still included, since it was HEARTBEAT at read time), it
    // converts `checkRace` to HTTP — exactly what `resolveCheckUpdate`'s
    // HEARTBEAT -> HTTP conversion does (nulls periodSeconds/schedule).
    // `sweepOverdue` only calls `check.findMany` and `$transaction` directly
    // on the client it's given, so intercepting just those two is enough to
    // exercise the real guarded `updateMany` inside the transaction.
    const racingPrisma = {
      check: {
        findMany: async (args: Parameters<typeof prisma.check.findMany>[0]) => {
          const result = await prisma.check.findMany(args);
          await prisma.check.update({
            where: { id: checkRaceId },
            data: {
              type: "HTTP",
              periodSeconds: null,
              schedule: null,
              tz: null,
              graceSeconds: null,
              target: "https://example.com",
              intervalSeconds: 300,
              timeoutMs: 5000,
            },
          });
          return result;
        },
      },
      $transaction: prisma.$transaction.bind(prisma),
      checkEvent: prisma.checkEvent,
    } as unknown as PrismaClient;

    const enqueuedJobs: Array<{ checkId: string; kind: "down" | "recovery" }> = [];
    const fakeEnqueue = async (job: { checkId: string; kind: "down" | "recovery" }) => {
      enqueuedJobs.push(job);
    };

    await sweepOverdue(racingPrisma, fakeEnqueue, new Date());

    // The converted check must be untouched: still HTTP, still UP (the
    // conversion didn't touch status), no DOWN event, no alert.
    const raceCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkRaceId } });
    expect(raceCheck.type).toBe("HTTP");
    expect(raceCheck.status).toBe("UP");

    const raceEvents = await prisma.checkEvent.findMany({ where: { checkId: checkRaceId } });
    expect(raceEvents).toHaveLength(0);

    expect(enqueuedJobs.some((j) => j.checkId === checkRaceId)).toBe(false);

    // The untouched decoy must still be swept normally — the guard isn't
    // over-broad.
    const decoyCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkDecoyId } });
    expect(decoyCheck.status).toBe(CheckStatus.DOWN);

    const decoyEvents = await prisma.checkEvent.findMany({
      where: { checkId: checkDecoyId, status: CheckStatus.DOWN },
    });
    expect(decoyEvents).toHaveLength(1);

    expect(enqueuedJobs.some((j) => j.checkId === checkDecoyId && j.kind === "down")).toBe(true);
  });
});
