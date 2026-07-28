import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { PrismaClient, CheckStatus, ChannelType } from "@systemvitals/database";
import { handleAlert } from "../src/alert-handler.js";
import type { NotifierDeps } from "../src/notifiers.js";
import { CollectingMailer } from "../src/mailer.js";

const prisma = new PrismaClient();

// IDs scoped to this test file
let userId: string;
let orgId: string;
let projectId: string;
let checkWithChannelId: string;
let checkNoChannelId: string;
let emailChannelId: string;
let slackChannelId: string;
// Project with escalation policy
let projectWithPolicyId: string;
let checkWithPolicyId: string;
let policyChannelId: string;
// Project without escalation policy
let projectNoPolicyId: string;
let checkNoPolicyId: string;
// Project with a managed Telegram channel
let telegramProjectId: string;
let telegramCheckId: string;
let telegramChannelId: string;

const TEST_EMAIL = `alert-handler-test-${Date.now()}@test.invalid`;
const OPS_EMAIL = "ops@example.com";
const SLACK_WEBHOOK = "https://hooks.slack.com/services/T00/B00/test";

beforeAll(async () => {
  // Clean up stale records from prior failed runs (match by unique test email)
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });

  // Create user
  const user = await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      passwordHash: "testhash",
    },
  });
  userId = user.id;

  // Create organization
  const org = await prisma.organization.create({
    data: {
      name: `AlertHandler Test Org ${Date.now()}`,
      slug: `alert-handler-test-org-${Date.now()}`,
      creatorUserId: userId,
    },
  });
  orgId = org.id;

  // Create membership
  await prisma.membership.create({
    data: { userId, organizationId: orgId, role: "OWNER" },
  });

  // Create project with EMAIL + SLACK channels
  const project = await prisma.project.create({
    data: {
      name: `AlertHandler Test Project ${Date.now()}`,
      slug: `alert-handler-test-project-${Date.now()}`,
      organizationId: orgId,
    },
  });
  projectId = project.id;

  // Create check WITH channels
  const checkWith = await prisma.check.create({
    data: {
      name: "API Heartbeat",
      slug: "api-heartbeat",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId,
    },
  });
  checkWithChannelId = checkWith.id;

  // Create an enabled EMAIL NotificationChannel
  const emailChannel = await prisma.notificationChannel.create({
    data: {
      projectId,
      type: ChannelType.EMAIL,
      config: { email: OPS_EMAIL },
      enabled: true,
    },
  });
  emailChannelId = emailChannel.id;

  // Create an enabled SLACK NotificationChannel
  const slackChannel = await prisma.notificationChannel.create({
    data: {
      projectId,
      type: ChannelType.SLACK,
      config: { webhookUrl: SLACK_WEBHOOK },
      enabled: true,
    },
  });
  slackChannelId = slackChannel.id;

  // Create check with NO channels (separate project)
  const projectNoChannel = await prisma.project.create({
    data: {
      name: `AlertHandler No-Channel Project ${Date.now()}`,
      slug: `alert-handler-no-channel-project-${Date.now()}`,
      organizationId: orgId,
    },
  });

  const checkNo = await prisma.check.create({
    data: {
      name: "No-Channel Check",
      slug: "no-channel-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: projectNoChannel.id,
    },
  });
  checkNoChannelId = checkNo.id;

  // Project WITH escalation policy
  const projectWithPolicy = await prisma.project.create({
    data: {
      name: `AlertHandler Policy Project ${Date.now()}`,
      slug: `alert-handler-policy-project-${Date.now()}`,
      organizationId: orgId,
    },
  });
  projectWithPolicyId = projectWithPolicy.id;

  const policyChannel = await prisma.notificationChannel.create({
    data: {
      projectId: projectWithPolicyId,
      type: ChannelType.EMAIL,
      config: { email: "policy@example.com" },
      enabled: true,
    },
  });
  policyChannelId = policyChannel.id;

  await prisma.escalationPolicy.create({
    data: {
      projectId: projectWithPolicyId,
      steps: [{ channelId: policyChannelId, delaySeconds: 300 }],
    },
  });

  const checkWithPolicy = await prisma.check.create({
    data: {
      name: "Policy Check",
      slug: "policy-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: projectWithPolicyId,
    },
  });
  checkWithPolicyId = checkWithPolicy.id;

  // Project WITHOUT escalation policy
  const projectNoPolicy = await prisma.project.create({
    data: {
      name: `AlertHandler No-Policy Project ${Date.now()}`,
      slug: `alert-handler-no-policy-project-${Date.now()}`,
      organizationId: orgId,
    },
  });
  projectNoPolicyId = projectNoPolicy.id;

  const checkNoPolicy = await prisma.check.create({
    data: {
      name: "No-Policy Check",
      slug: "no-policy-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: projectNoPolicyId,
    },
  });
  checkNoPolicyId = checkNoPolicy.id;

  const telegramProject = await prisma.project.create({
    data: {
      name: `AlertHandler Telegram Project ${Date.now()}`,
      slug: `alert-handler-telegram-project-${Date.now()}`,
      organizationId: orgId,
    },
  });
  telegramProjectId = telegramProject.id;

  const telegramCheck = await prisma.check.create({
    data: {
      name: "Managed Telegram Check",
      slug: "managed-telegram-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: telegramProjectId,
    },
  });
  telegramCheckId = telegramCheck.id;

  const telegramChannel = await prisma.notificationChannel.create({
    data: {
      projectId: telegramProjectId,
      type: ChannelType.TELEGRAM,
      config: {
        mode: "MANAGED",
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
        in: [
          checkWithChannelId,
          checkNoChannelId,
          checkWithPolicyId,
          checkNoPolicyId,
          telegramCheckId,
        ],
      },
    },
  });
  await prisma.check.deleteMany({
    where: {
      id: {
        in: [
          checkWithChannelId,
          checkNoChannelId,
          checkWithPolicyId,
          checkNoPolicyId,
          telegramCheckId,
        ],
      },
    },
  });
  await prisma.escalationPolicy.deleteMany({ where: { projectId: projectWithPolicyId } });
  await prisma.notificationChannel.deleteMany({
    where: {
      id: {
        in: [
          emailChannelId,
          slackChannelId,
          policyChannelId,
          telegramChannelId,
        ],
      },
    },
  });

  // Delete all projects belonging to this org
  await prisma.project.deleteMany({ where: { organizationId: orgId } });

  await prisma.membership.deleteMany({ where: { userId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

function makeDeps(httpPost: NotifierDeps["httpPost"]): NotifierDeps {
  return {
    mailer: new CollectingMailer(),
    httpPost,
    telegramPost: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, result: { message_id: 123 } },
    }),
    enqueueEscalation: vi.fn().mockResolvedValue(undefined),
    telegramBotToken: "managed-test-token",
  };
}

