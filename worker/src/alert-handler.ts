import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import type { AlertJob } from "./watchdog.js";
import type { NotifierDeps } from "./notifiers.js";
import { dispatchChannel } from "./notifiers.js";
import { config } from "./config.js";
import {
  buildTelegramDownAlertMessage,
  buildTelegramRecoveryAlertMessage,
} from "./telegram-alert.js";

/**
 * Process an alert job: dispatch its transition-time channel snapshot, or
 * resolve effective selected enabled channels for a legacy job, and write an
 * AlertLog per channel (success or failure). One failing channel does not
 * block the others.
 *
 * @returns The number of channels that were dispatched successfully.
 */
export async function handleAlert(
  prisma: PrismaClient,
  deps: NotifierDeps,
  data: AlertJob,
): Promise<number> {
  const { checkId, kind, channelIds } = data;

  // Load the check (include its project for context)
  const check = await prisma.check.findUnique({
    where: { id: checkId },
    include: { project: { include: { organization: true } } },
  });

  if (check == null) {
    // Stale job — check may have been deleted; silently skip
    return 0;
  }

  // Snapshots preserve transition-time selection. Legacy jobs without one use
  // the current exclusions during the rolling upgrade.
  const channels = await prisma.notificationChannel.findMany({
    where: {
      projectId: check.projectId,
      enabled: true,
      ...(channelIds === undefined
        ? { checkExclusions: { none: { checkId: check.id } } }
        : { id: { in: channelIds } }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const statusLabel = kind === "down" ? "DOWN" : "recovered";
  const subject = `[SystemVitals] ${check.name} is ${statusLabel}`;
  const now = new Date().toISOString();
  const text =
    kind === "down"
      ? `ALERT: "${check.name}" is DOWN.\n\nStatus: DOWN\nDetected at: ${now}\n\nPlease investigate immediately.`
      : `RECOVERY: "${check.name}" has recovered.\n\nStatus: UP\nRecovered at: ${now}`;

  const alertStatus = kind === "down" ? CheckStatus.DOWN : CheckStatus.UP;

  let telegramText: string | undefined;
  if (channels.some((channel) => channel.type === "TELEGRAM")) {
    const [totalPings, lastSuccess, otherChecksNotUp] = await Promise.all([
      prisma.checkEvent.count({
        where: { checkId, status: CheckStatus.UP },
      }),
      prisma.checkEvent.findFirst({
        where: { checkId, status: CheckStatus.UP },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      prisma.check.count({
        where: {
          projectId: check.projectId,
          id: { not: check.id },
          status: { not: CheckStatus.UP },
        },
      }),
    ]);
    const telegramContext = {
      appUrl: config.appUrl,
      organizationSlug: check.project.organization.slug,
      project: check.project,
      check,
      totalPings,
      lastSuccessAt: lastSuccess?.timestamp ?? null,
      otherChecksNotUp,
      now: new Date(),
    };
    if (kind === "down") {
      telegramText = buildTelegramDownAlertMessage(telegramContext);
    } else {
      const downtimeStart = await prisma.checkEvent.findFirst({
        where: {
          checkId,
          status: CheckStatus.DOWN,
          ...(lastSuccess == null
            ? {}
            : { timestamp: { lt: lastSuccess.timestamp } }),
        },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      });
      telegramText = buildTelegramRecoveryAlertMessage({
        ...telegramContext,
        downtimeStartedAt: downtimeStart?.timestamp ?? null,
      });
    }
  }

  const msg = {
    subject,
    text,
    telegramText,
    kind,
    check: { id: check.id, name: check.name, status: check.status },
  };
  let successes = 0;

  for (const channel of channels) {
    try {
      await dispatchChannel(channel, msg, deps);

      await prisma.alertLog.create({
        data: {
          checkId,
          channelId: channel.id,
          status: alertStatus,
          payload: { type: channel.type, ok: true },
        },
      });

      successes++;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(
        `[alert] channel ${channel.id} (${channel.type}) dispatch failed:`,
        error,
      );

      await prisma.alertLog.create({
        data: {
          checkId,
          channelId: channel.id,
          status: alertStatus,
          payload: { type: channel.type, ok: false, error },
        },
      });
    }
  }

  return successes;
}
