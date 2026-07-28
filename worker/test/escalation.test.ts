import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient, ChannelType } from "@systemvitals/database";
import { scheduleEscalation, handleEscalationStep } from "../src/escalation.js";
import type { NotifierDeps } from "../src/notifiers.js";
import { CollectingMailer } from "../src/mailer.js";

const prisma = new PrismaClient();

const TEST_EMAIL = `escalation-test-${Date.now()}@test.invalid`;

let userId: string;
let orgId: string;
// Project WITH an escalation policy
let projectWithPolicyId: string;
let checkWithPolicyId: string;
let channelAId: string;
let channelBId: string;
// Project WITHOUT an escalation policy
let projectNoPolicyId: string;
let checkNoPolicyId: string;
// A recovered check (status UP) for recovery skip test
let checkUpId: string;
// An enabled channel for handleEscalationStep tests
let testChannelId: string;
let telegramChannelId: string;

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

  const user = await prisma.user.create({
    data: { email: TEST_EMAIL, passwordHash: "testhash" },
  });
  userId = user.id;

  const org = await prisma.organization.create({
    data: {
      name: `Escalation Test Org ${Date.now()}`,
      slug: `escalation-test-org-${Date.now()}`,
      creatorUserId: userId,
    },
  });
  orgId = org.id;

  await prisma.membership.create({
    data: { userId, organizationId: orgId, role: "OWNER" },
  });

  // Project WITH policy
  const projectWith = await prisma.project.create({
    data: {
      name: `Escalation Test Project With Policy ${Date.now()}`,
      slug: `escalation-test-project-with-policy-${Date.now()}`,
      organizationId: orgId,
    },
  });
  projectWithPolicyId = projectWith.id;

  // Two channels on this project
  const chA = await prisma.notificationChannel.create({
    data: {
      projectId: projectWithPolicyId,
      type: ChannelType.EMAIL,
      config: { email: "esca@example.com" },
      enabled: true,
    },
  });
  channelAId = chA.id;

  const chB = await prisma.notificationChannel.create({
    data: {
      projectId: projectWithPolicyId,
      type: ChannelType.EMAIL,
      config: { email: "escb@example.com" },
      enabled: true,
    },
  });
  channelBId = chB.id;

  // Escalation policy with 2 steps
  await prisma.escalationPolicy.create({
    data: {
      projectId: projectWithPolicyId,
      steps: [
        { channelId: channelAId, delaySeconds: 300 },
        { channelId: channelBId, delaySeconds: 600 },
      ],
    },
  });

  // Check DOWN on this project
  const checkWith = await prisma.check.create({
    data: {
      name: "Escalation Check",
      slug: "escalation-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: projectWithPolicyId,
    },
  });
  checkWithPolicyId = checkWith.id;

  // Project WITHOUT policy
  const projectNo = await prisma.project.create({
    data: {
      name: `Escalation Test Project No Policy ${Date.now()}`,
      slug: `escalation-test-project-no-policy-${Date.now()}`,
      organizationId: orgId,
    },
  });
  projectNoPolicyId = projectNo.id;

  const checkNo = await prisma.check.create({
    data: {
      name: "No Policy Check",
      slug: "no-policy-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: projectNoPolicyId,
    },
  });
  checkNoPolicyId = checkNo.id;

  // A recovered (UP) check on projectWithPolicyId
  const checkUp = await prisma.check.create({
    data: {
      name: "Recovered Check",
      slug: "recovered-check",
      type: "HEARTBEAT",
      status: "UP",
      projectId: projectWithPolicyId,
    },
  });
  checkUpId = checkUp.id;

  // A dedicated enabled channel for handleEscalationStep tests
  const testCh = await prisma.notificationChannel.create({
    data: {
      projectId: projectWithPolicyId,
      type: ChannelType.EMAIL,
      config: { email: "step@example.com" },
      enabled: true,
    },
  });
  testChannelId = testCh.id;

  const telegramChannel = await prisma.notificationChannel.create({
    data: {
      projectId: projectWithPolicyId,
      type: ChannelType.TELEGRAM,
      config: {
        mode: "MANAGED",
        botToken: "legacy-test-token",
        chatId: "-1001234567890",
      },
      enabled: true,
    },
  });
  telegramChannelId = telegramChannel.id;
});

