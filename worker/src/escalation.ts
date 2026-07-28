import type { PrismaClient } from "@systemvitals/database";
import { CheckStatus } from "@systemvitals/database";
import type { NotifierDeps, NotifyMessage } from "./notifiers.js";
import { dispatchChannel } from "./notifiers.js";

/** Shape of a single step stored in EscalationPolicy.steps JSON array. */
interface PolicyStep {
  channelId: string;
  delaySeconds: number;
}

/** Payload enqueued for each delayed escalation job. */
export interface EscalationJob {
  checkId: string;
  alertedAt: string; // ISO string
  channelId: string;
}

/**
 * Schedule escalation jobs for a DOWN check by iterating the project's
 * EscalationPolicy steps and calling `enqueueEscalation` once per step.
 *
 * @returns The total number of steps scheduled (0 if no policy exists).
 */
export async function scheduleEscalation(
  prisma: PrismaClient,
  enqueueEscalation: (data: EscalationJob, delayMs: number) => Promise<void>,
  checkId: string,
  alertedAt: Date,
): Promise<number> {
  // Load check to get projectId
  const check = await prisma.check.findUnique({
    where: { id: checkId },
    select: { projectId: true },
  });

  if (check == null) {
    return 0;
  }

  // Load all escalation policies for this project
  const policies = await prisma.escalationPolicy.findMany({
    where: { projectId: check.projectId },
  });

  if (policies.length === 0) {
    return 0;
  }

  let count = 0;
  const alertedAtIso = alertedAt.toISOString();

  for (const policy of policies) {
    const steps = policy.steps as unknown as PolicyStep[];
    for (const step of steps) {
      await enqueueEscalation(
        { checkId, alertedAt: alertedAtIso, channelId: step.channelId },
        step.delaySeconds * 1000,
      );
      count++;
    }
  }

  return count;
}

/**
 * Process a single escalation step at fire time.
 *
 * Self-checks resolution before dispatching:
 * - If check no longer exists or is not DOWN → skipped-recovered
 * - If an Acknowledgement exists with createdAt >= alertedAt → skipped-acked
 * - If the channel is missing or disabled → skipped-no-channel
 * - Otherwise: dispatches via dispatchChannel, writes an AlertLog, returns 'dispatched'
 */
export async function handleEscalationStep(
  prisma: PrismaClient,
  deps: NotifierDeps,
  data: EscalationJob,
): Promise<"dispatched" | "skipped-recovered" | "skipped-acked" | "skipped-no-channel"> {
  const { checkId, alertedAt, channelId } = data;

  // Load the check
  const check = await prisma.check.findUnique({
    where: { id: checkId },
  });

  if (check == null || check.status !== CheckStatus.DOWN) {
    return "skipped-recovered";
  }

  // Check for acknowledgement at or after the alert time
  const alertedAtDate = new Date(alertedAt);
  const ack = await prisma.acknowledgement.findFirst({
    where: {
      checkId,
      createdAt: { gte: alertedAtDate },
    },
  });

  if (ack != null) {
    return "skipped-acked";
  }

  // Load the channel (must be enabled and belong to the check's project)
  const channel = await prisma.notificationChannel.findFirst({
    where: {
      id: channelId,
      projectId: check.projectId,
      enabled: true,
    },
  });

  if (channel == null) {
    return "skipped-no-channel";
  }

  // Build the notification message
  const now = new Date().toISOString();
  const msg: NotifyMessage = {
    subject: `[SystemVitals] ESCALATION: ${check.name} is still DOWN`,
    text: `ESCALATION: Unacknowledged alert — "${check.name}" is still DOWN.\n\nStatus: DOWN\nEscalation sent at: ${now}\n\nPlease investigate immediately.`,
    kind: "down",
    check: { id: check.id, name: check.name, status: check.status },
  };

  // Dispatch and write AlertLog (mirrors handleAlert per-dispatch observability)
  try {
    await dispatchChannel(channel, msg, deps);
    await prisma.alertLog.create({
      data: {
        checkId,
        channelId: channel.id,
        status: CheckStatus.DOWN,
        payload: { type: channel.type, ok: true, escalation: true },
      },
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await prisma.alertLog.create({
      data: {
        checkId,
        channelId: channel.id,
        status: CheckStatus.DOWN,
        payload: { type: channel.type, ok: false, escalation: true, error: errMsg },
      },
    });
    throw err; // rethrow so BullMQ retries the escalation step
  }

  return "dispatched";
}