describe("handleAlert", () => {
  it("sends to EMAIL + SLACK channels, writes 2 AlertLogs, returns 2", async () => {
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const mailer = new CollectingMailer();
    const enqueueEscalation = vi.fn().mockResolvedValue(undefined);
    const deps: NotifierDeps = {
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

    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
    });

    // Returns 2 — one per channel
    expect(sent).toBe(2);

    // EMAIL was dispatched via mailer
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe(OPS_EMAIL);
    expect(mailer.sent[0]?.subject).toContain("API Heartbeat");
    expect(mailer.sent[0]?.subject.toUpperCase()).toContain("DOWN");

    // SLACK was dispatched via httpPost
    expect(httpPost).toHaveBeenCalledOnce();
    const [slackUrl] = httpPost.mock.calls[0] as [string, unknown];
    expect(slackUrl).toBe(SLACK_WEBHOOK);

    // Two AlertLog rows written
    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkWithChannelId },
    });
    expect(logs).toHaveLength(2);
    const channelIds = logs.map((l) => l.channelId);
    expect(channelIds).toContain(emailChannelId);
    expect(channelIds).toContain(slackChannelId);

    // Clean up
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });
  });

  it("returns 0 and dispatches nothing when check has no channels", async () => {
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkNoChannelId,
      kind: "down",
    });

    expect(sent).toBe(0);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();

    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkNoChannelId },
    });
    expect(logs).toHaveLength(0);
  });

  it("returns 0 for a non-existent check (stale job safety)", async () => {
    const deps = makeDeps(vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const sent = await handleAlert(prisma, deps, {
      checkId: "nonexistent-check-id",
      kind: "down",
    });
    expect(sent).toBe(0);
  });

  it("uses 'recovered' wording in subject for kind=recovery", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });

    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const mailer = new CollectingMailer();
    const enqueueEscalation = vi.fn().mockResolvedValue(undefined);
    const deps: NotifierDeps = {
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

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "recovery",
    });

    expect(sent).toBe(2);
    expect(mailer.sent[0]?.subject.toLowerCase()).toContain("recover");

    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });
  });

  it("one failing channel does not block others; returns partial success count", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });

    // httpPost always fails (for SLACK)
    const httpPost = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 });
    const mailer = new CollectingMailer();
    const enqueueEscalation = vi.fn().mockResolvedValue(undefined);
    const deps: NotifierDeps = {
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

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
    });

    // EMAIL succeeded, SLACK failed → 1 success
    expect(sent).toBe(1);
    // EMAIL was still sent
    expect(mailer.sent).toHaveLength(1);

    // 2 AlertLogs: one success (EMAIL), one failure (SLACK)
    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkWithChannelId },
    });
    expect(logs).toHaveLength(2);

    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });
  });

  it("calls enqueueEscalation when kind=down and project HAS an escalation policy", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithPolicyId } });

    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const enqueueEscalation = vi.fn().mockResolvedValue(undefined);
    const mailer = new CollectingMailer();
    const deps: NotifierDeps = {
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

    await handleAlert(prisma, deps, { checkId: checkWithPolicyId, kind: "down" });

    expect(enqueueEscalation).toHaveBeenCalled();

    await prisma.alertLog.deleteMany({ where: { checkId: checkWithPolicyId } });
  });

  it("does NOT call enqueueEscalation when kind=down but project has NO escalation policy", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: checkNoPolicyId } });

    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const enqueueEscalation = vi.fn().mockResolvedValue(undefined);
    const mailer = new CollectingMailer();
    const deps: NotifierDeps = {
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

    await handleAlert(prisma, deps, { checkId: checkNoPolicyId, kind: "down" });

    expect(enqueueEscalation).not.toHaveBeenCalled();

    await prisma.alertLog.deleteMany({ where: { checkId: checkNoPolicyId } });
  });

  it("delivers a managed Telegram row with the environment token and records success", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: telegramCheckId } });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const telegramPost = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, result: { message_id: 456 } },
    });
    const deps: NotifierDeps = {
      mailer: new CollectingMailer(),
      httpPost,
      telegramPost,
      enqueueEscalation: vi.fn().mockResolvedValue(undefined),
      telegramBotToken: "managed-test-token",
    };

    const sent = await handleAlert(prisma, deps, {
      checkId: telegramCheckId,
      kind: "down",
    });

    expect(sent).toBe(1);
    expect(httpPost).not.toHaveBeenCalled();
    expect(telegramPost).toHaveBeenCalledOnce();
    const [url, body] = telegramPost.mock.calls[0] as [
      string,
      { chat_id: string; text: string },
    ];
    expect(url).toBe(
      "https://api.telegram.org/botmanaged-test-token/sendMessage",
    );
    expect(body).toEqual({
      chat_id: "-1001234567890",
      text: expect.stringContaining(
        '[SystemVitals] Managed Telegram Check is DOWN\nALERT: "Managed Telegram Check" is DOWN.',
      ),
    });

    const logs = await prisma.alertLog.findMany({
      where: { checkId: telegramCheckId, channelId: telegramChannelId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.payload).toEqual({ type: "TELEGRAM", ok: true });

    await prisma.alertLog.deleteMany({ where: { checkId: telegramCheckId } });
  });

  it("persists only a sanitized managed Telegram envelope failure", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: telegramCheckId } });
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

    const sent = await handleAlert(prisma, deps, {
      checkId: telegramCheckId,
      kind: "down",
    });

    expect(sent).toBe(0);
    const logs = await prisma.alertLog.findMany({
      where: { checkId: telegramCheckId, channelId: telegramChannelId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.payload).toEqual({
      type: "TELEGRAM",
      ok: false,
      error: `TELEGRAM channel ${telegramChannelId} sendMessage invalid response`,
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

    await prisma.alertLog.deleteMany({ where: { checkId: telegramCheckId } });
  });
});
