import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import type { AlertJob } from "./watchdog.js";
import type { NotifierDeps } from "./notifiers.js";
import { dispatchChannel } from "./notifiers.js";

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
    include: { project: true },
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

  const msg = {
    subject,
    text,
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
