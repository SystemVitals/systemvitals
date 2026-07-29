import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from "vitest";
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
// Project used to verify explicit selected-channel delivery
let selectedProjectId: string;
let selectedCheckId: string;
let selectedChannelId: string;
// Project used to verify channel changes after check creation
let dynamicProjectId: string;
let dynamicCheckId: string;
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

  async function createProjectInOwnOrganization(label: string) {
    const organization = await prisma.organization.create({
      data: {
        name: `AlertHandler ${label} Org ${Date.now()}`,
        slug: `alert-handler-${label}-org-${Date.now()}`,
        creatorUserId: userId,
        memberships: {
          create: { userId, role: "OWNER" },
        },
      },
    });
    return prisma.project.create({
      data: {
        name: `AlertHandler ${label} Project ${Date.now()}`,
        slug: `alert-handler-${label}-project-${Date.now()}`,
        organizationId: organization.id,
      },
    });
  }

  // Create check with NO channels in its own workspace
  const projectNoChannel =
    await createProjectInOwnOrganization("no-channel");

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

  const selectedProject =
    await createProjectInOwnOrganization("selected-channel");
  selectedProjectId = selectedProject.id;

  const selectedChannel = await prisma.notificationChannel.create({
    data: {
      projectId: selectedProjectId,
      type: ChannelType.EMAIL,
      config: { email: "selected@example.com" },
      enabled: true,
    },
  });
  selectedChannelId = selectedChannel.id;

  const selectedCheck = await prisma.check.create({
    data: {
      name: "Selected Channel Check",
      slug: "selected-channel-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: selectedProjectId,
    },
  });
  selectedCheckId = selectedCheck.id;

  const dynamicProject =
    await createProjectInOwnOrganization("dynamic-routing");
  dynamicProjectId = dynamicProject.id;

  const dynamicCheck = await prisma.check.create({
    data: {
      name: "Dynamic Routing Check",
      slug: "dynamic-routing-check",
      type: "HEARTBEAT",
      status: "DOWN",
      projectId: dynamicProjectId,
    },
  });
  dynamicCheckId = dynamicCheck.id;

  const telegramProject =
    await createProjectInOwnOrganization("telegram");
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

beforeEach(async () => {
  await prisma.checkChannelExclusion.deleteMany({
    where: { checkId: { in: [checkWithChannelId, selectedCheckId] } },
  });
  await prisma.notificationChannel.updateMany({
    where: { id: { in: [emailChannelId, slackChannelId] } },
    data: { enabled: true },
  });
  await prisma.alertLog.deleteMany({
    where: { checkId: { in: [checkWithChannelId, selectedCheckId] } },
  });
});

afterAll(async () => {
  // Clean up in dependency order
  await prisma.alertLog.deleteMany({
    where: {
      checkId: {
        in: [
          checkWithChannelId,
          checkNoChannelId,
          selectedCheckId,
          dynamicCheckId,
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
          selectedCheckId,
          dynamicCheckId,
          telegramCheckId,
        ],
      },
    },
  });
  await prisma.notificationChannel.deleteMany({
    where: {
      id: {
        in: [
          emailChannelId,
          slackChannelId,
          selectedChannelId,
          telegramChannelId,
        ],
      },
    },
  });

  await prisma.organization.deleteMany({ where: { creatorUserId: userId } });
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
    telegramBotToken: "managed-test-token",
  };
}

