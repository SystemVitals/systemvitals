import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PrismaClient,
  CheckStatus,
  ChannelType,
} from "@systemvitals/database";
import { handleProbe } from "../src/probe-handler.js";
import type { ProbeResult } from "../src/prober.js";
import type { AlertJob } from "../src/watchdog.js";

const prisma = new PrismaClient();

let userId: string;
let orgId: string;
let projectId: string;

// Checks for each scenario
let checkUpId: string;    // currently UP
let checkDownId: string;  // currently DOWN
let checkUpStayId: string; // currently UP, probe returns UP (no transition)
let checkConvertedId: string; // was HTTP when enqueued, now HEARTBEAT by the time the job runs
let checkPausedDuringProbeId: string;
let checkRoutingLockId: string;
let emailChannelId: string;
let slackChannelId: string;

const TEST_EMAIL = `probe-handler-test-${Date.now()}@probe-handler-test.invalid`;

beforeAll(async () => {
  // Clean up stale records from prior failed runs
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

  const user = await prisma.user.create({
    data: { email: TEST_EMAIL, passwordHash: "testhash" },
  });
  userId = user.id;

  const org = await prisma.organization.create({
    data: {
      name: `ProbeHandler Test Org ${Date.now()}`,
      slug: `probe-handler-test-org-${Date.now()}`,
      creatorUserId: userId,
    },
  });
  orgId = org.id;

  await prisma.membership.create({
    data: { userId, organizationId: orgId, role: "OWNER" },
  });

  const project = await prisma.project.create({
    data: {
      name: `ProbeHandler Test Project ${Date.now()}`,
      slug: `probe-handler-test-project-${Date.now()}`,
      organizationId: orgId,
    },
  });
  projectId = project.id;

  const checkUp = await prisma.check.create({
    data: {
      name: "UP Check",
      slug: "up-check",
      type: "HTTP",
      status: "UP",
      projectId,
      target: "http://example.com",
      intervalSeconds: 60,
    },
  });
  checkUpId = checkUp.id;

  const checkDown = await prisma.check.create({
    data: {
      name: "DOWN Check",
      slug: "down-check",
      type: "HTTP",
      status: "DOWN",
      projectId,
      target: "http://example.com",
      intervalSeconds: 60,
    },
  });
  checkDownId = checkDown.id;

  const checkUpStay = await prisma.check.create({
    data: {
      name: "UP Stay Check",
      slug: "up-stay-check",
      type: "HTTP",
      status: "UP",
      projectId,
      target: "http://example.com",
      intervalSeconds: 60,
    },
  });
  checkUpStayId = checkUpStay.id;

  // Represents a check that was HTTP (and UP) at the moment its probe job
  // was enqueued, but has since been converted to HEARTBEAT by the user —
  // the job in flight still targets its id.
  const checkConverted = await prisma.check.create({
    data: {
      name: "Converted Mid-Flight Check",
      slug: "converted-mid-flight-check",
      type: "HEARTBEAT",
      status: "UP",
      projectId,
      periodSeconds: 300,
      graceSeconds: 60,
      lastEventAt: new Date(),
    },
  });
  checkConvertedId = checkConverted.id;

  const checkPausedDuringProbe = await prisma.check.create({
    data: {
      name: "Paused During Probe Check",
      slug: "paused-during-probe-check",
      type: "HTTP",
      status: "UP",
      projectId,
      target: "http://example.com",
      intervalSeconds: 60,
    },
  });
  checkPausedDuringProbeId = checkPausedDuringProbe.id;

  const checkRoutingLock = await prisma.check.create({
    data: {
      name: "Routing Lock Check",
      slug: "routing-lock-check",
      type: "HTTP",
      status: "UP",
      projectId,
      target: "http://example.com",
      intervalSeconds: 60,
    },
  });
  checkRoutingLockId = checkRoutingLock.id;

  const emailChannel = await prisma.notificationChannel.create({
    data: {
      projectId,
      type: ChannelType.EMAIL,
      config: { email: "probe-email@example.com" },
      enabled: true,
    },
  });
  emailChannelId = emailChannel.id;

  const slackChannel = await prisma.notificationChannel.create({
    data: {
      projectId,
      type: ChannelType.SLACK,
      config: { webhookUrl: "https://hooks.slack.com/services/probe/test" },
      enabled: true,
    },
  });
  slackChannelId = slackChannel.id;

  await prisma.checkChannelExclusion.createMany({
    data: [
      { checkId: checkUpId, channelId: slackChannelId },
      { checkId: checkDownId, channelId: emailChannelId },
    ],
  });
});

