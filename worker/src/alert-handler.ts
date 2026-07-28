import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import type { AlertJob } from "./watchdog.js";
import type { NotifierDeps } from "./notifiers.js";
import { dispatchChannel } from "./notifiers.js";
import { scheduleEscalation } from "./escalation.js";

/**
 * Process an alert job: find the effective selected enabled notification
 * channels for the check, dispatch to each one, and write an AlertLog per
 * channel (success or failure). One failing channel does not block the others.
 *
 * @returns The number of channels that were dispatched successfully.
 */
export async function handleAlert(
  prisma: PrismaClient,
  deps: NotifierDeps,
  data: AlertJob,
): Promise<number> {
  const { checkId, kind } = data;

  // Load the check (include its project for context)
  const check = await prisma.check.findUnique({
    where: { id: checkId },
    include: { project: true },
  });

  if (check == null) {
    // Stale job — check may have been deleted; silently skip
    return 0;
  }

  // Find selected enabled channels (any type) for the check's project
  const channels = await prisma.notificationChannel.findMany({
    where: {
      projectId: check.projectId,
      enabled: true,
      checkExclusions: { none: { checkId: check.id } },
    },
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

  // After immediate dispatch, schedule escalation steps if this is a DOWN alert
  if (kind === "down") {
    await scheduleEscalation(prisma, deps.enqueueEscalation, checkId, new Date())
      .catch((err) => console.error("[alert-handler] scheduleEscalation failed:", err));
  }

  return successes;
}