describe("handleAlert", () => {
  it("sends to EMAIL + SLACK channels, writes 2 AlertLogs, returns 2", async () => {
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const mailer = new CollectingMailer();
    const deps: NotifierDeps = {
      mailer,
      httpPost,
      telegramPost: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 123 } },
      }),
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
    const deps: NotifierDeps = {
      mailer,
      httpPost,
      telegramPost: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 123 } },
      }),
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

  it("uses current exclusions for a legacy job without a channel snapshot", async () => {
    await prisma.checkChannelExclusion.create({
      data: { checkId: checkWithChannelId, channelId: slackChannelId },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
    });

    expect(sent).toBe(1);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(1);
    expect(
      (deps.mailer as CollectingMailer).sent[0]?.subject,
    ).toContain("DOWN");
    expect(httpPost).not.toHaveBeenCalled();
    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkWithChannelId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.channelId).toBe(emailChannelId);
    expect(logs[0]?.status).toBe(CheckStatus.DOWN);
    expect(logs[0]?.payload).toEqual({ type: "EMAIL", ok: true });
  });

  it("uses the same channel exclusion for recovery dispatch", async () => {
    await prisma.checkChannelExclusion.create({
      data: { checkId: checkWithChannelId, channelId: slackChannelId },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "recovery",
    });

    expect(sent).toBe(1);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(1);
    expect(httpPost).not.toHaveBeenCalled();
    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkWithChannelId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.channelId).toBe(emailChannelId);
    expect(logs[0]?.status).toBe(CheckStatus.UP);
  });

  it("delivers a snapshotted channel even when it is excluded before consumption", async () => {
    await prisma.checkChannelExclusion.create({
      data: { checkId: checkWithChannelId, channelId: slackChannelId },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
      channelIds: [slackChannelId],
    });

    expect(sent).toBe(1);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(0);
    expect(httpPost).toHaveBeenCalledOnce();
    const logs = await prisma.alertLog.findMany({
      where: { checkId: checkWithChannelId },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.channelId).toBe(slackChannelId);
  });

  it("keeps an empty transition snapshot empty after its exclusion is removed", async () => {
    await prisma.checkChannelExclusion.create({
      data: { checkId: checkWithChannelId, channelId: slackChannelId },
    });
    await prisma.checkChannelExclusion.delete({
      where: {
        checkId_channelId: {
          checkId: checkWithChannelId,
          channelId: slackChannelId,
        },
      },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
      channelIds: [],
    });

    expect(sent).toBe(0);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
    expect(
      await prisma.alertLog.count({ where: { checkId: checkWithChannelId } }),
    ).toBe(0);
  });

  it("skips a snapshotted channel that is globally disabled before consumption", async () => {
    await prisma.notificationChannel.update({
      where: { id: slackChannelId },
      data: { enabled: false },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
      channelIds: [slackChannelId],
    });

    expect(sent).toBe(0);
    expect(httpPost).not.toHaveBeenCalled();
    expect(
      await prisma.alertLog.count({ where: { checkId: checkWithChannelId } }),
    ).toBe(0);
  });

  it("skips a snapshotted channel that is deleted before consumption", async () => {
    const deletedChannel = await prisma.notificationChannel.create({
      data: {
        projectId: dynamicProjectId,
        type: ChannelType.EMAIL,
        config: { email: "deleted-before-alert@example.com" },
        enabled: true,
      },
    });
    await prisma.notificationChannel.delete({
      where: { id: deletedChannel.id },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: dynamicCheckId,
      kind: "down",
      channelIds: [deletedChannel.id],
    });

    expect(sent).toBe(0);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
    expect(
      await prisma.alertLog.count({ where: { checkId: dynamicCheckId } }),
    ).toBe(0);
  });

  it("selects an enabled channel created after the check when it has no exclusion", async () => {
    const lateChannel = await prisma.notificationChannel.create({
      data: {
        projectId: dynamicProjectId,
        type: ChannelType.EMAIL,
        config: { email: "late-channel@example.com" },
        enabled: true,
      },
    });
    const deps = makeDeps(
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    try {
      const sent = await handleAlert(prisma, deps, {
        checkId: dynamicCheckId,
        kind: "down",
      });

      expect(sent).toBe(1);
      expect((deps.mailer as CollectingMailer).sent).toHaveLength(1);
      const logs = await prisma.alertLog.findMany({
        where: { checkId: dynamicCheckId },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.channelId).toBe(lateChannel.id);
    } finally {
      await prisma.alertLog.deleteMany({ where: { checkId: dynamicCheckId } });
      await prisma.notificationChannel.delete({ where: { id: lateChannel.id } });
    }
  });

  it("returns zero without dispatch or logs when every enabled channel is excluded", async () => {
    await prisma.checkChannelExclusion.createMany({
      data: [
        { checkId: checkWithChannelId, channelId: emailChannelId },
        { checkId: checkWithChannelId, channelId: slackChannelId },
      ],
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
    });

    expect(sent).toBe(0);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
    expect(deps.telegramPost).not.toHaveBeenCalled();
    expect(
      await prisma.alertLog.count({ where: { checkId: checkWithChannelId } }),
    ).toBe(0);
  });

  it("does not dispatch or log a globally disabled channel", async () => {
    await prisma.notificationChannel.update({
      where: { id: slackChannelId },
      data: { enabled: false },
    });
    await prisma.checkChannelExclusion.create({
      data: { checkId: checkWithChannelId, channelId: emailChannelId },
    });
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: checkWithChannelId,
      kind: "down",
    });

    expect(sent).toBe(0);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(0);
    expect(httpPost).not.toHaveBeenCalled();
    expect(
      await prisma.alertLog.count({ where: { checkId: checkWithChannelId } }),
    ).toBe(0);
  });

  it("one failing channel does not block others; returns partial success count", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });

    // httpPost always fails (for SLACK)
    const httpPost = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500 });
    const mailer = new CollectingMailer();
    const deps: NotifierDeps = {
      mailer,
      httpPost,
      telegramPost: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 123 } },
      }),
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
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: emailChannelId,
          payload: { type: "EMAIL", ok: true },
        }),
        expect.objectContaining({
          channelId: slackChannelId,
          payload: {
            type: "SLACK",
            ok: false,
            error: expect.stringContaining("500"),
          },
        }),
      ]),
    );

    await prisma.alertLog.deleteMany({ where: { checkId: checkWithChannelId } });
  });

  it("dispatches a selected channel on DOWN", async () => {
    await prisma.alertLog.deleteMany({ where: { checkId: selectedCheckId } });

    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const mailer = new CollectingMailer();
    const deps: NotifierDeps = {
      mailer,
      httpPost,
      telegramPost: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: { ok: true, result: { message_id: 123 } },
      }),
      telegramBotToken: "managed-test-token",
    };
    const sent = await handleAlert(prisma, deps, {
      checkId: selectedCheckId,
      kind: "down",
      channelIds: [selectedChannelId],
    });

    expect(sent).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe("selected@example.com");

    await prisma.alertLog.deleteMany({ where: { checkId: selectedCheckId } });
  });

  it("dispatches the same selected channel on recovery", async () => {
    const httpPost = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const deps = makeDeps(httpPost);

    const sent = await handleAlert(prisma, deps, {
      checkId: selectedCheckId,
      kind: "recovery",
      channelIds: [selectedChannelId],
    });

    expect(sent).toBe(1);
    expect((deps.mailer as CollectingMailer).sent).toHaveLength(1);
    expect((deps.mailer as CollectingMailer).sent[0]?.to).toBe(
      "selected@example.com",
    );
    expect(httpPost).not.toHaveBeenCalled();
    expect(deps.telegramPost).not.toHaveBeenCalled();

    await prisma.alertLog.deleteMany({ where: { checkId: selectedCheckId } });
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