afterAll(async () => {
  // Clean up in dependency order
  await prisma.alertLog.deleteMany({
    where: {
      checkId: {
        in: [checkWithPolicyId, checkNoPolicyId, checkUpId],
      },
    },
  });
  await prisma.acknowledgement.deleteMany({
    where: { checkId: { in: [checkWithPolicyId, checkNoPolicyId, checkUpId] } },
  });
  await prisma.check.deleteMany({
    where: { id: { in: [checkWithPolicyId, checkNoPolicyId, checkUpId] } },
  });
  await prisma.escalationPolicy.deleteMany({ where: { projectId: projectWithPolicyId } });
  await prisma.notificationChannel.deleteMany({
    where: {
      id: { in: [channelAId, channelBId, testChannelId, telegramChannelId] },
    },
  });
  await prisma.project.deleteMany({
    where: { id: { in: [projectWithPolicyId, projectNoPolicyId] } },
  });
  await prisma.membership.deleteMany({ where: { userId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// scheduleEscalation
// ---------------------------------------------------------------------------

describe("scheduleEscalation", () => {
  it("calls enqueueEscalation twice with right data and delays when project has a 2-step policy", async () => {
    const calls: Array<{ data: { checkId: string; channelId: string; alertedAt: string }; delayMs: number }> = [];
    const fakeEnqueue = async (
      data: { checkId: string; channelId: string; alertedAt: string },
      delayMs: number,
    ) => {
      calls.push({ data, delayMs });
    };

    const alertedAt = new Date();
    const count = await scheduleEscalation(prisma, fakeEnqueue, checkWithPolicyId, alertedAt);

    expect(count).toBe(2);
    expect(calls).toHaveLength(2);

    // Step 1: channelA, 300s → 300000ms
    expect(calls[0]?.data.checkId).toBe(checkWithPolicyId);
    expect(calls[0]?.data.channelId).toBe(channelAId);
    expect(calls[0]?.data.alertedAt).toBe(alertedAt.toISOString());
    expect(calls[0]?.delayMs).toBe(300_000);

    // Step 2: channelB, 600s → 600000ms
    expect(calls[1]?.data.checkId).toBe(checkWithPolicyId);
    expect(calls[1]?.data.channelId).toBe(channelBId);
    expect(calls[1]?.data.alertedAt).toBe(alertedAt.toISOString());
    expect(calls[1]?.delayMs).toBe(600_000);
  });

  it("returns 0 and does not call enqueueEscalation when project has no policy", async () => {
    const fakeEnqueue = vi.fn();
    const count = await scheduleEscalation(prisma, fakeEnqueue, checkNoPolicyId, new Date());

    expect(count).toBe(0);
    expect(fakeEnqueue).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleEscalationStep
// ---------------------------------------------------------------------------

function makeDeps(): NotifierDeps & { mailer: CollectingMailer } {
  const mailer = new CollectingMailer();
  const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const enqueueEscalation = vi.fn().mockResolvedValue(undefined);
  return {
    mailer,
    httpPost,
    telegramPost: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, result: { message_id: 123 } },
    }),
    enqueueEscalation,
    telegramBotToken: "managed-test-token",
  };
}

describe("handleEscalationStep", () => {
  it("dispatches channel, writes AlertLog, returns 'dispatched' when check DOWN + no ack", async () => {
    // Ensure no stale acks or logs
    await prisma.acknowledgement.deleteMany({ where: { checkId: checkWithPolicyId } });
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithPolicyId } });

    const deps = makeDeps();
    const alertedAt = new Date(Date.now() - 10_000).toISOString();

    const result = await handleEscalationStep(prisma, deps, {
      checkId: checkWithPolicyId,
      alertedAt,
      channelId: testChannelId,
    });

    expect(result).toBe("dispatched");
    // dispatchChannel was called — mailer received a message
    expect(deps.mailer.sent).toHaveLength(1);
    expect(deps.mailer.sent[0]?.to).toBe("step@example.com");

    // AlertLog written
    const logs = await prisma.alertLog.findMany({ where: { checkId: checkWithPolicyId, channelId: testChannelId } });
    expect(logs).toHaveLength(1);

    // Cleanup
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithPolicyId } });
  });

  it("returns 'skipped-recovered' and does not dispatch when check status is UP", async () => {
    const deps = makeDeps();
    const alertedAt = new Date(Date.now() - 10_000).toISOString();

    const result = await handleEscalationStep(prisma, deps, {
      checkId: checkUpId,
      alertedAt,
      channelId: testChannelId,
    });

    expect(result).toBe("skipped-recovered");
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it("returns 'skipped-acked' when an Acknowledgement exists with createdAt >= alertedAt", async () => {
    // alertedAt is in the past; ack is created NOW (after alertedAt)
    const alertedAt = new Date(Date.now() - 5_000).toISOString();
    await prisma.acknowledgement.create({
      data: { checkId: checkWithPolicyId },
    });

    const deps = makeDeps();

    const result = await handleEscalationStep(prisma, deps, {
      checkId: checkWithPolicyId,
      alertedAt,
      channelId: testChannelId,
    });

    expect(result).toBe("skipped-acked");
    expect(deps.mailer.sent).toHaveLength(0);

    // Cleanup
    await prisma.acknowledgement.deleteMany({ where: { checkId: checkWithPolicyId } });
  });

  it("dispatches 'dispatched' when ack exists but its createdAt is BEFORE alertedAt (stale ack must not suppress new alert)", async () => {
    // The ack was created 60s ago — it predates this new alert
    const pastAckTime = new Date(Date.now() - 60_000);
    await prisma.acknowledgement.create({
      data: { checkId: checkWithPolicyId, createdAt: pastAckTime },
    });

    // alertedAt is NOW — after the stale ack
    const alertedAt = new Date().toISOString();

    const deps = makeDeps();

    const result = await handleEscalationStep(prisma, deps, {
      checkId: checkWithPolicyId,
      alertedAt,
      channelId: testChannelId,
    });

    // Stale ack must NOT suppress the new alert
    expect(result).toBe("dispatched");
    expect(deps.mailer.sent).toHaveLength(1);

    // Cleanup
    await prisma.acknowledgement.deleteMany({ where: { checkId: checkWithPolicyId } });
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithPolicyId } });
  });

  it("returns 'skipped-no-channel' when channel does not exist", async () => {
    await prisma.acknowledgement.deleteMany({ where: { checkId: checkWithPolicyId } });

    const deps = makeDeps();
    const alertedAt = new Date(Date.now() - 10_000).toISOString();

    const result = await handleEscalationStep(prisma, deps, {
      checkId: checkWithPolicyId,
      alertedAt,
      channelId: "nonexistent-channel-id",
    });

    expect(result).toBe("skipped-no-channel");
    expect(deps.mailer.sent).toHaveLength(0);
  });

  it("returns 'skipped-no-channel' when channel is disabled", async () => {
    await prisma.acknowledgement.deleteMany({ where: { checkId: checkWithPolicyId } });

    // Create a disabled channel
    const disabledCh = await prisma.notificationChannel.create({
      data: {
        projectId: projectWithPolicyId,
        type: ChannelType.EMAIL,
        config: { email: "disabled@example.com" },
        enabled: false,
      },
    });

    const deps = makeDeps();
    const alertedAt = new Date(Date.now() - 10_000).toISOString();

    const result = await handleEscalationStep(prisma, deps, {
      checkId: checkWithPolicyId,
      alertedAt,
      channelId: disabledCh.id,
    });

    expect(result).toBe("skipped-no-channel");
    expect(deps.mailer.sent).toHaveLength(0);

    // Cleanup
    await prisma.notificationChannel.delete({ where: { id: disabledCh.id } });
  });

  it("persists and rethrows only a sanitized Telegram escalation failure", async () => {
    await prisma.acknowledgement.deleteMany({
      where: { checkId: checkWithPolicyId },
    });
    await prisma.alertLog.deleteMany({
      where: { checkId: checkWithPolicyId, channelId: telegramChannelId },
    });
    const telegramPost = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        ok: false,
        description:
          "telegram-description-secret managed-test-token legacy-test-token -1001234567890 request body",
      },
    });
    const deps: NotifierDeps = {
      mailer: new CollectingMailer(),
      httpPost: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      telegramPost,
      enqueueEscalation: vi.fn().mockResolvedValue(undefined),
      telegramBotToken: "managed-test-token",
    };
    const alertedAt = new Date(Date.now() - 10_000).toISOString();
    const expectedError =
      `TELEGRAM channel ${telegramChannelId} sendMessage invalid response`;

    await expect(
      handleEscalationStep(prisma, deps, {
        checkId: checkWithPolicyId,
        alertedAt,
        channelId: telegramChannelId,
      }),
    ).rejects.toThrow(new Error(expectedError));

    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkWithPolicyId, channelId: telegramChannelId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.payload).toEqual({
      type: "TELEGRAM",
      ok: false,
      escalation: true,
      error: expectedError,
    });
    const persisted = JSON.stringify(logs[0]?.payload);
    for (const secret of [
      "managed-test-token",
      "legacy-test-token",
      "https://api.telegram.org",
      "-1001234567890",
      "request body",
      "telegram-description-secret",
    ]) {
      expect(persisted).not.toContain(secret);
    }

    await prisma.alertLog.deleteMany({
      where: { checkId: checkWithPolicyId, channelId: telegramChannelId },
    });
  });
});