afterAll(async () => {
  const allIds = [
    checkUpId,
    checkDownId,
    checkUpStayId,
    checkConvertedId,
    checkPausedDuringProbeId,
    checkRoutingLockId,
  ].filter(Boolean);
  await prisma.checkEvent.deleteMany({ where: { checkId: { in: allIds } } });
  await prisma.check.deleteMany({ where: { id: { in: allIds } } });
  await prisma.notificationChannel.deleteMany({
    where: { id: { in: [emailChannelId, slackChannelId] } },
  });
  await prisma.project.deleteMany({ where: { organizationId: orgId } });
  await prisma.membership.deleteMany({ where: { userId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("handleProbe", () => {
  it("UP check: probe returns down → writes DOWN event, sets status DOWN, enqueues kind=down", async () => {
    const enqueued: AlertJob[] = [];
    const fakeEnqueue = async (job: AlertJob) => {
      enqueued.push(job);
    };

    const fakeProbeFn = async (): Promise<ProbeResult> => ({
      up: false,
      responseTimeMs: 10,
      error: "connection refused",
    });

    await handleProbe(prisma, fakeEnqueue, fakeProbeFn, { checkId: checkUpId });

    // Check status should now be DOWN
    const updatedCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkUpId } });
    expect(updatedCheck.status).toBe(CheckStatus.DOWN);
    expect(updatedCheck.lastEventAt).not.toBeNull();

    // A DOWN CheckEvent should have been created
    const events = await prisma.checkEvent.findMany({
      where: { checkId: checkUpId, status: CheckStatus.DOWN },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events[events.length - 1]!;
    expect(event.responseTimeMs).toBe(10);

    // Alert enqueued with kind='down' exactly once
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]).toEqual({
      checkId: checkUpId,
      kind: "down",
      channelIds: [emailChannelId],
    });
  });

  it("DOWN check: probe returns up → writes UP event, sets status UP, enqueues kind=recovery", async () => {
    const enqueued: AlertJob[] = [];
    const fakeEnqueue = async (job: AlertJob) => {
      enqueued.push(job);
    };

    const fakeProbeFn = async (): Promise<ProbeResult> => ({
      up: true,
      responseTimeMs: 5,
      statusCode: 200,
    });

    await handleProbe(prisma, fakeEnqueue, fakeProbeFn, { checkId: checkDownId });

    // Check status should now be UP
    const updatedCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkDownId } });
    expect(updatedCheck.status).toBe(CheckStatus.UP);
    expect(updatedCheck.lastEventAt).not.toBeNull();

    // An UP CheckEvent should have been created
    const events = await prisma.checkEvent.findMany({
      where: { checkId: checkDownId, status: CheckStatus.UP },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events[events.length - 1]!;
    expect(event.responseTimeMs).toBe(5);
    expect(event.statusCode).toBe(200);

    // Alert enqueued with kind='recovery' exactly once
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]).toEqual({
      checkId: checkDownId,
      kind: "recovery",
      channelIds: [slackChannelId],
    });
  });

  it("UP check: probe returns up → writes UP event, status stays UP, NO alert enqueued", async () => {
    const enqueued: AlertJob[] = [];
    const fakeEnqueue = async (job: AlertJob) => {
      enqueued.push(job);
    };

    const fakeProbeFn = async (): Promise<ProbeResult> => ({
      up: true,
      responseTimeMs: 8,
      statusCode: 200,
    });

    await handleProbe(prisma, fakeEnqueue, fakeProbeFn, { checkId: checkUpStayId });

    // Check status should still be UP
    const updatedCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkUpStayId } });
    expect(updatedCheck.status).toBe(CheckStatus.UP);

    // An UP CheckEvent should have been created
    const events = await prisma.checkEvent.findMany({
      where: { checkId: checkUpStayId, status: CheckStatus.UP },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // NO alert should have been enqueued (no transition)
    expect(enqueued.length).toBe(0);
  });

  it("check converted away from HTTP/TCP before the job runs: no probe, no event, no status change, no alert (Fix 2)", async () => {
    const enqueued: AlertJob[] = [];
    const fakeEnqueue = async (job: AlertJob) => {
      enqueued.push(job);
    };

    let probeFnCalled = false;
    const fakeProbeFn = async (): Promise<ProbeResult> => {
      probeFnCalled = true;
      return { up: false, responseTimeMs: 0, error: "Unsupported probe type: HEARTBEAT" };
    };

    const beforeEvents = await prisma.checkEvent.count({ where: { checkId: checkConvertedId } });

    await handleProbe(prisma, fakeEnqueue, fakeProbeFn, { checkId: checkConvertedId });

    // The prober must never even be invoked for a non-HTTP/TCP type.
    expect(probeFnCalled).toBe(false);

    // No spurious DOWN write, no status flip, no alert.
    const updatedCheck = await prisma.check.findUniqueOrThrow({ where: { id: checkConvertedId } });
    expect(updatedCheck.status).toBe(CheckStatus.UP);

    const afterEvents = await prisma.checkEvent.count({ where: { checkId: checkConvertedId } });
    expect(afterEvents).toBe(beforeEvents);

    expect(enqueued.length).toBe(0);
  });

  it("does not commit a probe result when the check is paused while the probe is in flight", async () => {
    const enqueued: AlertJob[] = [];
    const beforeEvents = await prisma.checkEvent.count({
      where: { checkId: checkPausedDuringProbeId },
    });
    const fakeProbeFn = async (): Promise<ProbeResult> => {
      await prisma.check.update({
        where: { id: checkPausedDuringProbeId },
        data: { status: CheckStatus.PAUSED },
      });
      return {
        up: false,
        responseTimeMs: 12,
        error: "connection refused",
      };
    };

    await handleProbe(
      prisma,
      async (job) => {
        enqueued.push(job);
      },
      fakeProbeFn,
      { checkId: checkPausedDuringProbeId },
    );

    const check = await prisma.check.findUniqueOrThrow({
      where: { id: checkPausedDuringProbeId },
    });
    expect(check.status).toBe(CheckStatus.PAUSED);
    expect(
      await prisma.checkEvent.count({
        where: { checkId: checkPausedDuringProbeId },
      }),
    ).toBe(beforeEvents);
    expect(enqueued).toHaveLength(0);
  });

  it("serializes a routing toggle with the transition lock before snapshotting", async () => {
    let resolveLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      resolveLocked = resolve;
    });
    let releaseToggle!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseToggle = resolve;
    });

    const toggle = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id
        FROM checks
        WHERE id = ${checkRoutingLockId}
        FOR UPDATE
      `;
      resolveLocked();
      await release;
      await tx.checkChannelExclusion.create({
        data: {
          checkId: checkRoutingLockId,
          channelId: emailChannelId,
        },
      });
    });
    await locked;

    const enqueued: AlertJob[] = [];
    let probeCompleted = false;
    const handling = handleProbe(
      prisma,
      async (job) => {
        enqueued.push(job);
      },
      async () => {
        probeCompleted = true;
        return {
          up: false,
          responseTimeMs: 10,
          error: "connection refused",
        };
      },
      { checkId: checkRoutingLockId },
    );

    while (!probeCompleted) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let handlingResolved = false;
    void handling.then(
      () => {
        handlingResolved = true;
      },
      () => {
        handlingResolved = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handlingResolved).toBe(false);

    releaseToggle();
    await toggle;
    await handling;

    expect(enqueued).toEqual([
      {
        checkId: checkRoutingLockId,
        kind: "down",
        channelIds: [slackChannelId],
      },
    ]);
  });
});
